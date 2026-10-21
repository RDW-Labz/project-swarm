// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dailyLimitNotice, centralDayKey } from './daily-limit.mjs';
import { sanitizeText } from './journal.mjs';

export const NOTIFIER_STATE_REL = '.swarm/project/daily-limit-notified.json';
export const NOTIFIER_LOCK_REL = '.swarm/project/daily-limit-notified.lock';
export const BOARD_BANNER_REL = '.swarm/project/board-banner.json';
export const SUMMARY_LINES_REL = '.swarm/project/two-hour-summary.ndjson';
export const NOTIFY_FAIL_LOG_REL = '.swarm/project/daily-limit-notify-failures.ndjson';

const NOTIFIER_LOCK_STALE_MS = 60_000;

export function notifierDedupeKey(root) {
  const resolved = path.resolve(String(root));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

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
    if (error instanceof SyntaxError) return { __corrupt: true };
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

async function withNotifierLock(root, fn, { fs: fsImpl = fs, timeoutMs = 10000 } = {}) {
  const lockDir = path.join(root, NOTIFIER_LOCK_REL);
  const started = Date.now();
  await fsImpl.mkdir(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      await fsImpl.mkdir(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fsImpl.stat(lockDir);
        if (Date.now() - stat.mtimeMs > NOTIFIER_LOCK_STALE_MS) {
          await fsImpl.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started >= timeoutMs) throw new Error('daily-limit-notify: timed out waiting for notifier lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await fsImpl.rm(lockDir, { recursive: true, force: true });
  }
}

async function defaultReadNotified(root, { fs: fsImpl = fs, now = Date.now } = {}) {
  const file = path.join(root, NOTIFIER_STATE_REL);
  const day = centralDayKey(now);
  const raw = await readJson(fsImpl, file, { day, byProject: {} });
  if (raw?.__corrupt) {
    return { day, byProject: {}, replacedCorrupt: true };
  }
  if (raw.day !== day) return { day, byProject: {} };
  return { day, byProject: raw.byProject && typeof raw.byProject === 'object' ? raw.byProject : {} };
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

  const stateRoot = notifierDedupeKey(root);
  const dedupeKey = stateRoot;
  try {
    return await withNotifierLock(stateRoot, async () => {
      const state = await readNotified(stateRoot);
      if (notifiedHas(state, dedupeKey, level)) return { sent: false, reason: 'deduped', notice };

      const key = levelKey(level);
      try {
        await writeBoardBanner(stateRoot, notice);
        await appendSummaryLine(stateRoot, notice);
        if (isCeilingLevel(level)) {
          await appendCeilingHuman(stateRoot, notice);
        } else if (typeof deps.appendPhoneInbox === 'function') {
          await deps.appendPhoneInbox(stateRoot, notice);
        } else if (Number(level) >= 1 && Number(level) <= 3) {
          await appendFyiNote(stateRoot, notice);
        }
      } catch (error) {
        await logFailure(stateRoot, {
          at: new Date(nowMs(now)).toISOString(),
          project,
          level: key,
          error: String(error?.message ?? error).slice(0, 500),
        });
        return { sent: false, reason: 'delivery-failed', notice };
      }

      const byProject = { ...state.byProject };
      const levels = [...(Array.isArray(byProject[dedupeKey]) ? byProject[dedupeKey] : []), key];
      byProject[dedupeKey] = levels;
      if (project !== dedupeKey) byProject[project] = levels;
      await writeNotified(stateRoot, { day: state.day, byProject });

      return { sent: true, notice };
    }, { fs: fsImpl });
  } catch (error) {
    try {
      await logFailure(stateRoot, {
        at: new Date(nowMs(now)).toISOString(),
        project,
        level: levelKey(level),
        error: String(error?.message ?? error).slice(0, 500),
      });
    } catch {
      // Unwritable roots (e.g. admission test fixtures) skip failure logging.
    }
    return { sent: false, reason: 'delivery-failed', notice };
  }
}
