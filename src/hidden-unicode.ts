// 이대리 src/agent/code-reviewer/domain/hidden-unicode.ts · diff-added-lines.ts 에서 옮겼다.
//
// diff 의 추가된 줄에서 화면에 안 보이는 문자를 찾는다 (Trojan Source · 숨은 프롬프트 주입).
// 지우지 않고 찾기만 한다 — 리뷰 대상 코드를 바꾸면 리뷰어가 공격 자체를 못 본다.
// ZWJ·이형 선택자는 이모지 바로 뒤에 올 때만 정상으로 본다.

export type HiddenCharKind =
  | '방향 제어'
  | '폭 없는 문자'
  | '이형 선택자'
  | 'BOM'
  | '태그 문자';

export interface HiddenCharFinding {
  file: string;
  line: number;
  codePoint: string;
  kind: HiddenCharKind;
}

interface AddedLine {
  file: string;
  line: number;
  text: string;
}

const GIT_PATH_ESCAPES: Record<string, string> = {
  t: '\t',
  n: '\n',
  '"': '"',
  '\\': '\\',
};

// 비ASCII 경로는 git 이 `+++ "b/\355\225\234.ts"` 처럼 따옴표 + 8진수 이스케이프로 준다.
const parseNewHeaderPath = (line: string): string => {
  const marker = '+++ b/';
  if (line.startsWith(marker)) {
    return line.slice(marker.length).trim();
  }
  const quoted = '+++ "b/';
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith(quoted) || !trimmed.endsWith('"')) {
    return line.slice(4).trim();
  }
  const bytes = trimmed
    .slice(quoted.length, -1)
    .replace(/\\([0-7]{3}|.)/g, (_, code: string) =>
      code.length === 3
        ? String.fromCharCode(parseInt(code, 8))
        : (GIT_PATH_ESCAPES[code] ?? code),
    );
  return Buffer.from(bytes, 'latin1').toString('utf-8');
};

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// hunk 헤더가 알려 준 줄 수만큼을 본문으로 센다 — 본문 안의 `+++ ` 를 헤더로 오인하지 않게.
const listAddedLines = (diff: string): AddedLine[] => {
  const added: AddedLine[] = [];
  let file = '(알 수 없는 파일)';
  let nextLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const raw of diff.split('\n')) {
    if (oldRemaining <= 0 && newRemaining <= 0) {
      if (raw.startsWith('+++ ')) {
        file = parseNewHeaderPath(raw);
        continue;
      }
      const hunk = HUNK_HEADER.exec(raw);
      if (hunk) {
        oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
        nextLine = Number(hunk[2]);
        newRemaining = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
      continue;
    }
    if (raw.startsWith('\\')) {
      continue;
    }
    if (raw.startsWith('+')) {
      added.push({ file, line: nextLine, text: raw.slice(1) });
      nextLine += 1;
      newRemaining -= 1;
      continue;
    }
    if (raw.startsWith('-')) {
      oldRemaining -= 1;
      continue;
    }
    nextLine += 1;
    oldRemaining -= 1;
    newRemaining -= 1;
  }
  return added;
};

const ZWJ = 0x200d;
const KEYCAP = 0x20e3;
const isVariationSelector = (codePoint: number): boolean =>
  codePoint >= 0xfe00 && codePoint <= 0xfe0f;
const isSkinTone = (codePoint: number): boolean =>
  codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
const EMOJI_BASE = /\p{Extended_Pictographic}/u;

const classify = (codePoint: number): HiddenCharKind | null => {
  if (
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  ) {
    return '방향 제어';
  }
  if (
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === ZWJ ||
    codePoint === 0x2060
  ) {
    return '폭 없는 문자';
  }
  if (isVariationSelector(codePoint)) {
    return '이형 선택자';
  }
  if (codePoint === 0xfeff) {
    return 'BOM';
  }
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) {
    return '태그 문자';
  }
  return null;
};

const isPartOfEmoji = (chars: string[], index: number): boolean => {
  if (chars[index + 1]?.codePointAt(0) === KEYCAP) {
    return true;
  }
  let previous = index - 1;
  while (previous >= 0) {
    const codePoint = chars[previous].codePointAt(0) ?? 0;
    if (!isVariationSelector(codePoint) && !isSkinTone(codePoint)) {
      break;
    }
    previous -= 1;
  }
  return previous >= 0 && EMOJI_BASE.test(chars[previous]);
};

export const findHiddenUnicode = (diff: string): HiddenCharFinding[] => {
  const findings: HiddenCharFinding[] = [];
  for (const { file, line, text } of listAddedLines(diff)) {
    const chars = Array.from(text);
    chars.forEach((char, index) => {
      const codePoint = char.codePointAt(0) ?? 0;
      const kind = classify(codePoint);
      const isEmojiPart =
        (codePoint === ZWJ || isVariationSelector(codePoint)) &&
        isPartOfEmoji(chars, index);
      if (kind && !isEmojiPart) {
        findings.push({
          file,
          line,
          codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
          kind,
        });
      }
    });
  }
  return findings;
};

const MAX_LISTED = 10;

export const formatHiddenUnicodeWarning = (count: number): string =>
  `(주의: 추가된 줄에 화면에 안 보이는 문자 ${count}개 — 보이는 코드와 실제 코드가 다를 수 있다. 의도된 것인지 확인하고, 아니면 지적할 것)`;

// 경로는 PR 작성자가 정한 값이라 호출부가 목록만 신뢰 경계로 감싼다.
export const formatHiddenUnicodeList = (
  findings: HiddenCharFinding[],
): string => {
  const listed = findings
    .slice(0, MAX_LISTED)
    .map(
      (finding) =>
        `- ${finding.file}:${finding.line} ${finding.codePoint} (${finding.kind})`,
    );
  const rest =
    findings.length > MAX_LISTED
      ? [`- 외 ${findings.length - MAX_LISTED}건`]
      : [];
  return [...listed, ...rest].join('\n');
};
