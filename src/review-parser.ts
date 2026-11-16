import {
  ApprovalRecommendation,
  FindingCategory,
  FindingSeverity,
  PullRequestReview,
  PullRequestReviewCore,
  ReviewCommentDraft,
  ReviewError,
  ReviewFinding,
  RiskLevel,
} from './review.type.js';

// 이대리 src/agent/code-reviewer/domain/prompt/pr-review.parser.ts 와
// src/common/util/llm-json-extract.util.ts 에서 옮겼다.

const RISK_LEVELS: ReadonlySet<RiskLevel> = new Set([
  'low',
  'medium',
  'high',
  'unknown',
]);
const APPROVAL_RECOMMENDATIONS: ReadonlySet<ApprovalRecommendation> = new Set([
  'approve',
  'request_changes',
  'comment',
  'undetermined',
]);
const FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  'CORRECTNESS',
  'SECURITY',
  'RELIABILITY',
  'TEST',
  'ARCHITECTURE',
  'READABILITY',
  'STYLE',
  'UNCLASSIFIED',
]);
const FINDING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set([
  'MUST_FIX',
  'NICE_TO_HAVE',
  'MISSING_TEST',
]);

export const UNDETERMINED_REASON_MISSING = '사유 미기재(모델 응답에 없음)';
export const UNDETERMINED_REASON_UNKNOWN_RISK = '등급을 정하지 못함(모델 응답)';

export type VerdictCorrectionListener = (message: string) => void;

// 코드 펜스·앞뒤 설명문을 벗긴다. 후보 중 실제로 JSON object 로 파싱되는 첫 후보를 고른다 —
// 문자열 값 안의 코드펜스를 응답 펜스로 오인하지 않게.
export const extractJsonObjectText = (rawText: string): string => {
  const trimmed = rawText.trim();
  const candidates: string[] = [];
  const wholeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (wholeFenceMatch) {
    candidates.push(wholeFenceMatch[1].trim());
  }
  const innerFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (innerFenceMatch) {
    candidates.push(innerFenceMatch[1].trim());
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return candidates.find(isJsonObjectText) ?? candidates[0] ?? trimmed;
};

const isJsonObjectText = (candidate: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
};

export const parsePullRequestReview = (
  text: string,
  onCorrection?: VerdictCorrectionListener,
): PullRequestReview => {
  const parsed = joinSummarySentences(parseJson(extractJsonObjectText(text), text));
  if (!isPullRequestReviewShape(parsed)) {
    throw new ReviewError('모델 응답이 리뷰 스키마와 맞지 않습니다.');
  }

  const rawFindings = (parsed as unknown as Record<string, unknown>).findings;
  // 정제 후 요소가 있을 때만 findings 를 정본으로 쓴다 — 비었는데 legacy 3배열에 값이 있으면 그쪽에서 만든다.
  const cleanedFindings = Array.isArray(rawFindings)
    ? rawFindings
        .map(toFinding)
        .filter((finding): finding is ReviewFinding => finding !== null)
    : [];
  const findings =
    cleanedFindings.length > 0
      ? cleanedFindings
      : findingsFromLegacyArrays(parsed);

  return enforceVerdictConsistency({ ...parsed, findings }, onCorrection);
};

// 판단 보류와 등급의 짝을 코드가 강제한다. 예외로 끊으면 같은 응답의 지적까지 잃으므로 보정한다.
const enforceVerdictConsistency = (
  review: PullRequestReview,
  onCorrection?: VerdictCorrectionListener,
): PullRequestReview => {
  const { undeterminedReason, ...rest } = review;
  const hasBlockingFinding =
    rest.mustFix.length > 0 ||
    rest.findings.some(({ severity }) => severity === 'MUST_FIX');
  const claimsUndetermined =
    rest.approvalRecommendation === 'undetermined' ||
    rest.riskLevel === 'unknown';

  if (!claimsUndetermined) {
    return rest;
  }
  // 보이는 범위에서 막을 결함을 찾았다면 그것이 결론이다.
  if (hasBlockingFinding) {
    onCorrection?.(
      `판단 보류 응답(${rest.approvalRecommendation}/${rest.riskLevel})에 머지 필수 지적이 있어 request_changes/high 로 보정했다.`,
    );
    return {
      ...rest,
      approvalRecommendation: 'request_changes',
      riskLevel: 'high',
    };
  }
  if (rest.approvalRecommendation !== 'undetermined') {
    onCorrection?.(
      `riskLevel "unknown" 인데 권고가 ${rest.approvalRecommendation} 이라 판단 보류로 보정했다.`,
    );
    return {
      ...rest,
      approvalRecommendation: 'undetermined',
      riskLevel: 'unknown',
      undeterminedReason: UNDETERMINED_REASON_UNKNOWN_RISK,
    };
  }
  const reason =
    typeof undeterminedReason === 'string' ? undeterminedReason.trim() : '';
  if (reason.length === 0) {
    onCorrection?.('판단 보류 응답에 이유가 없어 사유 미기재로 채웠다.');
  }
  if (rest.riskLevel !== 'unknown') {
    onCorrection?.(
      `판단 보류 응답의 riskLevel "${rest.riskLevel}" 을 unknown 으로 보정했다.`,
    );
  }
  return {
    ...rest,
    riskLevel: 'unknown',
    undeterminedReason:
      reason.length > 0 ? reason : UNDETERMINED_REASON_MISSING,
  };
};

const parseJson = (text: string, rawText: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReviewError(
      `모델 응답을 JSON 으로 파싱하지 못했습니다: ${message} — raw=${rawText.trim().slice(0, 300)}`,
    );
  }
};

// summary 는 문장 배열로 받아 줄바꿈으로 잇는다. 옛 형태(문자열)도 통과한다.
const joinSummarySentences = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!isStringArray(record.summary)) {
    return value;
  }
  return {
    ...record,
    summary: record.summary
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0)
      .join('\n'),
  };
};

const isPullRequestReviewShape = (
  value: unknown,
): value is PullRequestReviewCore => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.summary === 'string' &&
    typeof record.riskLevel === 'string' &&
    RISK_LEVELS.has(record.riskLevel as RiskLevel) &&
    isStringArray(record.mustFix) &&
    isStringArray(record.niceToHave) &&
    isStringArray(record.missingTests) &&
    Array.isArray(record.reviewCommentDrafts) &&
    record.reviewCommentDrafts.every(isReviewCommentDraft) &&
    typeof record.approvalRecommendation === 'string' &&
    APPROVAL_RECOMMENDATIONS.has(
      record.approvalRecommendation as ApprovalRecommendation,
    ) &&
    (record.undeterminedReason === undefined ||
      typeof record.undeterminedReason === 'string')
  );
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isReviewCommentDraft = (value: unknown): value is ReviewCommentDraft => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.body === 'string' &&
    (record.file === undefined || typeof record.file === 'string') &&
    (record.line === undefined || typeof record.line === 'number')
  );
};

// 라벨이 틀렸다고 지적을 버리지 않는다 — 본문이 살아 있으면 강등만 한다.
const toFinding = (value: unknown): ReviewFinding | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.body !== 'string') {
    return null;
  }
  const body = record.body.trim();
  if (body.length === 0) {
    return null;
  }
  const finding: ReviewFinding = {
    category: FINDING_CATEGORIES.has(record.category as FindingCategory)
      ? (record.category as FindingCategory)
      : 'UNCLASSIFIED',
    severity: FINDING_SEVERITIES.has(record.severity as FindingSeverity)
      ? (record.severity as FindingSeverity)
      : 'NICE_TO_HAVE',
    body,
  };
  if (typeof record.file === 'string') {
    finding.file = record.file;
  }
  // GitHub 는 정수·양수 줄만 받는다.
  if (Number.isInteger(record.line) && (record.line as number) > 0) {
    finding.line = record.line as number;
  }
  return finding;
};

const findingsFromLegacyArrays = (
  review: PullRequestReviewCore,
): ReviewFinding[] => [
  ...review.mustFix.map((body) => legacyFinding(body, 'MUST_FIX')),
  ...review.niceToHave.map((body) => legacyFinding(body, 'NICE_TO_HAVE')),
  ...review.missingTests.map((body) => legacyFinding(body, 'MISSING_TEST')),
];

const legacyFinding = (
  body: string,
  severity: FindingSeverity,
): ReviewFinding => ({ category: 'UNCLASSIFIED', severity, body });
