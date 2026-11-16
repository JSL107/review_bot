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
  files: { path: string; additions: number; deletions: number }[];
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
    changedLinesByFile: Object.fromEntries(
      view.files.map((file) => [file.path, file.additions + file.deletions]),
    ),
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

export interface CreatedReview {
  reviewId: number;
  url: string;
}

// 리뷰 하나로 본문 + 인라인 코멘트를 한 번에 단다.
export const createReview = async (
  ref: ParsedPrReference,
  payload: CreateReviewPayload,
): Promise<CreatedReview> => {
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
  const created = JSON.parse(raw) as { id: number; html_url?: string };
  return {
    reviewId: created.id,
    url: created.html_url ?? `https://github.com/${ref.repo}/pull/${ref.number}`,
  };
};

// 페이지마다 배열이 오는 목록 API 를 하나로 합친다.
const ghApiList = async <T>(path: string): Promise<T[]> => {
  const raw = await runGh(['api', '--paginate', '--slurp', path]);
  return (JSON.parse(raw) as T[][]).flat();
};

export interface PullComment {
  id: number;
  inReplyToId?: number;
  userLogin: string;
  body: string;
  createdAt: string;
  path: string;
  url: string;
}

interface GhPullComment {
  id: number;
  in_reply_to_id?: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
  path: string;
  html_url: string;
}

const toPullComment = (comment: GhPullComment): PullComment => ({
  id: comment.id,
  ...(comment.in_reply_to_id === undefined ? {} : { inReplyToId: comment.in_reply_to_id }),
  userLogin: comment.user?.login ?? '',
  body: comment.body,
  createdAt: comment.created_at,
  path: comment.path,
  url: comment.html_url,
});

// 방금 만든 리뷰에 달린 인라인 코멘트 — 지적 카드와 코멘트 id 를 잇는 데 쓴다.
export const listReviewComments = async (
  ref: ParsedPrReference,
  reviewId: number,
): Promise<PullComment[]> =>
  (
    await ghApiList<GhPullComment>(
      `repos/${ref.repo}/pulls/${ref.number}/reviews/${reviewId}/comments`,
    )
  ).map(toPullComment);

export const listPullComments = async (
  ref: ParsedPrReference,
): Promise<PullComment[]> =>
  (await ghApiList<GhPullComment>(`repos/${ref.repo}/pulls/${ref.number}/comments`)).map(
    toPullComment,
  );

export interface CommentReaction {
  content: string; // '+1' | '-1' | ...
  userLogin: string;
  createdAt: string;
}

export const listCommentReactions = async (
  repo: string,
  commentId: number,
): Promise<CommentReaction[]> =>
  (
    await ghApiList<{ content: string; user: { login: string } | null; created_at: string }>(
      `repos/${repo}/pulls/comments/${commentId}/reactions`,
    )
  ).map((reaction) => ({
    content: reaction.content,
    userLogin: reaction.user?.login ?? '',
    createdAt: reaction.created_at,
  }));

export interface PullRequestStatus {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  authorLogin: string;
}

export const getPullRequestStatus = async (
  ref: ParsedPrReference,
): Promise<PullRequestStatus> => {
  const raw = await runGh([
    'pr',
    'view',
    String(ref.number),
    '--repo',
    ref.repo,
    '--json',
    'state,author',
  ]);
  const view = JSON.parse(raw) as { state: PullRequestStatus['state']; author: { login: string } };
  return { state: view.state, authorLogin: view.author.login };
};

let viewerLogin: string | undefined;

// 학습 재료(기각 사유)는 이 계정이 쓴 답글만 인정한다.
export const getViewerLogin = async (): Promise<string> => {
  viewerLogin ??= (await runGh(['api', 'user', '--jq', '.login'])).trim();
  return viewerLogin;
};

// 없는 파일이면 undefined. 그 밖의 실패는 던진다.
export const getFileContent = async ({
  repo,
  path,
  ref,
}: {
  repo: string;
  path: string;
  ref: string;
}): Promise<string | undefined> => {
  try {
    const raw = await runGh([
      'api',
      `repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
    ]);
    const file = JSON.parse(raw) as { content?: string; encoding?: string; type?: string };
    if (file.type !== 'file' || file.content === undefined) {
      return undefined;
    }
    return Buffer.from(file.content, 'base64').toString('utf-8');
  } catch (error: unknown) {
    if (error instanceof Error && /HTTP 404|Not Found/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
};

export interface OpenPullRequest {
  repo: string;
  number: number;
  title: string;
  isDraft: boolean;
  headSha: string;
  authorLogin: string;
}

export const listOpenPullRequests = async (
  repo: string,
  target: 'all' | 'review-requested' | 'mine',
): Promise<OpenPullRequest[]> => {
  const filter =
    target === 'review-requested'
      ? ['--search', 'review-requested:@me']
      : target === 'mine'
        ? ['--author', '@me']
        : [];
  const raw = await runGh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    ...filter,
    '--json',
    'number,title,isDraft,headRefOid,author',
    '--limit',
    '50',
  ]);
  return (
    JSON.parse(raw) as {
      number: number;
      title: string;
      isDraft: boolean;
      headRefOid: string;
      author: { login: string };
    }[]
  ).map((pr) => ({
    repo,
    number: pr.number,
    title: pr.title,
    isDraft: pr.isDraft,
    headSha: pr.headRefOid,
    authorLogin: pr.author.login,
  }));
};

export interface UserRepo {
  repo: string;
  private: boolean;
  pushedAt: string;
}

// 설정 화면의 레포 고르기용. 내가 소유·협업·조직 멤버인 레포를 최근 push 순으로.
export const listUserRepos = async (): Promise<UserRepo[]> =>
  (
    await ghApiList<{ full_name: string; private: boolean; pushed_at: string; archived: boolean }>(
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    )
  )
    .filter((repo) => !repo.archived)
    .map((repo) => ({ repo: repo.full_name, private: repo.private, pushedAt: repo.pushed_at }))
    .sort((left, right) => right.pushedAt.localeCompare(left.pushedAt));

export interface RepoTree {
  entries: { path: string; size: number }[];
  // GitHub 가 큰 레포의 트리를 자르면 true. 잘렸으면 짝 테스트 경로를 추측해 개별 조회한다.
  truncated: boolean;
}

// 기존 테스트 짝을 찾는 데 쓰는 파일 목록. 트리 조회 1회 — 본문은 받지 않는다.
export const listTree = async (repo: string, ref: string): Promise<RepoTree> => {
  const raw = await runGh(['api', `repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`]);
  const tree = JSON.parse(raw) as {
    tree: { path: string; type: string; size?: number }[];
    truncated: boolean;
  };
  return {
    entries: tree.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => ({ path: entry.path, size: entry.size ?? 0 })),
    truncated: tree.truncated,
  };
};
