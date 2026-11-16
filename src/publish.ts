import { parseDiffHunks, resolveCommentLine } from './diff.js';
import { CreateReviewPayload, ReviewCommentPayload } from './github.js';
import {
  FindingSeverity,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestReview,
  ReviewFinding,
} from './review.type.js';

// 이대리 src/pr-review-loop/domain/{publish-policy,finding-comment.body}.ts 를 바탕으로, 지적 카드·DB 없이
// GitHub 리뷰 하나로 게시하는 형태로 줄였다.

// 이대리 봇 마커(🤖 **이대리 자동 리뷰**)와 다르게 둔다 — 이대리 수확기·리뷰 대응 규약이 이 코멘트를
// 자기 글로 오인하지 않게.
export const REVIEW_MARKER = '🤖 **PR 리뷰 (개인 CLI)**';
export const DEFAULT_INLINE_MAX = 4;

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  MUST_FIX: 0,
  MISSING_TEST: 1,
  NICE_TO_HAVE: 2,
};

const RISK_LABEL: Record<PullRequestReview['riskLevel'], string> = {
  low: '낮음',
  medium: '중간',
  high: '높음',
  unknown: '판단 보류',
};

const APPROVAL_LABEL: Record<PullRequestReview['approvalRecommendation'], string> = {
  approve: '승인 권장',
  request_changes: '수정 요청',
  comment: '의견만',
  undetermined: '판단 보류',
};

// 심각도 우선 정렬. 같은 심각도 안에서는 모델이 낸 순서를 지킨다.
export const sortBySeverity = (findings: ReviewFinding[]): ReviewFinding[] =>
  findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (left, right) =>
        SEVERITY_ORDER[left.finding.severity] -
          SEVERITY_ORDER[right.finding.severity] || left.index - right.index,
    )
    .map((item) => item.finding);

const findingBody = (finding: ReviewFinding): string =>
  `${REVIEW_MARKER} · ${finding.category} / ${finding.severity}\n\n${finding.body.trim()}`;

const findingListItem = (finding: ReviewFinding): string => {
  const location =
    finding.file === undefined
      ? ''
      : ` \`${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}\``;
  return `- **${finding.category} / ${finding.severity}**${location} — ${finding.body.trim().replace(/\n/g, '\n  ')}`;
};

export interface PublicationPlan {
  payload: CreateReviewPayload;
  inlineCount: number;
  // 줄에 못 붙여 본문 목록으로 내린 지적.
  bodyCount: number;
  // 상한(inlineMax) 밖이라 아예 게시하지 않는 지적.
  droppedCount: number;
}

// 인라인으로 못 붙이는 지적(diff 밖 경로·줄이 너무 멂)은 리뷰 본문 목록으로 내린다.
// inline=false 면 전부 본문으로 — 인라인 좌표가 거부됐을 때의 재시도용.
export const planPublication = ({
  detail,
  diff,
  review,
  inlineMax,
  inline = true,
}: {
  detail: PullRequestDetail;
  diff: PullRequestDiff;
  review: PullRequestReview;
  inlineMax: number;
  inline?: boolean;
}): PublicationPlan => {
  const sorted = sortBySeverity(review.findings);
  const toPost = sorted.slice(0, inlineMax);
  const droppedCount = sorted.length - toPost.length;
  // 좌표는 잘리기 전 원본 diff 로 계산한다 — 노이즈로 뺀 파일도 GitHub diff 에는 있다.
  const hunks = parseDiffHunks(diff.rawDiff);

  const comments: ReviewCommentPayload[] = [];
  const bodyFindings: ReviewFinding[] = [];
  for (const finding of toPost) {
    const line =
      inline && finding.file !== undefined
        ? resolveCommentLine(hunks, finding.file, finding.line)
        : null;
    if (finding.file !== undefined && line !== null) {
      comments.push({
        path: finding.file,
        line,
        side: 'RIGHT',
        body: findingBody(finding),
      });
    } else {
      bodyFindings.push(finding);
    }
  }

  const sections: string[] = [
    `${REVIEW_MARKER} · 위험도 ${RISK_LABEL[review.riskLevel]} · ${APPROVAL_LABEL[review.approvalRecommendation]}`,
  ];
  const summary = review.summary.trim();
  if (summary.length > 0) {
    sections.push(summary.split('\n').map((line) => `> ${line}`).join('\n'));
  }
  if (review.undeterminedReason !== undefined) {
    sections.push(`판단 보류 사유: ${review.undeterminedReason}`);
  }
  if (bodyFindings.length > 0) {
    sections.push(['**PR 전체 의견**', ...bodyFindings.map(findingListItem)].join('\n'));
  }
  if (sorted.length === 0 && review.undeterminedReason === undefined) {
    sections.push('이번 diff 에서 머지 전에 고쳐야 할 것을 찾지 못했습니다.');
  }
  if (droppedCount > 0) {
    sections.push(`(우선순위가 낮은 지적 ${droppedCount}건은 게시하지 않았습니다)`);
  }
  // 잘린 diff 를 봤으면 코드가 직접 적는다 — 모델에게 맡기면 대부분 밝히지 않았다.
  if (diff.truncated) {
    const reviewedBytes = Buffer.byteLength(diff.diff, 'utf-8');
    sections.push(
      `⚠️ diff ${reviewedBytes.toLocaleString('en-US')}/${diff.bytes.toLocaleString('en-US')} 바이트만 검토 — 상한을 넘은 뒷부분은 보지 못했습니다(테스트 파일을 뒤로 미뤄 자름).`,
    );
  }

  return {
    payload: {
      commit_id: detail.headSha,
      body: sections.join('\n\n'),
      // 개인 리뷰라 머지 차단(REQUEST_CHANGES)·승인은 사람이 직접 한다.
      event: 'COMMENT',
      comments,
    },
    inlineCount: comments.length,
    bodyCount: bodyFindings.length,
    droppedCount,
  };
};
