import { scanSecrets } from './security-scan.mjs';
const AGENTS = new Set(['codex', 'claude', 'none']);
const TEST_TYPES = new Set(['build', 'test', 'migration']);
const KEYS = new Set(['command', 'setup', 'testEnv', 'agent', 'model', 'timeoutSec']);
const TESTS_TOKEN = '{tests}';
const SECRET_NAME_PARTS = ['KEY', 'JWT', 'DSN', 'SESSION', 'COOKIE', 'CERT', 'SIGN', 'PASS', 'AUTH', 'SECRET', 'TOKEN', 'PRIVATE', 'CREDENTIAL'];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[A-Za-z0-9]+$|_test\.(py|go)$/;

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isArgv = (v) => Array.isArray(v) && v.length > 0 && v.every((a) => isStr(a) && a.length <= 500);
const shellQuote = (s) => (/^[A-Za-z0-9_./,:=@%+-]+$/.test(s) ? s : "'" + s.split("'").join("'\\''") + "'");
const testArg = (p) => `./${p}`;

function urlHasBadPassword(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return /\/\/[^\/\s@]*:[^\/\s@]+@/.test(text);
  }
  if (!u.password) return false;
  return !LOCAL_HOSTS.has(u.hostname.toLowerCase());
}

function envValueProblem(name, val) {
  if (JWT_RE.test(val)) return 'looks like a JWT';
  for (const m of val.matchAll(URL_RE)) {
    if (urlHasBadPassword(m[0])) return 'holds a URL with a password';
  }
  // A whole value that is one URL to this machine (the local database's default login) is not a secret.
  const one = val.match(URL_RE);
  if (one && one.length === 1 && one[0] === val.trim()) return null;
  if (scanSecrets([{ path: `verify.testEnv.${name}`, content: val }]).length > 0) return 'looks like a secret';
  return null;
}

export function validateVerifyConfig(verify) {
  if (verify === undefined || verify === null) return { ok: true, errors: [], value: null };
  if (typeof verify !== 'object' || Array.isArray(verify)) {
    return { ok: false, errors: ['verify must be an object'], value: null };
  }
  const errors = [];
  const value = {};
  for (const key of Object.keys(verify)) {
    if (!KEYS.has(key)) errors.push(`verify.${key} is not a known key`);
  }
  if (isArgv(verify.command)) value.command = [...verify.command];
  else errors.push('verify.command must be a non-empty array of strings');

  const setup = verify.setup ?? [];
  if (Array.isArray(setup) && setup.length <= 5 && setup.every(isArgv)) value.setup = setup.map((a) => [...a]);
  else errors.push('verify.setup must be 0 to 5 argv arrays');

  const env = verify.testEnv ?? {};
  if (typeof env === 'object' && !Array.isArray(env)) {
    const entries = Object.entries(env);
    if (entries.length > 20) errors.push('verify.testEnv allows at most 20 entries');
    for (const [name, val] of entries) {
      if (!/^[A-Z0-9_]+$/.test(name)) {
        errors.push(`verify.testEnv name ${name} must use A-Z, 0-9 and _`);
      } else if (SECRET_NAME_PARTS.some((p) => name.includes(p))) {
        errors.push(`verify.testEnv name ${name} looks secret-like`);
      }
      if (typeof val !== 'string' || val.length > 200) {
        errors.push(`verify.testEnv.${name} must be a string of at most 200 characters`);
      } else {
        const problem = envValueProblem(name, val);
        if (problem) errors.push(`verify.testEnv.${name} ${problem}`);
      }
    }
    value.testEnv = Object.fromEntries(entries);
  } else {
    errors.push('verify.testEnv must be an object');
  }

  const agent = verify.agent ?? 'claude';
  if (AGENTS.has(agent)) value.agent = agent;
  else errors.push('verify.agent must be codex, claude or none');
  if (verify.model !== undefined) {
    if (agent === 'none') errors.push('verify.model is not used with agent none');
    else if (!isStr(verify.model) || !/^[A-Za-z0-9._:-]{1,80}$/.test(verify.model)) errors.push('verify.model must be a model name of letters, digits and . _ : -');
    else value.model = verify.model;
  }
  if (agent === 'claude' && value.model === undefined) value.model = 'sonnet-shell';
  if (agent === 'codex' && value.model === undefined) errors.push('verify.model is required with agent codex (the runner never uses a CLI default model)');

  const t = verify.timeoutSec ?? 900;
  if (Number.isInteger(t) && t >= 30 && t <= 3600) value.timeoutSec = t;
  else errors.push('verify.timeoutSec must be an integer from 30 to 3600');

  return errors.length ? { ok: false, errors, value: null } : { ok: true, errors, value };
}

export function isTestFile(path) {
  return typeof path === 'string' && TEST_PATH_RE.test(path);
}

const usableTest = (p) => isStr(p) && !p.startsWith('-') && isTestFile(p);

export function ticketTests(ticket) {
  if (!ticket || !TEST_TYPES.has(ticket.type)) return [];
  const listed = Array.isArray(ticket.tests) ? ticket.tests.filter(usableTest) : [];
  const own = Array.isArray(ticket.files) ? ticket.files.filter(usableTest) : [];
  return [...new Set([...listed, ...own])];
}

export function verifyJobFields(ticket, verify) {
  const v = validateVerifyConfig(verify);
  if (!v.ok || !v.value) return null;
  const cfg = v.value;
  if (cfg.agent === 'none') return null;
  const tests = ticketTests(ticket);
  if (tests.length === 0) return null;
  const specs = tests.map(testArg);
  const argv = cfg.command.flatMap((a) => (a === TESTS_TOKEN ? specs : [a]));
  const fields = { agent: cfg.agent };
  fields.model = cfg.model;
  if (cfg.agent === 'claude') fields.shell = true;
  if (cfg.setup.length > 0) fields.setup = cfg.setup;
  if (Object.keys(cfg.testEnv).length > 0) fields.testEnv = cfg.testEnv;
  fields.timeoutMs = cfg.timeoutSec * 1000;
  fields.promptLine = `Tests for this ticket: ${specs.join(', ')}. Run ${argv.map(shellQuote).join(' ')}. The ticket is done only when they pass; report what you ran.`;
  return fields;
}

export function managedChecks(verify) {
  const v = validateVerifyConfig(verify);
  if (!v.ok || !v.value) return { checks: [], preChecks: [] };
  const cfg = v.value;
  // The full run has no test list of its own: the {tests} item is dropped (the whole suite runs).
  const check = { name: 'tests', argv: cfg.command.filter((a) => a !== TESTS_TOKEN) };
  if (cfg.command.includes(TESTS_TOKEN)) {
    check.affectedArgv = cfg.command.map((a) => (a === TESTS_TOKEN ? '{affected}' : a));
  }
  check.timeoutMs = cfg.timeoutSec * 1000;
  return { checks: [check], preChecks: cfg.setup.map((a) => [...a]) };
}

const idOf = (j) => (typeof j === 'string' ? j : j?.id);

export function doneEvidence(state, jobId) {
  // A job can sit in several batches (a failed parent batch is bisected): the batch that passed is the one that integrated it.
  const holding = (Array.isArray(state?.mergeQueue?.batches) ? state.mergeQueue.batches : []).filter((b) =>
    (b.jobs ?? b.jobIds ?? []).some((j) => idOf(j) === jobId));
  // The batch the queue says integrated the job; older states without that record fall back to a batch that passed.
  const integratedId = state?.mergeQueue?.integratedIn?.[jobId];
  const batch = integratedId !== undefined ? holding.find((b) => b.id === integratedId) : (holding.find((b) => b.checks === 'passed' && b.security !== 'blocked') ?? holding.at(-1));
  if (batch) {
    const r = (batch.checkResults ?? []).find((c) => c.name === 'tests');
    // A test failure in a batch of one job is that job's failure: it goes back to the worker with the output (a larger batch cannot say whose it is).
    if (r?.status === 'failed' && batch.security !== 'blocked' && (batch.jobs ?? batch.jobIds ?? []).length === 1) return { ok: false, failed: true, check: 'tests', tail: String(r.tail ?? ''), reason: `tests check failed in batch ${batch.id ?? '?'}` };
    if (batch.checks !== 'passed' || batch.security === 'blocked') return { ok: false, reason: `batch ${batch.id ?? '?'} did not pass (checks ${batch.checks}, security ${batch.security ?? 'unknown'})` };
    if (r?.status === 'passed' && (r.mode !== 'affected' || (r.tests ?? 0) > 0)) return { ok: true, reason: `tests check passed in batch ${batch.id}` };
    if (r?.status === 'passed') return { ok: false, reason: `tests check ran no test in batch ${batch.id}` };
    return { ok: false, reason: r ? `tests check is ${r.status} in batch ${batch.id}` : `no tests check ran in batch ${batch.id}` };
  }
  const job = (Array.isArray(state?.jobs) ? state.jobs : []).find((j) => j.id === jobId);
  if (!job) return { ok: false, reason: 'job not found' };
  const files = Array.isArray(job.outputs) ? job.outputs : Array.isArray(job.files) ? job.files : [];
  const integrated = new Set(state.integratedFiles ?? []);
  if (files.length === 0 || !files.every((f) => integrated.has(f))) {
    return { ok: false, reason: 'job files are not in the integrated files' };
  }
  const c = (Array.isArray(state.checks) ? state.checks : []).find((x) => x.name === 'tests');
  if (c?.status === 'passed') return { ok: true, reason: 'tests check passed on integrate' };
  // A plain integrate runs the tests once for the whole run: a failure is shared, so only a ticket the output names goes back.
  if (c?.status === 'failed') return { ok: false, failed: true, shared: true, check: 'tests', tail: String(c.tail ?? ''), reason: 'tests check is failed' };
  return { ok: false, reason: c ? `tests check is ${c.status}` : 'no tests check ran' };
}
