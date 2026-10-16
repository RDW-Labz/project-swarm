// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// A grading run started from inside another node --test process must not inherit its test-runner context (the child would print no summary).
const gradingEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

export const TASK_DIR = fileURLToPath(new URL('./tasks/hard-planwaves', import.meta.url));
export const HARD_TIMEOUT_MS = 600000;

export function parseTapSummary(text) {
  const pass = /^# pass (\d+)$/m.exec(String(text ?? ''));
  const total = /^# tests (\d+)$/m.exec(String(text ?? ''));
  if (!pass || !total) return { passed: 0, total: 0 };
  return { passed: Number(pass[1]), total: Number(total[1]) };
}

export function gradeSolution({ file, taskDir = TASK_DIR, exec = spawnSync, timeoutMs = 120000 } = {}) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return { passed: 0, total: 0, passedAll: false, error: 'no solution file' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-grade-'));
  try {
    fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
    fs.copyFileSync(path.join(taskDir, 'test', 'planWaves.test.mjs'), path.join(tmp, 'test', 'planWaves.test.mjs'));
    fs.writeFileSync(path.join(tmp, 'planWaves.mjs'), source);
    const result = exec(process.execPath, ['--test', 'test/planWaves.test.mjs'], { cwd: tmp, encoding: 'utf8', timeout: timeoutMs, env: gradingEnv() });
    const parsed = parseTapSummary(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    return { ...parsed, passedAll: parsed.passed === parsed.total && parsed.total > 0 };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function prepareRepo({ taskDir = TASK_DIR, dir, exec = spawnSync } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['TASK.md', 'planWaves.mjs']) {
    fs.copyFileSync(path.join(taskDir, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\ncoordination/manifests/\n');
  const git = args => {
    const result = exec('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').slice(0, 300)}`);
    return result;
  };
  const init = exec('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init failed: ${(init.stderr || '').slice(0, 300)}`);
  git(['add', '-A']);
  git(['-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'hard task base']);
  return dir;
}

const HARD_PROMPT = 'Implement planWaves(tickets, opts) in planWaves.mjs exactly as TASK.md specifies (named ES module export, Node 22, no dependencies). Change only planWaves.mjs. Hidden tests grade it; read TASK.md carefully, the validation order, the path normalization and the scheduling rules.';

export function hardManifest({ model, bestOf = 1, maxUsd = 15, agent = 'rented' } = {}) {
  const maxOutputTokens = process.env.SWARM_RENTED_THINKING === 'off' ? 16000 : 30000;
  const job = agent === 'rented'
    ? {
        id: 'hard-planwaves',
        agent: 'rented',
        model,
        sensitive: false,
        prompt: HARD_PROMPT,
        context: ['TASK.md', 'planWaves.mjs'],
        outputs: ['planWaves.mjs'],
        contract: 'TASK.md',
        acceptance: ['node --test test/planWaves.test.mjs passes 16 of 16 (the tests are hidden from you)'],
        timeoutMs: HARD_TIMEOUT_MS,
        maxOutputTokens,
        ...(bestOf > 1 ? { bestOf } : {}),
      }
    : {
        id: 'hard-planwaves',
        agent,
        model,
        sensitive: true,
        prompt: HARD_PROMPT,
        context: ['TASK.md', 'planWaves.mjs'],
        outputs: ['planWaves.mjs'],
        timeoutMs: HARD_TIMEOUT_MS,
        maxOutputTokens: 32000,
        outputCapBytes: { total: 100000, perFile: 60000 },
      };
  return {
    version: 1,
    concurrency: 1,
    budget: { maxUsd },
    jobs: [job],
  };
}

export function runHardTask({ model, bestOf = 1, runner, maxUsd = 15, agent = 'rented', taskDir = TASK_DIR, exec = spawnSync, now = Date.now, log = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-task-'));
  try {
    prepareRepo({ taskDir, dir: path.join(dir, 'repo'), exec });
    const repo = path.join(dir, 'repo');
    const manifestRel = 'coordination/manifests/hard-planwaves.json';
    fs.mkdirSync(path.join(repo, 'coordination', 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(repo, manifestRel), JSON.stringify(hardManifest({ model, bestOf, maxUsd, agent })));
    log(`running hard task with ${model} (bestOf ${bestOf})`);
    const started = now();
    const ran = exec(process.execPath, [runner, '--root', repo, 'run', manifestRel], { env: process.env, encoding: 'utf8', timeout: 12 * 60 * 1000 });
    const wallMs = now() - started;
    const stdout = `${ran.stdout ?? ''}`.trim();
    const text = stdout || `${ran.stderr ?? ''}`.trim();
    const last = text.split('\n').filter(line => line.trim()).at(-1) ?? '';
    let state;
    try {
      state = JSON.parse(last);
    } catch {
      state = null;
    }
    if (!state || !Array.isArray(state.jobs) || state.jobs.length === 0) {
      throw new Error(`hard task run failed: ${text.slice(0, 300)}`);
    }
    const job = state.jobs[0];
    const file = path.join(repo, job.workspace ?? '', 'planWaves.mjs');
    const graded = gradeSolution({ file, taskDir, exec });
    const total = graded.total || 16;
    const usage = job.usage ?? {};
    const tokens = usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    return {
      model,
      agent,
      bestOf,
      status: job.status,
      passed: graded.passed,
      total,
      passedAll: graded.passedAll,
      seconds: Math.round(((job.durationMs ?? wallMs) / 1000) * 10) / 10,
      attempts: job.attempts?.length ?? 1,
      tokens,
      costUsd: job.costUsd ?? null,
      bestOfInfo: job.bestOf ?? null,
      error: job.error ?? null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
