import { appendFile, mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';

const STATES = new Set(['up', 'down']);

export function normalizeReason(reason) {
  const text = String(reason ?? 'unknown').replace(/[\r\n\t]+/g, ' ').trim();
  return text === '' ? 'unknown' : text;
}

export function buildLaneEvent({ lane, state, reason, now = new Date() }) {
  if (typeof lane !== 'string' || lane.trim() === '') {
    throw new TypeError('lane must be a non-empty string');
  }
  if (!STATES.has(state)) {
    throw new TypeError('state must be up or down');
  }
  return {
    type: 'lane',
    lane: lane.trim(),
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

export async function appendLaneEvent({ eventLogPath, busPath, lane, state, reason, now }) {
  const event = buildLaneEvent({ lane, state, reason, now });
  const line = formatLaneLine(event);
  await mkdir(dirname(eventLogPath), { recursive: true });
  await appendFile(eventLogPath, line, 'utf8');
  let busWritten = false;
  if (busPath && (await exists(busPath))) {
    await appendFile(busPath, line, 'utf8');
    busWritten = true;
  }
  return { event, busWritten };
}
