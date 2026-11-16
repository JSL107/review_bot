import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { buildCodexPermissionArgs } from './model.js';
import { stateFilePath } from './store.js';

// 처음 쓰는 사람이 어디서 막혔는지 바로 알게 하는 환경 점검. 대시보드 첫 화면과 `pnpm check` 가 같이 쓴다.

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  // 막혔을 때 실행할 명령이나 할 일.
  fix?: string;
}

const MIN_NODE_MAJOR = 22;
const CHECK_TIMEOUT_MS = 15_000;

const run = async (command: string, args: string[]): Promise<{ ok: boolean; out: string }> => {
  try {
    const { stdout, stderr } = await promisify(execFile)(command, args, { timeout: CHECK_TIMEOUT_MS });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (error: unknown) {
    const failed = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (failed.code === 'ENOENT') {
      return { ok: false, out: 'ENOENT' };
    }
    return { ok: false, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim() || (failed.message ?? '') };
  }
};

// codex 는 사용자 config 를 끄고 띄우므로(MCP 서버 기동 방지) 모델을 따로 넘겨야 한다. 각자 config 의 모델을 쓴다.
export const readCodexConfigModel = (): string | undefined => {
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), '.codex');
  try {
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf-8');
    // 첫 테이블([...]) 앞의 최상위 키만 본다 — 프로필 안의 model 을 집지 않게.
    const topLevel = toml.split(/^\s*\[/m)[0];
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(topLevel)?.[1];
  } catch {
    return undefined;
  }
};

const checkNode = (): CheckResult => {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { id: 'node', label: '실행 도구', level: 'ok', detail: `Node.js ${process.versions.node}` }
    : {
        id: 'node',
        label: '실행 도구',
        level: 'fail',
        detail: `Node.js ${process.versions.node} 은 오래된 버전이에요. ${MIN_NODE_MAJOR} 이상이 필요해요.`,
        fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요. 직접 하려면 https://nodejs.org 에서 설치하세요.',
      };
};

const checkGh = async (): Promise<CheckResult[]> => {
  const version = await run('gh', ['--version']);
  if (!version.ok) {
    return [
      {
        id: 'gh',
        label: 'GitHub 연결 도구',
        level: 'fail',
        detail: '아직 설치되지 않았어요.',
        fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요. 직접 하려면 https://cli.github.com 에서 설치한 뒤 `gh auth login`.',
      },
    ];
  }
  const user = await run('gh', ['api', 'user', '--jq', '.login']);
  return [
    { id: 'gh', label: 'GitHub 연결 도구', level: 'ok', detail: '설치되어 있어요.' },
    user.ok
      ? { id: 'gh-auth', label: 'GitHub 로그인', level: 'ok', detail: `${user.out} 계정으로 리뷰를 올려요.` }
      : {
          id: 'gh-auth',
          label: 'GitHub 로그인',
          level: 'fail',
          detail: '로그인되어 있지 않아요.',
          fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요. 직접 하려면 `gh auth login`.',
        },
  ];
};

const checkCodex = async (): Promise<CheckResult> => {
  const status = await run('codex', ['login', 'status']);
  if (status.out === 'ENOENT') {
    return {
      id: 'codex',
      label: 'ChatGPT 연결',
      level: 'warn',
      detail: '연결되어 있지 않아요. Claude 를 쓴다면 괜찮아요.',
      fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요.',
    };
  }
  if (!status.ok) {
    return {
      id: 'codex',
      label: 'ChatGPT 연결',
      level: 'warn',
      detail: '로그인되어 있지 않아요. Claude 를 쓴다면 괜찮아요.',
      fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요. 직접 하려면 `codex login`.',
    };
  }
  const model = readCodexConfigModel();
  return {
    id: 'codex',
    label: 'ChatGPT 연결',
    level: 'ok',
    detail: `연결되어 있어요.${model ? ` (기본 모델: ${model})` : ''}`,
  };
};

const checkClaude = async (): Promise<CheckResult> => {
  const status = await run('claude', ['auth', 'status']);
  if (status.out === 'ENOENT') {
    return {
      id: 'claude',
      label: 'Claude 연결',
      level: 'warn',
      detail: '연결되어 있지 않아요. ChatGPT 를 쓴다면 괜찮아요.',
      fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요.',
    };
  }
  let loggedIn = status.ok;
  try {
    loggedIn = (JSON.parse(status.out) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    // 구버전은 JSON 이 아니다 — 종료 코드만 믿는다.
  }
  return loggedIn
    ? { id: 'claude', label: 'Claude 연결', level: 'ok', detail: '연결되어 있어요.' }
    : {
        id: 'claude',
        label: 'Claude 연결',
        level: 'warn',
        detail: '로그인되어 있지 않아요. ChatGPT 를 쓴다면 괜찮아요.',
        fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요. 직접 하려면 `claude auth login`.',
      };
};

// codex 읽기 잠금이 실제로 먹는지 확인한다. codex 버전에 따라 권한 설정이 조용히 무시되면, 프롬프트 주입된
// PR 이 내 파일을 읽혀 리뷰 코멘트로 내보낼 수 있다. 모델은 부르지 않는다(`codex sandbox` 로 cat 만 돌린다).
// 대조군(작업 폴더 파일은 읽혀야 함)이 없으면 샌드박스가 아예 안 뜬 경우를 "잘 막았다" 로 오판한다.
const checkCodexReadLock = async (): Promise<CheckResult> => {
  const label = 'ChatGPT 파일 보호';
  const workDir = await mkdtemp(join(tmpdir(), 'pr-review-check-'));
  const canaryRoot = dirname(stateFilePath());
  await mkdir(canaryRoot, { recursive: true });
  const canaryDir = await mkdtemp(join(canaryRoot, 'canary-'));
  const env = { ...process.env, HOME: workDir, CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex') };
  const catInSandbox = async (path: string): Promise<boolean> => {
    try {
      await promisify(execFile)('codex', ['sandbox', ...buildCodexPermissionArgs(workDir), '--', 'cat', path], {
        env,
        timeout: CHECK_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  };
  try {
    await writeFile(join(workDir, 'allowed.txt'), 'ok', 'utf-8');
    await writeFile(join(canaryDir, 'canary.txt'), 'canary', 'utf-8');
    if (!(await catInSandbox(join(workDir, 'allowed.txt')))) {
      return {
        id: 'codex-lock',
        label,
        level: 'fail',
        detail: 'ChatGPT 리뷰용 보호 공간을 만들지 못했어요. 이대로는 ChatGPT 리뷰가 실패해요.',
        fix: 'codex 를 최신으로 올린 뒤 다시 확인해 주세요. 계속되면 설정에서 Claude 로 바꿔 쓸 수 있어요.',
      };
    }
    if (await catInSandbox(join(canaryDir, 'canary.txt'))) {
      return {
        id: 'codex-lock',
        label,
        level: 'fail',
        detail: 'ChatGPT 가 내 컴퓨터의 다른 파일을 읽을 수 있는 상태예요. 이 codex 버전이 보호 설정을 무시하고 있어요.',
        fix: '이 상태로 리뷰하지 마세요. codex 를 최신으로 올리거나, 설정에서 Claude 로 바꿔 주세요.',
      };
    }
    return { id: 'codex-lock', label, level: 'ok', detail: '리뷰 중 ChatGPT 는 내 다른 파일을 읽지 못해요.' };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(canaryDir, { recursive: true, force: true });
  }
};

export const runDoctor = async (): Promise<CheckResult[]> => {
  const [gh, codex, claude] = await Promise.all([checkGh(), checkCodex(), checkClaude()]);
  const results = [checkNode(), ...gh, codex, claude];
  if (codex.level === 'ok') {
    results.push(await checkCodexReadLock());
  }
  // 모델 CLI 가 둘 다 안 되면 리뷰를 못 한다 — 경고가 아니라 실패다.
  if (codex.level !== 'ok' && claude.level !== 'ok') {
    results.push({
      id: 'model',
      label: '리뷰할 AI',
      level: 'fail',
      detail: 'ChatGPT 나 Claude 중 하나는 연결되어 있어야 리뷰할 수 있어요.',
      fix: '`시작하기.command` 를 다시 열면 설치와 로그인을 차례로 안내해요.',
    });
  }
  return results;
};
