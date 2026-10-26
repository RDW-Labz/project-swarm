// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { redactRerunTail } from './gate-rerun.mjs';

const ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'TZ',
  'LANG',
  'CI',
  'NODE_OPTIONS',
  'PLAYWRIGHT_BROWSERS_PATH',
  'SWARM_PORT_BASE',
  'VIRTUAL_ENV',
];

const TICKET_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CAPTURE_BYTES = 256 * 1024;

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function assertNotSymlink(p, label) {
  if (isSymlink(p)) {
    throw new Error(`${label} must not be a symlink: ${p}`);
  }
}

function assertFailuresDirSafe(failuresDir) {
  assertNotSymlink(failuresDir, 'gate-failures directory');
  let stat;
  try {
    stat = fs.lstatSync(failuresDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`gate-failures must be a directory: ${failuresDir}`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `gate-failures directory must be owned by the current user: ${failuresDir}`,
    );
  }
}

/**
 * @param {object} input
 * @returns {object}
 */
export function gateEnvFingerprint({
  cwd,
  env,
  ports,
  concurrency,
  timeoutMs,
  cleanedDirs,
  browserPath,
  node: nodeVersion,
} = {}) {
  const source = env ?? process.env;
  const allowlistEnv = {};
  for (const name of ENV_ALLOWLIST) {
    allowlistEnv[name] = source[name];
  }
  const allowset = new Set(ENV_ALLOWLIST);
  const extraEnvNames = Object.keys(source)
    .filter((k) => !allowset.has(k))
    .sort();

  return {
    cwd,
    env: allowlistEnv,
    extraEnvNames,
    ports,
    concurrency,
    timeoutMs,
    cleanedDirs,
    browserPath,
    node: nodeVersion ?? process.version,
  };
}

function pushDiff(differences, field, a, b) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr) {
    differences.push({ field, a, b });
  }
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {{ same: boolean, differences: Array<{field: string, a: unknown, b: unknown}> }}
 */
export function diffFingerprints(a, b) {
  const differences = [];
  const topFields = [
    'cwd',
    'ports',
    'concurrency',
    'timeoutMs',
    'cleanedDirs',
    'browserPath',
    'node',
  ];
  for (const field of topFields) {
    pushDiff(differences, field, a[field], b[field]);
  }

  for (const name of ENV_ALLOWLIST) {
    pushDiff(differences, `env.${name}`, a.env?.[name], b.env?.[name]);
  }

  pushDiff(differences, 'extraEnvNames', a.extraEnvNames, b.extraEnvNames);

  return { same: differences.length === 0, differences };
}

function redactCaptureStrings(value, env) {
  if (typeof value === 'string') {
    return redactRerunTail(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCaptureStrings(item, env));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactCaptureStrings(child, env);
    }
    return out;
  }
  return value;
}

function serializedByteLength(obj) {
  return Buffer.byteLength(`${JSON.stringify(obj)}\n`, 'utf8');
}

function truncateStringFields(obj, pathPrefix = '') {
  if (typeof obj === 'string') {
    return '';
  }
  if (Array.isArray(obj)) {
    return obj.map((item, index) =>
      truncateStringFields(item, `${pathPrefix}[${index}]`),
    );
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(obj)) {
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (typeof child === 'string') {
        out[key] = '';
        continue;
      }
      out[key] = truncateStringFields(child, childPath);
    }
    return out;
  }
  return obj;
}

function trimCaptureForSize(capture) {
  const working = structuredClone(capture);
  if (serializedByteLength(working) <= MAX_CAPTURE_BYTES) {
    return working;
  }

  if (typeof working.tail === 'string') {
    let tail = working.tail;
    while (tail.length > 0) {
      working.tail = tail;
      if (serializedByteLength(working) <= MAX_CAPTURE_BYTES) {
        return working;
      }
      const nextLen = Math.max(0, Math.floor(tail.length * 0.9));
      if (nextLen >= tail.length) {
        tail = tail.slice(-Math.max(0, tail.length - 1));
      } else {
        tail = tail.slice(-nextLen);
      }
    }
    working.tail = '';
  }

  if (serializedByteLength(working) <= MAX_CAPTURE_BYTES) {
    return working;
  }

  let truncated = truncateStringFields(working);
  while (serializedByteLength(truncated) > MAX_CAPTURE_BYTES) {
    const prev = serializedByteLength(truncated);
    truncated = truncateStringFields(truncated);
    if (serializedByteLength(truncated) >= prev) {
      break;
    }
  }

  if (serializedByteLength(truncated) > MAX_CAPTURE_BYTES) {
    throw new Error(
      `gate capture exceeds ${MAX_CAPTURE_BYTES} bytes after trimming tail and string fields`,
    );
  }

  return truncated;
}

/**
 * @param {string} runDir
 * @param {string} ticketId
 * @param {object} capture
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function saveGateCapture(runDir, ticketId, capture, env = process.env) {
  if (!TICKET_ID_RE.test(ticketId)) {
    throw new Error(`invalid ticketId: ${ticketId}`);
  }

  assertNotSymlink(runDir, 'runDir');

  const failuresDir = path.join(runDir, 'gate-failures');
  assertFailuresDirSafe(failuresDir);

  await fsPromises.mkdir(failuresDir, { recursive: true, mode: 0o700 });
  assertFailuresDirSafe(failuresDir);
  await fsPromises.chmod(failuresDir, 0o700);

  const destPath = path.join(failuresDir, `${ticketId}.json`);
  assertNotSymlink(destPath, 'capture file');

  const redacted = redactCaptureStrings(capture, env);
  const payload = trimCaptureForSize(redacted);
  const text = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_CAPTURE_BYTES) {
    throw new Error(
      `gate capture exceeds ${MAX_CAPTURE_BYTES} bytes after trimming`,
    );
  }

  const tmpPath = path.join(
    failuresDir,
    `.${crypto.randomBytes(16).toString('hex')}.tmp`,
  );

  await fsPromises.writeFile(tmpPath, text, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await fsPromises.rename(tmpPath, destPath);
  } catch (err) {
    await fsPromises.unlink(tmpPath).catch(() => {});
    throw err;
  }

  return destPath;
}
