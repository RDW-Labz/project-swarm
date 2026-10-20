// SPDX-License-Identifier: Apache-2.0
// Read-only GitHub deployment status for the Swarm Watch build-progress board.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OWNER_OR_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const clean = value => typeof value === 'string' ? value.trim().slice(0, 200) : null;
const checkedAt = now => new Date(now()).toISOString();

function remoteRepo(url) {
  const value = String(url ?? '').trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  if (!match || !OWNER_OR_NAME.test(match[1]) || !OWNER_OR_NAME.test(match[2])) return null;
  return `${match[1]}/${match[2]}`;
}

async function gitConfigPath(root) {
  const gitPath = path.join(root, '.git');
  let stat;
  try { stat = await fs.stat(gitPath); } catch { return null; }
  if (stat.isDirectory()) return path.join(gitPath, 'config');
  if (!stat.isFile()) return null;
  let pointer;
  try { pointer = await fs.readFile(gitPath, 'utf8'); } catch { return null; }
  const match = /^gitdir:\s*(.+)$/im.exec(pointer.trim());
  if (!match) return null;
  const gitDir = path.resolve(root, match[1].trim());
  let commonDir = path.dirname(path.dirname(gitDir));
  try {
    const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    if (common) commonDir = path.resolve(gitDir, common);
  } catch (error) {
    if (error.code !== 'ENOENT') return null;
  }
  return path.join(commonDir, 'config');
}

export async function githubRepo(root) {
  try {
    const file = await gitConfigPath(root);
    if (!file) return null;
    const config = await fs.readFile(file, 'utf8');
    let inOrigin = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (section) { inOrigin = /^remote\s+"origin"$/i.test(section[1].trim()); continue; }
      if (!inOrigin) continue;
      const url = /^\s*url\s*=\s*(.*?)\s*$/.exec(line);
      if (url) return remoteRepo(url[1]);
    }
  } catch { /* a missing or unreadable git config is not a GitHub remote */ }
  return null;
}

async function defaultRun(cmd, args, opts) {
  try {
    const result = await execFileAsync(cmd, args, { ...opts, shell: false });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function resultBase(repo, ref, at) {
  return { checkedAt: at, repo, ref, latest: null, lastSuccess: null, error: null };
}

function newest(items, key) {
  return items.slice().sort((a, b) => {
    const aAt = Date.parse(a?.[key] ?? '');
    const bAt = Date.parse(b?.[key] ?? '');
    if (Number.isFinite(aAt) && Number.isFinite(bAt) && aAt !== bAt) return bAt - aAt;
    if (Number.isFinite(bAt)) return 1;
    if (Number.isFinite(aAt)) return -1;
    return 0;
  });
}

function deploymentStatus(deployment, status) {
  const url = [status?.environment_url, status?.target_url].map(clean).find(value => value?.startsWith('https://')) ?? null;
  return {
    state: clean(status?.state),
    environment: clean(status?.environment),
    at: clean(status?.created_at),
    url,
    sha: clean(deployment?.sha ?? status?.sha),
    id: deployment?.id ?? null,
  };
}

export async function fetchDeployStatus({ repo, ref = 'main', run = defaultRun, env = process.env, timeoutMs = 15000 } = {}) {
  const at = new Date().toISOString();
  const output = resultBase(clean(repo), clean(ref) ?? '', at);
  const childEnv = { ...(env ?? process.env) };
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GH_TOKEN;
  childEnv.GH_PROMPT_DISABLED = '1';
  const call = async args => {
    try { return await run('gh', args, { env: childEnv, shell: false, timeout: timeoutMs }); }
    catch { return null; }
  };
  const repoParts = typeof repo === 'string' ? repo.split('/') : [];
  if (repoParts.length !== 2 || !OWNER_OR_NAME.test(repoParts[0]) || !OWNER_OR_NAME.test(repoParts[1])) {
    output.error = 'invalid GitHub repo';
    return output;
  }
  const deploymentsResult = await call(['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/deployments?ref=${encodeURIComponent(String(ref))}&per_page=10`]);
  const fail = message => { output.latest = null; output.lastSuccess = null; output.error = message; return output; };
  if (!deploymentsResult || deploymentsResult.code !== 0) return fail('gh deployments request failed');
  let deployments;
  try {
    deployments = JSON.parse(String(deploymentsResult.stdout ?? ''));
    if (!Array.isArray(deployments)) throw new Error('not an array');
  } catch { return fail('gh deployments returned bad JSON'); }

  const candidates = newest(deployments.slice(0, 10), 'created_at').slice(0, 5);
  for (let index = 0; index < candidates.length; index += 1) {
    const deployment = candidates[index];
    const id = deployment?.id;
    if (id === undefined || id === null) {
      if (index === 0) output.error = 'gh deployment had no id';
      continue;
    }
    const statusesResult = await call(['api', `repos/${repo}/deployments/${encodeURIComponent(String(id))}/statuses?per_page=1`]);
    if (!statusesResult || statusesResult.code !== 0) return fail('gh deployment status request failed');
    let statuses;
    try {
      statuses = JSON.parse(String(statusesResult.stdout ?? ''));
      if (!Array.isArray(statuses)) throw new Error('not an array');
    } catch { return fail('gh deployment status returned bad JSON'); }
    const status = newest(statuses, 'created_at')[0] ?? null;
    if (!status) continue;
    const record = deploymentStatus(deployment, status);
    if (index === 0) output.latest = record;
    if (String(record.state ?? '').toLowerCase() === 'success' && !output.lastSuccess) output.lastSuccess = record;
  }
  return output;
}

export function createDeployTracker({ run = defaultRun, env = process.env, ttlMs = 300000, now = Date.now, repoOf = githubRepo } = {}) {
  const cache = new Map();
  const flights = new Map();
  const refresh = root => {
    const flight = flights.get(root);
    if (flight) return flight;
    const promise = (async () => {
      let value;
      try {
        const repo = await repoOf(root);
        value = repo ? await fetchDeployStatus({ repo, run, env }) : { checkedAt: checkedAt(now), repo: null, latest: null, lastSuccess: null, error: 'no GitHub remote' };
      } catch (error) {
        value = { checkedAt: checkedAt(now), repo: null, latest: null, lastSuccess: null, error: clean(error?.message ?? error) || 'deployment status unavailable' };
      }
      cache.set(root, { at: now(), value });
      return value;
    })().finally(() => { if (flights.get(root) === promise) flights.delete(root); });
    flights.set(root, promise);
    return promise;
  };
  return {
    get(root) {
      const hit = cache.get(root);
      if (!hit || now() - hit.at > ttlMs) refresh(root);
      return hit?.value ?? null;
    },
    refresh,
  };
}
