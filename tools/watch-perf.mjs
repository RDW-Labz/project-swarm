#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/** Redact watch-board token from `t=` query param (never log or persist raw token). */
export function redactUrl(url) {
  if (typeof url !== 'string' || url === '') return url;
  return url.replace(/([?&])t=([^&#]*)/gi, '$1t=…');
}

function redactErrorText(text, rawUrl) {
  let s = String(text ?? '');
  if (rawUrl) s = s.split(rawUrl).join(redactUrl(rawUrl));
  return s.replace(/([?&])t=([^&#]*)/gi, '$1t=…');
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
  return `Usage: node tools/watch-perf.mjs URL [--out FILE] [--profile desktop|phone] [--server-pid PID] [--idle SECONDS] [--wait-ms MS]`;
}

function parseArgs(argv) {
  const positional = [];
  const opts = {
    out: null,
    profile: 'desktop',
    serverPid: null,
    idle: 45,
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
    if (arg === '--idle') {
      opts.idle = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(opts.idle)) throw new Error('--idle requires a number');
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
  return { url, ...opts };
}

function emptyBytes() {
  return { total: 0, api: 0, html: 0, js: 0, css: 0, fonts: 0 };
}

function bucketForUrl(urlString, resourceType) {
  let pathname = urlString;
  try {
    pathname = new URL(urlString).pathname;
  } catch {
    /* keep raw */
  }
  const lower = pathname.toLowerCase();
  if (lower.includes('/api/') || lower.startsWith('/api')) return 'api';
  if (resourceType === 'document' || lower.endsWith('.html') || lower === '/command-center') return 'html';
  if (resourceType === 'stylesheet' || lower.endsWith('.css')) return 'css';
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(lower)) return 'fonts';
  if (resourceType === 'script' || lower.endsWith('.js') || lower.endsWith('.mjs')) return 'js';
  return null;
}

function parsePsTime(text) {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  if (s.includes('-')) {
    const [days, rest] = s.split('-');
    return parsePsTime(rest) + Number.parseInt(days, 10) * 86400;
  }
  const parts = s.split(':').map((p) => Number.parseFloat(p));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number.parseFloat(s) || 0;
}

async function readServerCpu(pid) {
  const { stdout } = await execFileAsync('ps', ['-o', 'time=', '-p', String(pid)]);
  return parsePsTime(stdout);
}

async function doubleRaf(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

function createByteTracker(onFinished) {
  const requestUrls = new Map();
  return {
    noteRequest(requestId, url, resourceType) {
      requestUrls.set(requestId, { url, resourceType });
    },
    noteEncoded(requestId, encodedDataLength) {
      const meta = requestUrls.get(requestId);
      if (!meta || !encodedDataLength) return;
      onFinished(meta.url, meta.resourceType, encodedDataLength);
    },
  };
}

function createNetworkCollector(segmentRef, cacheControl) {
  const segments = {
    boot: emptyBytes(),
    hiveToCockpit: emptyBytes(),
    cockpitToHive: emptyBytes(),
  };

  const addBytes = (segment, url, resourceType, encoded) => {
    if (!segments[segment]) return;
    const bucket = bucketForUrl(url, resourceType);
    const row = segments[segment];
    row.total += encoded;
    if (bucket) row[bucket] += encoded;
  };

  const tracker = createByteTracker((url, resourceType, encoded) => {
    addBytes(segmentRef.current, url, resourceType, encoded);
  });

  return {
    segments,
    tracker,
    setCacheHeader(url, resourceType, header) {
      const bucket = bucketForUrl(url, resourceType);
      if (bucket === 'js' || bucket === 'css' || bucket === 'fonts') {
        cacheControl[bucket].set(url, header ?? '');
      }
    },
  };
}

async function taskDurationSeconds(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const hit = metrics.find((m) => m.name === 'TaskDuration');
  return hit ? hit.value : 0;
}

function summarize(result) {
  const lines = [
    `profile=${result.profile} timeToUsable=${result.timings.timeToUsableMs.toFixed(1)}ms`,
    `hive→cockpit=${result.timings.hiveToCockpitMs.toFixed(1)}ms cockpit→hive=${result.timings.cockpitToHiveMs.toFixed(1)}ms`,
    `boot bytes total=${result.bytes.boot.total} api=${result.bytes.boot.api} js=${result.bytes.boot.js} css=${result.bytes.boot.css}`,
    `idle ${result.idle.seconds}s pageTaskDurationΔ=${result.idle.pageTaskDurationSeconds.toFixed(3)}s apiReq=${result.idle.apiRequests} apiBytes=${result.idle.apiBytes}`,
  ];
  if (result.idle.serverCpuSeconds != null) {
    lines.push(`serverCpuΔ=${result.idle.serverCpuSeconds.toFixed(3)}s`);
  }
  if (result.consoleErrors.length) {
    lines.push(`consoleErrors=${result.consoleErrors.length}`);
  }
  return lines.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

  const profile = PROFILES[opts.profile];
  const cacheControl = { js: new Map(), css: new Map(), fonts: new Map() };
  const segmentRef = { current: 'boot' };
  const net = createNetworkCollector(segmentRef, cacheControl);
  const consoleErrors = [];
  const idleApi = { requests: 0, bytes: 0 };

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SWARM_CC_CHROMIUM ? { executablePath: process.env.SWARM_CC_CHROMIUM } : {}),
    });
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');

    if (profile.throttle) {
      await cdp.send('Network.emulateNetworkConditions', profile.throttle);
    }

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err.message || err)));

    cdp.on('Network.requestWillBeSent', ({ requestId, request, type }) => {
      net.tracker.noteRequest(requestId, request.url, type || request.resourceType);
    });
    cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
      net.tracker.noteEncoded(requestId, encodedDataLength);
    });

    page.on('response', async (response) => {
      if (segmentRef.current !== 'idle') {
        const request = response.request();
        net.setCacheHeader(request.url(), request.resourceType(), response.headers()['cache-control']);
        return;
      }
      const url = response.url();
      if (!url.includes('/api/')) return;
      idleApi.requests += 1;
      try {
        const sizes = await response.request().sizes();
        idleApi.bytes += sizes.responseBodySize + sizes.responseHeadersSize;
      } catch {
        /* ignore */
      }
    });

    const nav = page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.waitMs });
    await nav;

    await page.waitForSelector('[data-project-id]', { timeout: opts.waitMs });
    const timeToUsableMs = await page.evaluate(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const entry = performance.getEntriesByType('navigation')[0];
      const start = entry?.startTime ?? 0;
      return performance.now() - start;
    });

    segmentRef.current = 'hiveToCockpit';
    const hiveToCockpitMs = await page.evaluate(async () => {
      const node = document.querySelector('.hive-node') || document.querySelector('[data-project-id]');
      if (!node) throw new Error('no project node to click');
      const started = performance.now();
      node.click();
      while (!document.querySelector('.cc-cockpit-shell')) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      return performance.now() - started;
    });

    segmentRef.current = 'cockpitToHive';
    const cockpitToHiveMs = await page.evaluate(async () => {
      const back = document.querySelector('.cc-cockpit-back-btn');
      if (!back) throw new Error('no cockpit back control');
      const started = performance.now();
      back.click();
      while (!document.querySelector('.hive-node')) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      return performance.now() - started;
    });

    segmentRef.current = 'idle';
    const pageTaskBefore = await taskDurationSeconds(cdp);
    const serverCpuBefore = opts.serverPid != null ? await readServerCpu(opts.serverPid) : null;
    await page.waitForTimeout(Math.max(0, opts.idle * 1000));
    const pageTaskAfter = await taskDurationSeconds(cdp);
    const serverCpuAfter = opts.serverPid != null ? await readServerCpu(opts.serverPid) : null;

    const result = {
      url: redactUrl(opts.url),
      profile: opts.profile,
      viewport: { width: profile.width, height: profile.height },
      timings: {
        timeToUsableMs,
        hiveToCockpitMs,
        cockpitToHiveMs,
      },
      bytes: net.segments,
      cacheControl: {
        js: Object.fromEntries(cacheControl.js),
        css: Object.fromEntries(cacheControl.css),
        fonts: Object.fromEntries(cacheControl.fonts),
      },
      idle: {
        seconds: opts.idle,
        pageTaskDurationSeconds: Math.max(0, pageTaskAfter - pageTaskBefore),
        serverCpuSeconds: serverCpuBefore != null && serverCpuAfter != null
          ? Math.max(0, serverCpuAfter - serverCpuBefore)
          : null,
        apiRequests: idleApi.requests,
        apiBytes: idleApi.bytes,
      },
      consoleErrors: consoleErrors.map((line) => redactErrorText(line, opts.url)),
    };

    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (opts.out) {
      await writeFile(opts.out, json, 'utf8');
    } else {
      process.stdout.write(json);
    }
    console.error(summarize(result));
  } catch (err) {
    console.error(redactErrorText(err.message || err, opts?.url));
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
