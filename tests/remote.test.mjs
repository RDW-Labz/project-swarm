// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { qrMatrix, qrText, reedSolomon, formatBits, QR_MAX_BYTES } from '../tools/qr.mjs';
import { realDeps, runRemoteCommand, readRemote, serveRemote, parseStatus, parseServe, isTailnetAddress, HTTPS_PORT } from '../tools/remote.mjs';
import { startBoardServer } from '../tools/watch-cli.mjs';

const MOCK = fileURLToPath(new URL('./fixtures/mock-tailscale.mjs', import.meta.url));
const DNS = 'my-mac.tail1234.ts.net';
const LOGIN = 'braden@example.com';

// ---- the QR code ----
test('Reed-Solomon matches the textbook vector (version 1-M, "HELLO WORLD")', () => {
  assert.deepEqual(reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('QR matrix: sizes by version, finder patterns, a valid format word, stable output', () => {
  assert.equal(qrMatrix('hi').length, 21);
  assert.equal(qrMatrix('x'.repeat(30)).length, 29);          // version 3 (7+... bytes of M)
  assert.equal(qrMatrix('x'.repeat(QR_MAX_BYTES)).length, 57); // version 10
  assert.throws(() => qrMatrix('x'.repeat(QR_MAX_BYTES + 1)), /more than/);
  const m = qrMatrix('https://example.ts.net:8443/?t=abc');
  assert.equal(m.length, 29);
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) {
    assert.ok(m[r][c] && m[r + 6][c + 6] && m[r][c + 6] && m[r + 6][c] && !m[r + 1][c + 1] && m[r + 3][c + 3]);
  }
  // Every format word is a codeword of the BCH(15,5) code: no two differ in fewer than 7 bits.
  const words = [0, 1, 2, 3, 4, 5, 6, 7].map(formatBits);
  for (let i = 0; i < 8; i += 1) for (let j = i + 1; j < 8; j += 1) assert.ok([...(words[i] ^ words[j]).toString(2)].filter(x => x === '1').length >= 7);
  // A pin that makes a change to the encoder visible (the encoder was checked by decoding its output with macOS CoreImage's QR reader).
  assert.equal(createHash('sha256').update(m.map(r => r.map(x => (x ? 1 : 0)).join('')).join('\n')).digest('hex'), 'f63f48c04f0271d853a19dbc11b3a8a4227870ba9ce8065e5bd681f0a28b2477');
});

test('QR text: a square of half blocks with a light quiet zone', () => {
  const text = qrText('hi');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, Math.ceil((21 + 8) / 2));   // a quiet zone of 4 modules, as the specification asks
  assert.ok(lines.every(l => [...l].length === 29));
  assert.ok([...lines[0]].every(ch => ch === '█'));
  assert.match(qrText('hi', { color: true }), /\u001b\[97;40m/);
});

// ---- Tailscale's answers ----
test('status, serve and address helpers read what Tailscale says and distrust the rest', () => {
  assert.deepEqual(parseStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'A.B.ts.net.', UserID: 3 }, User: { 3: { LoginName: 'me@x.com' } } })), { state: 'Running', dns: 'a.b.ts.net', login: 'me@x.com' });
  assert.equal(parseStatus('not json').state, 'Unknown');
  assert.equal(parseServe('garbage'), null);
  assert.equal(parseServe(''), null, 'no answer is unknown, never "nothing is set"');
  assert.equal(parseServe('[]'), null);
  assert.deepEqual(parseServe('{}'), { web: {}, funnel: {}, tcp: {} });
  const merged = parseServe(JSON.stringify({ AllowFunnel: { 'a.ts.net:8443': false }, Foreground: { s: { AllowFunnel: { 'a.ts.net:8443': true }, Web: { 'a.ts.net:9': { Handlers: {} } }, TCP: { 9: {} } } } }));
  assert.equal(merged.funnel['a.ts.net:8443'], true, 'a foreground funnel counts');
  assert.ok(merged.web['a.ts.net:9'] && merged.tcp[9]);
  assert.ok(isTailnetAddress('100.64.0.1') && isTailnetAddress('100.127.255.255') && isTailnetAddress('fd7a:115c:a1e0::1'));
  assert.ok(!isTailnetAddress('100.128.0.1') && !isTailnetAddress('8.8.8.8') && !isTailnetAddress('192.168.1.5') && !isTailnetAddress('2606:4700::1'));
});

// ---- the whole flow against a pretend tailscale ----
async function harness(t, mock = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-')));
  const tsDir = path.join(dir, 'ts');
  await fs.mkdir(tsDir);
  await fs.writeFile(path.join(tsDir, 'state.json'), JSON.stringify({ backend: 'Running', dns: DNS, login: LOGIN, serve: {}, funnelPorts: [], ...mock }));
  const env = { ...process.env, SWARM_TAILSCALE_BIN: MOCK, MOCK_TS_DIR: tsDir, SWARM_REMOTE_FILE: path.join(dir, 'home', 'remote.json'), SWARM_BOARD_FILE: path.join(dir, 'board.json') };
  const boards = [];
  const base = realDeps(env);
  const deps = {
    ...base,
    installed: async () => true,
    sleep: async () => {},
    up: async () => (await base.tailscale(['up'])).ok,
    // The board runs in this process (loopback only); `remote on` starts and stops it through these two.
    spawnServer: async () => {
      const state = await readRemote(env);
      const board = await startBoardServer({ env, root: dir, remote: { port: state.port, token: state.token, hosts: state.hosts, login: state.login } });
      boards.push(board);
      return process.pid + boards.length;
    },
    kill: () => { const b = boards.pop(); if (b) { b.server.close(); b.api.close(); } return true; },
    // The tailnet hop: what tailscale serve does to a request from the phone (the tailnet name as Host, the login header).
    reach: async (url, options = {}) => { const u = new URL(url); const s = await readRemote(env); const token = options.headers?.['x-watch-token'] ?? (u.searchParams.has('t') ? u.searchParams.get('t') : s.token); u.searchParams.delete('t'); return base.get(`http://127.0.0.1:${s.port}${u.pathname}${u.search}`, { host: u.host, headers: { 'Tailscale-User-Login': LOGIN, ...(options.headers || {}), ...(token ? { 'x-watch-token': token } : {}) } }); },
    resolve: async () => ['100.101.102.103'],
  };
  t.after(async () => { for (const b of boards) { b.server.close(); await b.api.close().catch(() => {}); } await fs.rm(dir, { recursive: true, force: true }); });
  const calls = async () => (await fs.readFile(path.join(tsDir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const tsState = async () => JSON.parse(await fs.readFile(path.join(tsDir, 'state.json'), 'utf8'));
  const setTs = async patch => fs.writeFile(path.join(tsDir, 'state.json'), JSON.stringify({ ...(await tsState()), ...patch }));
  return { dir, env, deps, calls, tsState, setTs, boards, run: (...args) => runRemoteCommand(args, { deps, tty: false }) };
}

test('remote on: serves the loopback board on the tailnet, prints the address and a QR code, runs the self-check, never touches funnel', async t => {
  const h = await harness(t);
  const res = await h.run('on');
  assert.equal(res.exitCode, 0, res.stdout);
  const state = await readRemote(h.env);
  assert.match(state.token, /^[0-9a-f]{48}$/);
  assert.equal((await fs.stat(h.env.SWARM_REMOTE_FILE)).mode & 0o777, 0o600);
  assert.ok(res.stdout.includes(`https://${DNS}:${HTTPS_PORT}/?t=${state.token}`));
  assert.match(res.stdout, /Remote is on \(your tailnet only\)/);
  assert.match(res.stdout, /ok .*resolves to tailnet addresses/);
  assert.match(res.stdout, /ok .*a wrong token is refused/);
  assert.match(res.stdout, /ok .*without your Tailscale login is refused/);
  assert.match(res.stdout, /█/);
  assert.match(res.stdout, /Install the Tailscale app/);
  const calls = await h.calls();
  assert.ok(calls.every(c => c[0] !== 'funnel'), 'no funnel call');
  assert.deepEqual(calls.find(c => c.includes('--bg')), ['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${state.port}`]);
  assert.equal((await h.tsState()).serve[HTTPS_PORT], `http://127.0.0.1:${state.port}`);
});

test('the board is on the loopback address only', async t => {
  const h = await harness(t);
  await h.run('on');
  const state = await readRemote(h.env);
  const ok = await new Promise(resolve => { const s = net.connect(state.port, '127.0.0.1', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
  assert.ok(ok);
  const external = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4');
  if (external) {
    const reachable = await new Promise(resolve => { const s = net.connect({ port: state.port, host: external.address, timeout: 1500 }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });
    assert.equal(reachable, false, 'not listening on a network address');
  }
  const src = await fs.readFile(fileURLToPath(new URL('../tools/watch-server.mjs', import.meta.url)), 'utf8');
  assert.match(src, /server\.listen\(wantedPort, '127\.0\.0\.1'/);
  assert.doesNotMatch(src, /0\.0\.0\.0|'::'/);
});

test('the remote code never runs tailscale funnel and never binds a public address', async () => {
  for (const f of ['remote.mjs', 'watch-server.mjs', 'watch-cli.mjs']) {
    const src = await fs.readFile(fileURLToPath(new URL(`../tools/${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /0\.0\.0\.0/, f);
    assert.doesNotMatch(src, /\[\s*'funnel'|"funnel"\s*[,\]]|tailscale\(\[\s*'funnel/, f);
  }
});

test('the board through tailscale: only your login, only with the token, read-only, and no run page starts', async t => {
  const h = await harness(t);
  await h.run('on');
  const s = await readRemote(h.env);
  const via = (pathname, { host = `${DNS}:${HTTPS_PORT}`, login = LOGIN, method = 'GET', extra = {} } = {}) => new Promise(resolve => {
    import('node:http').then(({ default: http }) => {
      const req = http.request({ hostname: '127.0.0.1', port: s.port, path: pathname, method, headers: { Host: host, ...(login ? { 'Tailscale-User-Login': login } : {}), ...extra } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0)); req.end();
    });
  });
  assert.equal(await via('/api/board', { extra: { 'x-watch-token': s.token } }), 200);
  assert.equal(await via('/api/board', { extra: { 'x-watch-token': '0'.repeat(48) } }), 403);
  assert.equal(await via(`/api/board`), 403);
  // Every refusal is the same 403, so the port cannot be probed for and a spoofed Host gets nothing.
  assert.equal(await via('/api/board', { login: 'someone-else@example.com', extra: { 'x-watch-token': s.token } }), 403);
  assert.equal(await via('/api/board', { login: null, extra: { 'x-watch-token': s.token } }), 403);
  assert.equal(await via('/api/board', { host: 'evil.example.com', extra: { 'x-watch-token': s.token } }), 403);
  assert.equal(await via('/api/board', { host: `127.0.0.1:${s.port}`, login: null, extra: { 'x-watch-token': s.token } }), 403, 'a loopback Host does not skip the login check');
  assert.equal(await via('/api/board', { host: `localhost:${s.port}`, login: 'someone-else@example.com', extra: { 'x-watch-token': s.token } }), 403);
  assert.equal(await via('/api/board', { host: `127.0.0.1:${s.port}`, extra: { 'x-watch-token': s.token } }), 200, 'the owner login with the loopback Host is the self-check path');
  assert.equal(await via('/api/board', { extra: { 'Tailscale-Funnel-Request': '?1', 'x-watch-token': s.token } }), 403, 'a Funnel request is refused even with a login header');
  assert.equal(await via('/api/board', { method: 'POST', extra: { 'x-watch-token': s.token } }), 405);
  assert.equal(await via('/open/run?id=x&run=y', { extra: { 'x-watch-token': s.token } }), 404);
  assert.equal(await via('/nav/board', { extra: { 'x-watch-token': s.token } }), 404);
});

test('remote on twice keeps the same token and board', async t => {
  const h = await harness(t);
  await h.run('on');
  const first = await readRemote(h.env);
  const res = await h.run('on');
  assert.equal(res.exitCode, 0, res.stdout);
  const second = await readRemote(h.env);
  assert.equal(second.token, first.token);
  assert.equal(second.port, first.port);
  assert.equal(h.boards.length, 1);
});

test('remote on: not installed says how to install it and starts nothing', async t => {
  const h = await harness(t);
  h.deps.installed = async () => false;
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /brew install --cask tailscale/);
  assert.equal(await readRemote(h.env), null);
  assert.equal(h.boards.length, 0);
  assert.deepEqual(await h.calls(), []);
});

test('remote on: signs in with tailscale up when it is not signed in; stops if that does not work', async t => {
  const h = await harness(t, { backend: 'NeedsLogin' });
  const res = await h.run('on');
  assert.equal(res.exitCode, 0, res.stdout);
  assert.ok((await h.calls()).some(c => c[0] === 'up'));
  const bad = await harness(t, { backend: 'NeedsLogin', upFails: true });
  const res2 = await bad.run('on');
  assert.equal(res2.exitCode, 1);
  assert.match(res2.stdout, /still not running/);
  assert.equal(await readRemote(bad.env), null);
  assert.equal(bad.boards.length, 0);
});

test('remote on refuses while Funnel is on for the board port, and starts nothing', async t => {
  const h = await harness(t, { funnelPorts: [String(HTTPS_PORT)] });
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /Funnel \(the public internet\) is ON/);
  assert.equal(await readRemote(h.env), null);
  assert.equal(h.boards.length, 0);
  const calls = await h.calls();
  assert.ok(!calls.some(c => c.includes('--bg')), 'no serve was set');
  assert.ok(calls.every(c => c[0] !== 'funnel'));
});

test('if Funnel shows up after serve is set, everything is taken down', async t => {
  const h = await harness(t, { funnelAfterServe: true });
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /Funnel .* showed up/);
  assert.equal(await readRemote(h.env), null);
  assert.equal(h.boards.length, 0);
  assert.equal((await h.tsState()).serve[HTTPS_PORT], undefined);
});

test('a name that resolves to a public address takes everything down', async t => {
  const h = await harness(t);
  h.deps.resolve = async () => ['100.101.102.103', '203.0.113.9'];
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /public address/);
  assert.equal(await readRemote(h.env), null);
  assert.equal((await h.tsState()).serve[HTTPS_PORT], undefined);
  assert.equal(h.boards.length, 0);
});

test('something else already on the board port is left alone', async t => {
  const h = await harness(t, { serve: { [HTTPS_PORT]: 'http://127.0.0.1:9999' } });
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /already uses/);
  assert.equal((await h.tsState()).serve[HTTPS_PORT], 'http://127.0.0.1:9999');
  assert.equal(h.boards.length, 0);
  const off = await h.run('off');
  assert.match(off.stdout, /already off/);
  assert.equal((await h.tsState()).serve[HTTPS_PORT], 'http://127.0.0.1:9999');
});

test('tailscale serve failing leaves nothing running', async t => {
  const h = await harness(t, { serveFails: true });
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /Serve is not enabled/);
  assert.equal(await readRemote(h.env), null);
  assert.equal(h.boards.length, 0);
});

test('status: off, on, and on-but-broken (Funnel on is reported, never changed)', async t => {
  const h = await harness(t);
  assert.match((await h.run('status')).stdout, /Remote is off/);
  await h.run('on');
  const on = await h.run('status');
  assert.equal(on.exitCode, 0, on.stdout);
  assert.match(on.stdout, /Remote is on \(tailnet only\)/);
  assert.match(on.stdout, /Funnel \(public internet\): off/);
  assert.ok(!on.stdout.includes((await readRemote(h.env)).token), 'status does not print the token');
  await h.setTs({ funnelPorts: [String(HTTPS_PORT)] });
  const bad = await h.run('status');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /Funnel .*ON/);
  assert.ok((await h.calls()).every(c => c[0] !== 'funnel'));
});

test('show prints the address with the token and a QR code', async t => {
  const h = await harness(t);
  assert.equal((await h.run('show')).exitCode, 1);
  await h.run('on');
  const res = await h.run('show');
  assert.ok(res.stdout.includes(`?t=${(await readRemote(h.env)).token}`));
  assert.match(res.stdout, /█/);
});

test('remote off removes the Tailscale entry, stops the board and deletes the token', async t => {
  const h = await harness(t);
  await h.run('on');
  const res = await h.run('off');
  assert.equal(res.exitCode, 0, res.stdout);
  assert.match(res.stdout, /removed the Tailscale entry/);
  assert.match(res.stdout, /stopped the board/);
  assert.match(res.stdout, /deleted the board token/);
  assert.equal(await readRemote(h.env), null);
  await assert.rejects(fs.stat(h.env.SWARM_REMOTE_FILE));
  assert.equal((await h.tsState()).serve[HTTPS_PORT], undefined);
  assert.equal(h.boards.length, 0);
  assert.match((await h.run('off')).stdout, /already off/);
});

test('remote off still cleans up on this computer when Tailscale is gone', async t => {
  const h = await harness(t);
  await h.run('on');
  h.deps.tailscale = async () => ({ ok: false, missing: true, stdout: '', stderr: 'tailscale is not installed' });
  const res = await h.run('off');
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /Tailscale is not installed/);
  assert.equal(await readRemote(h.env), null);
  assert.equal(h.boards.length, 0);
});

test('remote rotate: a new token, the old link stops working, the entry follows the board', async t => {
  const h = await harness(t);
  assert.equal((await h.run('rotate')).exitCode, 1);
  await h.run('on');
  const before = await readRemote(h.env);
  const res = await h.run('rotate');
  assert.equal(res.exitCode, 0, res.stdout);
  const after = await readRemote(h.env);
  assert.notEqual(after.token, before.token);
  assert.match(after.token, /^[0-9a-f]{48}$/);
  assert.match(res.stdout, /Old links no longer work/);
  assert.ok(res.stdout.includes(`?t=${after.token}`));
  assert.ok(!res.stdout.includes(before.token));
  const old = await h.deps.reach(`https://${DNS}:${HTTPS_PORT}/api/board?t=${before.token}`);
  assert.notEqual(old.status, 200);
  assert.equal((await h.deps.reach(`https://${DNS}:${HTTPS_PORT}/api/board?t=${after.token}`)).status, 200);
  assert.equal((await h.tsState()).serve[HTTPS_PORT], `http://127.0.0.1:${after.port}`);
  assert.equal(h.boards.length, 1);
  assert.deepEqual(after.ports, [after.port], 'only the current port is remembered');
  await h.run('off');
  assert.equal((await h.tsState()).serve[HTTPS_PORT], undefined, 'off removes the entry that rotate moved');
});

test('the real board process starts on the saved port and token, on loopback', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-real-')));
  const env = { ...process.env, SWARM_REMOTE_FILE: path.join(dir, 'remote.json'), SWARM_BOARD_FILE: path.join(dir, 'board.json') };
  const deps = realDeps(env);
  const port = await deps.freePort(0);
  await fs.writeFile(env.SWARM_REMOTE_FILE, JSON.stringify({ enabled: true, token: 'a'.repeat(48), port, httpsPort: HTTPS_PORT, dns: DNS, login: LOGIN, hosts: [`${DNS}:${HTTPS_PORT}`] }), { mode: 0o600 });
  const pid = await deps.spawnServer();
  t.after(async () => { deps.kill(pid); await fs.rm(dir, { recursive: true, force: true }); });
  let status = 0;
  for (let i = 0; i < 60 && status !== 200; i += 1) { status = (await deps.get(`http://127.0.0.1:${port}/api/board`, { host: `127.0.0.1:${port}`, headers: { 'Tailscale-User-Login': LOGIN, 'x-watch-token': 'a'.repeat(48) } })).status; if (status !== 200) await new Promise(r => setTimeout(r, 250)); }
  assert.equal(status, 200);
  assert.equal((await deps.get('http://127.0.0.1:' + port + '/api/board', { host: `127.0.0.1:${port}`, headers: { 'Tailscale-User-Login': LOGIN, 'x-watch-token': 'nope' } })).status, 403);
  assert.equal((await deps.get(`http://127.0.0.1:${port}/api/board`, { host: `127.0.0.1:${port}`, headers: { 'x-watch-token': 'a'.repeat(48) } })).status, 403, 'no login, no board');
  assert.equal((await fs.stat(path.join(dir, 'remote.log'))).mode & 0o077, 0, 'the log is private');
  await assert.rejects(fs.stat(env.SWARM_BOARD_FILE), 'the remote board does not register as the local board');
});

test('usage: unknown words and extra arguments are refused', async t => {
  const h = await harness(t);
  assert.equal((await h.run('funnel')).exitCode, 2);
  assert.equal((await h.run('on', '--public')).exitCode, 2);
  assert.equal((await h.run('serve')).exitCode, 2);
  assert.deepEqual(await h.calls(), []);
});

test('an unreadable Tailscale answer is never taken for "nothing is set"', async t => {
  const h = await harness(t, { statusFails: true });
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /did not give a clear answer/);
  assert.equal(await readRemote(h.env), null);
  assert.equal(h.boards.length, 0);
  assert.ok(!(await h.calls()).some(c => c.includes('--bg')));
});

test('a foreground Funnel, a Funnel on another entry that proxies to the board, and a taken TCP port are all seen', async t => {
  const fg = await harness(t, { foregroundFunnel: String(HTTPS_PORT) });
  const r1 = await fg.run('on');
  assert.equal(r1.exitCode, 1);
  assert.match(r1.stdout, /Funnel \(the public internet\) is ON/);
  assert.equal(fg.boards.length, 0);

  const tcp = await harness(t, { tcpPorts: [String(HTTPS_PORT)] });
  const r2 = await tcp.run('on');
  assert.equal(r2.exitCode, 1);
  assert.match(r2.stdout, /already uses/);
  assert.equal(tcp.boards.length, 0);

  const h = await harness(t);
  await h.run('on');
  const s = await readRemote(h.env);
  await h.setTs({ extraWeb: { 443: `http://127.0.0.1:${s.port}` }, funnelPorts: ['443'] });
  const status = await h.run('status');
  assert.equal(status.exitCode, 1);
  assert.match(status.stdout, /Funnel .*ON/);
});

test('a board that never answers is stopped anyway, and nothing is left behind', async t => {
  const h = await harness(t);
  const realGet = h.deps.get;
  let hidden = true;
  h.deps.get = async (...a) => (hidden ? { status: 0, body: '' } : realGet(...a));
  const real = h.deps.spawnServer;
  h.deps.spawnServer = async () => { const pid = await real(); return pid; };
  const killed = h.deps.kill;
  h.deps.kill = pid => { hidden = false; return killed(pid); };
  const res = await h.run('on');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /did not start/);
  assert.equal(h.boards.length, 0, 'the board that started late was stopped');
  assert.equal(await readRemote(h.env), null);
});

test('off that cannot remove the Tailscale entry keeps the settings, says so, and can be run again', async t => {
  const h = await harness(t);
  await h.run('on');
  await h.setTs({ offFails: true });
  const res = await h.run('off');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /NOT fully off/);
  assert.match(res.stdout, /could not remove the Tailscale entry/);
  assert.match(res.stdout, /kept the saved settings/);
  assert.ok(await readRemote(h.env), 'the settings are kept');
  await h.setTs({ offFails: false });
  const again = await h.run('off');
  assert.equal(again.exitCode, 0, again.stdout);
  assert.equal(await readRemote(h.env), null);
  assert.equal((await h.tsState()).serve[HTTPS_PORT], undefined);
});

test('off with unreadable Tailscale settings does not claim success', async t => {
  const h = await harness(t);
  await h.run('on');
  await h.setTs({ statusFails: true });
  const res = await h.run('off');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /could not read Tailscale's serve settings/);
  assert.ok(await readRemote(h.env));
});

test('rotate that stops early says the old token is still active', async t => {
  const h = await harness(t);
  await h.run('on');
  const before = await readRemote(h.env);
  await h.setTs({ funnelPorts: [String(HTTPS_PORT)] });
  const res = await h.run('rotate');
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /old token is still active/);
  assert.equal((await readRemote(h.env)).token, before.token);
});

test('a board that finds Funnel on for its address stops itself', async t => {
  const h = await harness(t);
  await h.run('on');
  const state = await readRemote(h.env);
  h.deps.kill();   // the in-process board of the flow above; the watchdog is tested on its own board
  const env = { ...h.env, SWARM_REMOTE_WATCH_MS: '100' };
  const running = serveRemote(env);
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) { up = (await h.deps.get(`http://127.0.0.1:${state.port}/api/board`, { host: `127.0.0.1:${state.port}`, headers: { 'Tailscale-User-Login': LOGIN, 'x-watch-token': state.token } })).status === 200; if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'the board came up');
  await h.setTs({ funnelPorts: [String(HTTPS_PORT)] });
  const stopped = await Promise.race([running.then(() => 'stopped'), new Promise(r => setTimeout(() => r('still running'), 8000))]);
  assert.equal(stopped, 'stopped');
});
