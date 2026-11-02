// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BEST_OF_MAX = 8;

export function bestOfCount(job, defaultCount) {
  if (!job || job.agent !== 'rented') return 1;
  let n = 1;
  if (Number.isInteger(job.bestOf)) n = job.bestOf;
  else if (Number.isInteger(defaultCount)) n = defaultCount;
  return Math.min(BEST_OF_MAX, Math.max(1, n));
}

export function candidateSize(envelope) {
  const files = Array.isArray(envelope?.files) ? envelope.files : [];
  const edits = Array.isArray(envelope?.edits) ? envelope.edits : [];
  let total = 0;
  for (const f of files) if (typeof f?.content === 'string') total += f.content.length;
  for (const e of edits) if (typeof e?.replace === 'string') total += e.replace.length;
  return total;
}

export async function selectBest(candidates, check, { concurrency = 3 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const n = list.length;
  const results = new Array(n);
  let next = 0;
  const workerCount = Math.min(n, Math.max(1, Math.floor(Number(concurrency)) || 1));
  async function worker() {
    while (next < n) {
      const i = next++;
      let r;
      try {
        r = await check(list[i], i);
      } catch (e) {
        r = { ok: false, detail: String(e?.message ?? e) };
      }
      const ok = r?.ok === true ? true : r?.ok === false ? false : null;
      results[i] = { index: i, ok, detail: r?.detail, size: candidateSize(list[i]?.envelope) };
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const pick = (want) => {
    let best = null;
    for (const r of results) {
      if (r.ok !== want) continue;
      if (best === null || r.size < results[best].size) best = r.index;
    }
    return best;
  };
  let chosen = pick(true);
  if (chosen === null) chosen = pick(null);
  return { chosen, results };
}

export function isTestFile(p) {
  if (typeof p !== 'string') return false;
  const segs = p.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s === 'test' || s === 'tests' || s === '__tests__')) return true;
  const name = segs[segs.length - 1] ?? '';
  return name.includes('.test.') || name.includes('.spec.') || name.includes('_test.') || name.startsWith('test_');
}

function safeRel(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (path.isAbsolute(p) || p.startsWith('/') || p.startsWith('\\')) return false;
  const segs = p.split(/[\\/]+/);
  return !segs.includes('..');
}

function defaultExec(argv, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        if (err.killed) return reject(new Error('timeout'));
        if (typeof err.code === 'number') {
          return resolve({ exitCode: err.code, stdout: stdout ?? '', stderr: stderr ?? '' });
        }
        reject(err);
      },
    );
  });
}

export function createTestChecker({ root, exec = defaultExec, fsImpl = fsp, timeoutMs = 120000 } = {}) {
  return async function check({ job, envelope } = {}) {
    const context = Array.isArray(job?.context) ? job.context.filter((p) => typeof p === 'string') : [];
    const tests = context.filter(isTestFile);
    if (tests.length === 0) return { ok: null, detail: 'no tests in context' };

    let tmp = null;
    try {
      tmp = await fsImpl.mkdtemp(path.join(os.tmpdir(), 'best-of-'));
      await exec(['git', '-C', root, 'worktree', 'add', '--detach', tmp, 'HEAD']);

      for (const rel of context) {
        if (!safeRel(rel)) continue;
        let data;
        try {
          data = await fsImpl.readFile(path.join(root, rel));
        } catch {
          continue;
        }
        const dest = path.join(tmp, rel);
        await fsImpl.mkdir(path.dirname(dest), { recursive: true });
        await fsImpl.writeFile(dest, data);
      }

      const fileEntries = Array.isArray(envelope?.files) ? envelope.files : [];
      for (const f of fileEntries) {
        if (!safeRel(f?.path)) return { ok: false, detail: 'unsafe path' };
        if (typeof f.content !== 'string') return { ok: false, detail: 'bad file entry' };
        const dest = path.join(tmp, f.path);
        await fsImpl.mkdir(path.dirname(dest), { recursive: true });
        await fsImpl.writeFile(dest, f.content);
      }

      const editEntries = Array.isArray(envelope?.edits) ? envelope.edits : [];
      for (const e of editEntries) {
        if (!safeRel(e?.path)) return { ok: false, detail: 'unsafe path' };
        const dest = path.join(tmp, e.path);
        if (typeof e.find !== 'string' || e.find === '' || typeof e.replace !== 'string') {
          return { ok: false, detail: 'edit does not apply' };
        }
        let text;
        try {
          text = String(await fsImpl.readFile(dest, 'utf8'));
        } catch {
          return { ok: false, detail: 'edit does not apply' };
        }
        const idx = text.indexOf(e.find);
        if (idx < 0) return { ok: false, detail: 'edit does not apply' };
        await fsImpl.writeFile(dest, text.slice(0, idx) + e.replace + text.slice(idx + e.find.length));
      }

      let res;
      try {
        res = await exec(['node', '--test', ...tests], { cwd: tmp, timeoutMs });
      } catch (err) {
        const msg = String(err?.message ?? err);
        return { ok: false, detail: 'timeout' };
      }
      const out = String(res?.stderr ?? '') + String(res?.stdout ?? '');
      return { ok: res?.exitCode === 0, detail: out.slice(-300) };
    } catch (err) {
      return { ok: false, detail: String(err?.message ?? err) };
    } finally {
      if (tmp !== null) {
        try {
          await exec(['git', '-C', root, 'worktree', 'remove', '--force', tmp]);
        } catch (error) {
          if (typeof error?.code !== 'number' || error.code === 0) {
            console.error('[tools/best-of.mjs] git worktree remove cleanup:', error?.message ?? error);
          }
        }
        try {
          await fsImpl.rm(tmp, { recursive: true, force: true });
        } catch (error) {
          console.error('[tools/best-of.mjs] fs.rm cleanup', tmp + ':', error?.message ?? error);
        }
      }
    }
  };
}
