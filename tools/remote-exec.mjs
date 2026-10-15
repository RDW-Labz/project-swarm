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
import { StringDecoder } from 'node:string_decoder';
import crypto from 'node:crypto';

// This file is copied alone to the remote host, so it imports nothing from this project. The three
// helpers below mirror isSecretPath, remoteEnv and hashBytes in executors.mjs; a test keeps them equal.
const SECRET_DIRS = new Set(['.git', '.swarm', '.ssh', '.aws', '.gnupg']);
const REMOTE_ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SWARM_PORT_BASE']);
export function isSecretPath(file) {
  return String(file).split(/[\\/]+/).some(part => {
    const name = part.toLowerCase();
    return SECRET_DIRS.has(name) || name === '.env' || name.startsWith('.env.');
  });
}
export function remoteEnv(env = {}) {
  const shipped = {};
  for (const key of REMOTE_ENV) if (env[key] !== undefined) shipped[key] = env[key];
  return shipped;
}
export function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const JOB_ID = /^[a-f0-9]{8,32}$/;

// One private folder per user. A shared, world-readable /tmp folder would let another user on the host
// plant job records: a planted pid would make `--kill` signal someone else's process.
function jobsDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return process.env.SWARM_REMOTE_JOBS || path.join(os.tmpdir(), `swarm-remote-jobs-${uid}`);
}

function ensureJobsDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('jobs directory is not a plain directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('jobs directory belongs to another user');
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

// Job records are never written through a symlink.
function writeRecord(file, data) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_FILES = 64;
const MAX_OUTPUT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_TOTAL_BYTES = 128 * 1024 * 1024;
const DRAIN_GRACE_MS = 5000;

function jobPath(dir, id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) return null;
  return path.join(dir, `${id}.json`);
}

function readLine(stdin) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const decoder = new StringDecoder('utf8');
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };
    const onData = chunk => {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (buf.length > MAX_REQUEST_BYTES) { cleanup(); reject(new Error('request too large')); return; }
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
  ensureJobsDir(dir);
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
  try { ensureJobsDir(dir); } catch { process.exit(1); }
  let child = null;
  let file = null;
  let workspace = null;
  let stopped = false;
  const cleanup = () => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child?.pid) signalGroup(child.pid, 'SIGKILL');
    if (file) {
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)) writeRecord(file, JSON.stringify({ costUsd: record.costUsd }));
        else fs.unlinkSync(file);
      } catch { /* the kill command will not find a pid */ }
    }
    cleanup();
    process.exit(1);
  };
  process.on('SIGHUP', stop);
  process.on('SIGTERM', stop);
  const workspacePath = name => {
    if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name) || path.win32.isAbsolute(name) || name.split(/[\\/]+/).includes('..') || isSecretPath(name)) throw new Error('refused path');
    const target = path.resolve(workspace, name);
    if (!target.startsWith(workspace + path.sep)) throw new Error('refused path');
    if (fs.lstatSync(workspace).isSymbolicLink()) throw new Error('refused workspace symlink');
    let current = workspace;
    for (const part of path.relative(workspace, target).split(path.sep)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('refused symlink'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  };
  try {
    const request = JSON.parse(await readLine(stdin));
    const id = request?.id;
    file = jobPath(dir, id ?? '');
    if (!file) throw new Error('invalid id');
    stdin.on('end', stop);
    stdin.on('close', stop);
    stdin.resume();
    if (stdin.readableEnded || stdin.destroyed) { stop(); return; }
    const { command } = request;
    if (typeof command !== 'string' || !path.isAbsolute(command) || /[\0\r\n]/.test(command)) throw new Error('invalid command');
    const args = request.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid args');
    if (request.stdin !== undefined && typeof request.stdin !== 'string') throw new Error('invalid stdin');
    if (!Array.isArray(request.files ?? []) || !Array.isArray(request.outputs ?? []) || (request.outputs ?? []).length > MAX_OUTPUT_FILES) throw new Error('invalid files');
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-remote-exec-')));
    fs.chmodSync(workspace, 0o700);
    for (const entry of request.files ?? []) {
      const target = workspacePath(entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(entry.bytes, 'base64'));
    }
    for (const name of request.outputs ?? []) workspacePath(name);
    // HOME is the throwaway workspace unless the caller asks to keep the account's own (a CLI like Hermes
    // reads its provider config there). The command is always the caller's fixed absolute path.
    child = spawnImpl(command, args, { cwd: workspace, env: { ...remoteEnv(request.env ?? {}), HOME: request.keepHome === true ? (process.env.HOME ?? workspace) : workspace }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const record = { pid: child.pid ?? null };
    if (typeof request.costUsd === 'number' && Number.isFinite(request.costUsd)) record.costUsd = request.costUsd;
    writeRecord(file, JSON.stringify(record));
    const chunks = [];
    let length = 0;
    child.stdout.on('data', chunk => {
      const kept = Buffer.from(chunk).subarray(0, Math.max(0, 4 * 1024 * 1024 - length));
      if (kept.length) chunks.push(kept);
      length += kept.length;
    });
    child.stderr.resume();
    child.stdin.on('error', () => { /* a command may close its input early */ });
    child.stdin.end(request.stdin ?? '');
    child.on('error', stop);
    let finalized = false;
    const finalize = code => {
      if (stopped || finalized) return;
      finalized = true;
      try {
        const files = [];
        let total = 0;
        for (const name of request.outputs ?? []) {
          const target = workspacePath(name);
          let stat;
          try { stat = fs.lstatSync(target); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!stat.isFile()) continue;
          if (stat.size > MAX_OUTPUT_FILE_BYTES || total + stat.size > MAX_OUTPUT_TOTAL_BYTES) throw new Error('output too large');
          const bytes = fs.readFileSync(target);
          total += bytes.length;
          files.push({ path: name, bytes: bytes.toString('base64'), sha256: hashBytes(bytes) });
        }
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        cleanup();
        stopped = true;
        stdout.write(`${JSON.stringify({ id, exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString('base64'), files })}\n`, () => process.exit(0));
      } catch { stop(); }
    };
    // The liveness link is needed only while the child lives. When it exits, anything it left running in its
    // process group is killed (after a moment to flush stdout), and if stdout is still held open by such a
    // process the job is finalized anyway, so a stray background process can neither hang the job nor outlive it.
    child.on('exit', code => {
      stdin.off('end', stop);
      stdin.off('close', stop);
      process.off('SIGHUP', stop);
      process.off('SIGTERM', stop);
      const leader = child.pid;
      setTimeout(() => { if (leader) signalGroup(leader, 'SIGKILL'); }, 500);
      setTimeout(() => finalize(code), DRAIN_GRACE_MS);
    });
    child.on('close', finalize);
  } catch { stop(); }
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
