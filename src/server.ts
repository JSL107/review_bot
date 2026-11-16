import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { Daemon } from './daemon.js';
import { CheckResult, runDoctor } from './doctor.js';
import { fetchConsistentSnapshot, getViewerLogin, listUserRepos, UserRepo } from './github.js';
import {
  renderLearnedConventions,
  selectLearningRows,
} from './learning.js';
import { parsePrReference } from './pr-reference.js';
import { planPublication } from './publish.js';
import {
  AppConfig,
  defaultRepoConfig,
  RepoConfig,
  stateFilePath,
  Store,
} from './store.js';

// pnpm dev 진입점. 설정·대시보드·리뷰 목록을 보여 주는 로컬 페이지와, 뒤에서 도는 스윕·수확을 한 프로세스로 띄운다.
//
// 이 서버는 내 gh 토큰으로 PR 에 코멘트를 단다. 그래서 127.0.0.1 에만 열고, 다른 사이트가 브라우저를 통해
// 호출하지 못하게 막는다: Host 검사(DNS rebinding) + 쓰기 요청의 커스텀 헤더(교차 출처에서는 preflight 로 막힘).

const PORT = Number(process.env.PORT ?? 4317);
const HOST = '127.0.0.1';
const PAGE_PATH = new URL('../web/index.html', import.meta.url);
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const RECENT_REVIEWS = 150;
const TREND_WEEKS = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DOCTOR_TTL_MS = 5 * 60 * 1000;
const REPOS_TTL_MS = 10 * 60 * 1000;

// 점검과 레포 목록은 gh·CLI 를 여러 번 부르므로 잠시 담아 둔다.
const cached = <T>(ttlMs: number, load: () => Promise<T>): ((refresh?: boolean) => Promise<T>) => {
  let value: { at: number; data: Promise<T> } | undefined;
  return (refresh = false) => {
    if (refresh || value === undefined || Date.now() - value.at > ttlMs) {
      const data = load();
      value = { at: Date.now(), data };
      data.catch(() => {
        value = undefined;
      });
    }
    return value.data;
  };
};
const doctor = cached<CheckResult[]>(DOCTOR_TTL_MS, runDoctor);
const userRepos = cached<UserRepo[]>(REPOS_TTL_MS, listUserRepos);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const store = new Store();
const daemon = new Daemon(store);

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) {
      throw new HttpError(413, '요청이 너무 큽니다.');
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'JSON 본문이 아닙니다.');
  }
};

const intIn = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} 은 ${min}~${max} 사이 정수여야 합니다.`);
  }
  return value;
};

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

// 페이지가 보낸 설정을 그대로 믿지 않고 필드마다 다시 만든다.
const parseConfig = (body: Record<string, unknown>): AppConfig => {
  if (body.provider !== 'codex' && body.provider !== 'claude') {
    throw new HttpError(400, 'provider 는 codex 또는 claude 여야 합니다.');
  }
  if (!Array.isArray(body.repos)) {
    throw new HttpError(400, 'repos 가 배열이 아닙니다.');
  }
  const seen = new Set<string>();
  const repos: RepoConfig[] = body.repos.map((raw: unknown) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const repo = typeof item.repo === 'string' ? item.repo.trim() : '';
    if (!REPO_PATTERN.test(repo)) {
      throw new HttpError(400, `레포 이름이 owner/name 형식이 아닙니다: "${repo}"`);
    }
    if (seen.has(repo.toLowerCase())) {
      throw new HttpError(400, `레포가 중복됐습니다: ${repo}`);
    }
    seen.add(repo.toLowerCase());
    const base = defaultRepoConfig(repo);
    const target = item.target === 'review-requested' || item.target === 'mine' ? item.target : 'all';
    const rulesFiles = Array.isArray(item.rulesFiles)
      ? item.rulesFiles
          .filter((path): path is string => typeof path === 'string')
          .map((path) => path.trim())
          .filter((path) => path.length > 0 && !path.includes('..') && !path.startsWith('/'))
      : base.rulesFiles;
    return {
      repo,
      autoReview: bool(item.autoReview, base.autoReview),
      publish: bool(item.publish, base.publish),
      target,
      skipDrafts: bool(item.skipDrafts, base.skipDrafts),
      learning: bool(item.learning, base.learning),
      rulesFiles,
      extraRules: typeof item.extraRules === 'string' ? item.extraRules.slice(0, 8000) : '',
    };
  });
  return {
    provider: body.provider,
    modelName: typeof body.modelName === 'string' ? body.modelName.trim() : '',
    sweepIntervalMin: intIn(body.sweepIntervalMin, '스윕 주기(분)', 1, 1440),
    harvestIntervalMin: intIn(body.harvestIntervalMin, '수확 주기(분)', 1, 1440),
    inlineMax: intIn(body.inlineMax, '게시 상한', 0, 50),
    timeoutSec: intIn(body.timeoutSec, '모델 제한 시간(초)', 30, 3600),
    paused: bool(body.paused, false),
    repos,
  };
};

const buildState = async (): Promise<unknown> => {
  const { config, reviews, findings, activity } = store.state;
  const recent = [...reviews].reverse().slice(0, RECENT_REVIEWS);
  const findingsByReview = new Map<string, typeof findings>();
  for (const finding of findings) {
    findingsByReview.set(finding.reviewId, [...(findingsByReview.get(finding.reviewId) ?? []), finding]);
  }

  const repoNames = [
    ...new Set([...config.repos.map((repo) => repo.repo), ...reviews.map((review) => review.repo)]),
  ];
  const stats = repoNames.map((repo) => {
    const mine = findings.filter((finding) => finding.repo.toLowerCase() === repo.toLowerCase());
    const count = (status: string): number => mine.filter((finding) => finding.status === status).length;
    const accepted = count('ACCEPTED');
    const rejected = count('REJECTED');
    const learned = renderLearnedConventions(selectLearningRows(findings, repo));
    return {
      repo,
      reviews: reviews.filter((review) => review.repo.toLowerCase() === repo.toLowerCase()).length,
      posted: mine.filter((finding) => finding.commentId !== undefined).length,
      open: count('OPEN'),
      accepted,
      rejected,
      needsJudge: count('NEEDS_JUDGE'),
      adoptionRate: accepted + rejected === 0 ? null : accepted / (accepted + rejected),
      learning: store.repoConfig(repo).learning,
      learnedCategories: learned.categories,
      learnedBlock: learned.block.trim(),
    };
  });

  // 최근 8주 판정 추이 (주 단위, 오래된 주 → 최근 주). 판정 시각 기준.
  const now = Date.now();
  const trend = Array.from({ length: TREND_WEEKS }, (_, index) => {
    const end = now - (TREND_WEEKS - 1 - index) * WEEK_MS;
    const start = end - WEEK_MS;
    const inWeek = findings.filter((finding) => {
      const at = Date.parse(finding.decidedAt ?? '');
      return at > start && at <= end;
    });
    return {
      weekEnd: new Date(end).toISOString(),
      accepted: inWeek.filter((finding) => finding.status === 'ACCEPTED').length,
      rejected: inWeek.filter((finding) => finding.status === 'REJECTED').length,
    };
  });
  const categoryCounts = new Map<string, { accepted: number; rejected: number }>();
  for (const finding of findings) {
    if (finding.status !== 'ACCEPTED' && finding.status !== 'REJECTED') {
      continue;
    }
    const entry = categoryCounts.get(finding.category) ?? { accepted: 0, rejected: 0 };
    if (finding.status === 'ACCEPTED') {
      entry.accepted += 1;
    } else {
      entry.rejected += 1;
    }
    categoryCounts.set(finding.category, entry);
  }
  const durations = reviews
    .filter((review) => review.status === 'done' && review.finishedAt !== undefined)
    .slice(-30)
    .map((review) => Date.parse(review.finishedAt as string) - Date.parse(review.createdAt));
  const avgReviewSec =
    durations.length === 0 ? null : Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length / 1000);

  let viewer: string | null = null;
  try {
    viewer = await getViewerLogin();
  } catch {
    viewer = null;
  }

  return {
    viewer,
    stateFile: stateFilePath(),
    config,
    status: daemon.status(),
    stats,
    trend,
    categories: [...categoryCounts.entries()]
      .map(([category, counts]) => ({ category, ...counts }))
      .sort((left, right) => right.rejected + right.accepted - (left.rejected + left.accepted)),
    avgReviewSec,
    reviews: recent.map((review) => ({ ...review, findings: findingsByReview.get(review.id) ?? [] })),
    // 학습 탭: 판정 대기와 기각 카드 전부(창 밖 포함 — 제외 토글을 위해).
    judgeQueue: findings.filter((finding) => finding.status === 'NEEDS_JUDGE'),
    rejected: findings.filter((finding) => finding.status === 'REJECTED').reverse(),
    activity: [...activity].reverse().slice(0, 100),
  };
};

const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const host = request.headers.host ?? '';
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) {
    throw new HttpError(403, '허용되지 않은 Host 입니다.');
  }
  const url = new URL(request.url ?? '/', `http://${host}`);
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(readFileSync(PAGE_PATH));
    return;
  }
  if (method === 'GET' && url.pathname === '/api/state') {
    sendJson(response, 200, await buildState());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/doctor') {
    sendJson(response, 200, await doctor(url.searchParams.has('refresh')));
    return;
  }
  if (method === 'GET' && url.pathname === '/api/repos') {
    sendJson(response, 200, await userRepos(url.searchParams.has('refresh')));
    return;
  }
  const previewMatch = /^\/api\/reviews\/([\w-]+)\/preview$/.exec(url.pathname);
  if (method === 'GET' && previewMatch) {
    // 게시 전 미리보기 — 실제 게시와 같은 계획 함수로, 지금 PR 상태 기준으로 계산한다.
    const record = store.reviewById(previewMatch[1]);
    if (record?.review === undefined) {
      throw new HttpError(404, '미리 볼 리뷰가 없습니다.');
    }
    const snapshot = await fetchConsistentSnapshot({ repo: record.repo, number: record.number });
    const plan = planPublication({
      detail: snapshot.detail,
      diff: snapshot.diff,
      review: { ...record.review, findings: store.findingsOf(record.id) },
      inlineMax: store.state.config.inlineMax,
    });
    sendJson(response, 200, {
      stale: snapshot.detail.headSha !== record.headSha,
      headSha: snapshot.detail.headSha,
      body: plan.payload.body,
      comments: plan.payload.comments.map(({ path, line, body }) => ({ path, line, body })),
      droppedCount: plan.droppedCount,
    });
    return;
  }

  if (method !== 'GET' && request.headers['x-review-bot'] !== '1') {
    throw new HttpError(403, '페이지 밖에서 온 요청은 받지 않습니다.');
  }
  const body = method === 'GET' ? {} : await readBody(request);

  if (method === 'PUT' && url.pathname === '/api/config') {
    store.setConfig(parseConfig(body));
    store.log('info', '설정을 저장했습니다.');
    store.save();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/review') {
    const ref = parsePrReference(typeof body.pr === 'string' ? body.pr : '');
    const provider = body.provider === 'claude' || body.provider === 'codex' ? body.provider : undefined;
    const queued = daemon.enqueue({
      kind: 'review',
      ref,
      trigger: 'manual',
      publish: body.publish === true,
      provider,
      modelName: typeof body.modelName === 'string' && body.modelName.trim() ? body.modelName.trim() : undefined,
      instruction: typeof body.instruction === 'string' ? body.instruction : undefined,
    });
    sendJson(response, 200, { queued });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/sweep') {
    sendJson(response, 200, { queued: daemon.enqueue({ kind: 'sweep' }) });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/harvest') {
    sendJson(response, 200, { queued: daemon.enqueue({ kind: 'harvest' }) });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/pause') {
    store.setConfig({ ...store.state.config, paused: body.paused === true });
    store.log('info', store.state.config.paused ? '자동 실행을 멈췄습니다.' : '자동 실행을 다시 켰습니다.');
    store.save();
    sendJson(response, 200, { ok: true });
    return;
  }

  const publishMatch = /^\/api\/reviews\/([\w-]+)\/publish$/.exec(url.pathname);
  if (method === 'POST' && publishMatch) {
    const record = store.reviewById(publishMatch[1]);
    if (record === undefined || record.status !== 'done') {
      throw new HttpError(404, '게시할 수 있는 리뷰가 아닙니다.');
    }
    if (record.published !== undefined) {
      throw new HttpError(409, '이미 게시한 리뷰입니다.');
    }
    sendJson(response, 200, { queued: daemon.enqueue({ kind: 'publish', reviewId: record.id }) });
    return;
  }

  const rereviewMatch = /^\/api\/reviews\/([\w-]+)\/rereview$/.exec(url.pathname);
  if (method === 'POST' && rereviewMatch) {
    const record = store.reviewById(rereviewMatch[1]);
    if (record === undefined) {
      throw new HttpError(404, '리뷰를 찾을 수 없습니다.');
    }
    sendJson(response, 200, {
      queued: daemon.enqueue({
        kind: 'review',
        ref: { repo: record.repo, number: record.number },
        trigger: 'manual',
        publish: false,
      }),
    });
    return;
  }

  const findingMatch = /^\/api\/findings\/([\w-]+)\/(judge|exclude)$/.exec(url.pathname);
  if (method === 'POST' && findingMatch) {
    const finding = store.state.findings.find((candidate) => candidate.id === findingMatch[1]);
    if (finding === undefined) {
      throw new HttpError(404, '지적을 찾을 수 없습니다.');
    }
    if (findingMatch[2] === 'exclude') {
      finding.excluded = body.excluded === true;
    } else {
      if (body.decision !== 'ACCEPTED' && body.decision !== 'REJECTED') {
        throw new HttpError(400, 'decision 은 ACCEPTED 또는 REJECTED 여야 합니다.');
      }
      finding.status = body.decision;
      finding.decidedAt = new Date().toISOString();
      // 페이지에서 적은 사유는 owner 본인이 쓴 것이라 학습 재료로 인정한다. 비우면 수확한 내 답글을 쓴다.
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (body.decision === 'REJECTED') {
        finding.rejectReason = reason.length > 0 ? reason : finding.rejectReason;
      } else {
        finding.rejectReason = undefined;
      }
    }
    store.save();
    sendJson(response, 200, { ok: true });
    return;
  }

  throw new HttpError(404, '없는 경로입니다.');
};

const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 400;
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
  });
});

// 켜자마자 브라우저를 연다. NO_OPEN=1 이나 CI 에서는 열지 않는다.
const openBrowser = (url: string): void => {
  if (process.env.NO_OPEN === '1' || process.env.CI) {
    return;
  }
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(command, args as string[], () => {
    // 열지 못해도 주소는 터미널에 찍혀 있다.
  });
};

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT} 를 이미 쓰고 있습니다. 이미 켜져 있다면 http://${HOST}:${PORT} 를 여세요. 다른 포트: PORT=4318 pnpm dev`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`review_bot 대시보드: ${url}  (상태 파일 ${stateFilePath()})`);
  console.log('끄려면 Ctrl+C');
  daemon.start();
  openBrowser(url);
  // 막히는 곳을 터미널에서도 바로 알린다. 자세한 안내는 대시보드 첫 화면에 있다.
  doctor()
    .then((results) => {
      for (const result of results.filter((item) => item.level === 'fail')) {
        console.warn(`✘ ${result.label}: ${result.detail}${result.fix ? ` → ${result.fix}` : ''}`);
      }
    })
    .catch(() => {});
});

const shutdown = (): void => {
  daemon.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
