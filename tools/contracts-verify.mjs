// SPDX-License-Identifier: Apache-2.0
// Proves generated contract files agree with themselves: starts the generated mock server and runs the generated
// contract tests against it. Used by `swarm scope contracts` right after generation.
// The generated code is never loaded into this process: the mock and the tests each run in their own process with a
// minimal environment and a temporary HOME, and one timer kills both process groups.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BOOT = `const m = await import(process.argv[1]); const s = await m.createMockServer({ port: 0 }); console.log('MOCK ' + s.url);\nsetInterval(() => {}, 1 << 30);`;

export async function verifyContracts(dir, { timeoutMs = 60000 } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'swarm-contract-verify-'));
  const env = { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'test' };
  const children = [];
  const killAll = () => { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') { console.error('[tools/contracts-verify.mjs] killAll process group:', error?.message ?? error); } } } };
  const timer = setTimeout(killAll, timeoutMs);
  try {
    const mockUrl = pathToFileURL(path.join(dir, 'contracts', 'mock-server.mjs')).href;
    const mock = spawn(process.execPath, ['--input-type=module', '-e', BOOT, mockUrl], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.push(mock);
    const url = await new Promise((resolve, reject) => {
      let seen = '';
      mock.stdout.setEncoding('utf8').on('data', chunk => { seen += chunk; const m = /MOCK (http:\/\/127\.0\.0\.1:\d+)/.exec(seen); if (m) resolve(m[1]); });
      mock.stderr.setEncoding('utf8').on('data', chunk => { seen += chunk; });
      mock.on('error', reject);
      mock.on('close', () => reject(new Error(`the generated mock did not start: ${seen.slice(-200)}`)));
    });
    return await new Promise(resolve => {
      const child = spawn(process.execPath, ['--test', 'contracts/contract.test.mjs'], { cwd: dir, env: { ...env, CONTRACT_BASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      children.push(child);
      let out = '';
      const add = chunk => { out = (out + chunk).slice(-20000); };
      child.stdout.setEncoding('utf8').on('data', add);
      child.stderr.setEncoding('utf8').on('data', add);
      child.on('error', error => resolve({ ok: false, failures: [], detail: [String(error.message).slice(0, 200)], tail: '' }));
      child.on('close', code => {
        const failures = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
        const detail = [...out.matchAll(/^\s+error: '(.+)'$/gm)].map(m => m[1]);
        resolve({ ok: code === 0, failures, detail, tail: out.slice(-600) });
      });
    });
  } finally {
    clearTimeout(timer);
    killAll();
    await rm(home, { recursive: true, force: true });
  }
}
