import {
  createReview,
  fetchConsistentSnapshot,
  listReviewComments,
  PullRequestSnapshot,
} from './github.js';
import {
  renderLearnedConventions,
  selectLearningRows,
} from './learning.js';
import { complete, ModelProvider } from './model.js';
import { ParsedPrReference } from './pr-reference.js';
import { buildReviewPrompt, CODE_REVIEWER_SYSTEM_PROMPT } from './prompt.js';
import { findingBody, planPublication } from './publish.js';
import { loadRepoRules } from './repo-rules.js';
import { parsePullRequestReview } from './review-parser.js';
import { ReviewError } from './review.type.js';
import { FindingRecord, ReviewRecord, ReviewTrigger, Store } from './store.js';

// 단발 CLI · 상주 스윕 · 페이지의 수동 리뷰가 모두 이 경로를 지난다 — 규칙(A)·학습 규약(B)이 어느 진입점에서도
// 같은 방식으로 실린다.

export interface RunReviewInput {
  store: Store;
  ref: ParsedPrReference;
  trigger: ReviewTrigger;
  provider: ModelProvider;
  modelName?: string;
  timeoutMs: number;
  instruction?: string;
  // 지정하면 리뷰 직후 게시한다.
  publish?: { inlineMax: number };
  // 스윕이 목록에서 본 head. 조회 전에 실패해도 이 커밋의 실패로 세어 같은 커밋을 무한히 다시 잡지 않게 한다.
  headShaHint?: string;
  onProgress?: (message: string) => void;
}

export interface RunReviewOutput {
  record: ReviewRecord;
  snapshot: PullRequestSnapshot;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const runReview = async ({
  store,
  ref,
  trigger,
  provider,
  modelName,
  timeoutMs,
  instruction,
  publish,
  headShaHint,
  onProgress,
}: RunReviewInput): Promise<RunReviewOutput> => {
  const progress = onProgress ?? ((): void => {});
  const record = store.addReview({
    repo: ref.repo,
    number: ref.number,
    title: '',
    headSha: headShaHint ?? '',
    trigger,
  });
  store.save();

  try {
    progress(`${ref.repo}#${ref.number} 조회 중…`);
    const snapshot = await fetchConsistentSnapshot(ref);
    const { detail, diff } = snapshot;
    record.title = detail.title;
    record.headSha = detail.headSha;
    record.truncated = diff.truncated;

    const repoConfig = store.repoConfig(ref.repo);
    const rules = await loadRepoRules({
      config: repoConfig,
      baseRef: detail.baseRef,
      warn: (message) => store.log('warn', message),
    });
    const learned = repoConfig.learning
      ? renderLearnedConventions(selectLearningRows(store.state.findings, ref.repo))
      : { block: '', categories: [] };
    record.rulesUsed = rules.used;
    record.learnedCategories = learned.categories;

    progress(
      `${provider} 로 리뷰 중… (규칙 ${rules.used.length > 0 ? rules.used.join(', ') : '없음'} · 학습 규약 ${learned.categories.length > 0 ? learned.categories.join(', ') : '없음'})`,
    );
    // 규약은 diff 뒤에 붙인다 — "지적하지 말라" 류는 diff 를 다 읽은 뒤 마지막에 있어야 덜 묻힌다.
    const completion = await complete({
      prompt: buildReviewPrompt({ detail, diff, instruction }) + rules.block + learned.block,
      systemPrompt: CODE_REVIEWER_SYSTEM_PROMPT,
      options: { provider, model: modelName || undefined, timeoutMs },
    });
    record.review = parsePullRequestReview(completion.text, (message) =>
      store.log('warn', `${ref.repo}#${ref.number} 판정 보정: ${message}`),
    );
    record.modelUsed = completion.modelUsed;
    record.status = 'done';
    record.finishedAt = new Date().toISOString();
    store.addFindings(record, record.review.findings);
    store.log(
      'info',
      `${ref.repo}#${ref.number} 리뷰 완료 — 지적 ${record.review.findings.length}건 (${completion.modelUsed})`,
    );
    store.save();

    if (publish !== undefined) {
      await publishReview({ store, record, snapshot, inlineMax: publish.inlineMax, onProgress });
    }
    return { record, snapshot };
  } catch (error: unknown) {
    if (record.status === 'running') {
      record.status = 'failed';
      record.error = errorMessage(error);
      record.finishedAt = new Date().toISOString();
      store.log('error', `${ref.repo}#${ref.number} 리뷰 실패: ${errorMessage(error).split('\n')[0]}`);
      store.save();
    }
    throw error;
  }
};

// 리뷰 하나를 PR 에 게시하고, 인라인 코멘트 id 를 지적 카드에 잇는다 (이후 👍/👎 수확의 열쇠).
// snapshot 이 없으면(페이지에서 나중에 게시) 다시 조회하고, 리뷰 뒤 push 가 있었으면 거절한다 —
// 옛 커밋 기준 좌표는 새 diff 에서 엉뚱한 줄을 가리킨다.
export const publishReview = async ({
  store,
  record,
  snapshot,
  inlineMax,
  onProgress,
}: {
  store: Store;
  record: ReviewRecord;
  snapshot?: PullRequestSnapshot;
  inlineMax: number;
  onProgress?: (message: string) => void;
}): Promise<void> => {
  const progress = onProgress ?? ((): void => {});
  if (record.review === undefined) {
    throw new ReviewError('완료되지 않은 리뷰는 게시할 수 없습니다.');
  }
  if (record.published !== undefined) {
    throw new ReviewError(`이미 게시했습니다: ${record.published.url}`);
  }
  const ref = { repo: record.repo, number: record.number };
  const current = snapshot ?? (await fetchConsistentSnapshot(ref));
  if (current.detail.headSha !== record.headSha) {
    throw new ReviewError(
      `리뷰 뒤 새 커밋이 올라왔습니다 (${record.headSha.slice(0, 7)} → ${current.detail.headSha.slice(0, 7)}). 다시 리뷰한 뒤 게시하세요.`,
    );
  }

  const findings = store.findingsOf(record.id);
  const review = { ...record.review, findings };
  let plan = planPublication({ detail: current.detail, diff: current.diff, review, inlineMax });
  progress(`게시 중… 인라인 ${plan.inlineCount}건 · 본문 목록 ${plan.bodyCount}건`);
  let created;
  try {
    created = await createReview(ref, plan.payload);
  } catch (error: unknown) {
    if (plan.inlineCount === 0) {
      throw error;
    }
    // 인라인 좌표 하나라도 거부되면 리뷰 전체가 실패한다(422). 전부 본문 목록으로 다시 게시한다.
    store.log('warn', `${ref.repo}#${ref.number} 인라인 게시 실패, 본문 목록으로 재시도: ${errorMessage(error).split('\n')[0]}`);
    plan = planPublication({ detail: current.detail, diff: current.diff, review, inlineMax, inline: false });
    created = await createReview(ref, plan.payload);
  }
  record.published = { at: new Date().toISOString(), url: created.url, reviewId: created.reviewId };

  if (plan.inlineCount > 0) {
    try {
      const comments = await listReviewComments(ref, created.reviewId);
      for (const finding of plan.inlineFindings as FindingRecord[]) {
        const body = findingBody(finding);
        const comment = comments.find((candidate) => candidate.body === body);
        if (comment !== undefined) {
          finding.commentId = comment.id;
          finding.commentUrl = comment.url;
          finding.status = 'OPEN';
        }
      }
    } catch (error: unknown) {
      // 게시는 됐다. 코멘트 id 를 못 이으면 그 지적만 수확에서 빠진다.
      store.log('warn', `${ref.repo}#${ref.number} 코멘트 id 조회 실패 — 이번 지적은 학습에서 빠집니다: ${errorMessage(error).split('\n')[0]}`);
    }
  }
  store.log('info', `${ref.repo}#${ref.number} 게시 완료 — ${created.url}`);
  store.save();
};
