// SPDX-License-Identifier: Apache-2.0
// swarm remote on | off | status | rotate | show: the Swarm Watch board on your phone, over Tailscale, on your tailnet only.
//
// What this does, and the lines it never crosses:
//  - The board listens on 127.0.0.1 only (a loopback port). `tailscale serve` is the only thing that reaches it from outside, and only from your own tailnet.
//  - Tailscale Funnel (the public internet) is never turned on and never run: this file does not call `tailscale funnel` at all. If Funnel is already on for the
//    board's port, `swarm remote on` refuses; if it ever shows up after setup, the setup is taken down again.
//  - The board stays read-only and the board token is still required. Answers still only go through swarm-inbox issues (swarm phone).
//  - Off by default. `swarm remote off` removes the serve entry, stops the board and deletes the token.
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qrText } from './qr.mjs';

export const WATCH_MS = 30000;
export const HTTPS_PORT = 8443;   // not 443, so an existing `tailscale serve` on the default port is left alone
const SWARM = fileURLToPath(new URL('./swarm.mjs', import.meta.url));
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export const REMOTE_USAGE = [
  'Usage: swarm remote on       show the board on your phone over Tailscale (your tailnet only, never the public internet)',
  '       swarm remote status   is it on, is the board up, is Funnel off',
  '       swarm remote show     print the address and QR code again',
  '       swarm remote rotate   a new board token (old links stop working)',
  '       swarm remote off      remove everything: the Tailscale entry, the board, the token',
].join('\n');

export const remoteFile = (env = process.env, home = os.homedir()) => env.SWARM_REMOTE_FILE || path.join(home, '.project-swarm', 'remote.json');
export { remoteServerFile } from './server-restart.mjs';
const logFile = (env, home) => path.join(path.dirname(remoteFile(env, home)), 'remote.log');

export async function readRemote(env = process.env) {
  try { const data = JSON.parse(await fs.readFile(remoteFile(env), 'utf8')); return data && typeof data === 'object' && typeof data.token === 'string' ? data : null; } catch { return null; }
}
async function writeRemote(env, data) {
  const file = remoteFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

// ---- Tailscale's own answers, read defensively (a CLI that answers something unexpected is treated as "not usable") ----
export function parseStatus(text) {
  try {
    const j = JSON.parse(text);
    const dnsName = typeof j?.Self?.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
    const user = j?.User?.[String(j?.Self?.UserID)];
    return { state: typeof j?.BackendState === 'string' ? j.BackendState : 'Unknown', dns: dnsName, login: typeof user?.LoginName === 'string' ? user.LoginName : '' };
  } catch { return { state: 'Unknown', dns: '', login: '' }; }
}
// `tailscale serve status --json`: background and foreground settings merged. Anything that is not a JSON object (an error, nothing at all) is "unknown", never "empty".
export function parseServe(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const web = { ...obj(j.Web) }; const funnel = { ...obj(j.AllowFunnel) }; const tcp = { ...obj(j.TCP) };
  for (const fg of Object.values(obj(j.Foreground))) {
    Object.assign(web, obj(fg?.Web)); Object.assign(tcp, obj(fg?.TCP));
    for (const [k, on] of Object.entries(obj(fg?.AllowFunnel))) funnel[k] = funnel[k] === true || on === true;
  }
  return { web, funnel, tcp };
}
const hostPort = (dnsName, port = HTTPS_PORT) => `${dnsName}:${port}`;
export const anyFunnel = serve => Object.entries(serve.funnel).filter(([, on]) => on === true).map(([k]) => k);
const proxyOf = (serve, key) => Object.values(serve.web[key]?.Handlers ?? {}).map(h => h?.Proxy).filter(Boolean);
// An entry points at one of our loopback ports (and nothing else counts as ours).
const isOurProxy = (target, ports) => ports.some(n => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${n}/?$`).test(String(target)));
const ourEntry = (serve, key, ports) => proxyOf(serve, key).some(t => isOurProxy(t, ports));
// Funnel is on for the board's address, or for any entry that proxies to the board's loopback port.
export const funnelOnFor = (serve, key, ports = []) => Object.entries(serve.funnel).some(([k, on]) => on === true && (k === key || proxyOf(serve, k).some(t => isOurProxy(t, ports))));
// The tailnet's own address space (CGNAT 100.64.0.0/10 and Tailscale's IPv6 range): a name that resolves anywhere else is not a tailnet-only name.
export function isTailnetAddress(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

// ---- The real world, replaceable in tests ----
export function realDeps(env = process.env) {
  const execp = (file, args, opts) => new Promise(resolve => execFile(file, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, env, ...opts }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') })));
  const find = async () => {
    if (env.SWARM_TAILSCALE_BIN) return env.SWARM_TAILSCALE_BIN;
    for (const dir of String(env.PATH ?? '').split(path.delimiter)) { if (!dir) continue; const p = path.join(dir, 'tailscale'); try { await fs.access(p, 1); return p; } catch { /* next */ } }
    try { await fs.access(MAC_APP_CLI, 1); return MAC_APP_CLI; } catch { return null; }
  };
  let bin;
  return {
    env,
    tailscale: async (args, { timeout } = {}) => { bin ??= await find(); if (!bin) return { ok: false, missing: true, stdout: '', stderr: 'tailscale is not installed' }; return execp(bin, args, timeout ? { timeout } : {}); },
    installed: async () => { bin ??= await find(); return Boolean(bin); },
    // `tailscale up` prints a sign-in address and waits for you to finish signing in; its own words go straight to the terminal.
    up: async () => { bin ??= await find(); return new Promise(resolve => { const c = spawn(bin, ['up', '--timeout=180s'], { stdio: 'inherit' }); c.on('error', () => resolve(false)); c.on('exit', code => resolve(code === 0)); }); },
    freePort: async (want) => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(null)); s.listen(want || 0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }),
    spawnServer: async () => {
      const log = path.join(path.dirname(remoteFile(env)), 'remote.log');
      await fs.mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
      const fd = (await fs.open(log, 'a', 0o600));
      const child = spawn(process.execPath, [SWARM, 'remote', 'serve'], { detached: true, stdio: ['ignore', fd.fd, fd.fd], env });
      child.unref();
      await fd.close();
      return child.pid;
    },
    kill: pid => { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } },
    // One GET with a Host header and optional tailnet-login header: how the self-check talks to the loopback port and, in tests, how a proxied request is imitated.
    get: (url, { host, headers = {} } = {}) => new Promise(resolve => {
      const u = new URL(url);
      const req = http.request({ hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'GET', agent: false, headers: { ...(host ? { Host: host } : {}), ...headers }, timeout: 4000 }, res => { res.resume(); let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.end();
    }),
    // The board's tailnet address, fetched the way the phone would: HTTPS to the tailnet name.
    reach: async (url) => { try { const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) }); return { status: res.status, body: res.status === 200 ? await res.text() : '' }; } catch (error) { return { status: 0, body: '', error: String(error?.cause?.code ?? error?.message ?? error) }; } },
    resolve: async name => { try { return (await dns.lookup(name, { all: true })).map(a => a.address); } catch { return []; } },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: Date.now,
  };
}

const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });
const boardUrl = (state, withToken = true) => `https://${state.dns}:${state.httpsPort}/${withToken ? `?t=${state.token}` : ''}`;
const localUrl = (state, pathname = '/api/board') => `http://127.0.0.1:${state.port}${pathname}?t=${state.token}`;

async function boardUp(deps, state) {
  const res = await deps.get(localUrl(state), { host: `127.0.0.1:${state.port}`, headers: { 'Tailscale-User-Login': state.login } });
  if (res.status !== 200) return false;
  try { const b = JSON.parse(res.body); return Array.isArray(b.projects); } catch { return false; }
}
async function waitForBoard(deps, state, tries = 40) {
  for (let i = 0; i < tries; i += 1) { if (await boardUp(deps, state)) return true; await deps.sleep(250); }
  return false;
}

// Take everything down: the serve entry (only one that points at one of our ports), the board process, the token file. `clean` is false when the Tailscale entry could not be
// confirmed gone or the board could not be stopped: then the state file stays, so `swarm remote off` can be run again. `force`: the process was started by this very call.
async function takeDown(deps, state, { force = false } = {}) {
  const lines = [];
  let clean = true;
  if (state?.dns) {
    const key = hostPort(state.dns, state.httpsPort);
    const ports = state.ports ?? [state.port];
    const raw = await deps.tailscale(['serve', 'status', '--json']);
    const serve = raw.ok ? parseServe(raw.stdout) : null;
    if (raw.missing) lines.push('Tailscale is not installed, so there is no entry to remove');
    else if (!serve) { clean = false; lines.push(`could not read Tailscale's serve settings (${(raw.stderr || 'unexpected answer').trim().split('\n')[0]}); run: tailscale serve --https=${state.httpsPort} off`); }
    else if (!ourEntry(serve, key, ports)) lines.push('no Tailscale entry of ours was found');
    else {
      const res = await deps.tailscale(['serve', `--https=${state.httpsPort}`, 'off']);
      const again = res.ok ? parseServe((await deps.tailscale(['serve', 'status', '--json'])).stdout) : null;
      if (res.ok && again && !ourEntry(again, key, ports)) lines.push(`removed the Tailscale entry for ${key}`);
      else { clean = false; lines.push(`could not remove the Tailscale entry for ${key} (${(res.stderr || 'it is still there').trim().split('\n')[0]}); run: tailscale serve --https=${state.httpsPort} off`); }
    }
  }
  if (state?.pid) {
    const answers = state.port ? await boardUp(deps, state) : false;
    if (answers || force) {
      const killed = deps.kill(state.pid);
      await deps.sleep(300);
      if (!killed || (state.port && await boardUp(deps, state))) { clean = false; lines.push(`could not stop the board (process ${state.pid}); stop it by hand`); }
      else lines.push('stopped the board');
    } else lines.push('the board was not running');
  } else lines.push('the board was not running');
  if (clean) { await fs.rm(remoteFile(deps.env), { force: true }); lines.push('deleted the board token'); }
  else lines.push('kept the saved settings so swarm remote off can be run again');
  return { lines, clean };
}

// The checks run from this computer. The name is looked up by this computer's own resolver (Tailscale's, which always answers with tailnet addresses), so it cannot show how the
// internet sees the name: that is why Funnel is read from Tailscale's own settings, before and after. The request without your login is the lock the proxy relies on.
async function selfCheck(deps, state) {
  const checks = [];
  const base = `https://${state.dns}:${state.httpsPort}`;
  const ips = await deps.resolve(state.dns);
  const publicIps = ips.filter(ip => !isTailnetAddress(ip));
  checks.push({ name: `${state.dns} resolves to tailnet addresses on this computer (${ips.join(', ') || 'no answer'})`, ok: ips.length > 0 && publicIps.length === 0, exposed: publicIps.length > 0 });
  if (publicIps.length) return checks;   // decided before any token is sent
  const noLogin = await deps.get(localUrl(state), { host: `127.0.0.1:${state.port}` });
  checks.push({ name: 'a request without your Tailscale login is refused, even with the token and a loopback Host (403)', ok: noLogin.status === 403 });
  const good = await deps.reach(`${base}/api/board?t=${state.token}`);
  checks.push({ name: `the board answers over the tailnet at ${base}`, ok: good.status === 200 });
  const bad = await deps.reach(`${base}/api/board?t=wrong`);
  checks.push({ name: 'a wrong token is refused (403)', ok: bad.status === 403 });
  return checks;
}

const phoneSteps = state => [
  'On your phone:',
  '  1. Install the Tailscale app and sign in with the same account as this computer. Switch it on.',
  '  2. Point the camera at the QR code above (or open the address in the browser).',
  `  3. The board opens read-only. Add it to the Home Screen if you like. The link has the board token in it: keep it private (swarm remote rotate makes a new one).`,
  '  Answers still go through your swarm-inbox issues (swarm phone), not through this board.',
  `The address: ${boardUrl(state)}`,
].join('\n');

function qrBlock(state, tty) { try { return `\n${qrText(boardUrl(state), { color: tty })}\n`; } catch { return '\n(the address is too long for a QR code; open it by hand)\n'; } }

export async function remoteOn(deps, { tty = false, rotate = false } = {}) {
  const env = deps.env;
  if (!await deps.installed()) {
    return out(['Tailscale is not installed on this computer.', 'Install it, then run swarm remote on again:', '  brew install --cask tailscale        (or download it from https://tailscale.com/download)', 'Nothing was started.'].join('\n'), 1);
  }
  let st = parseStatus((await deps.tailscale(['status', '--json'])).stdout);
  const log = [];
  if (st.state !== 'Running') {
    log.push(`Tailscale is not signed in or not on (${st.state}). Starting it: follow the sign-in address it prints.`);
    const ok = await deps.up();
    st = parseStatus((await deps.tailscale(['status', '--json'])).stdout);
    if (!ok || st.state !== 'Running') return out([...log, 'Tailscale is still not running, so remote was not turned on. Sign in, then run swarm remote on again.'].join('\n'), 1);
  }
  if (!st.dns) return out([...log, 'This computer has no Tailscale name. Turn on MagicDNS and HTTPS certificates for your tailnet (https://login.tailscale.com/admin/dns), then run swarm remote on again.'].join('\n'), 1);
  if (!st.login) return out([...log, 'Could not tell which Tailscale login this computer belongs to, so remote was not turned on.'].join('\n'), 1);

  const key = hostPort(st.dns);
  const existing = await readRemote(env);
  const oldPorts = existing && existing.dns === st.dns ? (existing.ports ?? [existing.port]) : [];
  const beforeRaw = await deps.tailscale(['serve', 'status', '--json']);
  const before = beforeRaw.ok ? parseServe(beforeRaw.stdout) : null;
  if (!before) return out([...log, 'Tailscale did not give a clear answer about its serve settings, so remote was not turned on (nothing was started).'].join('\n'), 1);
  if (funnelOnFor(before, key, oldPorts)) {
    return out([...log, `Funnel (the public internet) is ON for ${key}. Remote refuses to work next to it.`, `Turn it off yourself: tailscale funnel --https=${HTTPS_PORT} off`, `Then run swarm remote on again. Nothing was started${rotate ? ' (the old token is still active)' : ''}.`].join('\n'), 1);
  }
  const taken = Boolean(before.web[key]) || Object.hasOwn(before.tcp, String(HTTPS_PORT));
  if (taken && !ourEntry(before, key, oldPorts)) return out([...log, `Something else already uses ${key} in tailscale serve, so remote left it alone. Remove it yourself (tailscale serve --https=${HTTPS_PORT} off) and run swarm remote on again.`].join('\n'), 1);

  // The same loopback port as last time while that board is still the one answering; a new free port after a rotate or when it is gone.
  let port = null;
  if (existing?.port && !rotate) port = (await boardUp(deps, existing)) ? existing.port : await deps.freePort(existing.port);
  port ??= await deps.freePort(0);
  const state = {
    enabled: true,
    token: existing && !rotate ? existing.token : randomBytes(24).toString('hex'),
    port,
    ports: [...new Set([...oldPorts, port])],   // while an old entry may still point at an old port; cut back to the current one once the new entry is confirmed
    httpsPort: HTTPS_PORT,
    dns: st.dns,
    login: st.login,
    hosts: [key],
    pid: existing?.pid ?? null,
    startedAt: new Date(deps.now()).toISOString(),
  };
  // The board for this token, on this port: kept if it is already the right one, otherwise restarted.
  const keep = existing && existing.token === state.token && existing.port === state.port && await boardUp(deps, state);
  if (!keep) {
    if (existing?.pid && existing.port && await boardUp(deps, existing)) { deps.kill(existing.pid); await deps.sleep(400); }
    await writeRemote(env, state);
    state.pid = await deps.spawnServer();
    await writeRemote(env, state);
    if (!await waitForBoard(deps, state)) {
      const down = await takeDown(deps, state, { force: true });
      return out([...log, `The board did not start (see ${logFile(env, os.homedir())}).`, ...down.lines.map(l => `  ${l}`)].join('\n'), 1);
    }
  } else await writeRemote(env, state);

  const set = await deps.tailscale(['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${state.port}`], { timeout: 45000 });
  if (!set.ok) {
    const down = await takeDown(deps, state, { force: true });
    return out([...log, `tailscale serve failed: ${(set.stderr || set.stdout).trim().split('\n').slice(0, 3).join(' / ')}`, 'If it says HTTPS or Serve is not enabled, turn on HTTPS certificates for your tailnet (https://login.tailscale.com/admin/dns) and enable Serve when it asks.', ...down.lines.map(l => `  ${l}`)].join('\n'), 1);
  }
  // Check what Tailscale now holds: our entry, and no Funnel. If it cannot be confirmed, or Funnel is there, undo everything.
  const afterRaw = await deps.tailscale(['serve', 'status', '--json']);
  const after = afterRaw.ok ? parseServe(afterRaw.stdout) : null;
  if (!after || funnelOnFor(after, key, state.ports) || !ourEntry(after, key, [state.port])) {
    const down = await takeDown(deps, state, { force: true });
    const why = !after ? 'Tailscale did not give a clear answer about its serve settings' : funnelOnFor(after, key, state.ports) ? 'Funnel (the public internet) showed up for the board address' : 'the Tailscale entry is not what was set';
    return out([...log, `${why}. Everything was taken down:`, ...down.lines.map(l => `  ${l}`)].join('\n'), 1);
  }
  state.ports = [state.port];
  await writeRemote(env, state);
  const checks = await selfCheck(deps, state);
  if (checks.some(c => c.exposed)) {
    const down = await takeDown(deps, state, { force: true });
    return out([...log, `${st.dns} resolves to a public address, so the board might not be tailnet-only. Everything was taken down:`, ...down.lines.map(l => `  ${l}`), 'Check your tailnet settings, then try again.'].join('\n'), 1);
  }
  const failed = checks.filter(c => !c.ok);
  const lines = [...log, 'Remote is on (your tailnet only).', ...checks.map(c => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`)];
  const others = anyFunnel(after).filter(k => k !== key);
  if (others.length) lines.push(`Note: Funnel is on for ${others.join(', ')} (not the board). Remote never touches Funnel.`);
  if (failed.length) lines.push('', 'Not everything checked out from this computer. The board is up; try the address from your phone, or run swarm remote status.');
  lines.push(qrBlock(state, tty), phoneSteps(state));
  return out(lines.join('\n'), failed.length ? 1 : 0);
}

export async function remoteStatus(deps) {
  const state = await readRemote(deps.env);
  if (!state) return out('Remote is off. (swarm remote on turns it on.)');
  const raw = await deps.tailscale(['serve', 'status', '--json']);
  const serve = raw.ok ? parseServe(raw.stdout) : null;
  const key = hostPort(state.dns, state.httpsPort);
  const board = await boardUp(deps, state);
  const entry = serve ? ourEntry(serve, key, [state.port]) : false;
  const funnel = serve ? funnelOnFor(serve, key, state.ports ?? [state.port]) : null;
  const lines = [
    `Remote is ${board && entry && funnel === false ? 'on' : 'on, but not working'} (tailnet only).`,
    `  board running on this computer (127.0.0.1:${state.port}): ${board ? 'yes' : 'NO (run swarm remote on to start it again)'}`,
    `  Tailscale entry for ${key}: ${entry ? 'yes' : serve ? 'NO (run swarm remote on)' : 'could not read it'}`,
    `  Funnel (public internet): ${funnel === null ? 'could not read' : funnel ? 'ON for the board address: run swarm remote off' : 'off'}`,
    `  allowed login: ${state.login}`,
    `  address: ${boardUrl(state, false)}   (swarm remote show prints it with the token and a QR code)`,
  ];
  return out(lines.join('\n'), board && entry && funnel === false ? 0 : 1);
}

export async function remoteShow(deps, { tty = false } = {}) {
  const state = await readRemote(deps.env);
  if (!state) return out('Remote is off. swarm remote on turns it on.', 1);
  return out([qrBlock(state, tty), phoneSteps(state)].join('\n'));
}

export async function remoteOff(deps) {
  const state = await readRemote(deps.env);
  if (!state) return out('Remote is already off. Nothing to remove.');
  const down = await takeDown(deps, state);
  return out([down.clean ? 'Remote is off.' : 'Remote is NOT fully off yet:', ...down.lines.map(l => `  ${l}`)].join('\n'), down.clean ? 0 : 1);
}

export async function remoteRotate(deps, opts) {
  if (!await readRemote(deps.env)) return out('Remote is off, so there is no token to change. swarm remote on turns it on.', 1);
  const res = await remoteOn(deps, { ...opts, rotate: true });
  if (res.exitCode === 0 || /Remote is on/.test(res.stdout)) return out(`Old links no longer work.\n${res.stdout}`, res.exitCode);
  return out(`${res.stdout}${(await readRemote(deps.env)) ? 'The old token is still active (nothing was changed). swarm remote off removes it.\n' : ''}`, res.exitCode);
}

// The board process itself (started detached by `remote on`): loopback only, the saved port and token.
export async function serveRemote(env = process.env) {
  const state = await readRemote(env);
  if (!state) { process.stderr.write('swarm remote serve: remote is not set up\n'); return 1; }
  const { startBoardServer } = await import('./watch-cli.mjs');
  const board = await startBoardServer({ env, root: process.cwd(), remote: { port: state.port, token: state.token, hosts: state.hosts, login: state.login } });
  const stop = () => { board.server.close(); board.api.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // If Funnel is ever turned on for the board's address, the board stops itself (it refuses Funnel requests anyway: they carry no tailnet login).
  const deps = realDeps(env);
  const watch = setInterval(async () => {
    const raw = await deps.tailscale(['serve', 'status', '--json']);
    const serve = raw.ok ? parseServe(raw.stdout) : null;
    if (serve && funnelOnFor(serve, hostPort(state.dns, state.httpsPort), state.ports ?? [state.port])) { process.stderr.write(`${new Date().toISOString()} Funnel is on for the board address: stopping the board\n`); stop(); }
  }, Number(env.SWARM_REMOTE_WATCH_MS) || WATCH_MS);
  await board.server.done;
  clearInterval(watch);
  await board.api.close();
  return 0;
}

export async function runRemoteCommand(args, { deps = realDeps(), tty = Boolean(process.stdout.isTTY) } = {}) {
  const [sub, ...rest] = args;
  if (rest.length) return out(REMOTE_USAGE, 2);
  if (sub === 'on') return remoteOn(deps, { tty });
  if (sub === 'off') return remoteOff(deps);
  if (sub === 'status' || sub === undefined) return remoteStatus(deps);
  if (sub === 'show') return remoteShow(deps, { tty });
  if (sub === 'rotate') return remoteRotate(deps, { tty });
  return out(REMOTE_USAGE, 2);
}
