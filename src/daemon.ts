import { listOpenPullRequests } from './github.js';
import { harvest } from './learning.js';
import { ModelProvider } from './model.js';
import { ParsedPrReference } from './pr-reference.js';
import { publishReview, runReview } from './review-runner.js';
import { Store } from './store.js';

// pnpm dev 상주 모드의 스케줄러. 이대리의 PR 리뷰 스윕(*/5 cron) + 수확 cron 자리.
// 작업은 한 줄로 세운다 — 상태 파일 쓰기가 겹치지 않고, 구독 CLI 를 동시에 여러 개 띄우지 않는다.

type Job =
  | {
      kind: 'review';
      ref: ParsedPrReference;
      trigger: 'sweep' | 'manual';
      publish: boolean;
      provider?: ModelProvider;
      modelName?: string;
      instruction?: string;
      headShaHint?: string;
    }
  | { kind: 'publish'; reviewId: string }
  | { kind: 'sweep' }
  | { kind: 'harvest' };

export interface DaemonStatus {
  current?: string;
  // 지금 작업의 단계 (조회 중 → 리뷰 중 → 게시 중) 와 시작 시각.
  step?: string;
  startedAt?: string;
  queue: string[];
  lastSweepAt?: string;
  nextSweepAt?: string;
  lastHarvestAt?: string;
  nextHarvestAt?: string;
}

// 같은 커밋에서 이 횟수만큼 실패하면 스윕이 더 붙잡지 않는다 (새 push 가 오면 다시 본다).
const MAX_FAILURES_PER_COMMIT = 2;
const TICK_MS = 30_000;

const describe = (job: Job): string => {
  switch (job.kind) {
    case 'review':
      return `${job.ref.repo}#${job.ref.number} 리뷰${job.publish ? '하고 바로 올리기' : ''}`;
    case 'publish':
      return '리뷰 결과 올리기';
    case 'sweep':
      return '새 PR 확인';
    case 'harvest':
      return '반응 확인';
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message.split('\n')[0] : String(error);

export class Daemon {
  private queue: Job[] = [];
  private current?: Job;
  private step?: string;
  private startedAt?: number;
  private lastSweepAt?: number;
  private lastHarvestAt?: number;
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: Store) {}

  start(): void {
    // 켜자마자 한 번 돌지 않고 첫 틱을 기다리면 "켰는데 아무 일도 없다" 로 보인다.
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  status(): DaemonStatus {
    const config = this.store.state.config;
    const iso = (ms?: number): string | undefined =>
      ms === undefined ? undefined : new Date(ms).toISOString();
    return {
      current: this.current === undefined ? undefined : describe(this.current),
      step: this.step,
      startedAt: iso(this.startedAt),
      queue: this.queue.map(describe),
      lastSweepAt: iso(this.lastSweepAt),
      nextSweepAt: config.paused
        ? undefined
        : iso((this.lastSweepAt ?? Date.now()) + config.sweepIntervalMin * 60_000),
      lastHarvestAt: iso(this.lastHarvestAt),
      nextHarvestAt: config.paused
        ? undefined
        : iso((this.lastHarvestAt ?? Date.now()) + config.harvestIntervalMin * 60_000),
    };
  }

  enqueue(job: Job): boolean {
    const key = describe(job);
    if (
      (this.current !== undefined && describe(this.current) === key) ||
      this.queue.some((queued) => describe(queued) === key)
    ) {
      return false;
    }
    this.queue.push(job);
    void this.drain();
    return true;
  }

  private tick(): void {
    const config = this.store.state.config;
    if (config.paused) {
      return;
    }
    const now = Date.now();
    if (this.lastSweepAt === undefined || now - this.lastSweepAt >= config.sweepIntervalMin * 60_000) {
      this.lastSweepAt = now;
      this.enqueue({ kind: 'sweep' });
    }
    if (this.lastHarvestAt === undefined || now - this.lastHarvestAt >= config.harvestIntervalMin * 60_000) {
      this.lastHarvestAt = now;
      this.enqueue({ kind: 'harvest' });
    }
  }

  private async drain(): Promise<void> {
    if (this.current !== undefined) {
      return;
    }
    while (this.queue.length > 0) {
      this.current = this.queue.shift();
      this.step = undefined;
      this.startedAt = Date.now();
      const job = this.current as Job;
      try {
        await this.run(job);
      } catch (error: unknown) {
        // runReview 는 스스로 기록을 남긴다. 나머지만 여기서 남긴다.
        if (job.kind !== 'review') {
          this.store.log('error', `${describe(job)}에 실패했어요: ${errorMessage(error)}`);
          this.store.save();
        }
      } finally {
        this.current = undefined;
        this.step = undefined;
        this.startedAt = undefined;
      }
    }
  }

  private async run(job: Job): Promise<void> {
    const config = this.store.state.config;
    switch (job.kind) {
      case 'review': {
        await runReview({
          store: this.store,
          ref: job.ref,
          trigger: job.trigger,
          provider: job.provider ?? config.provider,
          modelName: job.modelName ?? config.modelName,
          timeoutMs: config.timeoutSec * 1000,
          instruction: job.instruction,
          publish: job.publish ? { inlineMax: config.inlineMax } : undefined,
          headShaHint: job.headShaHint,
          onProgress: (message) => {
            this.step = message;
          },
        });
        return;
      }
      case 'publish': {
        const record = this.store.reviewById(job.reviewId);
        if (record === undefined) {
          throw new Error('리뷰를 찾을 수 없습니다.');
        }
        await publishReview({
          store: this.store,
          record,
          inlineMax: config.inlineMax,
          onProgress: (message) => {
            this.step = message;
          },
        });
        return;
      }
      case 'sweep':
        await this.sweep();
        return;
      case 'harvest': {
        this.lastHarvestAt = Date.now();
        const result = await harvest(this.store);
        this.store.log(
          'info',
          `반응 확인: 의견 ${result.checked}개를 살펴 ${result.changed}개가 바뀌었어요.${result.failed > 0 ? ` PR ${result.failed}개는 확인하지 못했어요.` : ''}`,
        );
        this.store.save();
        return;
      }
    }
  }

  // 이미 본 커밋은 건너뛴다. 새 push(다른 headSha)면 다시 리뷰한다.
  private async sweep(): Promise<void> {
    this.lastSweepAt = Date.now();
    const repos = this.store.state.config.repos.filter((repo) => repo.autoReview);
    let queued = 0;
    for (const repoConfig of repos) {
      let pulls;
      try {
        pulls = await listOpenPullRequests(repoConfig.repo, repoConfig.target);
      } catch (error: unknown) {
        this.store.log('warn', `${repoConfig.repo} 의 PR 목록을 가져오지 못했어요: ${errorMessage(error)}`);
        continue;
      }
      for (const pull of pulls) {
        if (repoConfig.skipDrafts && pull.isDraft) {
          continue;
        }
        const sameCommit = this.store.state.reviews.filter(
          (review) =>
            review.repo.toLowerCase() === pull.repo.toLowerCase() &&
            review.number === pull.number &&
            review.headSha === pull.headSha,
        );
        const settled =
          sameCommit.some((review) => review.status !== 'failed') ||
          sameCommit.length >= MAX_FAILURES_PER_COMMIT;
        if (settled) {
          continue;
        }
        if (
          this.enqueue({
            kind: 'review',
            ref: { repo: pull.repo, number: pull.number },
            trigger: 'sweep',
            publish: repoConfig.publish,
            headShaHint: pull.headSha,
          })
        ) {
          queued += 1;
        }
      }
    }
    this.store.log('info', queued > 0 ? `새 PR 확인: 저장소 ${repos.length}곳에서 리뷰할 PR ${queued}개를 찾았어요.` : `새 PR 확인: 저장소 ${repos.length}곳, 새로 리뷰할 PR 은 없어요.`);
    this.store.save();
  }
}
