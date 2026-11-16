import { ReviewFinding } from './review.type.js';

// 같은 PR 에 같은 의견을 두 번 올리지 않는다. 새 커밋마다 다시 리뷰하면 모델은 같은 지적을 또 내는데,
// 그대로 올리면 커밋 수만큼 같은 말이 쌓인다.
//
// 두 단계로 본다.
// 1) 본문이 같으면(공백·대소문자 무시) 같은 의견. 이대리 finding-fingerprint 와 같은 기준이고 줄 번호는 보지 않는다 —
//    모델이 같은 지적에 매번 다른 줄을 준다.
// 2) 모델은 같은 지적을 매번 조금 다른 문장으로 쓴다. 같은 파일·같은 종류·줄 차이 SIMILAR_LINE_GAP 이내이고
//    글자 두 개씩 묶은 조각이 SIMILAR_TEXT_MIN 이상 겹치면 같은 의견으로 본다. 단어 단위로 세면 한국어 조사
//    ("테스트가"/"테스트는")가 달라 겹침이 낮게 나온다.
// 보안 의견은 2) 에서 뺀다 — 같은 자리의 다른 보안 문제를 뭉치는 것보다 한 번 더 올리는 편이 낫다.

// 실측(2026-11-16, personal_agents#1026 을 네 번 리뷰한 결과):
// - 같은 지적의 다른 표현 5쌍: 0.28·0.34·0.45·0.73·0.80. 다른 지적 5쌍(바로 옆 줄 포함): 0.00·0.02·0.05·0.05·0.13.
// - 같은 지적인데 모델이 가리킨 줄이 142 → 128 로 14줄 흔들렸다. 5줄 기준으로는 놓쳤다.
// 문턱은 두 무리 사이(0.13 < x < 0.28)에, 줄 차이는 이대리 코멘트 위치 보정 거리(SNAP_MAX_DISTANCE 20)에 맞췄다.
// 표본이 작다 — 묶이면 안 되는 의견이 묶이거나 같은 의견이 또 올라가면 그 쌍으로 다시 잰다.
export const SIMILAR_LINE_GAP = 20;
export const SIMILAR_TEXT_MIN = 0.2;

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

const bigrams = (text: string): Map<string, number> => {
  const compact = normalize(text).replace(/[\s\p{P}\p{S}]/gu, '');
  const counts = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const pair = compact.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
};

// Sørensen–Dice 계수 (0~1). 글자 2개 조각의 겹침.
export const textSimilarity = (left: string, right: string): number => {
  const a = bigrams(left);
  const b = bigrams(right);
  const total = [...a.values(), ...b.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    return normalize(left) === normalize(right) ? 1 : 0;
  }
  let shared = 0;
  for (const [pair, count] of a) {
    shared += Math.min(count, b.get(pair) ?? 0);
  }
  return (2 * shared) / total;
};

type Opinion = Pick<ReviewFinding, 'category' | 'file' | 'line' | 'body'>;

export const isSameOpinion = (next: Opinion, previous: Opinion): boolean => {
  if ((next.file ?? '') !== (previous.file ?? '')) {
    return false;
  }
  if (normalize(next.body) === normalize(previous.body)) {
    return true;
  }
  if (next.category === 'SECURITY' || next.category !== previous.category) {
    return false;
  }
  if (next.line === undefined || previous.line === undefined || next.file === undefined) {
    return false;
  }
  return (
    Math.abs(next.line - previous.line) <= SIMILAR_LINE_GAP &&
    textSimilarity(next.body, previous.body) >= SIMILAR_TEXT_MIN
  );
};
