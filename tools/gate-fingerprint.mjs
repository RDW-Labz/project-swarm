// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

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

function trimCaptureForSize(capture) {
  const working = structuredClone(capture);
  let text = JSON.stringify(working);
  if (Buffer.byteLength(text, 'utf8') <= MAX_CAPTURE_BYTES) {
    return working;
  }
  if (typeof working.tail !== 'string') {
    return working;
  }
  let tail = working.tail;
  while (tail.length > 0) {
    tail = tail.slice(0, Math.floor(tail.length * 0.9));
    working.tail = tail;
    text = JSON.stringify(working);
    if (Buffer.byteLength(text, 'utf8') <= MAX_CAPTURE_BYTES) {
      return working;
    }
  }
  working.tail = '';
  return working;
}

/**
 * @param {string} runDir
 * @param {string} ticketId
 * @param {object} capture
 * @returns {Promise<string>}
 */
export async function saveGateCapture(runDir, ticketId, capture) {
  if (!TICKET_ID_RE.test(ticketId)) {
    throw new Error(`invalid ticketId: ${ticketId}`);
  }

  assertNotSymlink(runDir, 'runDir');

  const failuresDir = path.join(runDir, 'gate-failures');
  assertNotSymlink(failuresDir, 'gate-failures directory');

  await fsPromises.mkdir(failuresDir, { recursive: true, mode: 0o700 });
  try {
    await fsPromises.chmod(failuresDir, 0o700);
  } catch {
    /* existing dir */
  }

  const destPath = path.join(failuresDir, `${ticketId}.json`);
  assertNotSymlink(destPath, 'capture file');

  const payload = trimCaptureForSize(capture);
  const text = `${JSON.stringify(payload)}\n`;
  const tmpPath = path.join(
    failuresDir,
    `.${ticketId}.${process.pid}.${Date.now()}.tmp`,
  );

  await fsPromises.writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
  await fsPromises.rename(tmpPath, destPath);
  await fsPromises.chmod(destPath, 0o600);

  return destPath;
}
