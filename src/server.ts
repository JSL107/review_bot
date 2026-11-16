import { readFileSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { Daemon } from './daemon.js';
import { getViewerLogin } from './github.js';
import {
  renderLearnedConventions,
  selectLearningRows,
} from './learning.js';
import { parsePrReference } from './pr-reference.js';
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

  if (method !== 'GET' && request.headers['x-review-bot'] !== '1') {
    throw new HttpError(403, '페이지 밖에서 온 요청은 받지 않습니다.');
  }
  const body = method === 'GET' ? {} : await readBody(request);

  if (method === 'PUT' && url.pathname === '/api/config') {
    store.state.config = parseConfig(body);
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
    store.state.config.paused = body.paused === true;
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

server.listen(PORT, HOST, () => {
  console.log(`review_bot 대시보드: http://${HOST}:${PORT}  (상태 파일 ${stateFilePath()})`);
  daemon.start();
});

const shutdown = (): void => {
  daemon.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
