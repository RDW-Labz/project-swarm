// SPDX-License-Identifier: Apache-2.0
// Per-job secret grants for isolated workers: each job gets its own on-disk grant and env block
// with only that job's values. Grant bytes are encrypted per job; loading a peer grant fails closed.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const GRANT_KEY_RE = /^[0-9a-f]{64}$/i;
const GRANT_FILE_NAME = 'grant.env';
const GRANT_VERSION = 1;

export const SWARM_JOB_GRANT_FILE = 'SWARM_JOB_GRANT_FILE';
export const SWARM_JOB_GRANT_KEY = 'SWARM_JOB_GRANT_KEY';
export const SWARM_JOB_ID = 'SWARM_JOB_ID';

export class JobGrantAccessError extends Error {
  constructor(message, code = 'ERR_GRANT_ACCESS') {
    super(message);
    this.name = 'JobGrantAccessError';
    this.code = code;
  }
}

export function assertJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new TypeError(`invalid job id: ${String(jobId)}`);
  }
}

export function assertEnvKey(key) {
  if (typeof key !== 'string' || !ENV_KEY_RE.test(key)) {
    throw new TypeError(`invalid env key: ${String(key)}`);
  }
}

/**
 * Caller-supplied grant keys must be 32 random bytes encoded as 64 hex digits (use a CSPRNG).
 */
export function assertGrantKey(grantKey) {
  if (typeof grantKey !== 'string' || !GRANT_KEY_RE.test(grantKey)) {
    throw new TypeError(
      'grantKey must be 64 hex characters (32 random bytes from a CSPRNG)',
    );
  }
}

export function jobGrantDir(grantsRoot, jobId) {
  assertJobId(jobId);
  const root = path.resolve(grantsRoot);
  const dir = path.join(root, jobId);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(root + path.sep)) {
    throw new TypeError('job id escapes grants root');
  }
  return resolved;
}

function deriveKey(grantKey) {
  assertGrantKey(grantKey);
  return Buffer.from(grantKey, 'hex');
}

function encryptGrantPayload({ jobId, secrets, grantKey }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(grantKey), iv);
  const plaintext = JSON.stringify({ v: GRANT_VERSION, jobId, secrets });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `SWARM_GRANT_V${GRANT_VERSION}\n${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}\n`;
}

function decryptGrantPayload({ content, grantKey, expectedJobId }) {
  const lines = String(content).trim().split('\n');
  if (lines[0] !== `SWARM_GRANT_V${GRANT_VERSION}` || lines.length !== 2) {
    throw new JobGrantAccessError('grant file is not a valid swarm grant');
  }
  const [ivB64, tagB64, dataB64] = lines[1].split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new JobGrantAccessError('grant file is malformed');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(grantKey),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new JobGrantAccessError('grant decryption failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new JobGrantAccessError('grant payload is invalid');
  }
  if (parsed?.v !== GRANT_VERSION || parsed?.jobId !== expectedJobId) {
    throw new JobGrantAccessError('grant job id does not match');
  }
  if (!parsed?.secrets || typeof parsed.secrets !== 'object' || Array.isArray(parsed.secrets)) {
    throw new JobGrantAccessError('grant secrets block is invalid');
  }
  return parsed.secrets;
}

async function applyGrantPermissions(grantDir, envFile) {
  await fs.chmod(grantDir, 0o700);
  await fs.chmod(envFile, 0o600);
}

/**
 * Remove a job's grant directory and grant file. Call when a job finishes so secrets do not
 * outlive the job on disk.
 */
export async function deleteJobGrant(grantsRoot, jobId) {
  assertJobId(jobId);
  const root = path.resolve(grantsRoot);
  const grantDir = jobGrantDir(root, jobId);
  await fs.rm(grantDir, { recursive: true, force: true });
}

/**
 * Build a scoped grant for one job. Does not mutate process.env or any shared global env.
 *
 * @param {object} options
 * @param {string} options.grantsRoot - base directory; each job id gets its own subdirectory
 * @param {string} options.jobId
 * @param {string[]} options.needs - declared secret/env keys for this job
 * @param {Record<string, string>} options.values - source values (only `needs` keys are written)
 * @param {string} [options.grantKey] - 64-char hex key (32 CSPRNG bytes); generated when omitted
 * @param {boolean} [options.overwrite=false] - replace an existing grant for the same job id
 */
export async function createJobGrant({
  grantsRoot,
  jobId,
  needs,
  values,
  grantKey,
  overwrite = false,
}) {
  assertJobId(jobId);
  if (!Array.isArray(needs) || needs.length === 0) {
    throw new TypeError('needs must be a non-empty array of env keys');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError('values must be an object');
  }
  const key = grantKey ?? crypto.randomBytes(32).toString('hex');
  if (grantKey !== undefined) {
    assertGrantKey(grantKey);
  }
  const secrets = {};
  for (const name of needs) {
    assertEnvKey(name);
    const value = values[name];
    if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
      throw new TypeError(`invalid value for ${name}`);
    }
    secrets[name] = value;
  }

  const root = path.resolve(grantsRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);

  const grantDir = jobGrantDir(root, jobId);
  if (overwrite) {
    await fs.rm(grantDir, { recursive: true, force: true });
  }

  try {
    await fs.mkdir(grantDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new JobGrantAccessError('job grant already exists', 'EEXIST');
    }
    throw error;
  }

  const envFile = path.join(grantDir, GRANT_FILE_NAME);
  const body = encryptGrantPayload({ jobId, secrets, grantKey: key });
  try {
    await fs.writeFile(envFile, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    await fs.rm(grantDir, { recursive: true, force: true }).catch(() => {});
    if (error?.code === 'EEXIST') {
      throw new JobGrantAccessError('grant file already exists', 'EEXIST');
    }
    throw error;
  }

  await applyGrantPermissions(grantDir, envFile);

  const containerEnv = {
    [SWARM_JOB_ID]: jobId,
    [SWARM_JOB_GRANT_FILE]: envFile,
    [SWARM_JOB_GRANT_KEY]: key,
  };

  return {
    jobId,
    grantsRoot: root,
    grantDir,
    envFile,
    grantKey: key,
    needs,
    secrets,
    containerEnv,
    containerEnvBlock: Object.entries(containerEnv).map(([name, value]) => ({ name, value })),
  };
}

/**
 * Merge a base environment with this job's grant handles only — secret keys from the parent are
 * stripped so a concurrent job cannot inherit another job's DATABASE_URL from a shared global env.
 */
export function buildIsolatedProcessEnv({ baseEnv = {}, grant, stripKeys }) {
  const keys = stripKeys ?? grant.needs;
  const env = { ...baseEnv };
  for (const name of keys) {
    delete env[name];
  }
  delete env[SWARM_JOB_GRANT_FILE];
  delete env[SWARM_JOB_GRANT_KEY];
  delete env[SWARM_JOB_ID];
  return { ...env, ...grant.containerEnv };
}

/**
 * Load decrypted secrets for the job described in `env` (SWARM_JOB_* variables).
 */
export async function loadJobGrantSecrets(env) {
  const jobId = env[SWARM_JOB_ID];
  const envFile = env[SWARM_JOB_GRANT_FILE];
  const grantKey = env[SWARM_JOB_GRANT_KEY];
  if (typeof jobId !== 'string' || typeof envFile !== 'string' || typeof grantKey !== 'string') {
    throw new JobGrantAccessError('missing swarm job grant handles in env');
  }
  assertJobId(jobId);
  let content;
  try {
    content = await fs.readFile(envFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new JobGrantAccessError('grant file not found', 'ENOENT');
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new JobGrantAccessError('grant file not readable', error.code);
    }
    throw error;
  }
  return decryptGrantPayload({ content, grantKey, expectedJobId: jobId });
}

export function grantPlaintextLeakCheck(content, secretValue) {
  return String(content).includes(secretValue);
}
