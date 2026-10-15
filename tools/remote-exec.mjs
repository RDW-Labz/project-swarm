#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The remote side of an ssh or sandbox job. The connection stays open for the life of the job.
// If that pipe closes, or the session gets SIGHUP, this process kills its child and exits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const JOB_ID = /^[a-f0-9]{8,32}$/;

function jobsDir() {
  return process.env.SWARM_REMOTE_JOBS || path.join(os.tmpdir(), 'swarm-remote-jobs');
}

function jobPath(dir, id) {
  if (!JOB_ID.test(id)) return null;
  return path.join(dir, `${id}.json`);
}

function readLine(stdin) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      cleanup();
      resolve(buf.slice(0, nl));
    };
    const onEnd = () => { cleanup(); reject(Object.assign(new Error('link closed'), { code: 'link-closed' })); };
    const onError = error => { cleanup(); reject(error); };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

// Kill leftover jobs by id. A record may name a pid and a cost the worker reported.
export function killRemoteJobs(ids, { dir = jobsDir(), stdout = process.stdout } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let cost = 0;
  let reported = false;
  for (const id of ids.flatMap(part => String(part).split(',')).filter(Boolean)) {
    const file = jobPath(dir, id);
    if (!file) continue;
    let record = null;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { record = null; }
    if (!record || typeof record !== 'object') continue;
    if (typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)) { cost += record.costUsd; reported = true; }
    if (Number.isInteger(record.pid) && record.pid > 0) signalGroup(record.pid, 'SIGKILL');
    try { fs.unlinkSync(file); } catch { /* already reaped */ }
  }
  stdout.write(`${JSON.stringify(reported ? { costUsd: cost } : {})}\n`);
}

// Read one job from stdin, run it, and die with the connection.
export async function serveRemoteExec({ stdin = process.stdin, stdout = process.stdout, spawnImpl = spawn, dir = jobsDir() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let child = null;
  let file = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child?.pid) signalGroup(child.pid, 'SIGKILL');
    if (file) {
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)) fs.writeFileSync(file, JSON.stringify({ costUsd: record.costUsd }));
        else fs.unlinkSync(file);
      } catch { /* the kill command will not find a pid */ }
    }
    process.exit(1);
  };
  process.on('SIGHUP', stop);
  process.on('SIGTERM', stop);
  let line;
  try { line = await readLine(stdin); }
  catch { process.exit(1); }
  if (stopped) return;
  let request;
  try { request = JSON.parse(line); } catch { process.exit(1); }
  const id = request?.id;
  file = jobPath(dir, id ?? '');
  if (!file) process.exit(1);
  stdin.resume();
  stdin.on('end', stop);
  stdin.on('close', stop);
  if (stdin.readableEnded || stdin.destroyed) { stop(); return; }
  const command = typeof request.command === 'string' && request.command ? request.command : null;
  const args = Array.isArray(request.args) && request.args.every(part => typeof part === 'string') ? request.args : [];
  if (!command) {
    await new Promise(() => {});
    return;
  }
  child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
  const record = { pid: child.pid ?? null };
  if (typeof request.costUsd === 'number' && Number.isFinite(request.costUsd)) record.costUsd = request.costUsd;
  fs.writeFileSync(file, JSON.stringify(record));
  child.on('error', () => { if (!stopped) process.exit(1); });
  child.on('exit', code => {
    if (stopped) return;
    stopped = true;
    try { fs.unlinkSync(file); } catch { /* already reaped */ }
    stdout.write(`${JSON.stringify({ id, files: [] })}\n`);
    process.exit(code ?? 0);
  });
}

function main() {
  const args = process.argv.slice(2);
  const killAt = args.indexOf('--kill');
  if (killAt !== -1) {
    killRemoteJobs(args.slice(killAt + 1));
    return;
  }
  return serveRemoteExec();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve(main()).catch(() => { process.exitCode = 1; });
}
