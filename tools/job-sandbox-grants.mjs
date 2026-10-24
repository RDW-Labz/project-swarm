import { randomBytes, randomUUID } from 'node:crypto';

const registry = new Map();
const pending = new Set();
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function isIsolationEnabled(project) {
  return project?.sandbox?.isolated === true;
}

function quoteIdent(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new TypeError('unsafe SQL identifier');
  return '"' + name + '"';
}

function quoteLiteral(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('unsafe SQL literal');
  return "'" + value + "'";
}

async function dropGrantResources(adminExec, grant) {
  await adminExec('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [grant.database]);
  await adminExec('DROP DATABASE IF EXISTS ' + quoteIdent(grant.database));
  await adminExec('DROP ROLE IF EXISTS ' + quoteIdent(grant.role));
}

export async function issueGrant(jobId, { project, adminExec } = {}) {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new TypeError('jobId must be a non-empty string');
  }
  if (registry.has(jobId) || pending.has(jobId)) {
    throw new Error('grant already issued for job ' + jobId);
  }
  if (!isIsolationEnabled(project)) {
    return { mode: 'legacy', jobId, grantId: null, role: null, database: null, password: null, permissions: null };
  }
  if (typeof adminExec !== 'function') {
    throw new Error('isolated grant requires an admin SQL executor; refusing to fall back');
  }
  pending.add(jobId);
  try {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const grant = {
      mode: 'isolated',
      jobId,
      grantId: randomUUID(),
      role: 'job_' + id,
      database: 'job_' + id,
      password: randomBytes(32).toString('base64url'),
      permissions: { gitPush: false, databaseAccess: 'own-database-only' },
      issuedAt: new Date().toISOString(),
    };
    try {
      await adminExec('CREATE ROLE ' + quoteIdent(grant.role) + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ' + quoteLiteral(grant.password));
      await adminExec('CREATE DATABASE ' + quoteIdent(grant.database));
      await adminExec('REVOKE CONNECT ON DATABASE ' + quoteIdent(grant.database) + ' FROM PUBLIC');
      await adminExec('GRANT CONNECT ON DATABASE ' + quoteIdent(grant.database) + ' TO ' + quoteIdent(grant.role));
    } catch (err) {
      await dropGrantResources(adminExec, grant).catch(() => {});
      throw err;
    }
    registry.set(jobId, grant);
    return grant;
  } finally {
    pending.delete(jobId);
  }
}

export function databaseUrlFor(grant, baseUrl) {
  if (!grant || grant.mode !== 'isolated' || !grant.database) {
    throw new Error('no isolated grant for this job');
  }
  const url = new URL(baseUrl);
  url.username = grant.role;
  url.password = grant.password;
  url.pathname = '/' + grant.database;
  return url.toString();
}

export function checkGitPush(jobId, argv) {
  const grant = registry.get(jobId);
  const isPush = Array.isArray(argv) && argv[0] === 'git' && argv[1] === 'push';
  if (grant && grant.mode === 'isolated' && isPush && grant.permissions.gitPush !== true) {
    return { allowed: false, exitCode: 1, reason: 'git push denied by sandbox grant' };
  }
  return { allowed: true, exitCode: 0, reason: null };
}

export async function releaseGrant(jobId, { adminExec } = {}) {
  const grant = registry.get(jobId);
  if (!grant) return false;
  if (grant.mode === 'isolated') {
    if (typeof adminExec !== 'function') {
      throw new Error('releasing an isolated grant requires an admin SQL executor');
    }
    await dropGrantResources(adminExec, grant);
  }
  registry.delete(jobId);
  return true;
}
