import { ReviewError } from './review.type.js';

// 이대리 src/agent/code-reviewer/domain/pr-reference.parser.ts 에서 옮겼다.
const URL_PATTERN =
  /https?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)(?=$|[^A-Za-z0-9])/;
const SHORTHAND_PATTERN =
  /(?<![A-Za-z0-9._/-])([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)(?![A-Za-z0-9_-])/;

export interface ParsedPrReference {
  repo: string; // "owner/repo"
  number: number;
}

// 지원 형식: https://github.com/owner/repo/pull/123 · owner/repo#123
export const parsePrReference = (raw: string): ParsedPrReference => {
  const normalized = raw.trim();
  const urlMatch = normalized.match(URL_PATTERN);
  const shortMatch = normalized.match(SHORTHAND_PATTERN);

  if (
    urlMatch &&
    (!shortMatch || (urlMatch.index ?? 0) <= (shortMatch.index ?? 0))
  ) {
    return { repo: urlMatch[1], number: Number.parseInt(urlMatch[2], 10) };
  }
  if (shortMatch) {
    return { repo: shortMatch[1], number: Number.parseInt(shortMatch[2], 10) };
  }
  throw new ReviewError(
    `PR 참조 형식이 잘못되었습니다: "${raw}". 예: https://github.com/owner/repo/pull/123 또는 owner/repo#123`,
  );
};
