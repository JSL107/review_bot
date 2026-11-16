import { CheckLevel, runDoctor } from './doctor.js';

// `pnpm check` — 대시보드 없이 환경만 점검한다.
const icon: Record<CheckLevel, string> = { ok: '✔', warn: '!', fail: '✘' };
const results = await runDoctor();
for (const result of results) {
  console.log(`${icon[result.level]} ${result.label}: ${result.detail}`);
  if (result.fix && result.level !== 'ok') {
    console.log(`    → ${result.fix}`);
  }
}
process.exitCode = results.some((result) => result.level === 'fail') ? 1 : 0;
