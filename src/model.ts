import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReviewError } from './review.type.js';

// 이대리 src/model-router/infrastructure/{codex,claude}-cli.provider.ts · cli-process.util.ts 에서
// 리뷰에 필요한 만큼만 옮겼다. 폴백은 없다 — 사용자가 고른 모델 하나로만 돈다.

export type ModelProvider = 'codex' | 'claude';

export interface ModelOptions {
  provider: ModelProvider;
  // 비우면 provider 기본값.
  model?: string;
  timeoutMs: number;
}

// --ignore-user-config 로 사용자 config 를 안 읽으므로 모델을 명시해야 한다. 이대리 CODEX_MODEL 과 같은 값.
export const DEFAULT_CODEX_MODEL = 'gpt-6-sol';
export const DEFAULT_CLAUDE_MODEL = 'opus';
const CODEX_REASONING_EFFORT = 'high';

// prompt 는 argv 가 아니라 stdin 으로 넘긴다 — argv 는 `ps aux` 로 다른 프로세스가 읽는다.
const SAFE_ENV_KEYS = [
  'PATH',
  'USER',
  // macOS Keychain 접근에 USER 와 함께 필요하다. 없으면 claude 가 침묵 exit=1.
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TERM',
  'TMPDIR',
] as const;

const realHome = (): string => process.env.HOME ?? homedir();
const codexHome = (): string => process.env.CODEX_HOME ?? `${realHome()}/.codex`;

const buildSafeChildEnv = (
  extra: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
};

const CODEX_EPHEMERAL_NOTICE = `## 실행 환경 제약
이 세션은 스레드를 저장하지 않는 일회성 실행이다. 서브에이전트 spawn(collab 도구)은 이 환경에서 반드시 실패하므로 호출하지 말고, 요청받은 작업 전부를 이 세션에서 직접 처리한다.
네트워크가 차단돼 있어 외부 조회(curl·gh·웹 요청 등)는 전부 실패한다. 시도하지 말고 입력으로 받은 내용만 근거로 삼는다.`;

const buildPayload = ({
  prompt,
  systemPrompt,
  provider,
}: {
  prompt: string;
  systemPrompt: string;
  provider: ModelProvider;
}): string => {
  const instructions =
    provider === 'codex'
      ? `${systemPrompt}\n\n${CODEX_EPHEMERAL_NOTICE}`
      : systemPrompt;
  return `[System Instructions]\n${instructions}\n\n[User]\n${prompt}`;
};

// 모델이 실행하는 셸 명령의 읽기 범위를 빈 작업 디렉터리로 잠근다. `--sandbox read-only` 는 디스크 전체
// 읽기를 허용해서, 주입된 PR 이 ~/.ssh 를 읽혀 리뷰 코멘트로 게시시킬 수 있다.
// `--sandbox` 와 함께 넘기면 프로필이 조용히 무시되므로 섞지 않는다.
const CODEX_PERMISSION_PROFILE = 'pr_review_read_lock';

export const buildCodexArgs = ({
  workDir,
  outputFile,
  model,
}: {
  workDir: string;
  outputFile: string;
  model: string;
}): string[] => {
  const readableRoots = [
    workDir,
    `${realHome()}/.local/bin`,
    // 바이너리가 여기 있어야 세션이 뜬다. auth.json 이 있는 CODEX_HOME 전체는 열지 않는다.
    `${codexHome()}/packages`,
  ];
  const entries = [
    '":minimal"="read"',
    ...readableRoots.map((root) => `${JSON.stringify(root)}="read"`),
    '"/private/tmp"="deny"',
  ];
  return [
    'exec',
    '--skip-git-repo-check',
    '-c',
    `default_permissions="${CODEX_PERMISSION_PROFILE}"`,
    '-c',
    `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={${entries.join(',')}}`,
    '--ephemeral',
    // 사용자 config 의 MCP 서버·플러그인이 매 호출 기동되지 않게 한다.
    '--ignore-user-config',
    '-c',
    `model="${model}"`,
    '-c',
    `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
    '--color',
    'never',
    '-o',
    outputFile,
  ];
};

// 도구·MCP·사용자 설정(훅 포함)을 전부 끈다 — 리뷰는 입력만 보고 쓰면 되고, 파일 읽기 도구가 열려 있으면
// 주입된 PR 이 로컬 파일을 읽혀 게시시킬 수 있다.
export const buildClaudeArgs = (model: string): string[] => [
  '-p',
  '--output-format',
  'json',
  '--no-session-persistence',
  '--model',
  model,
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
];

interface SpawnResult {
  stdout: string;
  stderr: string;
}

const spawnWithStdin = ({
  command,
  args,
  cwd,
  env,
  input,
  timeoutMs,
}: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
}): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    // 같은 프로세스 그룹에 둔다 — Ctrl+C 가 자식까지 닿는다. MCP 를 끄고 띄워 손자 프로세스는 없다.
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ReviewError(`${command} 실행 실패: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new ReviewError(`${command} 가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new ReviewError(
            `${command} exit=${code}: ${stderr.trim().slice(-800) || '(stderr 없음 — 인증 만료나 쿼터 소진을 의심)'}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });

const runCodex = async ({
  payload,
  model,
  timeoutMs,
}: {
  payload: string;
  model: string;
  timeoutMs: number;
}): Promise<string> => {
  const workDir = await mkdtemp(join(tmpdir(), 'pr-review-'));
  const outputFile = join(workDir, 'last-message.txt');
  try {
    await spawnWithStdin({
      command: 'codex',
      args: buildCodexArgs({ workDir, outputFile, model }),
      cwd: workDir,
      // throwaway HOME + 실제 CODEX_HOME(인증 보존).
      env: buildSafeChildEnv({ HOME: workDir, PWD: workDir, CODEX_HOME: codexHome() }),
      input: payload,
      timeoutMs,
    });
    const text = await readFile(outputFile, 'utf-8').catch(() => '');
    if (text.trim().length === 0) {
      throw new ReviewError(
        'codex 가 빈 응답으로 끝났습니다 — 인증 만료나 쿼터 소진을 의심하세요 (`codex login`).',
      );
    }
    return text;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

interface ClaudeJsonOutput {
  result?: string;
  is_error?: boolean;
}

const runClaude = async ({
  payload,
  model,
  timeoutMs,
}: {
  payload: string;
  model: string;
  timeoutMs: number;
}): Promise<string> => {
  const workDir = await mkdtemp(join(tmpdir(), 'pr-review-'));
  try {
    // HOME 은 실제 값 — macOS 구독 인증이 Keychain 에 있다. CLAUDE_CONFIG_DIR 는 넣지 않는다
    // (넣으면 Keychain 대신 자격증명 파일을 찾다 "Not logged in" 으로 끊긴다).
    const extra: NodeJS.ProcessEnv = { HOME: realHome(), PWD: workDir };
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      extra.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    const { stdout } = await spawnWithStdin({
      command: 'claude',
      args: buildClaudeArgs(model),
      cwd: workDir,
      env: buildSafeChildEnv(extra),
      input: payload,
      timeoutMs,
    });
    let parsed: ClaudeJsonOutput;
    try {
      parsed = JSON.parse(stdout) as ClaudeJsonOutput;
    } catch {
      throw new ReviewError(`claude 출력을 읽지 못했습니다: ${stdout.slice(0, 300)}`);
    }
    if (parsed.is_error === true || typeof parsed.result !== 'string') {
      throw new ReviewError(`claude 오류 응답: ${String(parsed.result ?? stdout.slice(0, 300))}`);
    }
    return parsed.result;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

export interface CompletionResult {
  text: string;
  modelUsed: string;
}

export const complete = async ({
  prompt,
  systemPrompt,
  options,
}: {
  prompt: string;
  systemPrompt: string;
  options: ModelOptions;
}): Promise<CompletionResult> => {
  const payload = buildPayload({
    prompt,
    systemPrompt,
    provider: options.provider,
  });
  if (options.provider === 'codex') {
    const model = options.model ?? DEFAULT_CODEX_MODEL;
    const text = await runCodex({ payload, model, timeoutMs: options.timeoutMs });
    return { text, modelUsed: `codex:${model}` };
  }
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  const text = await runClaude({ payload, model, timeoutMs: options.timeoutMs });
  return { text, modelUsed: `claude:${model}` };
};
