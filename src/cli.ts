#!/usr/bin/env node
import { confirm, input, select } from '@inquirer/prompts';
import { parseArgs, styleText } from 'node:util';

import { formatReview } from './format.js';
import {
  createReview,
  fetchConsistentSnapshot,
  listCandidatePullRequests,
} from './github.js';
import { complete, ModelProvider } from './model.js';
import { parsePrReference } from './pr-reference.js';
import { buildReviewPrompt, CODE_REVIEWER_SYSTEM_PROMPT } from './prompt.js';
import { DEFAULT_INLINE_MAX, planPublication } from './publish.js';
import { parsePullRequestReview } from './review-parser.js';
import { ReviewError } from './review.type.js';

const HELP = `pr-review — codex / claude CLI 로 GitHub PR 을 리뷰한다

사용법
  pr-review [PR] [옵션]

  PR      https://github.com/owner/repo/pull/123 또는 owner/repo#123
          생략하면 리뷰 요청·내 PR 목록에서 고른다(터미널일 때)

옵션
  -m, --model <codex|claude>   리뷰 모델 (생략하면 선택 화면, 비대화형이면 codex)
      --model-name <이름>       세부 모델 (기본 codex=gpt-6-sol, claude=opus)
  -c, --comment                 결과를 PR 리뷰 코멘트로 게시 (게시 전 확인)
      --no-comment              터미널에만 출력
  -y, --yes                     게시 확인을 건너뛴다 (비대화형에서 게시하려면 필수)
      --inline-max <n>          게시할 지적 상한 (기본 ${DEFAULT_INLINE_MAX})
  -i, --instruction <문장>      이번 리뷰에 덧붙일 지시 (예: "보안 위주로")
      --timeout <초>            모델 호출 제한 시간 (기본 600)
      --json                    리뷰 결과를 JSON 으로 stdout 에 출력
  -h, --help
`;

const log = (message: string): void => {
  process.stderr.write(`${styleText('gray', message)}\n`);
};

const parseProvider = (raw: string): ModelProvider => {
  if (raw === 'codex' || raw === 'claude') {
    return raw;
  }
  throw new ReviewError(`--model 은 codex 또는 claude 여야 합니다: "${raw}"`);
};

const parsePositiveInt = (raw: string, name: string): number => {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ReviewError(`${name} 은 0 이상의 정수여야 합니다: "${raw}"`);
  }
  return parsed;
};

const pickPullRequest = async (): Promise<string> => {
  log('리뷰 요청·내 PR 을 불러오는 중…');
  const candidates = await listCandidatePullRequests();
  const MANUAL = '__manual__';
  const picked = await select({
    message: '리뷰할 PR',
    choices: [
      ...candidates.map((candidate) => ({
        name: `[${candidate.role}] ${candidate.repo}#${candidate.number} ${candidate.title}`,
        value: `${candidate.repo}#${candidate.number}`,
      })),
      { name: '직접 입력', value: MANUAL },
    ],
    pageSize: 15,
  });
  if (picked !== MANUAL) {
    return picked;
  }
  return await input({
    message: 'PR URL 또는 owner/repo#번호',
    validate: (value) => {
      try {
        parsePrReference(value);
        return true;
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      model: { type: 'string', short: 'm' },
      'model-name': { type: 'string' },
      comment: { type: 'boolean', short: 'c' },
      yes: { type: 'boolean', short: 'y' },
      'inline-max': { type: 'string' },
      instruction: { type: 'string', short: 'i' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    process.stdout.write(HELP);
    return;
  }

  // 선택 화면은 stdout 에 그려진다 — `--json > file` 처럼 출력을 돌리면 비대화형으로 본다.
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  const rawRef = positionals[0] ?? (interactive ? await pickPullRequest() : undefined);
  if (rawRef === undefined) {
    throw new ReviewError('PR 을 지정하세요. 예: pr-review owner/repo#123 (도움말: --help)');
  }
  const ref = parsePrReference(rawRef);

  const provider: ModelProvider =
    values.model !== undefined
      ? parseProvider(values.model)
      : interactive
        ? await select<ModelProvider>({
            message: '리뷰 모델',
            choices: [
              { name: 'codex (ChatGPT 구독)', value: 'codex' },
              { name: 'claude (Claude 구독)', value: 'claude' },
            ],
          })
        : 'codex';

  const publish: boolean =
    values.comment ??
    (interactive
      ? await select<boolean>({
          message: '결과를 어디로 낼까요',
          choices: [
            { name: '터미널에만 출력', value: false },
            { name: 'PR 리뷰 코멘트로 게시 (게시 전 한 번 더 확인)', value: true },
          ],
        })
      : false);

  const inlineMax =
    values['inline-max'] === undefined
      ? DEFAULT_INLINE_MAX
      : parsePositiveInt(values['inline-max'], '--inline-max');
  const timeoutMs =
    (values.timeout === undefined ? 600 : parsePositiveInt(values.timeout, '--timeout')) * 1000;

  log(`${ref.repo}#${ref.number} 조회 중…`);
  const { detail, diff } = await fetchConsistentSnapshot(ref);

  log(`${provider} 로 리뷰 중… (보통 1~5분)`);
  const startedAt = Date.now();
  const completion = await complete({
    prompt: buildReviewPrompt({ detail, diff, instruction: values.instruction }),
    systemPrompt: CODE_REVIEWER_SYSTEM_PROMPT,
    options: { provider, model: values['model-name'], timeoutMs },
  });
  const review = parsePullRequestReview(completion.text, (message) =>
    log(`판정 보정: ${message}`),
  );
  log(`완료 (${Math.round((Date.now() - startedAt) / 1000)}초)`);

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ pr: `${ref.repo}#${ref.number}`, headSha: detail.headSha, modelUsed: completion.modelUsed, review }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReview({ detail, review, modelUsed: completion.modelUsed, truncated: diff.truncated })}\n`);
  }

  if (!publish) {
    return;
  }

  const plan = planPublication({ detail, diff, review, inlineMax });
  const planLine = `게시 예정: 인라인 ${plan.inlineCount}건 · 본문 목록 ${plan.bodyCount}건${plan.droppedCount > 0 ? ` · 상한 밖 ${plan.droppedCount}건 제외` : ''}`;
  log(planLine);
  if (values.yes !== true) {
    if (!interactive) {
      log('비대화형 실행이라 게시하지 않았습니다. 게시하려면 --yes 를 붙이세요.');
      return;
    }
    const ok = await confirm({
      message: `${ref.repo}#${ref.number} 에 게시할까요?`,
      default: false,
    });
    if (!ok) {
      log('게시하지 않았습니다.');
      return;
    }
  }

  try {
    const url = await createReview(ref, plan.payload);
    log(`게시 완료: ${url}`);
  } catch (error: unknown) {
    if (plan.inlineCount === 0) {
      throw error;
    }
    // 인라인 좌표 하나라도 GitHub 이 거부하면 리뷰 전체가 실패한다(422). 전부 본문 목록으로 다시 게시한다.
    log(`인라인 게시 실패, 본문 목록으로 다시 게시: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    const fallback = planPublication({ detail, diff, review, inlineMax, inline: false });
    const url = await createReview(ref, fallback.payload);
    log(`게시 완료: ${url}`);
  }
};

main().catch((error: unknown) => {
  // 선택 화면에서 Ctrl+C.
  if (error instanceof Error && error.name === 'ExitPromptError') {
    process.exitCode = 130;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${styleText('red', '오류')}: ${message}\n`);
  process.exitCode = 1;
});
