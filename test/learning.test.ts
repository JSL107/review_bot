import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CommentReaction, PullComment } from '../src/github.js';
import {
  applySignal,
  renderLearnedConventions,
  resolveHarvestSignal,
  selectLearningRows,
  stripSalutation,
} from '../src/learning.js';
import { REVIEW_MARKER } from '../src/publish.js';
import { extractReviewSection, renderRepoRules } from '../src/repo-rules.js';
import { FindingRecord, Store } from '../src/store.js';

const LONG = '이 레포는 마이그레이션 파일 없이 db:push 로 스키마를 맞춘다. 그래서 마이그레이션 누락은 결함이 아니다.';

const finding = (overrides: Partial<FindingRecord> = {}): FindingRecord => ({
  id: 'f',
  reviewId: 'r',
  repo: 'o/r',
  number: 1,
  category: 'CORRECTNESS',
  severity: 'NICE_TO_HAVE',
  body: 'b',
  status: 'REJECTED',
  rejectReason: LONG,
  decidedAt: new Date().toISOString(),
  excluded: false,
  ...overrides,
});

const comment = (overrides: Partial<PullComment> = {}): PullComment => ({
  id: 10,
  userLogin: 'me',
  body: `${REVIEW_MARKER} · X`,
  createdAt: '2026-11-01T00:00:00Z',
  path: 'a.ts',
  url: 'https://github.com/o/r/pull/1#discussion_r10',
  ...overrides,
});

const reply = (userLogin: string, body: string, createdAt = '2026-11-02T00:00:00Z'): PullComment =>
  comment({ id: 11, inReplyToId: 10, userLogin, body, createdAt });

const reaction = (userLogin: string, content: string, createdAt = '2026-11-03T00:00:00Z'): CommentReaction => ({
  userLogin,
  content,
  createdAt,
});

const signalOf = (replies: PullComment[], reactions: CommentReaction[], state: 'OPEN' | 'CLOSED' = 'OPEN') =>
  resolveHarvestSignal({
    comment: comment(),
    replies,
    reactions,
    ownerLogin: 'me',
    authorLogin: 'author',
    pullRequestState: state,
  });

describe('학습 규약', () => {
  it('같은 카테고리 2건부터 규약이 된다', () => {
    assert.equal(renderLearnedConventions([{ category: 'CORRECTNESS', rejectReason: LONG, decidedAt: '1' }]).block, '');
    const learned = renderLearnedConventions([
      { category: 'CORRECTNESS', rejectReason: LONG, decidedAt: '1' },
      { category: 'CORRECTNESS', rejectReason: `${LONG} 두 번째`, decidedAt: '2' },
    ]);
    assert.deepEqual(learned.categories, ['CORRECTNESS']);
    assert.ok(learned.block.includes('### CORRECTNESS (기각 2건)'));
  });
  it('보안과 짧은 사유는 학습하지 않는다', () => {
    const rows = [
      { category: 'SECURITY', rejectReason: LONG, decidedAt: '1' },
      { category: 'SECURITY', rejectReason: LONG, decidedAt: '2' },
      { category: 'STYLE', rejectReason: '@bot 감사합니다. 반영 안 함', decidedAt: '1' },
      { category: 'STYLE', rejectReason: '반영 안 함', decidedAt: '2' },
    ];
    assert.equal(renderLearnedConventions(rows).block, '');
  });
  it('인사말과 멘션만 걷어낸다', () => {
    assert.equal(stripSalutation('@gemini 검토 감사합니다. 다만 이건 의도다'), '다만 이건 의도다');
    assert.equal(stripSalutation('이미 확인했습니다. 근거는 위에'), '이미 확인했습니다. 근거는 위에');
  });
  it('레포·창·제외·상태로 재료를 고른다', () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const rows = selectLearningRows(
      [
        finding({ id: '1' }),
        finding({ id: '2', repo: 'o/other' }),
        finding({ id: '3', decidedAt: old }),
        finding({ id: '4', excluded: true }),
        finding({ id: '5', status: 'ACCEPTED' }),
        finding({ id: '6', rejectReason: undefined }),
      ],
      'O/R',
    );
    assert.equal(rows.length, 1);
  });
});

describe('수확 신호', () => {
  it('마지막 결정 리액션이 이긴다', () => {
    assert.equal(signalOf([], [reaction('me', '-1', '2026-11-03'), reaction('author', '+1', '2026-11-04')]).kind, 'ACCEPTED');
  });
  it('제3자 리액션은 무시하고, 기각 사유는 내 답글만 쓴다', () => {
    const signal = signalOf(
      [reply('author', '작성자 반박'), reply('me', LONG, '2026-11-02T01:00:00Z'), reply('stranger', '남의 말')],
      [reaction('stranger', '+1'), reaction('me', '-1')],
    );
    assert.equal(signal.kind, 'REJECTED');
    assert.equal(signal.kind === 'REJECTED' && signal.ownerReplyBody, LONG);
    assert.ok(signal.kind === 'REJECTED' && signal.replyBody?.includes('작성자 반박'));
  });
  it('마커로 시작하는 후속 코멘트는 사람 답글이 아니다', () => {
    assert.equal(signalOf([reply('me', `${REVIEW_MARKER} 추가`)], []).kind, 'NONE');
  });
  it('답글만 있으면 판정 필요, 닫힌 PR 무반응은 STALE', () => {
    assert.equal(signalOf([reply('me', LONG)], []).kind, 'NEEDS_JUDGE');
    assert.equal(signalOf([], [], 'CLOSED').kind, 'STALE');
  });
  it('페이지에서 기각한 카드는 답글이 늘어도 판정을 유지한다', () => {
    const card = finding({ status: 'REJECTED', rejectReason: 'old' });
    applySignal(card, { kind: 'NEEDS_JUDGE', replyBody: 'x', ownerReplyBody: LONG }, 'now');
    assert.equal(card.status, 'REJECTED');
    assert.equal(card.rejectReason, LONG);
  });
  it('👎 로 바뀌면 판정 시각을 찍는다', () => {
    const card = finding({ status: 'OPEN', rejectReason: undefined, decidedAt: undefined });
    assert.equal(applySignal(card, { kind: 'REJECTED', ownerReplyBody: LONG }, 'now'), true);
    assert.equal(card.decidedAt, 'now');
    assert.equal(card.rejectReason, LONG);
  });
});

describe('레포 규칙', () => {
  it('리뷰용 섹션이 있으면 그 섹션만 쓴다', () => {
    const md = '# A\n빌드 명령\n## Code Review Rules\n- 규칙 1\n### 세부\n- 규칙 2\n## 다른 절\n무관';
    assert.equal(extractReviewSection(md), '## Code Review Rules\n- 규칙 1\n### 세부\n- 규칙 2');
    assert.equal(extractReviewSection('# 없음'), null);
  });
  it('설정 규약을 앞에, 실린 출처를 돌려준다', () => {
    const rules = renderRepoRules([{ path: 'AGENTS.md', content: '규칙' }], '손 규약');
    assert.deepEqual(rules.used, ['(설정)', 'AGENTS.md']);
    assert.ok(rules.block.indexOf('손 규약') < rules.block.indexOf('### AGENTS.md'));
    assert.deepEqual(renderRepoRules([], '  ').used, []);
  });
});

describe('저장소', () => {
  it('저장 후 다시 읽고, 빠진 설정 필드는 기본값으로 채운다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-bot-test-'));
    try {
      const path = join(dir, 'state.json');
      const store = new Store(path);
      store.state.config.repos.push({ repo: 'o/r' } as never);
      const review = store.addReview({ repo: 'o/r', number: 1, title: 't', headSha: 's', trigger: 'cli' });
      store.addFindings(review, [{ category: 'STYLE', severity: 'NICE_TO_HAVE', body: 'x' }]);
      store.save();
      const reloaded = new Store(path);
      assert.equal(reloaded.state.findings.length, 1);
      assert.equal(reloaded.repoConfig('O/R').learning, true);
      assert.deepEqual(reloaded.repoConfig('O/R').rulesFiles.includes('AGENTS.md'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('두 프로세스가 같은 파일에 저장해도 서로의 리뷰를 지우지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-bot-test-'));
    try {
      const path = join(dir, 'state.json');
      const server = new Store(path);
      server.setConfig({ ...server.state.config, inlineMax: 7 });
      server.save();
      const cli = new Store(path);
      server.addReview({ repo: 'o/r', number: 1, title: 'server', headSha: 's', trigger: 'sweep' });
      server.save();
      cli.addReview({ repo: 'o/r', number: 2, title: 'cli', headSha: 's', trigger: 'cli' });
      cli.save(); // 설정을 안 바꾼 쪽은 디스크 설정을 따른다
      server.save();
      const reloaded = new Store(path);
      assert.deepEqual(reloaded.state.reviews.map((review) => review.title).sort(), ['cli', 'server']);
      assert.equal(reloaded.state.config.inlineMax, 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
