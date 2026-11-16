import { styleText } from 'node:util';

import { sortBySeverity } from './publish.js';
import {
  FindingSeverity,
  PullRequestDetail,
  PullRequestReview,
} from './review.type.js';

type Color = 'green' | 'yellow' | 'red' | 'gray' | 'cyan';

const RISK_STYLE: Record<PullRequestReview['riskLevel'], [Color, string]> = {
  low: ['green', '낮음'],
  medium: ['yellow', '중간'],
  high: ['red', '높음'],
  unknown: ['gray', '판단 보류'],
};

const APPROVAL_LABEL: Record<PullRequestReview['approvalRecommendation'], string> = {
  approve: '승인 권장',
  request_changes: '수정 요청',
  comment: '의견만',
  undetermined: '판단 보류',
};

const SEVERITY_STYLE: Record<FindingSeverity, [Color, string]> = {
  MUST_FIX: ['red', '머지 전 필수'],
  MISSING_TEST: ['yellow', '테스트 누락'],
  NICE_TO_HAVE: ['cyan', '권장'],
};

export const formatReview = ({
  detail,
  review,
  modelUsed,
  truncated,
}: {
  detail: PullRequestDetail;
  review: PullRequestReview;
  modelUsed: string;
  truncated: boolean;
}): string => {
  const [riskColor, riskLabel] = RISK_STYLE[review.riskLevel];
  const lines: string[] = [
    '',
    styleText('bold', `${detail.repo}#${detail.number} ${detail.title}`),
    styleText('gray', `${detail.headRef} → ${detail.baseRef} · +${detail.additions}/-${detail.deletions} · ${modelUsed}`),
    '',
    `위험도 ${styleText(['bold', riskColor], riskLabel)} · ${APPROVAL_LABEL[review.approvalRecommendation]}`,
  ];
  if (review.undeterminedReason !== undefined) {
    lines.push(styleText('gray', `판단 보류 사유: ${review.undeterminedReason}`));
  }
  if (truncated) {
    lines.push(styleText('yellow', '⚠ diff 가 상한에서 잘려 뒷부분은 검토하지 못했습니다.'));
  }
  lines.push('', ...review.summary.split('\n').map((line) => `  ${line}`), '');

  const findings = sortBySeverity(review.findings);
  if (findings.length === 0) {
    lines.push(styleText('green', '지적 사항 없음'));
    return lines.join('\n');
  }
  findings.forEach((finding, index) => {
    const [color, label] = SEVERITY_STYLE[finding.severity];
    const location =
      finding.file === undefined
        ? ''
        : styleText('gray', ` ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`);
    lines.push(
      `${index + 1}. ${styleText(['bold', color], `[${label}]`)} ${finding.category}${location}`,
      ...finding.body.split('\n').map((line) => `   ${line}`),
      '',
    );
  });
  return lines.join('\n');
};
