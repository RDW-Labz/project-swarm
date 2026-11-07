#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { redactUrl } from './watch-perf.mjs';

const execFileAsync = promisify(execFile);

function ensurePlaywrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const home = process.env.SWARM_REAL_HOME;
  if (!home) return;
  for (const candidate of [
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'),
  ]) {
    if (fs.existsSync(candidate)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = candidate;
      return;
    }
  }
}

function findBundledHeadlessShell(browsersPath) {
  let entries;
  try {
    entries = fs.readdirSync(browsersPath).filter((name) => name.startsWith('chromium_headless_shell-'));
  } catch {
    return null;
  }
  for (const dir of entries.sort().reverse()) {
    for (const leaf of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const full = path.join(browsersPath, dir, leaf);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function chromiumLaunchOptions() {
  ensurePlaywrightBrowsersPath();
  if (process.env.SWARM_CC_CHROMIUM) {
    return { headless: true, executablePath: process.env.SWARM_CC_CHROMIUM };
  }
  const shell = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? findBundledHeadlessShell(process.env.PLAYWRIGHT_BROWSERS_PATH)
    : null;
  if (shell) return { headless: true, executablePath: shell };
  return { headless: true };
}

async function launchChromium() {
  ensurePlaywrightBrowsersPath();
  const { chromium } = await import('playwright');
  return chromium.launch(chromiumLaunchOptions());
}

const PROFILES = {
  desktop: { width: 1440, height: 900, throttle: null },
  phone: {
    width: 390,
    height: 844,
    throttle: {
      offline: false,
      latency: 100,
      downloadThroughput: Math.floor((1.6 * 1_000_000) / 8),
      uploadThroughput: Math.floor((750 * 1_000) / 8),
      connectionType: 'cellular4g',
    },
  },
};

function usage() {
  return `Usage: node tools/watch-live-latency.mjs URL [--project-root DIR] [--project-id ID] [--change-cmd CMD] [--revert-cmd CMD] [--builtin inbox|tickets] [--runs N] [--profile desktop|phone] [--out FILE] [--wait-ms MS]`;
}

function parseArgs(argv) {
  const positional = [];
  const opts = {
    out: null,
    profile: 'desktop',
    projectRoot: null,
    projectId: null,
    changeCmd: null,
    revertCmd: null,
    builtin: null,
    runs: 3,
    waitMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      opts.out = argv[++i];
      continue;
    }
    if (arg === '--profile') {
      opts.profile = argv[++i];
      if (!PROFILES[opts.profile]) throw new Error(`unknown profile ${opts.profile}`);
      continue;
    }
    if (arg === '--project-root') {
      opts.projectRoot = argv[++i];
      continue;
    }
    if (arg === '--project-id') {
      opts.projectId = argv[++i];
      continue;
    }
    if (arg === '--change-cmd') {
      opts.changeCmd = argv[++i];
      continue;
    }
    if (arg === '--revert-cmd') {
      opts.revertCmd = argv[++i];
      continue;
    }
    if (arg === '--builtin') {
      opts.builtin = argv[++i];
      continue;
    }
    if (arg === '--runs') {
      opts.runs = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(opts.runs) || opts.runs < 1) throw new Error('--runs requires a positive integer');
      continue;
    }
    if (arg === '--wait-ms') {
      opts.waitMs = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`);
    positional.push(arg);
  }
  const url = positional[0];
  if (!url) throw new Error(usage());
  if (positional.length > 1) throw new Error(usage());
  return { url, ...opts };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runShell(cmd, cwd) {
  await execFileAsync(process.env.SHELL || '/bin/sh', ['-c', cmd], { cwd });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, body) {
  await writeFile(file, `${JSON.stringify(body)}\n`, 'utf8');
}

export function buildBuiltinHandlers({ projectRoot, kind }) {
  if (!projectRoot) throw new Error('--project-root is required for --builtin');
  if (kind === 'inbox') {
    const inbox = path.join(projectRoot, '.swarm/inbox/state.json');
    return {
      async prepare() {
        const state = await readJson(inbox);
        const base = Number(state.needsYou ?? 0);
        return { inbox, base, next: base + 1 };
      },
      async apply(ctx) {
        await writeJson(ctx.inbox, { needsYou: ctx.next });
        return ctx.next;
      },
      async revert(ctx) {
        await writeJson(ctx.inbox, { needsYou: ctx.base });
      },
      selectorValue: (ctx) => ctx.next,
    };
  }
  if (kind === 'tickets') {
    const tickets = path.join(projectRoot, '.swarm/project/tickets.json');
    return {
      async prepare() {
        const ledger = await readJson(tickets);
        const ticket = ledger.tickets?.[0];
        if (!ticket) throw new Error('no tickets in ledger');
        return { tickets, ticketId: ticket.id, baseStatus: ticket.status, nextStatus: ticket.status === 'running' ? 'done' : 'running' };
      },
      async apply(ctx) {
        const ledger = await readJson(ctx.tickets);
        ledger.tickets = ledger.tickets.map((t) => (
          t.id === ctx.ticketId ? { ...t, status: ctx.nextStatus, doneAt: ctx.nextStatus === 'done' ? new Date().toISOString() : undefined } : t
        ));
        await writeJson(ctx.tickets, ledger);
        return ctx.nextStatus;
      },
      async revert(ctx) {
        const ledger = await readJson(ctx.tickets);
        ledger.tickets = ledger.tickets.map((t) => (
          t.id === ctx.ticketId ? { ...t, status: ctx.baseStatus, doneAt: undefined } : t
        ));
        await writeJson(ctx.tickets, ledger);
      },
      selectorValue: () => null,
    };
  }
  throw new Error(`unknown builtin ${kind}`);
}

export async function waitForLiveUpdate(page, { projectId, statValue, timeoutMs }) {
  await page.waitForFunction(({ projectId, statValue }) => {
    if (statValue == null) return false;
    const counters = document.querySelector('[data-k="need you"]')
      || document.querySelector('[data-stat-key="needsYouCount"] .command-center-stat-value');
    if (counters && counters.textContent.trim() === String(statValue)) return true;
    if (projectId) {
      const card = document.querySelector(`[data-project-id="${projectId}"]`);
      const legacy = card?.querySelector('.num.needs-you');
      if (legacy && legacy.textContent.trim() === String(statValue)) return true;
      const pill = card?.querySelector('.hive-pill--need');
      if (statValue > 0 && pill && pill.textContent.includes(String(statValue))) return true;
      if (statValue === 0 && card && !pill) return true;
    }
    return false;
  }, { projectId, statValue }, { timeout: timeoutMs });
}

export async function measureLiveLatency(opts) {
  const profile = PROFILES[opts.profile];
  const latencies = [];
  let fullSnapshotFetches = 0;
  let fullSnapshotFetchesDuringUpdates = 0;
  let browser;

  const useBuiltin = opts.builtin != null;
  const builtin = useBuiltin
    ? buildBuiltinHandlers({ projectRoot: opts.projectRoot, kind: opts.builtin })
    : null;
  if (!useBuiltin && (!opts.changeCmd || !opts.revertCmd)) {
    throw new Error('provide --change-cmd and --revert-cmd or --builtin');
  }

  try {
    browser = await launchChromium();
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    if (profile.throttle) {
      await cdp.send('Network.emulateNetworkConditions', profile.throttle);
    }

    const trackFullSnapshot = (request) => {
      try {
        const u = new URL(request.url());
        if (u.pathname === '/api/command-center' && request.method() === 'GET') fullSnapshotFetches += 1;
      } catch {
        /* ignore */
      }
    };
    page.on('request', trackFullSnapshot);

    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.waitMs });
    await page.waitForSelector('[data-project-id], [data-stat-key], [data-k="need you"]', { timeout: opts.waitMs });
    await page.waitForFunction(() => {
      const stat = document.querySelector('[data-k="need you"]')
        || document.querySelector('[data-stat-key="needsYouCount"] .command-center-stat-value');
      return stat && stat.textContent.trim().length > 0;
    }, null, { timeout: opts.waitMs });

    const bootFullFetches = fullSnapshotFetches;
    fullSnapshotFetches = 0;

    let ctx = useBuiltin ? await builtin.prepare() : null;
    for (let run = 0; run < opts.runs; run += 1) {
      const fetchBefore = fullSnapshotFetches;
      const started = performance.now();
      if (useBuiltin) {
        const expected = await builtin.apply(ctx);
        ctx.expected = expected;
        await waitForLiveUpdate(page, {
          projectId: opts.projectId,
          statValue: opts.builtin === 'inbox' ? expected : null,
          timeoutMs: opts.waitMs,
        });
      } else {
        await runShell(opts.changeCmd, opts.projectRoot || process.cwd());
        await waitForLiveUpdate(page, {
          projectId: opts.projectId,
          statValue: null,
          timeoutMs: opts.waitMs,
        });
      }
      latencies.push(Math.round(performance.now() - started));
      fullSnapshotFetchesDuringUpdates += fullSnapshotFetches - fetchBefore;
      if (useBuiltin) {
        await builtin.revert(ctx);
        await waitForLiveUpdate(page, {
          projectId: opts.projectId,
          statValue: ctx.base,
          timeoutMs: opts.waitMs,
        });
        ctx = await builtin.prepare();
      } else if (opts.revertCmd) {
        await runShell(opts.revertCmd, opts.projectRoot || process.cwd());
        await page.waitForTimeout(500);
      }
    }

    return {
      url: redactUrl(opts.url),
      profile: opts.profile,
      runs: opts.runs,
      latenciesMs: latencies,
      medianMs: Math.round(median(latencies)),
      bootFullSnapshotFetches: bootFullFetches,
      fullSnapshotFetchesAfterReady: fullSnapshotFetches,
      fullSnapshotFetchesDuringUpdates,
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

  try {
    const result = await measureLiveLatency(opts);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (opts.out) {
      await writeFile(opts.out, json, 'utf8');
    } else {
      process.stdout.write(json);
    }
    console.error(`live latency median=${result.medianMs}ms runs=${result.latenciesMs.join(',')} fullAfterReady=${result.fullSnapshotFetchesAfterReady}`);
  } catch (err) {
    console.error(String(err.message || err).replace(/([?&])t=([^&#]*)/gi, '$1t=…'));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
