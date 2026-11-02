// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';

const DEFAULT_THRESHOLD = 20;

function localDay(now) {
  const d = new Date(now);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pendingNotifications(items, notified, { now = Date.now(), threshold = DEFAULT_THRESHOLD } = {}) {
  const previous = Array.isArray(notified?.items) ? notified.items : [];
  const seen = new Set(previous);
  const list = Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [];
  const messages = [];
  const fresh = list.filter(item => typeof item.unblocks === 'number' && item.unblocks > 0 && item.unblocks >= threshold && !seen.has(item.id));
  if (fresh.length) {
    const plural = fresh.length === 1 ? '' : 's';
    const lines = fresh.map(item => `${item.id} (${item.unblocks} jobs)`).join('; ');
    messages.push(`Needs you (${fresh.length} item${plural}): ${lines}`);
  }
  const today = localDay(now);
  const digestDay = notified?.digestDay ?? null;
  const count = list.length;
  const jobs = list.reduce((sum, item) => sum + (typeof item.unblocks === 'number' && item.unblocks > 0 ? item.unblocks : 0), 0);
  let nextDigestDay = digestDay;
  if (digestDay !== today && count > 0 && jobs > 0) {
    messages.push(`Needs you: ${count} items, unblocking ${jobs} jobs`);
    nextDigestDay = today;
  }
  const nextItems = [...previous, ...fresh.map(item => item.id).filter(id => !seen.has(id))];
  return { messages, notified: { items: nextItems, digestDay: nextDigestDay } };
}

function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

export async function macNotify(message, { run = defaultRun } = {}) {
  if (process.platform !== 'darwin') return false;
  const text = String(message ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${escaped}" with title "Swarm"`;
  try {
    await run('osascript', ['-e', script]);
    return true;
  } catch {
    return false;
  }
}
