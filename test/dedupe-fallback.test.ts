import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isSameOpinion } from '../src/dedupe.js';
import { shouldFallback, withFallback } from '../src/fallback.js';
import { ModelCallError, ReviewError, ReviewFinding } from '../src/review.type.js';
import { Store } from '../src/store.js';

const opinion = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  category: 'TEST',
  severity: 'MISSING_TEST',
  file: 'src/app.config.spec.ts',
  line: 126,
  body: 'skin-tone 범위 밖 값(skin-tone-1, skin-tone-7)을 거부하는 케이스가 spec 에 없습니다.',
  ...overrides,
});

describe('같은 의견 판단', () => {
  it('본문이 같으면 줄이 달라도 같은 의견이다', () => {
    assert.equal(isSameOpinion(opinion({ line: 300, body: '  SKIN-TONE 범위 밖 값(skin-tone-1, skin-tone-7)을   거부하는 케이스가 spec 에 없습니다. ' }), opinion()), true);
  });
  it('같은 파일·종류·가까운 줄이면 다른 표현도 같은 의견이다 (실측 사례)', () => {
    const paraphrase = opinion({ line: 125, body: '`::skin-tone-[2-6]` 범위의 경계(1, 7, 접미사만 있는 값)를 거부하는 테스트가 없습니다.' });
    assert.equal(isSameOpinion(paraphrase, opinion()), true);
  });
  it('파일이 다르거나, 종류가 다르거나, 줄이 멀면 다른 의견이다', () => {
    const paraphrase = '`::skin-tone-[2-6]` 범위의 경계(1, 7, 접미사만 있는 값)를 거부하는 테스트가 없습니다.';
    assert.equal(isSameOpinion(opinion({ body: paraphrase, file: 'src/other.spec.ts' }), opinion()), false);
    assert.equal(isSameOpinion(opinion({ body: paraphrase, category: 'CORRECTNESS' }), opinion()), false);
    assert.equal(isSameOpinion(opinion({ body: paraphrase, line: 160 }), opinion()), false);
  });
  it('모델이 가리킨 줄이 14줄 흔들려도 같은 지적이면 묶는다 (실측 사례)', () => {
    const before = opinion({ line: 142, body: '`::skin-tone-[2-6]` 범위의 경계(1, 7, 접미사만 있는 값)를 거부하는 테스트가 없습니다.' });
    const after = opinion({ line: 128, body: '피부색 접미사 범위 밖(`::skin-tone-1`, `::skin-tone-7`)과 콜론 하나(`:skin-tone-2`) 거부가 검증되지 않는다.' });
    assert.equal(isSameOpinion(after, before), true);
  });
  it('같은 자리의 다른 지적은 묶지 않는다', () => {
    assert.equal(isSameOpinion(opinion({ body: '거부 케이스는 toThrow()만 확인합니다. 에러 메시지에 env 키가 포함되는지 검증하세요.' }), opinion()), false);
  });
  it('보안 의견은 표현이 비슷해도 본문이 다르면 다시 올린다', () => {
    const a = opinion({ category: 'SECURITY', body: '로그에 카드 번호 앞 6자리와 뒤 4자리가 함께 찍힌다.' });
    const b = opinion({ category: 'SECURITY', body: '로그에 카드 번호 앞 6자리와 뒤 4자리가 같이 남는다.' });
    assert.equal(isSameOpinion(a, b), false);
  });
});

describe('저장소의 중복 표시', () => {
  const withStore = (run: (store: Store) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'review-bot-dedupe-'));
    try {
      run(new Store(join(dir, 'state.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('같은 PR 에 올렸거나 판정된 의견과 같으면 DUPLICATE, 다른 PR 의 의견은 보지 않는다', () => {
    withStore((store) => {
      const first = store.addReview({ repo: 'o/r', number: 1, title: 't', headSha: 'a', trigger: 'sweep' });
      const [posted, rejected] = store.addFindings(first, [opinion(), opinion({ file: 'src/b.ts', body: '다른 의견' })]);
      posted.posted = true;
      rejected.status = 'REJECTED';
      first.published = { at: 'now', url: 'https://github.com/o/r/pull/1', reviewId: 1 };
      const other = store.addReview({ repo: 'o/r', number: 2, title: 't', headSha: 'x', trigger: 'sweep' });
      store.addFindings(other, [opinion({ body: '세 번째' })]).forEach((f) => { f.posted = true; });

      const second = store.addReview({ repo: 'o/r', number: 1, title: 't', headSha: 'b', trigger: 'sweep' });
      store.addFindings(second, [opinion({ line: 128 }), opinion({ file: 'src/b.ts', body: '다른 의견' }), opinion({ body: '세 번째' }), opinion({ file: 'src/new.ts', body: '새 의견' })]);
      assert.equal(store.markDuplicates(second), 2);
      assert.deepEqual(store.findingsOf(second.id).map((f) => f.status), ['DUPLICATE', 'DUPLICATE', 'NOT_POSTED', 'NOT_POSTED']);
      assert.equal(store.hasPublishedReview(second), true);
      assert.equal(store.hasPublishedReview(other), false);
    });
  });
});

describe('다른 AI 로 넘기기', () => {
  it('시간 초과는 넘기지 않고, 실패와 응답 형식 깨짐은 넘긴다', () => {
    assert.equal(shouldFallback(new ModelCallError('x', 'timeout')), false);
    assert.equal(shouldFallback(new ModelCallError('x')), true);
    assert.equal(shouldFallback(new ReviewError('모델 응답이 리뷰 스키마와 맞지 않습니다.')), true);
    assert.equal(shouldFallback(new Error('알 수 없는 오류')), false);
  });

  it('첫 AI 가 실패하면 다른 AI 로 한 번만 다시 한다', async () => {
    const tried: string[] = [];
    const switched: string[] = [];
    const outcome = await withFallback({
      primary: 'codex',
      enabled: true,
      attempt: async (provider) => {
        tried.push(provider);
        if (provider === 'codex') throw new ModelCallError('codex exit=1');
        return 'ok';
      },
      onSwitch: (next) => switched.push(next),
    });
    assert.deepEqual(tried, ['codex', 'claude']);
    assert.deepEqual(switched, ['claude']);
    assert.deepEqual(outcome, { result: 'ok', used: 'claude', fellBack: true });
  });

  it('꺼져 있거나 시간 초과면 넘기지 않고, 둘 다 실패하면 두 이유를 모두 알린다', async () => {
    const fail = async (): Promise<string> => { throw new ModelCallError('exit=1'); };
    await assert.rejects(withFallback({ primary: 'codex', enabled: false, attempt: fail }), /exit=1/);
    let calls = 0;
    await assert.rejects(
      withFallback({ primary: 'claude', enabled: true, attempt: async () => { calls += 1; throw new ModelCallError('느림', 'timeout'); } }),
      /느림/,
    );
    assert.equal(calls, 1);
    await assert.rejects(withFallback({ primary: 'codex', enabled: true, attempt: fail }), /ChatGPT 실패: exit=1\nClaude 로 다시 했지만 실패: exit=1/);
  });
});
