import { spawn } from 'node:child_process';
import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactText } from './lesson-schema.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const TAG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAG_RE = /^--test(?:-reporter=[A-Za-z0-9._-]{1,40}|-timeout=\d{1,7}|-name-pattern=.{1,200})?$/;
const SECRET_RE = /\b(sk|ghp|gho)[-_][A-Za-z0-9_-]{16,}\b/g;
const KEYS = ['version', 'id', 'title', 'lesson', 'tags', 'prompt', 'context', 'outputs', 'check'];
const REFUSED = ['rented', 'openrouter', 'lambda', 'openai', 'gemini'];
const NOFOLLOW = fsc.O_NOFOLLOW || 0;

function refuse(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function relOk(p) {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !/^[A-Za-z]:/.test(p);
}

async function readJson(file) {
  const fh = await fs.open(file, fsc.O_RDONLY | NOFOLLOW);
  try {
    return JSON.parse(await fh.readFile('utf8'));
  } finally {
    await fh.close();
  }
}

// Kind of the path below base, checking every part with lstat. Never follows a symlink.
async function pathKind(base, rel) {
  const top = await fs.lstat(base).catch(() => null);
  if (!top) return 'missing';
  if (top.isSymbolicLink()) return 'symlink';
  const parts = rel.split('/');
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const st = await fs.lstat(cur).catch(() => null);
    if (!st) return 'missing';
    if (st.isSymbolicLink()) return 'symlink';
    if (i === parts.length - 1) return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
    if (!st.isDirectory()) return 'other';
  }
  return 'missing';
}

async function assertRealDir(dir) {
  const st = await fs.lstat(dir).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw refuse('not a real folder', 'not-folder');
}

async function copyFileSafe(src, dst) {
  const fh = await fs.open(src, fsc.O_RDONLY | NOFOLLOW);
  try {
    const buf = await fh.readFile();
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, buf, { flag: 'w' });
  } finally {
    await fh.close();
  }
}

async function copyTree(src, dst) {
  await assertRealDir(src);
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isSymbolicLink()) throw refuse('symlink refused', 'symlink');
    if (ent.isDirectory()) await copyTree(s, d);
    else if (ent.isFile()) await copyFileSafe(s, d);
  }
}

function redact(text, tmp) {
  let s = String(text);
  for (const p of [tmp, '/private/var', '/var/folders']) {
    if (p) s = s.split(p).join('<tmp>');
  }
  return redactText(s).replace(SECRET_RE, '<secret>');
}

// Each non-flag argv entry must be a real file under repo/ or hidden/.
async function argvFileErrors(evalDir, spec) {
  const errors = [];
  for (const a of spec.check.argv.slice(1)) {
    if (a.startsWith('-')) continue;
    let found = false;
    for (const sub of ['repo', 'hidden']) {
      if ((await pathKind(path.join(evalDir, sub), a)) === 'file') {
        found = true;
        break;
      }
    }
    if (!found) errors.push('check.argv file not found under repo or hidden');
  }
  return errors;
}

export function validateEvalSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec must be an object'] };
  for (const k of Object.keys(spec)) if (!KEYS.includes(k)) errors.push(`unknown key: ${k}`);
  if (spec.version !== 1) errors.push('version must be 1');
  if (typeof spec.id !== 'string' || !ID_RE.test(spec.id)) errors.push('id must be kebab-case, 3 to 60 characters');
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 200) errors.push('title must be 1 to 200 characters');
  if (spec.lesson !== undefined && (typeof spec.lesson !== 'string' || !/^L-\d{4,}$/.test(spec.lesson))) errors.push('lesson must look like L-0001');
  if (!Array.isArray(spec.tags) || spec.tags.length < 1 || spec.tags.length > 12 || !spec.tags.every((t) => typeof t === 'string' && t.length >= 2 && t.length <= 40 && TAG_RE.test(t))) {
    errors.push('tags must be 1 to 12 kebab-case words of 2 to 40 characters');
  }
  if (typeof spec.prompt !== 'string' || spec.prompt.length < 20 || spec.prompt.length > 4000) errors.push('prompt must be 20 to 4000 characters');
  else if (spec.prompt.includes('**')) errors.push('prompt must not contain **');
  if (!Array.isArray(spec.context) || !spec.context.every(relOk)) errors.push('context must be relative paths');
  if (!Array.isArray(spec.outputs) || spec.outputs.length < 1 || !spec.outputs.every(relOk)) errors.push('outputs must be one or more relative paths');
  const c = spec.check;
  if (!c || typeof c !== 'object' || !Array.isArray(c.argv) || c.argv.length < 2) {
    errors.push('check.argv must be an array');
  } else {
    if (c.argv[0] !== 'node') errors.push('check.argv[0] must be node');
    for (const a of c.argv.slice(1)) {
      const flagOk = typeof a === 'string' && a.startsWith('-') && FLAG_RE.test(a);
      const pathOk = typeof a === 'string' && !a.startsWith('-') && relOk(a);
      if (!flagOk && !pathOk) errors.push('check.argv entries must be allowed test flags or relative paths');
    }
  }
  if (!c || !Number.isInteger(c.timeoutSec) || c.timeoutSec < 1 || c.timeoutSec > 120) errors.push('check.timeoutSec must be an integer 1 to 120');
  return { ok: errors.length === 0, errors };
}

export async function listEvals(root, { dir = 'evals' } = {}) {
  const base = path.join(root, dir);
  const evals = [];
  const invalid = [];
  const bst = await fs.lstat(base).catch(() => null);
  if (!bst) return { evals, invalid };
  if (bst.isSymbolicLink()) throw refuse('evals folder is a symlink', 'symlink');
  const entries = await fs.readdir(base, { withFileTypes: true });
  for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (ent.name.startsWith('.') || !ent.isDirectory()) continue;
    const d = path.join(base, ent.name);
    let spec;
    try {
      spec = await readJson(path.join(d, 'eval.json'));
    } catch (e) {
      invalid.push({ id: ent.name, errors: [e.code === 'ELOOP' ? 'symlink' : `unreadable: ${e.code || 'bad json'}`] });
      continue;
    }
    const v = validateEvalSpec(spec);
    if (!v.ok) invalid.push({ id: ent.name, errors: v.errors });
    else if (spec.id !== ent.name) invalid.push({ id: ent.name, errors: ['id must match folder name'] });
    else evals.push({ id: spec.id, dir: d, spec });
  }
  return { evals, invalid };
}

export function defaultRun(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs ?? 60000);
    child.stdout.on('data', (d) => {
      out = (out + d).slice(-20000);
    });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-20000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: out, stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      killGroup();
      resolve({ code: timedOut ? 124 : code ?? 1, stdout: out, stderr: err + (timedOut ? '\ntimeout' : '') });
    });
  });
}

export async function checkEval(evalDir, outputsDir, { run = defaultRun } = {}) {
  const spec = await readJson(path.join(evalDir, 'eval.json'));
  const v = validateEvalSpec(spec);
  if (!v.ok) throw new Error(`invalid eval spec: ${v.errors[0]}`);
  const argvErrors = await argvFileErrors(evalDir, spec);
  if (argvErrors.length) throw new Error(argvErrors[0]);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-eval-'));
  const started = Date.now();
  try {
    const work = path.join(tmp, 'work');
    await copyTree(path.join(evalDir, 'repo'), work);
    for (const rel of spec.outputs) {
      const kind = await pathKind(outputsDir, rel);
      if (kind === 'symlink') throw refuse('symlink refused in outputs', 'symlink');
      if (kind !== 'file') continue;
      await copyFileSafe(path.join(outputsDir, rel), path.join(work, rel));
    }
    const hidden = path.join(evalDir, 'hidden');
    if (await fs.lstat(hidden).catch(() => null)) await copyTree(hidden, work);
    const env = { PATH: process.env.PATH ?? '', HOME: tmp, NODE_ENV: 'test' };
    const res = await run(spec.check.argv[0], spec.check.argv.slice(1), {
      cwd: work,
      env,
      timeoutMs: spec.check.timeoutSec * 1000,
    });
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    return {
      pass: res.code === 0,
      exitCode: res.code,
      tail: redact(combined, tmp).slice(-600),
      ms: Date.now() - started,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function validateEval(evalDir, { run = defaultRun } = {}) {
  let spec;
  try {
    spec = await readJson(path.join(evalDir, 'eval.json'));
  } catch (e) {
    return { ok: false, red: false, green: false, errors: [`eval.json unreadable: ${e.code || e.message}`] };
  }
  const v = validateEvalSpec(spec);
  if (!v.ok) return { ok: false, red: false, green: false, errors: v.errors };
  const argvErrors = await argvFileErrors(evalDir, spec);
  if (argvErrors.length) return { ok: false, red: false, green: false, errors: argvErrors };
  let red;
  let green;
  try {
    red = await checkEval(evalDir, path.join(evalDir, 'repo'), { run });
    green = await checkEval(evalDir, path.join(evalDir, 'solution'), { run });
  } catch (e) {
    return { ok: false, red: false, green: false, errors: [`check error: ${e.code || 'failed'}`] };
  }
  const errors = [];
  if (red.pass) errors.push('check passes on the untouched repo (not red)');
  if (!green.pass) errors.push(`check fails on the solution (exit ${green.exitCode}; not green)`);
  return { ok: errors.length === 0, red: !red.pass, green: green.pass, errors };
}

export function evalManifest(evals, { agent = 'auto', model, lane, maxUsd } = {}) {
  for (const who of [agent, lane]) {
    if (who !== undefined && who !== null && REFUSED.includes(String(who).toLowerCase())) {
      throw refuse('this agent or lane is not allowed for evals', 'eval-agent');
    }
  }
  const jobs = evals.map((e) => {
    const s = e.spec;
    const pre = `evals/${s.id}/repo/`;
    const job = {
      id: `eval-${s.id}`,
      type: 'build',
      agent,
      sensitive: true,
      prompt: s.prompt,
      context: s.context.map((p) => pre + p),
      outputs: s.outputs.map((p) => pre + p),
      maxOutputTokens: 16000,
      timeoutMs: 600000,
    };
    if (model) job.model = model;
    return job;
  });
  const manifest = { version: 1, jobs };
  if (lane) manifest.lane = lane;
  if (maxUsd !== undefined) manifest.maxUsd = maxUsd;
  return manifest;
}

// The job workspace must be a real folder inside <root>/.swarm/workspaces with no symlink parts.
async function workspaceFolder(root, ws) {
  if (typeof ws !== 'string' || !ws) return null;
  const realRoot = await fs.realpath(root).catch(() => null);
  if (!realRoot) return null;
  const base = path.resolve(realRoot, '.swarm', 'workspaces');
  const target = path.resolve(realRoot, ws);
  const rel = path.relative(base, target);
  if (!rel || rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) return null;
  const kind = await pathKind(realRoot, `.swarm/workspaces/${rel.split(path.sep).join('/')}`);
  return kind === 'dir' ? target : null;
}

export async function scoreRun(root, runId, { evals = [], run = defaultRun } = {}) {
  if (typeof runId !== 'string' || !RUN_RE.test(runId)) throw new Error('invalid run id');
  const state = await readJson(path.join(root, '.swarm', 'runs', runId, 'state.json'));
  const jobs = Array.isArray(state.jobs) ? state.jobs.filter((j) => j && typeof j === 'object') : [];
  const scoredIds = new Set(evals.map((e) => `eval-${e.id}`));
  const scored = jobs.filter((j) => scoredIds.has(j.id));
  const agents = new Set();
  const models = new Set();
  let costUsd = 0;
  for (const j of scored) {
    agents.add(typeof j.agent === 'string' && j.agent ? j.agent : 'unknown');
    models.add(typeof j.model === 'string' && j.model ? j.model : 'unknown');
    if (Number.isFinite(j.costUsd)) costUsd += j.costUsd;
  }
  const results = [];
  for (const e of evals) {
    const job = scored.find((j) => j.id === `eval-${e.id}`);
    if (!job || job.status !== 'complete') {
      results.push({ id: e.id, pass: false, exitCode: null, tail: '', status: job ? String(job.status ?? 'incomplete') : 'missing' });
      continue;
    }
    const ws = await workspaceFolder(root, job.workspace);
    if (!ws || (await pathKind(ws, `evals/${e.id}/repo`)) !== 'dir') {
      results.push({ id: e.id, pass: false, exitCode: null, tail: '', status: 'workspace-refused' });
      continue;
    }
    try {
      const r = await checkEval(e.dir, path.join(ws, 'evals', e.id, 'repo'), { run });
      results.push({ id: e.id, pass: r.pass, exitCode: r.exitCode, tail: r.tail, status: 'complete' });
    } catch {
      results.push({ id: e.id, pass: false, exitCode: null, tail: '', status: 'eval-error' });
    }
  }
  return {
    runId,
    results,
    passed: results.filter((r) => r.pass).length,
    total: evals.length,
    agents: [...agents].sort(),
    models: [...models].sort(),
    costUsd: Math.round(costUsd * 10000) / 10000,
  };
}

export function validateBaseline(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['baseline must be a plain object'] };
  for (const key of Object.keys(obj)) {
    const e = obj[key];
    if (!e || typeof e !== 'object' || Array.isArray(e) || !Number.isInteger(e.passed) || !Number.isInteger(e.total)) {
      errors.push(`${key}: passed and total must be integers`);
      continue;
    }
    if (e.total < 1 || e.passed < 0 || e.passed > e.total) errors.push(`${key}: need 0 <= passed <= total and total >= 1`);
  }
  return { ok: errors.length === 0, errors };
}

export function compareBaseline(score, baseline = {}) {
  const reasons = [];
  const bv = validateBaseline(baseline);
  if (!bv.ok) reasons.push('baseline-invalid');
  if (score.total === 0) reasons.push('no-evals');
  const mixed = score.agents.length > 1 || score.models.length > 1;
  const key = mixed ? 'mixed' : `${score.agents[0] ?? 'unknown'}/${score.models[0] ?? 'unknown'}`;
  if (mixed) reasons.push('mixed-key');
  if (key.includes('unknown')) reasons.push('unknown-key');
  const base = bv.ok && Object.prototype.hasOwnProperty.call(baseline, key) ? baseline[key] : null;
  if (base && base.total !== score.total) reasons.push('total-changed');
  const regressed = Boolean(base) && base.total === score.total && score.passed < base.passed;
  if (regressed) reasons.push('regressed');
  return {
    key,
    ok: reasons.length === 0,
    reasons,
    passed: score.passed,
    total: score.total,
    baseline: base ? { passed: base.passed, total: base.total } : null,
    regressed,
  };
}

if (process.env.EVALS_SELFTEST === '1') {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const good = () => ({
    version: 1, id: 'off-by-one', title: 'Fix off by one', tags: ['bug-fix'], prompt: 'x'.repeat(30),
    context: ['src/a.js'], outputs: ['src/a.js'], check: { argv: ['node', '--test', 'a.test.mjs'], timeoutSec: 5 },
  });
  test('validateEvalSpec rejects absolute outputs', () => {
    const s = good();
    s.outputs = ['/etc/x.js'];
    assert.equal(validateEvalSpec(s).ok, false);
  });
  test('validateEvalSpec accepts a good spec', () => {
    assert.deepEqual(validateEvalSpec(good()).errors, []);
  });
  test('validateEvalSpec refuses flags that run code', () => {
    for (const flag of ['-e', '--eval', '--require', '--import', '--env-file']) {
      const s = good();
      s.check.argv = ['node', flag, 'x.mjs'];
      assert.equal(validateEvalSpec(s).ok, false, flag);
    }
  });
  test('validateEvalSpec allows the test flags', () => {
    const s = good();
    s.check.argv = ['node', '--test', '--test-reporter=spec', '--test-timeout=5000', '--test-name-pattern=works', 'a.test.mjs'];
    assert.deepEqual(validateEvalSpec(s).errors, []);
  });
  test('compareBaseline flags a lower pass count on the same total', () => {
    const score = { passed: 2, total: 4, agents: ['a'], models: ['m'] };
    const low = compareBaseline(score, { 'a/m': { passed: 3, total: 4 } });
    assert.equal(low.regressed, true);
    assert.equal(low.ok, false);
    assert.deepEqual(low.reasons, ['regressed']);
    const changed = compareBaseline(score, { 'a/m': { passed: 3, total: 5 } });
    assert.equal(changed.regressed, false);
    assert.deepEqual(changed.reasons, ['total-changed']);
    const none = compareBaseline(score, {});
    assert.equal(none.baseline, null);
    assert.equal(none.ok, true);
  });
  test('compareBaseline refuses unknown and mixed keys', () => {
    assert.equal(compareBaseline({ passed: 1, total: 1, agents: [], models: [] }, {}).ok, false);
    const mixed = compareBaseline({ passed: 1, total: 1, agents: ['a', 'b'], models: ['m'] }, {});
    assert.equal(mixed.key, 'mixed');
    assert.equal(mixed.ok, false);
  });
  test('validateBaseline rejects passed above total', () => {
    assert.equal(validateBaseline({ 'a/m': { passed: 5, total: 4 } }).ok, false);
    assert.equal(validateBaseline({ 'a/m': { passed: 4, total: 4 } }).ok, true);
  });
  test('evalManifest refuses hosted agents and lanes', () => {
    const e = [{ id: 'off-by-one', dir: '', spec: good() }];
    assert.throws(() => evalManifest(e, { agent: 'openai' }), { code: 'eval-agent' });
    assert.throws(() => evalManifest(e, { lane: 'rented' }), { code: 'eval-agent' });
    assert.equal(evalManifest(e).jobs[0].sensitive, true);
  });
  test('redact hides home paths and secret-looking text', () => {
    const fake = ['sk', 'test', 'a1b2c3d4e5f6a7b8c9d0e1f2'].join('-');
    const out = redact(`see /Users/jane/x ${fake}`, '/tmp/none');
    assert.doesNotMatch(out, /jane/);
    assert.doesNotMatch(out, /a1b2c3d4e5f6/);
  });
}
