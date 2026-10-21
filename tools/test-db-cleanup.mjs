// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from 'node:url';

const ALLOWED_PROTOCOLS = new Set(['postgres:', 'postgresql:', 'mysql:', 'sqlite:', 'file:']);

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseDatabaseUrl(urlString) {
  try {
    return new URL(urlString);
  } catch {
    const normalized = urlString.replace(
      /^(postgres(?:ql)?|mysql):\/\/([^/]*@)\/(.*)$/i,
      '$1://$2localhost/$3',
    );
    if (normalized !== urlString) {
      return new URL(normalized);
    }
    throw new Error('unparseable');
  }
}

function databaseNameFromUrl(url) {
  const raw = url.pathname.replace(/^\//, '').split('/')[0];
  if (!raw) {
    if (url.protocol === 'sqlite:' || url.protocol === 'file:') {
      return url.pathname || url.href.replace(/^[^:]+:\/?\/?/, '');
    }
    return 'postgres';
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function hostLabel(url) {
  const hostParam = url.searchParams.get('host');
  if (hostParam && hostParam.startsWith('/')) {
    return hostParam;
  }
  const h = url.hostname;
  if (h) return h;
  if (url.protocol === 'sqlite:' || url.protocol === 'file:') {
    return '(local file)';
  }
  return '(unknown host)';
}

function isUnixSocketConnection(url) {
  const hostParam = url.searchParams.get('host');
  if (hostParam && hostParam.startsWith('/')) return true;
  const h = url.hostname;
  if (h && h.startsWith('/')) return true;
  return false;
}

function isLocalHost(url) {
  const protocol = url.protocol;
  if (protocol === 'sqlite:' || protocol === 'file:') {
    return true;
  }
  if (isUnixSocketConnection(url)) {
    return true;
  }
  const hostname = url.hostname;
  if (!hostname) {
    return false;
  }
  const lower = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(lower) || LOCAL_HOSTNAMES.has(hostname);
}

/**
 * @param {string} urlString
 * @throws {Error & { code: 'test-db-not-local' }}
 */
export function assertLocalDatabaseUrl(urlString) {
  if (typeof urlString !== 'string' || urlString.length === 0) {
    const err = new Error('database URL has no parseable host');
    err.code = 'test-db-not-local';
    throw err;
  }

  let url;
  try {
    url = parseDatabaseUrl(urlString);
  } catch {
    const err = new Error('database URL has no parseable host');
    err.code = 'test-db-not-local';
    throw err;
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    const err = new Error(`database URL protocol is not permitted for test cleanup`);
    err.code = 'test-db-not-local';
    throw err;
  }

  if (url.protocol === 'sqlite:' || url.protocol === 'file:') {
    return;
  }

  if (!isLocalHost(url)) {
    const label = hostLabel(url);
    const err = new Error(`refusing non-local database host: ${label}`);
    err.code = 'test-db-not-local';
    throw err;
  }
}

/**
 * @param {string} urlString
 * @param {{ dropSchema: (name: string) => Promise<unknown> | unknown, dryRun?: boolean }} options
 */
export async function cleanupTestDatabase(urlString, { dropSchema, dryRun = false } = {}) {
  assertLocalDatabaseUrl(urlString);
  const url = parseDatabaseUrl(urlString);
  const name = databaseNameFromUrl(url);
  if (dryRun) {
    return { dryRun: true, name };
  }
  if (typeof dropSchema !== 'function') {
    throw new Error('dropSchema is required when dryRun is false');
  }
  return await dropSchema(name);
}

function isCliMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isCliMain()) {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  const urlArg = args[0];
  if (!urlArg) {
    console.error('usage: node tools/test-db-cleanup.mjs <url> [--dry-run]');
    process.exit(1);
  }
  try {
    await cleanupTestDatabase(urlArg, {
      dryRun,
      dropSchema: dryRun
        ? undefined
        : async () => {
            /* no default drop implementation in CLI */
          },
    });
  } catch (err) {
    const code = err && typeof err === 'object' && err.code === 'test-db-not-local' ? 1 : 1;
    const message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
    console.error(message);
    process.exit(code);
  }
}
