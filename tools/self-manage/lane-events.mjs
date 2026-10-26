import { open, lstat, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

const STATES = new Set(['up', 'down']);
const FIELD_LIMIT = 200;
const MAX_LOG_BYTES = 1024 * 1024;
const TRIM_LOG_BYTES = 512 * 1024;

const OPEN_APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
const BUS_APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;

export function redactSecrets(text) {
  let out = String(text ?? '');
  out = out.replace(/(https?):\/\/[^/\s:@]+:[^@\s/]+@/gi, (_, scheme) => `${scheme}://[redacted]@`);
  out = out.replace(
    /([\w-]*(?:key|token|secret|password)[\w-]*)\s*=\s*("(?:[^"\\]|\\.)*"|\S+)/gi,
    (_, name) => `${name}=[redacted]`,
  );
  out = out.replace(
    /([\w-]*(?:key|token|secret|password)[\w-]*)\s*:\s*("(?:[^"\\]|\\.)*"|\S+)/gi,
    (_, name) => `${name}:[redacted]`,
  );
  out = out.replace(
    /"([^"]*(?:key|token|secret|password)[^"]*)"\s*:\s*"([^"]*)"/gi,
    (_, name) => `"${name}":"[redacted]"`,
  );
  out = out.replace(/\bAuthorization\s*:\s*Basic\s+\S+/gi, 'Authorization: Basic [redacted]');
  out = out.replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]');
  out = out.replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]');
  out = out.replace(/\bBasic\s+[^\s]+/gi, 'Basic [redacted]');
  out = out.replace(/\bAIza[A-Za-z0-9_-]+\b/g, 'AIza[redacted]');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, 'github_pat_[redacted]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]+/g, 'sk-[redacted]');
  out = out.replace(/\bghp_[A-Za-z0-9]+/g, 'ghp_[redacted]');
  out = out.replace(/\bxox[a-z]-[A-Za-z0-9-]+/gi, 'xox[redacted]');
  return out;
}

export function normalizeReason(reason) {
  const text = redactSecrets(String(reason ?? 'unknown').replace(/[\r\n\t]+/g, ' ').trim());
  return text === '' ? 'unknown' : text.slice(0, FIELD_LIMIT);
}

export function buildLaneEvent({ lane, state, reason, now = new Date() }) {
  if (typeof lane !== 'string' || lane.trim() === '') {
    throw new TypeError('lane must be a non-empty string');
  }
  if (!STATES.has(state)) {
    throw new TypeError('state must be up or down');
  }
  const laneId = lane.trim().slice(0, FIELD_LIMIT);
  return {
    type: 'lane',
    lane: laneId,
    state,
    reason: normalizeReason(reason),
    at: now.toISOString(),
  };
}

export function formatLaneLine(event) {
  return JSON.stringify(event) + '\n';
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNotSymlink(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      throw new Error('lane event log path must not be a symlink');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

async function trimLogIfOversized(filePath) {
  await assertNotSymlink(filePath);
  let st;
  try {
    st = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (st.isSymbolicLink()) {
    throw new Error('lane event log path must not be a symlink');
  }
  if (st.size <= MAX_LOG_BYTES) return;
  const fh = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let slice;
  try {
    const start = st.size - TRIM_LOG_BYTES;
    const buf = Buffer.alloc(TRIM_LOG_BYTES);
    await fh.read(buf, 0, TRIM_LOG_BYTES, start);
    const nl = buf.indexOf(0x0a);
    slice = nl === -1 ? buf : buf.subarray(nl + 1);
  } finally {
    await fh.close();
  }
  const wfh = await open(filePath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    await wfh.write(slice);
  } finally {
    await wfh.close();
  }
}

async function appendLineSecure(filePath, line, { trim = true } = {}) {
  await assertNotSymlink(filePath);
  if (trim) {
    await trimLogIfOversized(filePath);
  }
  const flags = trim ? OPEN_APPEND_FLAGS : BUS_APPEND_FLAGS;
  const fh = await open(filePath, flags, trim ? 0o600 : undefined);
  try {
    await fh.writeFile(line, 'utf8');
  } finally {
    await fh.close();
  }
}

export async function appendLaneEvent({ eventLogPath, busPath, lane, state, reason, now }) {
  const event = buildLaneEvent({ lane, state, reason, now });
  const line = formatLaneLine(event);
  await mkdir(dirname(eventLogPath), { recursive: true });
  await appendLineSecure(eventLogPath, line);
  let busWritten = false;
  if (busPath && (await exists(busPath))) {
    await appendLineSecure(busPath, line, { trim: false });
    busWritten = true;
  }
  return { event, busWritten };
}
