// SPDX-License-Identifier: Apache-2.0
// Lane benchmark harness: build the base repo, run one lane, verify its outputs, review, report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TASKS } from './tasks.mjs';

export const LANES = {
  hermes: { agent: 'hermes', model: 'qwen3.8-flash-next-iq2_xs', concurrency: 1, paid: false },
  cursor: { agent: 'cursor', model: 'composer-2.5', concurrency: 4, paid: false },
  codex: { agent: 'codex', model: 'gpt-6.1-sol', concurrency: 4, paid: false },
  'anthropic-haiku': { agent: 'anthropic', model: 'claude-haiku-5-5', concurrency: 6, paid: true },
  'anthropic-sonnet': { agent: 'anthropic', model: 'claude-sonnet-5-5', concurrency: 6, paid: true },
  openrouter: { agent: 'openrouter', model: 'openai/gpt-oss-20b', concurrency: 6, paid: true, sensitive: false },
  claude: { agent: 'claude', model: 'sonnet', concurrency: 3, paid: false },
};
// Cheapest first: the order the router tries lanes.
export const LANE_ORDER = ['hermes', 'cursor', 'codex', 'anthropic-haiku', 'anthropic-sonnet', 'openrouter', 'claude'];

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
const sh = (command, args, options) => {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').slice(0, 400)}`);
  return result.stdout;
};

// A lazily loaded view of the tree: reading a path loads the file, assigning changes it.
function treeView(dir) {
  const cache = new Map(), changed = new Set();
  return {
    proxy: new Proxy({}, {
      get: (_t, file) => { if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(dir, file), 'utf8')); return cache.get(file); },
      set: (_t, file, value) => { cache.set(file, value); changed.add(file); return true; },
    }),
    flush: () => { for (const file of changed) fs.writeFileSync(path.join(dir, file), cache.get(file)); return [...changed]; },
  };
}

// `git archive` of one ref, without history and without bench/, plus each task's setup, as one commit.
export function buildBaseRepo(srcRepo, ref, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(os.tmpdir(), `bench-archive-${process.pid}.tar`);
  sh('git', ['-C', srcRepo, 'archive', '--format=tar', '-o', tar, ref, '--', '.', ':(exclude)bench']);
  sh('tar', ['-xf', tar, '-C', dest]);
  fs.rmSync(tar, { force: true });
  const originals = {};
  const view = treeView(dest);
  for (const task of TASKS) {
    for (const file of task.outputs) if (fs.existsSync(path.join(dest, file))) originals[file] = fs.readFileSync(path.join(dest, file), 'utf8');
    task.mutate(view.proxy);
  }
  view.flush();
  sh('git', ['init', '-q', '-b', 'main', dest]);
  fs.writeFileSync(path.join(dest, '.gitignore'), `${fs.existsSync(path.join(dest, '.gitignore')) ? fs.readFileSync(path.join(dest, '.gitignore'), 'utf8') : ''}\n.swarm/\ncoordination/manifests/\n`);
  sh('git', ['-C', dest, 'add', '-A']);
  sh('git', ['-C', dest, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'lane benchmark base']);
  const head = sh('git', ['-C', dest, 'rev-parse', 'HEAD']).trim();
  return { head, sourceRef: sh('git', ['-C', srcRepo, 'rev-parse', ref]).trim(), originals };
}

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: source => !['.git', '.swarm'].includes(path.basename(source)) });
}
const exportsOf = text => new Set([...text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)].map(match => match[1]));
const exportsEqual = (a, b) => a.size === b.size && [...a].every(name => b.has(name));
const regexFrom = pattern => (pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern));

function runTests(dir, argv) {
  const env = { PATH: process.env.PATH, HOME: dir, LANG: 'C', TMPDIR: os.tmpdir() };
  const result = run(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd: dir, env, timeout: 120000 });
  return { ok: result.status === 0, tail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n').slice(0, 600) };
}

// Applies the outputs to a copy of the base repo and checks them the way the task says.
export function verifyOutputs(baseDir, task, outputs) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-verify-'));
  try {
    copyTree(baseDir, work);
    for (const file of task.outputs) {
      if (typeof outputs[file] !== 'string') return { pass: false, detail: `missing output ${file}`, score: 0 };
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), outputs[file]);
    }
    const v = task.verify;
    if (v.facts) {
      const text = outputs[v.facts.file];
      const missing = v.facts.patterns.filter(pattern => !regexFrom(pattern).test(text));
      return { pass: missing.length === 0, detail: missing.length ? `missing facts: ${missing.join(' | ')}` : `all ${v.facts.patterns.length} facts present`, score: (v.facts.patterns.length - missing.length) / v.facts.patterns.length };
    }
    for (const [file, content] of Object.entries(v.hidden ?? {})) fs.writeFileSync(path.join(work, file), content);
    const tests = runTests(work, v.argv);
    if (!tests.ok) return { pass: false, detail: `tests failed: ${tests.tail.split('\n').slice(-2).join(' ').slice(0, 200)}`, score: 0 };
    if (v.structural) {
      const original = fs.readFileSync(path.join(baseDir, v.structural.file), 'utf8');
      const result = outputs[v.structural.file];
      const used = result.split(v.structural.needle).length - 1;
      if (!(used < v.structural.fewerThan)) return { pass: false, detail: `not refactored: "${v.structural.needle}" appears ${used} times (was ${original.split(v.structural.needle).length - 1})`, score: 0.5 };
      if (v.structural.sameExports && !exportsEqual(exportsOf(original), exportsOf(result))) return { pass: false, detail: 'exports changed', score: 0.5 };
    }
    if (v.mutants) {
      const original = fs.readFileSync(path.join(baseDir, v.mutants.file), 'utf8');
      let killed = 0;
      for (const [from, to] of v.mutants.list) {
        if (original.split(from).length !== 2) throw new Error(`mutant source not found: ${from}`);
        const mutantDir = `${work}-mutant`;
        copyTree(work, mutantDir);
        fs.writeFileSync(path.join(mutantDir, v.mutants.file), original.replace(from, to));
        if (!runTests(mutantDir, ['node', '--import', './tests/_isolate-config.mjs', '--test', v.mutants.testFile]).ok) killed += 1;
        fs.rmSync(mutantDir, { recursive: true, force: true });
      }
      const total = v.mutants.list.length;
      return { pass: killed >= total - 1, detail: `tests pass; killed ${killed}/${total} mutants`, score: killed / total };
    }
    return { pass: true, detail: 'tests pass', score: 1 };
  } finally { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(`${work}-mutant`, { recursive: true, force: true }); }
}

function tokensOf(job) {
  const usage = job.usage ?? {};
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  const parts = ['input', 'output', 'input_tokens', 'output_tokens'].map(key => usage[key]).filter(Number.isFinite);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

// Runs one lane's ten jobs with the given runner and returns the results (nothing is merged).
export function runLane({ lane, repo, runner, maxUsd = 0.5, baseInfo, log = () => {} }) {
  const spec = LANES[lane];
  if (!spec) throw new Error(`unknown lane ${lane}`);
  const manifest = {
    version: 1, concurrency: spec.concurrency, budget: { maxUsd },
    jobs: TASKS.map(task => ({
      id: task.id, agent: spec.agent, model: spec.model, ...(spec.paid && spec.agent === 'anthropic' ? { sensitive: true } : {}), ...(spec.sensitive === false ? { sensitive: false } : {}),
      prompt: task.prompt, context: task.context, outputs: task.outputs, timeoutMs: 900000,
    })),
  };
  const manifestRel = `coordination/manifests/bench-${lane}.json`;
  fs.mkdirSync(path.join(repo, 'coordination/manifests'), { recursive: true });
  // A single-request API worker may return at most 15 KB per file unless the job raises its cap, so
  // a large output (tools/spend.mjs, 23 KB) gets a higher cap for those lanes only.
  if (['anthropic', 'openrouter'].includes(spec.agent)) {
    for (const job of manifest.jobs) {
      const biggest = Math.max(...job.outputs.map(file => (fs.existsSync(path.join(repo, file)) ? fs.statSync(path.join(repo, file)).size : 0)));
      if (biggest > 12000) job.outputCapBytes = { total: 100000, perFile: 60000 };
    }
  }
  // The runner refuses a job when a test that mentions its files is outside its context. Name those
  // tests in ignoreTests, with a reason in the prompt, exactly as `swarm scaffold` does.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fs.writeFileSync(path.join(repo, manifestRel), JSON.stringify(manifest, null, 1));
    const checked = run(process.execPath, [runner, '--root', repo, 'validate', manifestRel], { env: process.env });
    const text = (`${checked.stdout ?? ''}`.trim() || `${checked.stderr ?? ''}`.trim()).split('\n').at(-1);
    let verdict; try { verdict = JSON.parse(text); } catch { throw new Error(`validate gave no verdict: ${text.slice(0, 300)}`); }
    if (verdict.status !== 'error') break;
    const refs = [...String(verdict.error).matchAll(/([\w-]+): \S+ <- ([^\s;]+)/g)];
    if (!refs.length) throw new Error(`validate failed: ${String(verdict.error).slice(0, 400)}`);
    for (const [, id, test] of refs) {
      const job = manifest.jobs.find(item => item.id === id);
      if (!job || job.ignoreTests?.includes(test)) continue;
      (job.ignoreTests ??= []).push(test);
      job.prompt += `\nignoreTests: ${test} — Existing test outside this task's declared outputs; the coordinator runs it after integration.`;
    }
  }
  log(`running ${lane} (${spec.agent}/${spec.model}) with ${runner}`);
  const started = Date.now();
  const ran = run(process.execPath, [runner, '--root', repo, 'run', manifestRel], { env: process.env, timeout: 3 * 3600 * 1000 });
  const last = (`${ran.stdout ?? ''}`.trim() || `${ran.stderr ?? ''}`.trim()).split('\n').at(-1);
  let state;
  try { state = JSON.parse(last); } catch { throw new Error(`run did not return a state: ${(ran.stdout || ran.stderr || '').slice(0, 400)}`); }
  if (!state.jobs) throw new Error(`run failed: ${JSON.stringify(state).slice(0, 400)}`);
  const results = state.jobs.map(job => {
    const task = TASKS.find(item => item.id === job.id);
    const outputs = {};
    for (const file of task.outputs) {
      const at = path.join(repo, job.workspace, file);
      if (fs.existsSync(at)) outputs[file] = fs.readFileSync(at, 'utf8').slice(0, 120000);
    }
    const verified = job.status === 'complete' || Object.keys(outputs).length === task.outputs.length
      ? verifyOutputs(repo, task, outputs) : { pass: false, detail: `job ${job.status}: ${String(job.error ?? '').slice(0, 160)}`, score: 0 };
    return {
      taskId: task.id, type: task.type, lane, agent: spec.agent, model: spec.model, status: job.status, error: job.error ?? null,
      durationMs: job.durationMs ?? null, tokens: tokensOf(job), costUsd: typeof job.costUsd === 'number' ? job.costUsd : null,
      attempts: job.attempts?.length ?? 1, pass: verified.pass, detail: verified.detail, score: verified.score, outputs,
    };
  });
  return { lane, agent: spec.agent, model: spec.model, host: os.hostname(), baseHead: baseInfo?.head ?? null, sourceRef: baseInfo?.sourceRef ?? null, wallMs: Date.now() - started, results };
}

// A unified diff of each output against the base, capped, for the reviewer.
export function diffFor(baseDir, task, outputs) {
  const parts = [];
  for (const file of task.outputs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-diff-'));
    try {
      const before = path.join(dir, 'before'), after = path.join(dir, 'after');
      fs.writeFileSync(before, fs.existsSync(path.join(baseDir, file)) ? fs.readFileSync(path.join(baseDir, file), 'utf8') : '');
      fs.writeFileSync(after, outputs[file] ?? '');
      parts.push(`--- ${file}\n${run('diff', ['-u', before, after]).stdout.split('\n').slice(2).join('\n')}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const text = parts.join('\n');
  return text.length > 14000 ? `${text.slice(0, 14000)}\n[diff cut at 14000 characters]` : text;
}
