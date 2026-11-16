import {
  assembleCompanionSpecs,
  AssembledCompanionSpecs,
  COMPANION_SPEC_FETCH_CONCURRENCY,
  COMPANION_SPEC_FETCH_TIMEOUT_MS,
  COMPANION_SPEC_MAX_BYTES,
  COMPANION_SPEC_MAX_FILES,
  COMPANION_SPEC_MAX_LISTED_PATHS,
  countChangedLines,
  selectCompanionSpecs,
} from './companion-spec.js';
import { getFileContent, listTree } from './github.js';
import { PullRequestDetail, PullRequestDiff } from './review.type.js';
import { wrapUntrustedInput } from './untrusted-input.js';

// 이대리 review-pull-request.usecase.ts 의 buildCompanionSpecs·renderCompanionSpecs 를 옮겼다.
// 조회가 실패하거나 느려도 리뷰는 멈추지 않는다 — 모은 데까지만 싣고, 못 실은 사실은 블록에 적는다.

// 실패가 거듭되면 rate limit 일 가능성이 커서, 계속 치면 같은 gh 토큰을 쓰는 다른 작업의 예산까지 태운다.
const MAX_READ_FAILURES = 3;

export interface CompanionSpecBlock extends AssembledCompanionSpecs {
  treeTruncated: boolean;
  unreadPaths: string[];
}

// 기한까지 안 끝나면 undefined. 늦게 끝난 쪽의 결과·실패는 버린다.
const withDeadline = async <T>(promise: Promise<T>, deadline: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export const loadCompanionSpecs = async ({
  detail,
  diff,
  warn,
}: {
  detail: PullRequestDetail;
  diff: PullRequestDiff;
  warn: (message: string) => void;
}): Promise<CompanionSpecBlock | undefined> => {
  const label = `${detail.repo}#${detail.number}`;
  const deadline = Date.now() + COMPANION_SPEC_FETCH_TIMEOUT_MS;
  try {
    const tree = await withDeadline(listTree(detail.repo, detail.headSha), deadline);
    if (tree === undefined) {
      warn(`${label} 기존 테스트를 싣지 못했어요 — 파일 목록 조회가 ${COMPANION_SPEC_FETCH_TIMEOUT_MS / 1000}초 안에 끝나지 않았어요.`);
      return undefined;
    }
    // PR 조회 값이 우선이다 — 잘린 diff 로 세면 뒤쪽 파일이 0 이 된다.
    const changedLines = new Map([...countChangedLines(diff.rawDiff), ...Object.entries(detail.changedLinesByFile)]);
    const { candidates, omitted } = selectCompanionSpecs({
      changedPaths: [...new Set([...detail.changedFiles, ...changedLines.keys()])],
      changedLines,
      tree: tree.entries,
      treeTruncated: tree.truncated,
    });
    if (candidates.length === 0 && omitted.length === 0) {
      return undefined;
    }

    const contents = new Map<string, string>();
    let next = 0;
    let failures = 0;
    const worker = async (): Promise<void> => {
      while (next < candidates.length && Date.now() < deadline && failures < MAX_READ_FAILURES) {
        const candidate = candidates[next];
        next += 1;
        try {
          const content = await getFileContent({ repo: detail.repo, path: candidate.path, ref: detail.headSha });
          if (content !== undefined) {
            contents.set(candidate.path, content);
          }
        } catch {
          failures += 1;
        }
      }
    };
    await withDeadline(
      Promise.all(Array.from({ length: Math.min(COMPANION_SPEC_FETCH_CONCURRENCY, candidates.length) }, worker)),
      deadline,
    );
    if (failures >= MAX_READ_FAILURES) {
      warn(`${label} 기존 테스트 조회가 ${failures}번 실패해 남은 조회를 멈췄어요.`);
    }

    const files = candidates.flatMap((candidate) => {
      const content = contents.get(candidate.path);
      return content === undefined ? [] : [{ path: candidate.path, content }];
    });
    // 크기를 모르는 후보는 잘린 트리에서 경로를 추측한 것이라, 못 읽었으면 대개 없는 파일이다.
    const unreadPaths = candidates
      .filter((candidate) => candidate.size !== undefined && !contents.has(candidate.path))
      .map((candidate) => candidate.path);
    const assembled = assembleCompanionSpecs(files);
    const block: CompanionSpecBlock = {
      ...assembled,
      omittedPaths: [...omitted, ...assembled.omittedPaths],
      treeTruncated: tree.truncated,
      unreadPaths,
    };
    if (block.includedPaths.length === 0 && block.omittedPaths.length === 0 && unreadPaths.length === 0) {
      return undefined;
    }
    return block;
  } catch (error: unknown) {
    warn(`${label} 기존 테스트를 싣지 못했어요: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return undefined;
  }
};

const listPaths = (paths: string[]): string => {
  const shown = paths.slice(0, COMPANION_SPEC_MAX_LISTED_PATHS).join(', ');
  const rest = paths.length - COMPANION_SPEC_MAX_LISTED_PATHS;
  return rest > 0 ? `${shown} 외 ${rest}개` : shown;
};

// 생략·미조회·잘림을 블록 머리에 적는다 — 모델이 블록에 없는 테스트를 "없다" 로 읽지 않게 한다.
// 경로는 PR 작성자가 정하는 값이라 안내까지 경계 안에 둔다.
export const renderCompanionSpecs = (block: CompanionSpecBlock | undefined): string => {
  if (block === undefined) {
    return '';
  }
  const notes: string[] = [];
  if (block.treeTruncated) {
    notes.push('레포 트리가 잘려 짝 일부는 경로를 추측해 확인했다 — 여기 없다고 테스트가 없는 것은 아니다');
  }
  if (block.omittedPaths.length > 0) {
    notes.push(
      `예산(${COMPANION_SPEC_MAX_BYTES} bytes · ${COMPANION_SPEC_MAX_FILES}개)을 넘어 ${block.omittedPaths.length}개 생략 — 본문을 못 봤을 뿐 테스트는 있다: ${listPaths(block.omittedPaths)}`,
    );
  }
  if (block.unreadPaths.length > 0) {
    notes.push(`조회하지 못한 테스트 ${block.unreadPaths.length}개 — 있지만 본문을 못 봤다: ${listPaths(block.unreadPaths)}`);
  }
  return [
    '',
    '',
    '[기존 테스트] — 바뀐 파일(또는 그 짝 소스)의 테스트 파일 head 본문 전체(줄 번호 포함). diff 에 바뀐 부분만 보이는 테스트도 여기서는 전체다.',
    wrapUntrustedInput(
      [...notes.map((note) => `(${note})`), block.text.length > 0 ? block.text : '(실린 본문 없음 — 위 안내 참조)'].join('\n'),
    ),
  ].join('\n');
};
