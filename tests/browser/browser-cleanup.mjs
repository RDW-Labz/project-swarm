// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import process from 'node:process';

function defaultWait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultListProcesses() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    });
  }
  return rows;
}

function defaultIsAlive(pid, { listProcesses = defaultListProcesses } = {}) {
  if (!isKillablePid(pid)) return false;
  const list = listProcesses();
  return list.some((row) => row.pid === pid);
}

function defaultKillProcess(pid, signal, { group = false } = {}) {
  if (!isKillablePid(pid)) return;
  const target = group ? -pid : pid;
  process.kill(target, signal);
}

function isKillablePid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

/**
 * @param {import('playwright').Browser} browser
 */
export function trackBrowser(browser) {
  const proc = browser.process();
  const pid = proc?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('trackBrowser: browser.process() did not return a pid');
  }
  return { pid, closed: false };
}

/**
 * @param {number} rootPid
 * @param {{ pid: number, ppid: number }[]} processList
 * @returns {number[]}
 */
export function descendantPids(rootPid, processList) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const children = new Map();
  for (const row of processList) {
    if (!Number.isInteger(row.pid) || !Number.isInteger(row.ppid)) continue;
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const out = [];
  const stack = [...(children.get(rootPid) ?? [])];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = children.get(pid);
    if (kids) stack.push(...kids);
  }
  return out;
}

function trackedTreePids(tracked, listProcesses) {
  if (!tracked?.pid) return [];
  const list = listProcesses();
  const desc = descendantPids(tracked.pid, list);
  const aliveRoot = list.some((row) => row.pid === tracked.pid);
  return aliveRoot ? [tracked.pid, ...desc] : desc;
}

function pidsStillAlive(pids, isAlive, deps) {
  const alive = [];
  for (const pid of pids) {
    if (isKillablePid(pid) && isAlive(pid, deps)) alive.push(pid);
  }
  return alive;
}

async function waitForPidsExit(pids, timeoutMs, { isAlive, wait, ...deps }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pidsStillAlive(pids, isAlive, deps);
    if (!alive.length) return;
    await wait(50);
  }
}

/**
 * @param {{
 *   browser?: import('playwright').Browser,
 *   context?: import('playwright').BrowserContext,
 *   pages?: import('playwright').Page[],
 *   tracked?: { pid: number, closed?: boolean },
 *   listProcesses?: typeof defaultListProcesses,
 *   killProcess?: typeof defaultKillProcess,
 *   isAlive?: typeof defaultIsAlive,
 *   wait?: typeof defaultWait,
 * }} opts
 */
export async function closeBrowserFully(opts = {}) {
  const listProcesses = opts.listProcesses ?? defaultListProcesses;
  const killProcess = opts.killProcess ?? defaultKillProcess;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const wait = opts.wait ?? defaultWait;
  const deps = { listProcesses, killProcess, isAlive, wait };

  const pages = Array.isArray(opts.pages) ? opts.pages : [];
  for (const page of pages) {
    try {
      if (page) await page.close();
    } catch {
      /* continue closing */
    }
  }

  try {
    if (opts.context) await opts.context.close();
  } catch {
    /* continue */
  }

  try {
    if (opts.browser) await opts.browser.close();
  } catch {
    /* continue */
  }

  const tracked = opts.tracked;
  if (!tracked?.pid || tracked.closed) return;
  tracked.closed = true;

  const rootPid = tracked.pid;
  const treePids = () => {
    const desc = descendantPids(rootPid, listProcesses());
    return [rootPid, ...desc];
  };

  await waitForPidsExit(treePids(), 3000, deps);

  let alive = pidsStillAlive(treePids(), isAlive, deps);
  if (alive.length && isKillablePid(rootPid) && isAlive(rootPid, deps)) {
    try {
      killProcess(rootPid, 'SIGTERM', { group: true });
    } catch {
      /* may already be gone */
    }
  }

  await wait(1000);

  const afterTerm = treePids();
  const stillOnGroup = pidsStillAlive(
    afterTerm.filter((pid) => pid === rootPid),
    isAlive,
    deps,
  );
  if (stillOnGroup.length && isKillablePid(rootPid)) {
    try {
      killProcess(rootPid, 'SIGKILL', { group: true });
    } catch {
      /* continue */
    }
  }

  await wait(50);

  const descendants = descendantPids(rootPid, listProcesses());
  for (const pid of descendants) {
    if (!isKillablePid(pid)) continue;
    if (!isAlive(pid, deps)) continue;
    try {
      killProcess(pid, 'SIGKILL', { group: false });
    } catch {
      /* continue */
    }
  }
}

/**
 * @param {{ pid: number }} tracked
 * @param {{ listProcesses?: typeof defaultListProcesses, isAlive?: typeof defaultIsAlive }} [injected]
 */
export function assertNoLeftoverBrowser(tracked, injected = {}) {
  const listProcesses = injected.listProcesses ?? defaultListProcesses;
  const isAlive = injected.isAlive ?? defaultIsAlive;
  const deps = { listProcesses, ...injected };

  if (!tracked?.pid) return;

  const list = listProcesses();
  const desc = descendantPids(tracked.pid, list);
  const leftovers = [];
  const rootAlive = isKillablePid(tracked.pid) && isAlive(tracked.pid, deps);
  if (rootAlive) {
    const row = list.find((r) => r.pid === tracked.pid);
    leftovers.push({ pid: tracked.pid, command: row?.command ?? '(unknown)' });
  }
  for (const pid of desc) {
    if (!isKillablePid(pid)) continue;
    if (!isAlive(pid, deps)) continue;
    const row = list.find((r) => r.pid === pid);
    leftovers.push({ pid, command: row?.command ?? '(unknown)' });
  }
  if (!leftovers.length) return;

  const parts = leftovers.map((l) => `pid ${l.pid} (${l.command})`);
  throw new Error(`leftover browser process(es): ${parts.join('; ')}`);
}
