import { spawn } from 'node:child_process';
import { validateVerifyConfig, ticketTests } from './verify-config.mjs';

const TESTS_TOKEN = '{tests}';
const TAIL_MAX = 4000;

const tailOf = (s) => String(s ?? '').slice(-TAIL_MAX);

export function isLocalVerify(verify) {
  const v = validateVerifyConfig(verify);
  return Boolean(v.ok && v.value && v.value.agent === 'none');
}

function runArgv(argv, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    let out = '';
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ status: 'error', code: null, tail: tailOf(String(err && err.message ? err.message : err)) });
      return;
    }
    const append = (chunk) => {
      out += chunk.toString('utf8');
      if (out.length > TAIL_MAX * 4) out = out.slice(-TAIL_MAX * 2);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => finish({ status: 'error', code: null, tail: tailOf(out + String(err.message)) }));
    child.on('close', (code) => finish({ status: code === 0 ? 'passed' : 'failed', code, tail: tailOf(out) }));
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          console.error('[tools/verify-local-runner.mjs] timeout SIGKILL:', error?.message ?? error);
        }
      }
      finish({ status: 'timeout', code: null, tail: tailOf(out) });
    }, timeoutMs);
  });
}

export async function runLocalVerify(ticket, verify, opts = {}) {
  const v = validateVerifyConfig(verify);
  if (!v.ok || !v.value) return { ok: false, status: 'invalid', errors: v.errors, tokens: 0, results: [] };
  const cfg = v.value;
  if (cfg.agent !== 'none') return { ok: false, status: 'not-local', tokens: 0, results: [] };

  const tests = ticketTests(ticket);
  if (tests.length === 0) return { ok: false, status: 'no-tests', tokens: 0, results: [] };

  const specs = tests.map((p) => `./${p}`);
  const cmd = cfg.command.flatMap((a) => (a === TESTS_TOKEN ? specs : [a]));
  const env = { ...process.env, ...cfg.testEnv };
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = cfg.timeoutSec * 1000;
  const results = [];

  for (const argv of cfg.setup) {
    const r = await runArgv(argv, { cwd, env, timeoutMs });
    results.push({ name: 'setup', argv: [...argv], ...r });
    if (r.status !== 'passed') return { ok: false, status: 'setup-failed', tokens: 0, results };
  }

  const r = await runArgv(cmd, { cwd, env, timeoutMs });
  results.push({ name: 'tests', argv: [...cmd], ...r });
  return { ok: r.status === 'passed', status: r.status, tokens: 0, results };
}
