#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parsePsTime, redactUrl } from './watch-perf.mjs';

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

const SAMPLE_INTERVAL_MS = 30_000;
// Allow the one-time build peak while bounding a real leak (~1 MB/minute over an hour).
const RSS_GROWTH_KB_MAX = 65536;
const HEAP_GROWTH_BYTES_MAX = 2 * 1024 * 1024;
const CPU_AVG_MAX = 5;

function usage() {
  return `Usage: node tools/watch-soak.mjs URL [--minutes N] [--seconds N] [--out FILE] [--profile desktop|phone] [--server-pid PID] [--wait-ms MS]`;
}

function parseArgs(argv) {
  const positional = [];
  const opts = {
    out: null,
    profile: 'desktop',
    serverPid: null,
    minutes: 60,
    seconds: null,
    waitMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      opts.out = argv[++i];
      if (!opts.out) throw new Error('--out requires a path');
      continue;
    }
    if (arg === '--profile') {
      opts.profile = argv[++i];
      if (!PROFILES[opts.profile]) throw new Error(`unknown profile ${opts.profile}`);
      continue;
    }
    if (arg === '--server-pid') {
      const raw = argv[++i];
      opts.serverPid = Number.parseInt(raw, 10);
      if (!Number.isFinite(opts.serverPid)) throw new Error('--server-pid requires a number');
      continue;
    }
    if (arg === '--minutes') {
      opts.minutes = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(opts.minutes)) throw new Error('--minutes requires a number');
      continue;
    }
    if (arg === '--seconds') {
      opts.seconds = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(opts.seconds)) throw new Error('--seconds requires a number');
      continue;
    }
    if (arg === '--wait-ms') {
      opts.waitMs = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(opts.waitMs)) throw new Error('--wait-ms requires a number');
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`);
    positional.push(arg);
  }
  const url = positional[0];
  if (!url) throw new Error(usage());
  if (positional.length > 1) throw new Error(usage());
  const durationMs = opts.seconds != null
    ? Math.max(0, opts.seconds * 1000)
    : Math.max(0, opts.minutes * 60 * 1000);
  return { url, durationMs, ...opts };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seriesStats(values) {
  if (!values.length) {
    return { first: null, last: null, average: null, slopePerSample: null };
  }
  const first = values[0];
  const last = values.at(-1);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const slopePerSample = values.length > 1 ? (last - first) / (values.length - 1) : 0;
  return { first, last, average, slopePerSample };
}

function steadyMemoryStats(values, steadyValues) {
  // Short runs can end before warm-up finishes; retain their available endpoints.
  const available = steadyValues.length ? steadyValues : values;
  const medianOfThree = (window) => [...window].sort((a, b) => a - b)[1];
  const baseline = available.length >= 6 ? medianOfThree(available.slice(0, 3)) : available[0] ?? null;
  const tail = available.length >= 6 ? medianOfThree(available.slice(-3)) : available.at(-1) ?? null;
  return { baseline, tail, growth: baseline == null ? 0 : Math.round(tail - baseline) };
}

function monotonicGrowth(values) {
  if (values.length < 2) return false;
  let grew = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) grew += 1;
    else if (values[i] < values[i - 1]) return false;
  }
  return grew > 0 && grew === values.length - 1;
}

/** Average CPU over one wall-clock interval; missing baselines are warm-up samples. */
export function intervalCpuPercent(prevCpuSeconds, nextCpuSeconds, elapsedMs) {
  if (!Number.isFinite(prevCpuSeconds) || !Number.isFinite(nextCpuSeconds)
    || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return Math.max(0, (nextCpuSeconds - prevCpuSeconds) / (elapsedMs / 1000) * 100);
}

export function summarizeSoak(samples) {
  const rssKb = samples.map((s) => s.serverRssKb).filter((v) => v != null);
  // The first sample only establishes cumulative CPU time and is excluded here.
  const cpu = samples.map((s) => s.serverCpuPercent).filter((v) => v != null);
  const heap = samples.map((s) => s.pageHeapBytes).filter((v) => v != null);
  const connections = samples.map((s) => s.eventSourceConnections);
  const watchers = samples.map((s) => s.watcherHandles);
  const apiRequests = samples.map((s) => s.apiRequestCount);

  // Page load and the first build are warm-up, regardless of telemetry availability.
  const steadySamples = samples.slice(2);
  const rssTrend = steadyMemoryStats(rssKb,
    steadySamples.map((s) => s.serverRssKb).filter((v) => v != null));
  const heapTrend = steadyMemoryStats(heap,
    steadySamples.map((s) => s.pageHeapBytes).filter((v) => v != null));
  const memory = {
    serverRssKb: {
      ...seriesStats(rssKb),
      steadyBaselineKb: rssTrend.baseline,
      steadyTailKb: rssTrend.tail,
      steadyGrowthKb: rssTrend.growth,
    },
    pageHeapBytes: {
      ...seriesStats(heap),
      steadyBaselineBytes: heapTrend.baseline,
      steadyTailBytes: heapTrend.tail,
      steadyGrowthBytes: heapTrend.growth,
    },
  };
  const cpuStats = seriesStats(cpu);

  const rssGrowth = rssTrend.growth;
  const heapGrowth = heapTrend.growth;
  const cpuOk = cpuStats.average == null || cpuStats.average < CPU_AVG_MAX;
  const memoryOk = rssGrowth <= RSS_GROWTH_KB_MAX && heapGrowth <= HEAP_GROWTH_BYTES_MAX;
  const connectionsOk = !monotonicGrowth(connections);
  const watchersOk = !monotonicGrowth(watchers);
  const flat = memoryOk && cpuOk && connectionsOk && watchersOk;

  return {
    memory,
    cpu: cpuStats,
    connections: { series: connections, ...seriesStats(connections) },
    watchers: { series: watchers, ...seriesStats(watchers) },
    apiRequests: { series: apiRequests, ...seriesStats(apiRequests) },
    thresholds: {
      rssGrowthKbMax: RSS_GROWTH_KB_MAX,
      heapGrowthBytesMax: HEAP_GROWTH_BYTES_MAX,
      cpuAverageMax: CPU_AVG_MAX,
    },
    verdict: flat ? 'flat' : 'leak',
    reasons: [
      ...(memoryOk ? [] : [`memory growth rss=${rssGrowth}kb heap=${heapGrowth}b`]),
      ...(cpuOk ? [] : [`cpu average ${cpuStats.average?.toFixed(2)}%`]),
      ...(connectionsOk ? [] : ['monotonic EventSource connection growth']),
      ...(watchersOk ? [] : ['monotonic file-watcher handle growth']),
    ],
  };
}

async function readServerRssCpu(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=,time=', '-p', String(pid)]);
    const line = stdout.trim();
    const match = /^(\d+)\s+(\S+)$/.exec(line);
    if (!match) return { rssKb: null, cpuSeconds: null };
    return { rssKb: Number.parseInt(match[1], 10), cpuSeconds: parsePsTime(match[2]) };
  } catch {
    return { rssKb: null, cpuSeconds: null };
  }
}

async function readWatcherHandles(pid) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-p${pid}`]);
    return stdout.split('\n').filter((line) => line.includes('.swarm/')).length;
  } catch {
    return null;
  }
}

async function readPageHeap(cdp) {
  try {
    const usage = await cdp.send('Runtime.getHeapUsage');
    if (usage && Number.isFinite(usage.usedSize)) return usage.usedSize;
  } catch {
    /* fall through */
  }
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const hit = metrics.find((m) => m.name === 'JSHeapUsedSize');
    return hit ? hit.value : null;
  } catch {
    return null;
  }
}

async function countServerTcpConnections(pid) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP']);
    return stdout.split('\n').filter((line) => line.includes('ESTABLISHED')).length;
  } catch {
    return null;
  }
}

export async function runSoak(opts) {
  const profile = PROFILES[opts.profile];
  const samples = [];
  let apiRequestCount = 0;
  let browser;
  const startedAt = Date.now();

  try {
    browser = await launchChromium();
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
    });
    await context.addInitScript(() => {
      const Native = globalThis.EventSource;
      if (typeof Native !== 'function') return;
      let open = 0;
      globalThis.__swarmCcEventSourcesOpen = () => open;
      globalThis.EventSource = class extends Native {
        constructor(...args) {
          super(...args);
          open += 1;
          this.addEventListener('error', () => {
            if (!this.__swarmCountedClosed) {
              this.__swarmCountedClosed = true;
              open = Math.max(0, open - 1);
            }
          });
        }
        close() {
          if (!this.__swarmCountedClosed) {
            this.__swarmCountedClosed = true;
            open = Math.max(0, open - 1);
          }
          return super.close();
        }
      };
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Runtime.enable');
    await cdp.send('Performance.enable');
    if (profile.throttle) {
      await cdp.send('Network.emulateNetworkConditions', profile.throttle);
    }

    page.on('response', (response) => {
      try {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/')) apiRequestCount += 1;
      } catch {
        /* ignore */
      }
    });

    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.waitMs });
    await page.waitForSelector('[data-project-id], [data-stat-key], [data-k="need you"]', { timeout: opts.waitMs });
    await page.waitForTimeout(Math.min(5000, Math.max(1000, opts.durationMs / 4)));

    async function takeSample() {
      const server = opts.serverPid != null ? await readServerRssCpu(opts.serverPid) : { rssKb: null, cpuSeconds: null };
      const at = new Date().toISOString();
      const previous = samples.at(-1);
      const cpuPercent = intervalCpuPercent(previous?.serverCpuSeconds, server.cpuSeconds,
        Date.parse(at) - Date.parse(previous?.at));
      const heap = await readPageHeap(cdp);
      const eventSources = await page.evaluate(() => (
        typeof globalThis.__swarmCcEventSourcesOpen === 'function' ? globalThis.__swarmCcEventSourcesOpen() : 0
      ));
      const tcpConnections = opts.serverPid != null ? await countServerTcpConnections(opts.serverPid) : null;
      const watcherHandles = opts.serverPid != null ? await readWatcherHandles(opts.serverPid) : null;
      return {
        at,
        serverRssKb: server.rssKb,
        serverCpuSeconds: server.cpuSeconds,
        serverCpuPercent: cpuPercent,
        pageHeapBytes: heap,
        eventSourceConnections: eventSources,
        tcpConnections,
        watcherHandles,
        apiRequestCount,
      };
    }

    samples.push(await takeSample());
    let elapsed = 0;
    while (elapsed + SAMPLE_INTERVAL_MS <= opts.durationMs) {
      await sleep(SAMPLE_INTERVAL_MS);
      elapsed += SAMPLE_INTERVAL_MS;
      samples.push(await takeSample());
    }
    const remaining = opts.durationMs - elapsed;
    if (remaining > 0 && samples.length === 1) {
      await sleep(remaining);
      samples.push(await takeSample());
    }

    const summary = summarizeSoak(samples);
    const result = {
      url: redactUrl(opts.url),
      profile: opts.profile,
      durationSeconds: opts.durationMs / 1000,
      sampleIntervalSeconds: SAMPLE_INTERVAL_MS / 1000,
      sampleCount: samples.length,
      samples,
      ...summary,
      elapsedMs: Date.now() - startedAt,
    };
    return result;
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
    const result = await runSoak(opts);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (opts.out) {
      await writeFile(opts.out, json, 'utf8');
    } else {
      process.stdout.write(json);
    }
    if (result.verdict !== 'flat') {
      process.exitCode = 1;
      console.error(`soak verdict=${result.verdict} ${result.reasons.join('; ')}`);
    } else {
      console.error(`soak verdict=flat samples=${result.sampleCount} connections=${result.connections.last} watchers=${result.watchers.last}`);
    }
  } catch (err) {
    console.error(String(err.message || err).replace(/([?&])t=([^&#]*)/gi, '$1t=…'));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
