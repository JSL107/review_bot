import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';

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
    ? { id: 'node', label: 'Node.js', level: 'ok', detail: `v${process.versions.node}` }
    : {
        id: 'node',
        label: 'Node.js',
        level: 'fail',
        detail: `v${process.versions.node} — ${MIN_NODE_MAJOR} 이상이 필요합니다`,
        fix: 'https://nodejs.org 에서 LTS 를 설치하거나 `nvm use` 를 실행하세요 (.nvmrc 포함)',
      };
};

const checkGh = async (): Promise<CheckResult[]> => {
  const version = await run('gh', ['--version']);
  if (!version.ok) {
    return [
      {
        id: 'gh',
        label: 'GitHub CLI (gh)',
        level: 'fail',
        detail: '설치되어 있지 않습니다',
        fix: 'https://cli.github.com 에서 설치한 뒤 `gh auth login`',
      },
    ];
  }
  const user = await run('gh', ['api', 'user', '--jq', '.login']);
  return [
    { id: 'gh', label: 'GitHub CLI (gh)', level: 'ok', detail: firstLine(version.out) },
    user.ok
      ? { id: 'gh-auth', label: 'GitHub 로그인', level: 'ok', detail: `${user.out} 계정으로 리뷰를 게시합니다` }
      : {
          id: 'gh-auth',
          label: 'GitHub 로그인',
          level: 'fail',
          detail: '로그인되어 있지 않습니다',
          fix: '`gh auth login` 을 실행하세요',
        },
  ];
};

const checkCodex = async (): Promise<CheckResult> => {
  const status = await run('codex', ['login', 'status']);
  if (status.out === 'ENOENT') {
    return {
      id: 'codex',
      label: 'codex CLI',
      level: 'warn',
      detail: '설치되어 있지 않습니다 (claude 만 써도 됩니다)',
      fix: '`npm i -g @openai/codex` 후 `codex login`',
    };
  }
  if (!status.ok) {
    return {
      id: 'codex',
      label: 'codex CLI',
      level: 'warn',
      detail: '로그인되어 있지 않습니다',
      fix: '`codex login` 을 실행하세요',
    };
  }
  const model = readCodexConfigModel();
  return {
    id: 'codex',
    label: 'codex CLI',
    level: 'ok',
    detail: `${firstLine(status.out)}${model ? `, 기본 모델 ${model}` : ''}`,
  };
};

const checkClaude = async (): Promise<CheckResult> => {
  const status = await run('claude', ['auth', 'status']);
  if (status.out === 'ENOENT') {
    return {
      id: 'claude',
      label: 'claude CLI',
      level: 'warn',
      detail: '설치되어 있지 않습니다 (codex 만 써도 됩니다)',
      fix: '`npm i -g @anthropic-ai/claude-code` 후 `claude` 로 로그인',
    };
  }
  let loggedIn = status.ok;
  try {
    loggedIn = (JSON.parse(status.out) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    // 구버전은 JSON 이 아니다 — 종료 코드만 믿는다.
  }
  return loggedIn
    ? { id: 'claude', label: 'claude CLI', level: 'ok', detail: '로그인됨' }
    : {
        id: 'claude',
        label: 'claude CLI',
        level: 'warn',
        detail: '로그인되어 있지 않습니다',
        fix: '`claude` 를 한 번 실행해 로그인하세요',
      };
};

export const runDoctor = async (): Promise<CheckResult[]> => {
  const [gh, codex, claude] = await Promise.all([checkGh(), checkCodex(), checkClaude()]);
  const results = [checkNode(), ...gh, codex, claude];
  // 모델 CLI 가 둘 다 안 되면 리뷰를 못 한다 — 경고가 아니라 실패다.
  if (codex.level !== 'ok' && claude.level !== 'ok') {
    results.push({
      id: 'model',
      label: '리뷰 모델',
      level: 'fail',
      detail: 'codex 와 claude 중 하나는 로그인되어 있어야 합니다',
      fix: '위 codex 또는 claude 항목의 안내를 따르세요',
    });
  }
  return results;
};
