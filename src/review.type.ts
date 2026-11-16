// 이대리 src/agent/code-reviewer/domain/code-reviewer.type.ts 에서 리뷰 결과 모양만 옮겼다.

// 'unknown' 은 판단 보류(approvalRecommendation 'undetermined') 전용이다 — 파서가 둘을 짝으로 강제한다.
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export type ApprovalRecommendation =
  | 'approve'
  | 'request_changes'
  | 'comment'
  | 'undetermined';

export interface ReviewCommentDraft {
  file?: string;
  line?: number;
  body: string;
}

export type FindingCategory =
  | 'CORRECTNESS' // 정확성·회귀·데이터 유실
  | 'SECURITY'
  | 'RELIABILITY' // 동시성·트랜잭션·에러 처리·외부 API graceful
  | 'TEST' // 커버리지 누락
  | 'ARCHITECTURE' // DDD / Port-Adapter 위반, 의존 방향
  | 'READABILITY' // 네이밍·가독성·중복
  | 'STYLE' // 포맷·주석·lint 영역
  | 'UNCLASSIFIED'; // 구버전 응답 호환 / 라벨 강등

export type FindingSeverity = 'MUST_FIX' | 'NICE_TO_HAVE' | 'MISSING_TEST';

export interface ReviewFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  file?: string;
  line?: number;
  body: string;
}

export interface PullRequestReviewCore {
  summary: string;
  riskLevel: RiskLevel;
  mustFix: string[];
  niceToHave: string[];
  missingTests: string[];
  reviewCommentDrafts: ReviewCommentDraft[];
  approvalRecommendation: ApprovalRecommendation;
  // approvalRecommendation === 'undetermined' 일 때만 있다.
  undeterminedReason?: string;
}

export interface PullRequestReview extends PullRequestReviewCore {
  findings: ReviewFinding[];
}

export interface PullRequestDetail {
  repo: string;
  number: number;
  title: string;
  body: string;
  authorLogin: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: string[];
}

export interface PullRequestDiff {
  // 모델에 보내는 diff (노이즈·비밀 파일 제외, 상한에서 잘림).
  diff: string;
  truncated: boolean;
  // 정제 전 원본 바이트 수.
  bytes: number;
  omittedPaths: string[];
  secretPaths: string[];
  // 인라인 코멘트 좌표 계산용 원본 diff. 잘리지 않았다.
  rawDiff: string;
}

export class ReviewError extends Error {}
