// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { diffSnapshots, createThrottle } from './watch-delta.mjs';
import { versionInfo } from './server-version.mjs';
import { screenshotPath } from './watch-gallery.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const SECURITY = {
  'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const IDLE_FINISHED_MS = 10000;
const MAX_STREAMS = 8;
export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
const MAX_STREAM_PAUSED_MS = 60000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  const size = Math.max(x.length, y.length);
  const xx = Buffer.alloc(size);
  const yy = Buffer.alloc(size);
  x.copy(xx);
  y.copy(yy);
  return timingSafeEqual(xx, yy) && x.length === y.length;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[!#$%&'()*+\-.\/0-9:<=>?@A-Z[\\\]^_`a-z{|}~]*$/;

function watchCookie(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  const pairs = [];
  for (const raw of header.split(';')) {
    const part = raw.trim();
    const at = part.indexOf('=');
    if (!part || at <= 0 || !COOKIE_NAME.test(part.slice(0, at).trim())) return null;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!COOKIE_VALUE.test(value)) return null;
    pairs.push([name, value]);
  }
  const matches = pairs.filter(([name]) => name === 'swarm_watch');
  return matches.length === 1 ? matches[0][1] : null;
}

function send(res, method, status, headers, body) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(method === 'HEAD' ? undefined : body);
}

function sendText(res, method, status, msg) {
  send(res, method, status, { 'Content-Type': 'text/plain; charset=utf-8' }, msg);
}

function sendJson(res, method, obj) {
  send(res, method, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj));
}

function sse(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

export function createWatchStreamManager({ getRunSnapshot, now = Date.now, onDrop = () => {}, onClose = () => {} }) {
  const streams = new Set();
  let latestSnapshot = null;

  function dropStream(stream, end = false) {
    if (!streams.delete(stream)) return;
    onDrop(stream);
    if (end) {
      try {
        stream.res.end();
      } catch {
        // already closed
      }
    }
  }

  function writableLength(stream) {
    return Number.isFinite(stream.res.writableLength) ? stream.res.writableLength : 0;
  }

  function shouldDrop(stream) {
    return writableLength(stream) > MAX_STREAM_BUFFER_BYTES
      || (stream.paused && now() - stream.pausedAt > MAX_STREAM_PAUSED_MS);
  }

  function pause(stream) {
    if (!stream.paused) {
      stream.paused = true;
      stream.pausedAt = now();
    }
  }

  function write(stream, chunk) {
    try {
      const ok = stream.res.write(chunk);
      if (!ok) pause(stream);
      return ok;
    } catch {
      dropStream(stream, true);
      return false;
    }
  }

  function open(res, run) {
    latestSnapshot = run;
    const stream = {
      res,
      prev: run,
      paused: false,
      pausedAt: null,
      throttle: createThrottle(250, now),
    };
    streams.add(stream);
    res.on('close', () => {
      dropStream(stream);
      onClose();
    });
    res.on('drain', () => {
      if (!streams.has(stream) || !stream.paused) return;
      if (shouldDrop(stream)) {
        dropStream(stream, true);
        return;
      }
      const next = latestSnapshot;
      const ok = write(stream, sse('snapshot', next));
      stream.prev = next;
      if (ok) {
        stream.paused = false;
        stream.pausedAt = null;
      }
    });
    try {
      write(stream, sse('snapshot', run));
    } catch {
      dropStream(stream, true);
    }
    return stream;
  }

  function writeHeartbeats() {
    const line = ': ping\n\n' + sse('ping', {});
    for (const stream of [...streams]) {
      if (shouldDrop(stream)) {
        dropStream(stream, true);
        continue;
      }
      if (stream.paused && writableLength(stream) >= MAX_STREAM_BUFFER_BYTES) continue;
      write(stream, line);
    }
  }

  async function pushUpdates() {
    const next = (await getRunSnapshot()) ?? null;
    latestSnapshot = next;
    for (const stream of [...streams]) {
      if (stream.paused) {
        if (shouldDrop(stream)) dropStream(stream, true);
        continue;
      }
      if (shouldDrop(stream)) {
        dropStream(stream, true);
        continue;
      }
      if (JSON.stringify(stream.prev) === JSON.stringify(next)) continue;
      if (!stream.throttle.shouldSend()) continue;
      const line = (stream.prev === null || next === null)
        ? sse('snapshot', next)
        : sse('delta', diffSnapshots(stream.prev, next));
      if (write(stream, line)) {
        stream.prev = next;
      }
    }
  }

  function close() {
    for (const stream of [...streams]) {
      try {
        stream.res.end();
      } catch {
        // already closed
      }
    }
    streams.clear();
  }

  return {
    open,
    writeHeartbeats,
    pushUpdates,
    close,
    get size() {
      return streams.size;
    },
  };
}

export function createWatchServer(opts) {
  const {
    root,
    getRunSnapshot,
    getPlanSnapshot,
    getGallery,
    getJobReport,
    getBoard,
    board,
    nav,
    indexName = 'index.html',
    commandList,
    contextCommands,
    assetDir,
    deltaFile,
    idleMs = 1800000,
    now = Date.now,
    heartbeatMs = 10000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    // A fixed port and token, for a board that stays up between restarts (swarm remote). Without them: a free port and a fresh token every start.
    port: wantedPort = 0,
    token: fixedToken,
    // swarm remote: the board is also reached through `tailscale serve`, which proxies from the tailnet to this loopback port. `hosts` are the names it is
    // reached by and `login` is the tailnet login allowed to use it (Tailscale sets that header on what it proxies). Nothing else is ever listened on.
    remote,
  } = opts;

  const token = fixedToken ?? randomBytes(24).toString('hex');
  const assets = new Map();
  let server = null;
  let port = 0;
  let url = null;
  let timer = null;
  let heartbeatTimer = null;
  let ticking = false;
  let closed = false;
  let streamEverClosed = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let lastActivity = now();
  let noStreamSince = now();
  const streamManager = createWatchStreamManager({
    getRunSnapshot,
    now,
    onDrop: () => { streamEverClosed = true; },
    onClose: () => {
      lastActivity = now();
      if (streamManager.size === 0) noStreamSince = now();
    },
  });

  async function loadAssets() {
    assets.clear();
    const entries = await readdir(assetDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!Object.hasOwn(TYPES, ext)) continue;
      const body = await readFile(path.join(assetDir, entry.name));
      assets.set(entry.name, { type: TYPES[ext], body });
    }
    const delta = await readFile(deltaFile);
    assets.set('watch-delta.mjs', { type: TYPES['.js'], body: delta });
  }

  function sendAsset(res, method, name, headers = {}) {
    const a = Object.hasOwn(Object.fromEntries(assets), name) ? assets.get(name) : undefined;
    if (!a) return sendText(res, method, 404, 'not found');
    send(res, method, 200, { 'Content-Type': a.type, 'Content-Length': a.body.length, ...headers }, a.body);
  }

  async function payload() {
    const run = (await getRunSnapshot()) ?? null;
    const plan = (await getPlanSnapshot()) ?? { present: false };
    const gallery = (await getGallery()) ?? { schema: 1, screens: [] };
    const ctx = await contextCommands(run, plan);
    return { run, plan, gallery, commands: commandList, contextCommands: ctx };
  }

  async function sendShot(res, method, id, kind) {
    const file = await screenshotPath(root, id, kind);
    if (!file) return sendText(res, method, 404, 'not found');
    const body = await readFile(file);
    send(res, method, 200, { 'Content-Type': 'image/png', 'Content-Length': body.length }, body);
  }

  async function openEvents(res, method) {
    if (method === 'HEAD') {
      return send(res, method, 200, { 'Content-Type': 'text/event-stream; charset=utf-8' }, '');
    }
    if (closed) return sendText(res, method, 503, 'shutting down');
    const run = (await getRunSnapshot()) ?? null;
    if (streamManager.size >= MAX_STREAMS) return sendText(res, method, 503, 'too many event streams');
    res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/event-stream; charset=utf-8' });
    if (res.socket) {
      res.socket.setTimeout(0);
      res.socket.setKeepAlive(true);
    }
    streamManager.open(res, run);
  }

  async function handle(req, res) {
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      return send(res, method, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed');
    }
    if (!server) return sendText(res, method, 421, 'misdirected request');
    const host = req.headers.host;
    const local = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    if (remote) {
      // Every request, whatever its Host, must come through tailscale serve as the owner: it sets the login header itself (a client cannot forge it past Tailscale) and a
      // Funnel request carries none, so a Host spoofed to the loopback address gets nothing. Every refusal is the same 403, so the port cannot be probed for.
      const login = req.headers['tailscale-user-login'];
      const named = local || remote.hosts.includes(String(host).toLowerCase());
      if (!named || req.headers['tailscale-funnel-request'] !== undefined || typeof login !== 'string' || login.toLowerCase() !== String(remote.login ?? '').toLowerCase()) return sendText(res, method, 403, 'forbidden');
    } else if (!local) {
      return sendText(res, method, 421, 'misdirected request');
    }
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = u.pathname;
    if (pathname === '/api/health') {
      if (remote || !local) return sendText(res, method, 421, 'misdirected request');
      const hostName = String(host ?? '').split(':')[0];
      if (hostName !== '127.0.0.1' && hostName !== 'localhost') return sendText(res, method, 421, 'misdirected request');
      const info = await versionInfo();
      return sendJson(res, method, { ok: true, version: info.version, pid: process.pid });
    }
    if (pathname.startsWith('/assets/')) {
      lastActivity = now();
      return sendAsset(res, method, pathname.slice('/assets/'.length));
    }
    const parts = pathname.split('/');
    const isJob = parts.length === 3 && parts[1] === 'job' && typeof getJobReport === 'function';
    const isBoard = pathname === '/board' && typeof getBoard === 'function';
    // The board's own routes (all GET, all behind the token): data, one project, history, the CSV and the click-through to a run's own Watch page.
    // The remote board only reads: it never starts a run's own page on the computer ('/open/run') or a board.
    const boardRoutes = board ? ['/api/board', '/api/project', '/api/live', '/api/history', '/history.csv', ...(remote ? [] : ['/open/run']), '/project', '/run', '/api/run'] : [];
    const isBoardRoute = boardRoutes.includes(pathname);
    // Navigation back to the board from a run page: where this page sits (project, run) and links that find or start the board.
    const isNav = Boolean(nav) && !remote && ['/api/nav', '/nav/board', '/nav/project'].includes(pathname);
    const isShot = parts.length === 4 && parts[1] === 'shot' && (parts[3] === 'mockup' || parts[3] === 'page');
    if (pathname !== '/' && pathname !== '/api/snapshot' && pathname !== '/events' && !isShot && !isJob && !isBoard && !isBoardRoute && !isNav) return sendText(res, method, 404, 'not found');
    const isHtmlPage = pathname === '/' || (isBoardRoute && (pathname === '/project' || pathname === '/run'));
    const queryToken = u.searchParams.get('t');
    const headerToken = req.headers['x-watch-token'];
    const cookieToken = watchCookie(req.headers.cookie);
    const headerOk = typeof headerToken === 'string' && safeEqual(headerToken, token);
    const cookieOk = typeof cookieToken === 'string' && safeEqual(cookieToken, token);
    const queryOk = isHtmlPage && typeof queryToken === 'string' && safeEqual(queryToken, token);
    const ok = headerOk || cookieOk || queryOk;
    if (!ok) {
      return sendText(res, method, 403, 'forbidden');
    }
    lastActivity = now();
    const pageHeaders = queryOk ? {
      'Set-Cookie': `swarm_watch=${token}; HttpOnly; SameSite=Strict; Path=/${remote || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https' ? '; Secure' : ''}`,
    } : {};
    if (pathname === '/') return sendAsset(res, method, indexName, pageHeaders);
    if (pathname === '/api/snapshot') return sendJson(res, method, await payload());
    if (pathname === '/events') return openEvents(res, method);
    if (isBoard) return sendJson(res, method, (await getBoard()) ?? { runs: [] });
    if (isNav) {
      if (pathname === '/api/nav') return sendJson(res, method, { project: nav.project ?? null, run: nav.runId ?? null, board: '/nav/board', projectPage: nav.project ? '/nav/project' : null });
      // The board is found (already running, in this or another process) or started; the browser is sent there with the board's own token.
      const target = await nav.openBoard(pathname === '/nav/project' ? nav.project?.id ?? null : null);
      if (!target) return sendText(res, method, 404, 'not found');
      return send(res, method, 302, { Location: target, 'Content-Type': 'text/plain; charset=utf-8' }, 'redirecting');
    }
    if (isBoardRoute) {
      const q = Object.fromEntries(u.searchParams);
      delete q.t;
      if (pathname === '/project') return sendAsset(res, method, 'project.html', pageHeaders);
      if (pathname === '/run') return sendAsset(res, method, 'run.html', pageHeaders);
      if (pathname === '/api/run') { const detail = await board.run(String(q.id ?? ''), String(q.run ?? ''), q.compare ? String(q.compare) : null); return detail ? sendJson(res, method, { ...detail, openRun: !remote }) : sendText(res, method, 404, 'not found'); }
      // `openRun`: the "Watch" links start a run's own page on this computer, which the remote board never does (it links to the run inspector instead). `server`: the version this
      // process runs, the one now installed, and whether they differ (it was started before the last swarm update).
      if (pathname === '/api/board') {
        const localOnly = q.local === '1';
        return sendJson(res, method, { ...(await board.snapshot({ ...q, local: localOnly })), openRun: !remote, server: await versionInfo() });
      }
      if (pathname === '/api/project') { const detail = await board.project(String(q.id ?? '')); return detail ? sendJson(res, method, detail) : sendText(res, method, 404, 'not found'); }
      if (pathname === '/api/live') { const live = await board.live(String(q.id ?? '')); return live ? sendJson(res, method, live) : sendText(res, method, 404, 'not found'); }
      if (pathname === '/api/history') return sendJson(res, method, await board.history(q));
      if (pathname === '/history.csv') return send(res, method, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="swarm-history.csv"' }, await board.historyCsv(q));
      // /open/run?id=PROJECT&run=RUN: starts the run's own Watch server (or reuses it) and sends the browser to it. The target address carries that server's own token.
      const target = await board.openRun(String(q.id ?? ''), String(q.run ?? ''));
      if (!target) return sendText(res, method, 404, 'not found');
      return send(res, method, 302, { Location: target, 'Content-Type': 'text/plain; charset=utf-8' }, 'redirecting');
    }
    if (isJob) {
      const report = await getJobReport(decodeURIComponent(parts[2]));
      return report ? sendJson(res, method, report) : sendText(res, method, 404, 'not found');
    }
    return sendShot(res, method, parts[2], parts[3]);
  }

  async function close() {
    if (closed && !server) return;
    closed = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
    streamManager.close();
    if (server && server.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    }
    resolveDone();
  }

  async function tick() {
    if (ticking || closed) return;
    ticking = true;
    try {
      const t = now();
      if (streamManager.size > 0) {
        await streamManager.pushUpdates();
      } else {
        if (t - lastActivity >= idleMs) {
          await close();
          return;
        }
        const run = (await getRunSnapshot()) ?? null;
        const finished = !!run && (run.status === 'complete' || run.status === 'failed');
        if (finished && streamEverClosed && t - noStreamSince >= IDLE_FINISHED_MS) {
          await close();
          return;
        }
      }
    } catch {
      // keep polling; a failed read is retried on the next tick
    } finally {
      ticking = false;
    }
  }

  async function listen() {
    await loadAssets();
    server = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) sendText(res, req.method, 500, 'error');
        else res.end();
      });
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(wantedPort, '127.0.0.1', () => resolve());
    });
    port = server.address().port;
    url = `http://127.0.0.1:${port}/?t=${token}`;
    closed = false;
    streamEverClosed = false;
    lastActivity = now();
    noStreamSince = now();
    timer = setIntervalFn(() => {
      tick();
    }, 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    heartbeatTimer = setIntervalFn(streamManager.writeHeartbeats, Math.max(1, heartbeatMs));
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    return { url, port };
  }

  return {
    listen,
    close,
    done,
    token,
    get url() {
      return url;
    },
  };
}
