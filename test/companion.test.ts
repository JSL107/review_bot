import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapTestsToSources, selectCompanionSpecs } from '../src/companion-spec.js';
import { renderCompanionSpecs } from '../src/companion-tests.js';

describe('기존 테스트 짝 찾기', () => {
  it('같은 폴더의 X.spec / X.<주제>.spec 은 X 의 테스트이고, 더 긴 이름이 이긴다', () => {
    const map = mapTestsToSources([
      'src/user.ts',
      'src/user.service.ts',
      'src/user.service.spec.ts',
      'src/user.spec.ts',
      'src/user.edge.spec.ts',
    ]);
    assert.deepEqual(map.get('src/user.service.ts'), ['src/user.service.spec.ts']);
    assert.deepEqual(map.get('src/user.ts'), ['src/user.spec.ts', 'src/user.edge.spec.ts']);
  });

  it('바뀐 줄이 많은 쪽부터 싣고, 예산을 넘는 것은 생략 목록으로 보낸다', () => {
    const { candidates, omitted } = selectCompanionSpecs({
      changedPaths: ['src/a.ts', 'src/b.ts'],
      changedLines: new Map([['src/a.ts', 3], ['src/b.ts', 30]]),
      tree: [
        { path: 'src/a.ts', size: 10 },
        { path: 'src/a.spec.ts', size: 500 },
        { path: 'src/b.ts', size: 10 },
        { path: 'src/b.spec.ts', size: 500 },
      ],
      treeTruncated: false,
      maxFiles: 1,
    });
    assert.deepEqual(candidates.map((c) => c.path), ['src/b.spec.ts']);
    assert.deepEqual(omitted, ['src/a.spec.ts']);
  });

  it('트리가 잘렸으면 짝을 못 찾은 소스에 spec·test 경로를 추측한다', () => {
    const { candidates } = selectCompanionSpecs({
      changedPaths: ['src/c.ts'],
      changedLines: new Map(),
      tree: [{ path: 'src/c.ts', size: 10 }],
      treeTruncated: true,
    });
    assert.deepEqual(candidates.map((c) => c.path).sort(), ['src/c.spec.ts', 'src/c.test.ts']);
  });
});

describe('[기존 테스트] 블록', () => {
  it('없으면 아무것도 싣지 않는다', () => {
    assert.equal(renderCompanionSpecs(undefined), '');
  });

  it('생략·미조회·잘림을 경계 안에 적어 "없다" 로 읽히지 않게 한다', () => {
    const text = renderCompanionSpecs({
      text: '### src/a.spec.ts (전체 3 bytes)\n1: ok',
      bytes: 10,
      includedPaths: ['src/a.spec.ts'],
      omittedPaths: ['src/b.spec.ts'],
      treeTruncated: true,
      unreadPaths: ['src/c.spec.ts'],
    });
    assert.ok(text.includes('[기존 테스트]'));
    const inside = text.slice(text.indexOf('<untrusted-input>'));
    assert.ok(inside.includes('트리가 잘려'));
    assert.ok(inside.includes('src/b.spec.ts'));
    assert.ok(inside.includes('조회하지 못한 테스트 1개'));
    assert.ok(inside.includes('1: ok'));
  });
});
