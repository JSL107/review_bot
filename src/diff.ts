import { posix } from 'node:path';

// 이대리 src/github/infrastructure/octokit-github.client.ts (omitNoiseFiles·truncateDiff),
// src/common/util/secret-file.util.ts, src/pr-review-loop/domain/diff-hunk.parser.ts 에서 옮겼다.

export const DEFAULT_DIFF_MAX_BYTES = 120_000;

// 모델에 보내지 않는 비밀 파일. 리뷰 모델은 받은 내용을 근거로 인용할 수 있어 PR 코멘트로 샐 수 있다.
const SECRET_FILE_NAMES = new Set(['.env', '.npmrc', '.pypirc', '.netrc']);
const SECRET_FILE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.keystore',
  '.jks',
]);
const SECRET_FILE_PREFIXES = ['id_rsa', 'id_ed25519'];
// `.env.*` 중 값이 비어 있는 견본으로 쓰는 이름 — 리뷰에 필요한 설정 키 목록이라 남긴다.
const ENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template']);

export const isSecretFilePath = (path: string): boolean => {
  const name = posix.basename(path);
  if (SECRET_FILE_NAMES.has(name)) {
    return true;
  }
  if (name.startsWith('.env.')) {
    return !ENV_TEMPLATE_SUFFIXES.has(name.slice('.env.'.length));
  }
  if (SECRET_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  return SECRET_FILE_EXTENSIONS.has(posix.extname(name));
};

const TEST_FILE_PATH =
  /\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)(test|tests|__tests__)\//;

// 사람이 리뷰하지 않는 파일. 큰 PR 에서 상한을 이런 파일이 먹으면 정작 동작 코드가 잘린다.
const NOISE_FILE_PATH = new RegExp(
  [
    '(^|/)(pnpm-lock\\.yaml|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|bun\\.lockb?|Cargo\\.lock|poetry\\.lock|Pipfile\\.lock|uv\\.lock|composer\\.lock|Gemfile\\.lock|go\\.sum)$',
    '(^|/)__snapshots__/',
    '\\.snap$',
    '\\.min\\.(js|css)$',
    '\\.map$',
    '(^|/)dist/',
  ].join('|'),
);

interface DiffSectionPaths {
  from: string;
  to: string;
}

// `diff --git a/<옛 경로> b/<새 경로>` 헤더의 두 경로. 이름이 바뀐 섹션은 rename/copy 줄을 믿는다.
const diffSectionPaths = (section: string): DiffSectionPaths | undefined => {
  const lines = section.split('\n');
  const matched = lines[0].match(/^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/);
  if (matched === null) {
    return undefined;
  }
  const extendedPath = (kind: 'from' | 'to'): string | undefined => {
    const line = lines.find((candidate) =>
      new RegExp(`^(rename|copy) ${kind} `).test(candidate),
    );
    return line?.replace(/^\S+ \S+ /, '').replace(/^"(.*)"$/, '$1');
  };
  return {
    from: extendedPath('from') ?? matched[1],
    to: extendedPath('to') ?? matched[2],
  };
};

export interface OmittedDiffSections {
  diff: string;
  omittedPaths: string[];
  secretPaths: string[];
}

// 비밀 파일은 한쪽 경로만 걸려도, 노이즈 파일은 양쪽 경로가 다 노이즈일 때만 뺀다.
export const omitNoiseFiles = (diff: string): OmittedDiffSections => {
  const kept: string[] = [];
  const omittedPaths: string[] = [];
  const secretPaths: string[] = [];
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const paths = diffSectionPaths(section);
    if (
      paths !== undefined &&
      (isSecretFilePath(paths.from) || isSecretFilePath(paths.to))
    ) {
      secretPaths.push(paths.to);
    } else if (
      paths !== undefined &&
      NOISE_FILE_PATH.test(paths.from) &&
      NOISE_FILE_PATH.test(paths.to)
    ) {
      omittedPaths.push(paths.to);
    } else {
      kept.push(section);
    }
  }
  return { diff: kept.join(''), omittedPaths, secretPaths };
};

const moveTestFilesLast = (diff: string): string => {
  const sections = diff.split(/^(?=diff --git )/m);
  const isTest = (section: string): boolean => {
    const paths = diffSectionPaths(section);
    return paths !== undefined && TEST_FILE_PATH.test(paths.to);
  };
  return [
    ...sections.filter((section) => !isTest(section)),
    ...sections.filter(isTest),
  ].join('');
};

export interface TruncatedDiff {
  diff: string;
  truncated: boolean;
  bytes: number;
}

// UTF-8 바이트 단위로 판정·절단한다. 넘칠 때만 테스트 파일을 뒤로 보내 동작 코드를 먼저 싣는다.
// 멀티바이트 문자 중간이면 문자 경계까지 물린다.
export const truncateDiff = (diff: string, maxBytes: number): TruncatedDiff => {
  const bytes = Buffer.byteLength(diff, 'utf-8');
  if (bytes <= maxBytes) {
    return { diff, truncated: false, bytes };
  }
  const buffer = Buffer.from(moveTestFilesLast(diff), 'utf-8');
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end--;
  }
  return {
    diff: buffer.subarray(0, end).toString('utf-8'),
    truncated: true,
    bytes,
  };
};

// ── 인라인 코멘트 좌표 ──────────────────────────────────────────────

export interface LineRange {
  start: number;
  end: number;
}

export interface FileHunkRanges {
  filePath: string;
  ranges: LineRange[];
}

// 스냅 허용 거리. 이보다 멀면 엉뚱한 코드에 붙는 편보다 PR 전체 의견으로 내리는 게 낫다.
export const SNAP_MAX_DISTANCE = 20;

const NEW_FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;
const OLD_FILE_HEADER = /^--- (?:a\/)?(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const FILE_PREAMBLE =
  /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

// `--- a/…` 다음 줄이 `+++ b/…` 이고 그 앞이 파일 머리말일 때만 파일 헤더로 인정한다 —
// hunk 본문의 `-- 주석` 삭제 줄(`--- 주석`)을 파일 경계로 오인하지 않게.
const isFileHeaderPair = (lines: string[], oldIndex: number): boolean =>
  (oldIndex === 0 || FILE_PREAMBLE.test(lines[oldIndex - 1] ?? '')) &&
  OLD_FILE_HEADER.test(lines[oldIndex] ?? '') &&
  NEW_FILE_HEADER.test(lines[oldIndex + 1] ?? '');

// 파일별 신규(오른쪽) 파일 기준 줄 범위. GitHub 인라인 코멘트는 이 범위 안에만 달 수 있다.
export const parseDiffHunks = (diff: string): FileHunkRanges[] => {
  const files: FileHunkRanges[] = [];
  let current: FileHunkRanges | null = null;

  const lines = diff.split('\n');
  for (const [index, rawLine] of lines.entries()) {
    const fileMatch = isFileHeaderPair(lines, index - 1)
      ? rawLine.match(NEW_FILE_HEADER)
      : null;
    if (fileMatch) {
      const filePath = fileMatch[1].trim();
      current = filePath === '/dev/null' ? null : { filePath, ranges: [] };
      if (current) {
        files.push(current);
      }
      continue;
    }
    const hunkMatch = rawLine.match(HUNK_HEADER);
    if (hunkMatch && current) {
      const start = Number(hunkMatch[1]);
      const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      if (count > 0) {
        current.ranges.push({ start, end: start + count - 1 });
      }
    }
  }
  return files.filter((file) => file.ranges.length > 0);
};

// 범위 안이면 그대로, 밖이면 가장 가까운 경계로 당긴다. 너무 멀거나 diff 에 없는 파일이면 null.
// line 이 없으면 그 파일의 첫 변경 줄.
export const resolveCommentLine = (
  hunks: FileHunkRanges[],
  filePath: string,
  line: number | undefined,
): number | null => {
  const found = hunks.find((file) => file.filePath === filePath);
  if (!found) {
    return null;
  }
  if (line === undefined) {
    return found.ranges[0]?.start ?? null;
  }
  if (found.ranges.some((range) => line >= range.start && line <= range.end)) {
    return line;
  }
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of found.ranges.flatMap((range) => [
    range.start,
    range.end,
  ])) {
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance > SNAP_MAX_DISTANCE ? null : best;
};
