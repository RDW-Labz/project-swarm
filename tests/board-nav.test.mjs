// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatchServer } from '../tools/watch-server.mjs';
import { createBoardApi, makeRunServer, runNav, ensureBoard, startBoardServer, readBoardFile, writeBoardFile, boardFile, boardProjectUrl } from '../tools/watch-cli.mjs';
import { projectId } from '../tools/projects.mjs';

const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const realAssets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nav-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const get = (port, pathname, { method = 'GET', host } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { Host: host ?? `127.0.0.1:${port}` } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
  });
  req.on('error', reject); req.end();
});
const portOf = url => Number(new URL(url).port);
const tokenOf = url => new URL(url).searchParams.get('t');

async function setup(t) {
  const home = await tmp(t);
  const root = path.join(home, 'parts-app'); await fs.mkdir(path.join(root, '.swarm/runs/run-1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-1/state.json'), JSON.stringify({ id: 'run-1', status: 'running', startedAt: new Date().toISOString(), jobs: [{ id: 'a', status: 'running', agent: 'codex' }] }));
  const real = await fs.realpath(root);
  const env = { SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'), SWARM_BOARD_FILE: path.join(home, 'board.json'), SWARM_CONFIG: path.join(home, 'none.json') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ id: projectId(real), root: real, name: 'parts-app', addedAt: 'x', lastSeen: 'x' }] }));
  return { home, root: real, env, id: projectId(real) };
}

test('run page opened FROM the board: its nav says where it is, and the links lead back to the board and to the project, each needing the run page\'s own token', async t => {
  const { env, id } = await setup(t);
  const board = await startBoardServer({ env, root: env.SWARM_BOARD_FILE });
  t.after(async () => { await board.server.close(); await board.api.close(); });
  const boardPort = portOf(board.url), boardToken = tokenOf(board.url);
  const open = await get(boardPort, `/open/run?id=${id}&run=run-1&t=${boardToken}`);
  assert.equal(open.status, 302);
  const runUrl = open.headers.location, runPort = portOf(runUrl), runToken = tokenOf(runUrl);
  // the page carries the nav element and script
  const page = await get(runPort, `/?t=${runToken}`);
  assert.match(page.body, /id="crumbs"/);
  assert.match(page.body, /assets\/nav\.js/);
  // without the run page's token nothing works; the board's token is not the run page's token
  for (const route of ['/api/nav', '/nav/board', '/nav/project']) {
    assert.equal((await get(runPort, route)).status, 403, `${route} without a token`);
    assert.equal((await get(runPort, `${route}?t=${boardToken}`)).status, 403, `${route} with the board's token`);
  }
  assert.equal((await get(runPort, `/api/nav?t=${runToken}`, { method: 'POST' })).status, 405);
  assert.equal((await get(runPort, `/api/nav?t=${runToken}`, { host: 'evil.example:80' })).status, 421);
  const nav = JSON.parse((await get(runPort, `/api/nav?t=${runToken}`)).body);
  assert.deepEqual(nav.project, { id, name: 'parts-app' });
  assert.equal(nav.run, 'run-1');
  // back to the board: a redirect to the board's address with the board's token (so Back works, no copy and paste)
  const back = await get(runPort, `/nav/board?t=${runToken}`);
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, board.url);
  assert.equal((await get(boardPort, new URL(back.headers.location).pathname + new URL(back.headers.location).search)).status, 200);
  // to the project page on the board
  const project = await get(runPort, `/nav/project?t=${runToken}`);
  assert.equal(project.status, 302);
  assert.equal(project.headers.location, boardProjectUrl(board.url, id));
  const projectPage = await get(boardPort, new URL(project.headers.location).pathname + new URL(project.headers.location).search);
  assert.equal(projectPage.status, 200);
  assert.match(projectPage.body, /id="crumbs"/);
  assert.match(projectPage.body, /All projects/);
});

test('the nav script and the project page use plain links with the token (no history tricks), and show All projects > project > run', async () => {
  const nav = await fs.readFile(path.join(realAssets, 'nav.js'), 'utf8');
  assert.match(nav, /'\/nav\/board\?t=' \+ T/);
  assert.match(nav, /'\/nav\/project\?t=' \+ T/);
  assert.match(nav, /← All projects/);
  assert.match(nav, /›/, 'the separator of the breadcrumb');
  assert.match(nav, /nav\.run/, 'the run is the last crumb');
  for (const name of ['nav.js', 'project.js', 'board.js']) assert.doesNotMatch(await fs.readFile(path.join(realAssets, name), 'utf8'), /history\.(push|replace)State|location\.replace|innerHTML/, `${name}: nothing that breaks the Back button or injects markup`);
  const project = await fs.readFile(path.join(realAssets, 'project.html'), 'utf8');
  assert.match(project, /id="crumbBack"/);
  assert.match(project, /id="crumbProject"/);
  const js = await fs.readFile(path.join(realAssets, 'project.js'), 'utf8');
  assert.match(js, /crumbBack'\)\.href = '\/\?t=' \+ T/);
  assert.match(js, /crumbProject'\)\.textContent = p\.name/);
});

test('a run page opened DIRECTLY finds a running board, or starts one, and a second click reuses it', async t => {
  const { env, root, id } = await setup(t);
  // no board yet: the link starts one (here, in this process) and records its address
  const closers = [];
  t.after(async () => { for (const c of closers) await c(); });
  let started = 0;
  const start = async args => { started += 1; const b = await startBoardServer(args); closers.push(async () => { await b.server.close(); await b.api.close(); }); return b; };
  const nav = runNav({ root, runId: 'run-1', env });
  nav.openBoard = async pid => { const url = await ensureBoard({ env, root, start }); return pid ? boardProjectUrl(url, pid) : url; };
  const runServer = makeRunServer(root, 'run-1', { nav });
  await runServer.listen();
  t.after(() => runServer.close());
  const runPort = portOf(runServer.url), runToken = runServer.token;
  assert.equal(await readBoardFile({ env }), null, 'no board is running');
  const first = await get(runPort, `/nav/board?t=${runToken}`);
  assert.equal(first.status, 302);
  assert.equal(started, 1);
  const boardUrl = first.headers.location;
  assert.equal(await readBoardFile({ env }), boardUrl, 'its address is recorded for others');
  assert.equal((await get(portOf(boardUrl), `/api/board?t=${tokenOf(boardUrl)}`)).status, 200, 'the board answers');
  assert.equal((await get(runPort, `/nav/board?t=${runToken}`)).headers.location, boardUrl, 'a second click reuses it');
  assert.equal((await get(runPort, `/nav/project?t=${runToken}`)).headers.location, boardProjectUrl(boardUrl, id));
  assert.equal(started, 1, 'started once');
  // another process's board (found through the file) is reused without starting one
  const second = createWatchServer({ root, assetDir: realAssets, deltaFile, getRunSnapshot: async () => null, getPlanSnapshot: async () => ({ present: false }), getGallery: async () => ({ schema: 1, screens: [] }), nav: runNav({ root, runId: 'run-1', env, openBoard: async () => ensureBoard({ env, root, start }) }), commandList: [], contextCommands: () => [] });
  await second.listen();
  t.after(() => second.close());
  assert.equal((await get(portOf(second.url), `/nav/board?t=${second.token}`)).headers.location, boardUrl);
  assert.equal(started, 1);
  // a stale file (the board is gone) starts a fresh one
  await closers.pop()();
  assert.equal(await readBoardFile({ env }), null, 'a closed board is not offered');
  const again = await get(runPort, `/nav/board?t=${runToken}`);
  assert.equal(again.status, 302);
  assert.equal(started, 2);
  assert.notEqual(again.headers.location, boardUrl);
});

test('the board file is private, only a loopback board that answers is reused, and a run page without nav has no nav routes', async t => {
  const { env, root } = await setup(t);
  await writeBoardFile('http://127.0.0.1:1/?t=abc', { env });
  assert.equal((await fs.stat(boardFile(env))).mode & 0o777, 0o600);
  assert.equal(await readBoardFile({ env }), null, 'nothing listens there');
  await writeBoardFile('http://example.com:80/?t=abc', { env });
  assert.equal(await readBoardFile({ env, fetchImpl: async () => ({ ok: true }) }), null, 'only a loopback address is ever used');
  await fs.writeFile(boardFile(env), '{ not json');
  assert.equal(await readBoardFile({ env }), null);
  const plain = makeRunServer(root, 'run-1');
  await plain.listen();
  t.after(() => plain.close());
  assert.equal((await get(portOf(plain.url), `/api/nav?t=${plain.token}`)).status, 404);
  assert.equal((await get(portOf(plain.url), `/nav/board?t=${plain.token}`)).status, 404);
});

test('review fixes: only our own board is reused (shape checked, redirects not followed, a foreign local service gets no token), one start at a time, and a closed board is not pointed at', async t => {
  const { env, root, id } = await setup(t);
  // a foreign local service on a port that answers 200 to anything, and one that redirects
  const seen = [];
  const foreign = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"hello":"world"}'); });
  const redirecting = http.createServer((req, res) => { seen.push(`redirect ${req.url}`); res.writeHead(302, { Location: 'http://127.0.0.1:9/steal' }); res.end(); });
  await Promise.all([foreign, redirecting].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => { foreign.close(); redirecting.close(); });
  await writeBoardFile(`http://127.0.0.1:${foreign.address().port}/?t=secret`, { env });
  assert.equal(await readBoardFile({ env }), null, 'a service that is not our board is refused');
  await writeBoardFile(`http://127.0.0.1:${redirecting.address().port}/?t=secret`, { env });
  assert.equal(await readBoardFile({ env }), null, 'a redirect is not followed');
  // pid 0 / not ours
  await fs.writeFile(boardFile(env), JSON.stringify({ pid: 0, url: 'http://127.0.0.1:1/?t=x' }));
  assert.equal(await readBoardFile({ env }), null);
  // single flight: two clicks at once start one board
  let started = 0;
  const closers = [];
  t.after(async () => { for (const c of closers) await c(); });
  const start = async args => { started += 1; await new Promise(r => setTimeout(r, 50)); const b = await startBoardServer(args); closers.push(async () => { await b.server.close(); await b.api.close(); }); return b; };
  await fs.rm(boardFile(env), { force: true });
  const [one, two] = await Promise.all([ensureBoard({ env, root, start }), ensureBoard({ env, root, start })]);
  assert.equal(one, two);
  assert.equal(started, 1);
  // the file is rebuilt from the origin and the token only
  await fs.writeFile(boardFile(env), JSON.stringify({ pid: process.pid, url: `${new URL(one).origin}/evil/path?x=1&t=${tokenOf(one)}#frag` }));
  assert.equal(await readBoardFile({ env }), one);
  // when the board ends, the run pages it opened stop pointing at it
  const board = await startBoardServer({ env, root });
  const open = await get(portOf(board.url), `/open/run?id=${id}&run=run-1&t=${tokenOf(board.url)}`);
  const runUrl = open.headers.location;
  assert.equal((await get(portOf(runUrl), `/nav/board?t=${tokenOf(runUrl)}`)).status, 302);
  await board.server.close();
  await new Promise(r => setTimeout(r, 100));
  await assert.rejects(get(portOf(runUrl), `/nav/board?t=${tokenOf(runUrl)}`), { code: 'ECONNREFUSED' }, 'the run pages a board opened close with it, so none points at a dead board');
  assert.equal(await fs.readFile(boardFile(env), 'utf8').then(text => JSON.parse(text).url !== board.url, () => true), true, 'its file entry is not left behind');
});
