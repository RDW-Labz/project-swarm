// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { dailyLimitNotice, centralDayKey } from './daily-limit.mjs';
import { sanitizeText } from './journal.mjs';

export const NOTIFIER_STATE_REL = '.swarm/project/daily-limit-notified.json';
export const BOARD_BANNER_REL = '.swarm/project/board-banner.json';
export const SUMMARY_LINES_REL = '.swarm/project/two-hour-summary.ndjson';
export const NOTIFY_FAIL_LOG_REL = '.swarm/project/daily-limit-notify-failures.ndjson';

function nowMs(now) {
  return typeof now === 'function' ? now() : Number(now ?? Date.now());
}

function levelKey(level) {
  if (level === 'ceiling' || level === 'ceiling-stop') return 'ceiling';
  const n = Number(level);
  return Number.isFinite(n) ? n : String(level);
}

function notifiedHas(state, project, level) {
  const day = state?.day;
  const list = state?.byProject?.[project];
  if (!Array.isArray(list) || !day) return false;
  const key = levelKey(level);
  return list.some(entry => entry === key || entry === String(key));
}

async function readJson(fsImpl, file, fallback) {
  try {
    return JSON.parse(await fsImpl.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicWriteJson(fsImpl, file, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  await fsImpl.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fsImpl.open(temp, 'wx', mode);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await fsImpl.rename(temp, file);
  await fsImpl.chmod(file, mode);
}

async function defaultReadNotified(root, { fs: fsImpl = fs, now = Date.now } = {}) {
  const file = path.join(root, NOTIFIER_STATE_REL);
  const state = await readJson(fsImpl, file, { day: centralDayKey(now), byProject: {} });
  const day = centralDayKey(now);
  if (state.day !== day) return { day, byProject: {} };
  return { day, byProject: state.byProject && typeof state.byProject === 'object' ? state.byProject : {} };
}

async function defaultWriteNotified(root, state, { fs: fsImpl = fs } = {}) {
  const file = path.join(root, NOTIFIER_STATE_REL);
  await atomicWriteJson(fsImpl, file, state);
}

async function defaultWriteBoardBanner(root, notice, { fs: fsImpl = fs } = {}) {
  const file = path.join(root, BOARD_BANNER_REL);
  await atomicWriteJson(fsImpl, file, notice);
}

async function defaultAppendFyiNote(root, notice, { appendEvent, now = Date.now } = {}) {
  const append = appendEvent ?? (async (r, event, opts) => {
    const { appendEvent: journalAppend } = await import('./journal.mjs');
    return journalAppend(r, event, opts);
  });
  const at = nowMs(now);
  const day = centralDayKey(() => at);
  const id = `daily-limit-${day}-${levelKey(notice.level)}`;
  await append(root, {
    kind: 'note',
    id,
    title: sanitizeText(`FYI, no action needed: ${notice.text}`),
  }, { now: () => at });
}

async function defaultAppendCeilingHuman(root, notice, { fs: fsImpl = fs, appendEvent, now = Date.now } = {}) {
  const append = appendEvent ?? (async (r, event, opts) => {
    const { appendEvent: journalAppend } = await import('./journal.mjs');
    return journalAppend(r, event, opts);
  });
  const at = nowMs(now);
  const day = centralDayKey(() => at);
  const id = `daily-limit-${day}-${levelKey(notice.level)}`;
  await append(root, {
    kind: 'human',
    id,
    title: sanitizeText(`Daily spend hard ceiling: ${notice.text}`),
    unblocks: 0,
    done: false,
  }, { now: () => at });
}

async function defaultAppendSummaryLine(root, notice, { fs: fsImpl = fs, now = Date.now } = {}) {
  const file = path.join(root, SUMMARY_LINES_REL);
  const dir = path.dirname(file);
  await fsImpl.mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({ at: new Date(nowMs(now)).toISOString(), kind: notice.kind, text: notice.text, project: notice.project, level: notice.level })}\n`;
  await fsImpl.appendFile(file, line, { mode: 0o600 });
}

async function logDeliveryFailure(root, payload, { fs: fsImpl = fs } = {}) {
  const file = path.join(root, NOTIFY_FAIL_LOG_REL);
  const dir = path.dirname(file);
  await fsImpl.mkdir(dir, { recursive: true });
  await fsImpl.appendFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

function isCeilingLevel(level) {
  const key = levelKey(level);
  return key === 'ceiling';
}

export async function notifyDailyLimit({ project, level, billedTodayUsd, settings, deps = {} }) {
  const root = deps.root;
  if (typeof root !== 'string' || !root) throw new Error('daily-limit-notify: deps.root is required');
  const now = deps.now ?? Date.now;
  const fsImpl = deps.fs ?? fs;
  const notice = dailyLimitNotice({ project, level, billedTodayUsd, settings, now });
  const readNotified = deps.readNotified ?? (r => defaultReadNotified(r, { fs: fsImpl, now }));
  const writeNotified = deps.writeNotified ?? ((r, state) => defaultWriteNotified(r, state, { fs: fsImpl }));
  const writeBoardBanner = deps.writeBoardBanner ?? ((r, n) => defaultWriteBoardBanner(r, n, { fs: fsImpl }));
  const appendCeilingHuman = deps.appendCeilingHuman ?? ((r, n) => defaultAppendCeilingHuman(r, n, { fs: fsImpl, appendEvent: deps.appendEvent, now }));
  const appendFyiNote = deps.appendFyiNote ?? ((r, n) => defaultAppendFyiNote(r, n, { appendEvent: deps.appendEvent, now }));
  const appendSummaryLine = deps.appendSummaryLine ?? ((r, n) => defaultAppendSummaryLine(r, n, { fs: fsImpl, now }));
  const logFailure = deps.logDeliveryFailure ?? ((r, p) => logDeliveryFailure(r, p, { fs: fsImpl }));

  const state = await readNotified(root);
  if (notifiedHas(state, project, level)) return { sent: false, reason: 'deduped', notice };

  const key = levelKey(level);
  try {
    await writeBoardBanner(root, notice);
    await appendSummaryLine(root, notice);
    if (isCeilingLevel(level)) {
      await appendCeilingHuman(root, notice);
    } else if (typeof deps.appendPhoneInbox === 'function') {
      await deps.appendPhoneInbox(root, notice);
    } else if (Number(level) >= 1 && Number(level) <= 3) {
      await appendFyiNote(root, notice);
    }
  } catch (error) {
    await logFailure(root, {
      at: new Date(nowMs(now)).toISOString(),
      project,
      level: key,
      error: String(error?.message ?? error).slice(0, 500),
    });
    return { sent: false, reason: 'delivery-failed', notice };
  }

  const byProject = { ...state.byProject };
  const levels = [...(Array.isArray(byProject[project]) ? byProject[project] : []), key];
  byProject[project] = levels;
  await writeNotified(root, { day: state.day, byProject });

  return { sent: true, notice };
}
