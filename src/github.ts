import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DEFAULT_DIFF_MAX_BYTES,
  omitNoiseFiles,
  truncateDiff,
} from './diff.js';
import { ParsedPrReference } from './pr-reference.js';
import {
  PullRequestDetail,
  PullRequestDiff,
  ReviewError,
} from './review.type.js';

// 이대리는 Octokit + PAT 를 쓰지만, 개인 CLI 는 이미 로그인된 `gh` 를 그대로 쓴다 (토큰 관리 0).
const GH_MAX_BUFFER = 64 * 1024 * 1024;
// 상세 → diff 사이 push 가 들어오면 지적은 새 diff, 게시 앵커는 옛 headSha 로 갈린다. 한 번 다시 받는다.
const SNAPSHOT_FETCH_ATTEMPTS = 2;

const runGh = async (args: string[], input?: string): Promise<string> => {
  try {
    if (input === undefined) {
      const { stdout } = await promisify(execFile)('gh', args, {
        maxBuffer: GH_MAX_BUFFER,
      });
      return stdout;
    }
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'gh',
        args,
        { maxBuffer: GH_MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}\n${stderr}`));
            return;
          }
          resolve(stdout);
        },
      );
      child.stdin?.end(input);
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReviewError(`gh ${args.slice(0, 2).join(' ')} 실패: ${message}`);
  }
};

interface GhPrView {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  files: { path: string }[];
}

const getPullRequest = async (
  ref: ParsedPrReference,
): Promise<PullRequestDetail> => {
  const raw = await runGh([
    'pr',
    'view',
    String(ref.number),
    '--repo',
    ref.repo,
    '--json',
    'number,title,body,author,headRefName,baseRefName,headRefOid,additions,deletions,files',
  ]);
  const view = JSON.parse(raw) as GhPrView;
  return {
    repo: ref.repo,
    number: view.number,
    title: view.title,
    body: view.body,
    authorLogin: view.author.login,
    headRef: view.headRefName,
    baseRef: view.baseRefName,
    headSha: view.headRefOid,
    additions: view.additions,
    deletions: view.deletions,
    changedFiles: view.files.map((file) => file.path),
  };
};

const getPullRequestDiff = async (
  ref: ParsedPrReference,
  maxBytes: number,
): Promise<PullRequestDiff> => {
  const rawDiff = await runGh([
    'pr',
    'diff',
    String(ref.number),
    '--repo',
    ref.repo,
    '--color',
    'never',
  ]);
  const { diff, omittedPaths, secretPaths } = omitNoiseFiles(rawDiff);
  return {
    ...truncateDiff(diff, maxBytes),
    omittedPaths,
    secretPaths,
    rawDiff,
  };
};

export interface PullRequestSnapshot {
  detail: PullRequestDetail;
  diff: PullRequestDiff;
}

// 상세 → diff → 재조회를 차례로 받는다. 병렬이면 diff 가 옛 커밋이어도 두 상세가 같아 통과한다.
export const fetchConsistentSnapshot = async (
  ref: ParsedPrReference,
  maxBytes = DEFAULT_DIFF_MAX_BYTES,
): Promise<PullRequestSnapshot> => {
  for (let attempt = 1; attempt <= SNAPSHOT_FETCH_ATTEMPTS; attempt += 1) {
    const detail = await getPullRequest(ref);
    const diff = await getPullRequestDiff(ref, maxBytes);
    const recheck = await getPullRequest(ref);
    if (recheck.headSha === detail.headSha) {
      return { detail, diff };
    }
  }
  throw new ReviewError(
    `${ref.repo}#${ref.number} 에 push 가 이어지고 있어 같은 커밋 기준으로 조회하지 못했습니다. 잠시 뒤 다시 실행해 주세요.`,
  );
};

export interface PullRequestCandidate {
  repo: string;
  number: number;
  title: string;
  // 선택 화면에 붙일 출처 표시.
  role: '리뷰 요청' | '내 PR';
}

interface GhSearchItem {
  number: number;
  title: string;
  repository: { nameWithOwner: string };
}

// 선택 화면용 후보. 검색 실패는 빈 목록 — 사용자가 직접 입력하면 된다.
export const listCandidatePullRequests = async (): Promise<
  PullRequestCandidate[]
> => {
  const search = async (
    filter: string,
    role: PullRequestCandidate['role'],
  ): Promise<PullRequestCandidate[]> => {
    try {
      const raw = await runGh([
        'search',
        'prs',
        filter,
        '--state=open',
        '--json',
        'number,title,repository',
        '--limit',
        '20',
      ]);
      return (JSON.parse(raw) as GhSearchItem[]).map((item) => ({
        repo: item.repository.nameWithOwner,
        number: item.number,
        title: item.title,
        role,
      }));
    } catch {
      return [];
    }
  };
  const [requested, mine] = await Promise.all([
    search('--review-requested=@me', '리뷰 요청'),
    search('--author=@me', '내 PR'),
  ]);
  return [...requested, ...mine];
};

export interface ReviewCommentPayload {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface CreateReviewPayload {
  commit_id: string;
  body: string;
  event: 'COMMENT';
  comments: ReviewCommentPayload[];
}

// 리뷰 하나로 본문 + 인라인 코멘트를 한 번에 단다. 돌려주는 값은 리뷰 URL.
export const createReview = async (
  ref: ParsedPrReference,
  payload: CreateReviewPayload,
): Promise<string> => {
  const raw = await runGh(
    [
      'api',
      '-X',
      'POST',
      `repos/${ref.repo}/pulls/${ref.number}/reviews`,
      '--input',
      '-',
    ],
    JSON.stringify(payload),
  );
  const created = JSON.parse(raw) as { html_url?: string };
  return created.html_url ?? `https://github.com/${ref.repo}/pull/${ref.number}`;
};
