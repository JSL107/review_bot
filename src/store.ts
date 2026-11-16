import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ModelProvider } from './model.js';
import { PullRequestReview, ReviewFinding } from './review.type.js';

// 이대리의 Postgres(agent_run · pr_review_finding) 자리. 한 프로세스(pnpm dev)와 단발 CLI 가 같이
// 쓰는 개인용이라 JSON 파일 하나로 둔다.
// shortcut: 서버와 CLI 가 동시에 쓰면 나중 쓰기가 이긴다. 동시 실행이 잦아지면 SQLite 로 옮긴다.

export type PrTarget = 'all' | 'review-requested' | 'mine';

export interface RepoConfig {
  repo: string; // owner/name
  // 상주 모드가 이 레포의 PR 을 찾아 리뷰할지.
  autoReview: boolean;
  // 리뷰 결과를 PR 에 게시할지. 끄면 대시보드에만 쌓이고 페이지에서 골라 게시한다.
  publish: boolean;
  target: PrTarget;
  skipDrafts: boolean;
  // 기각에서 배운 규약을 이 레포 리뷰에 실을지.
  learning: boolean;
  // base 브랜치에서 읽어 싣는 규칙 문서.
  rulesFiles: string[];
  // 손으로 적는 레포 규약 (이대리 SELF_REPO_CONVENTIONS 자리).
  extraRules: string;
}

export interface AppConfig {
  provider: ModelProvider;
  // 비우면 provider 기본값.
  modelName: string;
  sweepIntervalMin: number;
  harvestIntervalMin: number;
  inlineMax: number;
  timeoutSec: number;
  paused: boolean;
  repos: RepoConfig[];
}

export type ReviewTrigger = 'sweep' | 'manual' | 'cli';

export interface ReviewRecord {
  id: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  trigger: ReviewTrigger;
  modelUsed?: string;
  status: 'running' | 'done' | 'failed';
  error?: string;
  createdAt: string;
  finishedAt?: string;
  review?: PullRequestReview;
  truncated?: boolean;
  // 이번 리뷰에 실린 규칙 문서와 학습 규약 카테고리 — 무엇이 리뷰를 바꿨는지 대시보드에서 본다.
  rulesUsed?: string[];
  learnedCategories?: string[];
  published?: { at: string; url: string; reviewId: number };
}

export type FindingStatus =
  | 'NOT_POSTED' // 게시 안 함·상한 밖·본문 목록(스레드가 없어 판정 불가)
  | 'OPEN' // 인라인 게시, 반응 없음
  | 'ACCEPTED' // 👍
  | 'REJECTED' // 👎 또는 페이지에서 기각
  | 'NEEDS_JUDGE' // 답글만 있음 — 페이지에서 사람이 판정
  | 'STALE'; // 반응 없이 PR 이 닫힘

export interface FindingRecord extends ReviewFinding {
  id: string;
  reviewId: string;
  repo: string;
  number: number;
  commentId?: number;
  commentUrl?: string;
  status: FindingStatus;
  // 학습 재료. owner(나) 가 쓴 답글만 담는다 — PR 작성자 답글이 규약으로 굳지 않게.
  rejectReason?: string;
  // 판정용 스레드 전체 답글(작성자 포함). 학습에는 쓰지 않는다.
  replyBody?: string;
  decidedAt?: string;
  // 학습에서 뺀 카드 (이대리 review:unlearn).
  excluded: boolean;
}

export interface ActivityEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface AppState {
  version: 1;
  config: AppConfig;
  reviews: ReviewRecord[];
  findings: FindingRecord[];
  activity: ActivityEntry[];
}

export const DEFAULT_RULES_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CODE_RULES.md',
  '.github/copilot-instructions.md',
  'REVIEW.md',
];

export const defaultRepoConfig = (repo: string): RepoConfig => ({
  repo,
  autoReview: true,
  publish: false,
  target: 'all',
  skipDrafts: true,
  learning: true,
  rulesFiles: [...DEFAULT_RULES_FILES],
  extraRules: '',
});

export const defaultConfig = (): AppConfig => ({
  provider: 'codex',
  modelName: '',
  sweepIntervalMin: 10,
  harvestIntervalMin: 30,
  inlineMax: 4,
  timeoutSec: 600,
  paused: false,
  repos: [],
});

const MAX_REVIEWS = 500;
const MAX_ACTIVITY = 300;

export const stateFilePath = (): string =>
  join(process.env.REVIEW_BOT_HOME ?? join(homedir(), '.review_bot'), 'state.json');

const emptyState = (): AppState => ({
  version: 1,
  config: defaultConfig(),
  reviews: [],
  findings: [],
  activity: [],
});

export class Store {
  state: AppState;

  // 이 프로세스가 설정을 바꿨는가. 아니면 저장 때 디스크의 설정(다른 프로세스가 바꿨을 수 있다)을 따른다.
  private configDirty = false;

  constructor(private readonly path = stateFilePath()) {
    this.state = this.load();
  }

  setConfig(config: AppConfig): void {
    this.state.config = config;
    this.configDirty = true;
  }

  private load(): AppState {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf-8');
    } catch {
      return emptyState();
    }
    // 깨진 파일을 빈 상태로 덮어쓰면 학습 재료를 잃는다 — 던져서 사람이 보게 한다.
    const parsed = JSON.parse(raw) as AppState;
    return {
      ...emptyState(),
      ...parsed,
      config: {
        ...defaultConfig(),
        ...parsed.config,
        repos: (parsed.config?.repos ?? []).map((repo) => ({
          ...defaultRepoConfig(repo.repo),
          ...repo,
        })),
      },
    };
  }

  // pnpm dev 서버와 단발 CLI 가 같은 파일을 쓴다. 저장 직전에 디스크 내용과 id 기준으로 합쳐
  // 서로의 리뷰를 지우지 않게 한다. 같은 id 는 이 프로세스의 것이 이긴다.
  private mergeWithDisk(): void {
    const disk = this.load();
    const byId = <T extends { id: string }>(mine: T[], theirs: T[]): T[] => {
      const known = new Set(mine.map((item) => item.id));
      return [...mine, ...theirs.filter((item) => !known.has(item.id))];
    };
    this.state.reviews = byId(this.state.reviews, disk.reviews).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    this.state.findings = byId(this.state.findings, disk.findings);
    const seen = new Set(this.state.activity.map((entry) => `${entry.at}|${entry.message}`));
    this.state.activity = [
      ...this.state.activity,
      ...disk.activity.filter((entry) => !seen.has(`${entry.at}|${entry.message}`)),
    ].sort((left, right) => left.at.localeCompare(right.at));
    if (!this.configDirty) {
      this.state.config = disk.config;
    }
    this.configDirty = false;
  }

  // 임시 파일에 쓰고 rename — 쓰는 중에 죽어도 기존 파일이 반쯤 잘리지 않는다.
  save(): void {
    this.mergeWithDisk();
    this.state.reviews = this.state.reviews.slice(-MAX_REVIEWS);
    const keptReviewIds = new Set(this.state.reviews.map((review) => review.id));
    this.state.findings = this.state.findings.filter((finding) =>
      keptReviewIds.has(finding.reviewId),
    );
    this.state.activity = this.state.activity.slice(-MAX_ACTIVITY);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf-8');
    renameSync(temp, this.path);
  }

  repoConfig(repo: string): RepoConfig {
    return (
      this.state.config.repos.find(
        (candidate) => candidate.repo.toLowerCase() === repo.toLowerCase(),
      ) ?? defaultRepoConfig(repo)
    );
  }

  log(level: ActivityEntry['level'], message: string): void {
    this.state.activity.push({ at: new Date().toISOString(), level, message });
    const line = `[${level}] ${message}`;
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  addReview(
    input: Omit<ReviewRecord, 'id' | 'createdAt' | 'status'>,
  ): ReviewRecord {
    const record: ReviewRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'running',
    };
    this.state.reviews.push(record);
    return record;
  }

  addFindings(review: ReviewRecord, findings: ReviewFinding[]): FindingRecord[] {
    const records = findings.map((finding) => ({
      ...finding,
      id: randomUUID(),
      reviewId: review.id,
      repo: review.repo,
      number: review.number,
      status: 'NOT_POSTED' as const,
      excluded: false,
    }));
    this.state.findings.push(...records);
    return records;
  }

  reviewById(id: string): ReviewRecord | undefined {
    return this.state.reviews.find((review) => review.id === id);
  }

  findingsOf(reviewId: string): FindingRecord[] {
    return this.state.findings.filter((finding) => finding.reviewId === reviewId);
  }
}
