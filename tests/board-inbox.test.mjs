// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardInbox, inboxText } from '../tools/board-inbox.mjs';
import { writePhoneConfig } from '../tools/phone.mjs';
import { projectId } from '../tools/projects.mjs';
import { appendEvent } from '../tools/journal.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';
import { createBoardApi } from '../tools/watch-cli.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-inbox-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const proj = (home, name) => { const root = path.join(home, name); return { id: projectId(root), name, root }; };
const tk = (id, status, extra = {}) => ({ id, title: `Ticket ${id}`, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status, stage: 'S1', ...extra });

async function world(t) {
  const home = await tmp(t);
  const A = proj(home, 'shop'), B = proj(home, 'blog');
  for (const p of [A, B]) await fs.mkdir(path.join(p.root, '.swarm/project'), { recursive: true });
  await appendEvent(A.root, { kind: 'decision', id: 'logo', text: 'Which logo?', choice: 'blue', options: ['blue', 'green'], confirm: true }, { now: () => NOW - 3600000 });
  await appendEvent(A.root, { kind: 'human', id: 'h-dns', title: 'Point the domain at Vercel', steps: ['open registrar', 'set CNAME'], unblocks: 3 }, { now: () => NOW - 7200000 });
  await appendEvent(B.root, { kind: 'blocker', id: 'b-1', text: 'Stripe key missing' }, { now: () => NOW - 60000 });
  await writeLedger(A.root, createLedger({ scope: { name: 'shop', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', 'done'), tk('T-0002', 'proposed', { origin: 'error', files: ['src/a.ts'] }), tk('T-0003', 'proposed', { origin: 'comment' })] }));
  const phoneDirectory = path.join(home, 'phone');
  await writePhoneConfig(phoneDirectory, { repo: 'o/swarm-inbox', owner: 'me', owners: ['me'], enabled: true });
  await fs.writeFile(path.join(phoneDirectory, 'state.json'), JSON.stringify({ repo: 'o/swarm-inbox', issues: { 7: { key: `${A.root}|decision|logo`, kind: 'decision', status: 'confirming', number: 7, expiresAt: NOW + 5 * 3600000 }, 8: { key: `${A.root}|ticket|T-0002`, kind: 'ticket', status: 'open', number: 8, expiresAt: NOW + 3600000 }, 9: { key: 'panic', kind: 'panic', status: 'open', number: 9, expiresAt: NOW + 3600000 } } }));
  return { home, A, B, phoneDirectory };
}

test('the panel lists what waits in each project: decisions, human tasks, blockers and proposed tickets; each with the command to run at the computer; other projects do not leak into each other', async t => {
  const w = await world(t);
  const inbox = await boardInbox({ projects: [w.A, w.B], now: NOW, phoneDirectory: w.phoneDirectory });
  assert.equal(inbox.total, 5);
  const by = id => inbox.items.find(i => i.id === id);
  assert.deepEqual(inbox.items.filter(i => i.projectId === w.B.id).map(i => i.id), ['b-1']);
  assert.deepEqual(inbox.items.filter(i => i.projectId === w.A.id).map(i => i.id).sort(), ['T-0002', 'T-0003', 'h-dns', 'logo']);
  assert.equal(by('h-dns').command, `swarm --root ${w.A.root} done h-dns`);
  assert.equal(by('logo').command, `swarm --root ${w.A.root} decide logo blue`);
  assert.deepEqual(by('logo').choices, ['blue', 'green']);
  assert.equal(by('T-0002').command, `swarm --root ${w.A.root} tickets T-0002 --approve --yes`);
  assert.equal(by('T-0002').filesNamed, true);
  assert.match(by('T-0003').command, /tickets T-0003 --files FILE\[,FILE\] --yes$/);
  assert.equal(by('T-0003').filesNamed, false);
  assert.equal(by('b-1').command, null);
  assert.equal(inbox.items[0].id, 'h-dns', 'the item that unblocks the most comes first within a project');
});

test('phone: an item that was also asked on the phone says so, with its state and expiry; the panic button is not an item; the phone summary counts open and confirming questions', async t => {
  const w = await world(t);
  const inbox = await boardInbox({ projects: [w.A, w.B], now: NOW, phoneDirectory: w.phoneDirectory });
  const logo = inbox.items.find(i => i.id === 'logo');
  assert.deepEqual([logo.phone.status, logo.phone.issue], ['confirming', 7]);
  assert.equal(logo.phone.expiresAt, new Date(NOW + 5 * 3600000).toISOString());
  assert.equal(inbox.items.find(i => i.id === 'T-0002').phone.status, 'open');
  assert.equal(inbox.items.find(i => i.id === 'h-dns').phone, null);
  assert.deepEqual(inbox.phone, { on: true, repo: 'o/swarm-inbox', owners: ['me'], open: 2, confirming: 1 });
  const none = await boardInbox({ projects: [w.B], now: NOW, phoneDirectory: path.join(w.home, 'nowhere') });
  assert.equal(none.phone, null, 'phone not set up');
});

test('what is shown is sanitised and bounded; one project that cannot be read is named and does not hide the others; a long list is capped per project', async t => {
  const home = await tmp(t);
  const A = proj(home, 'a'), B = proj(home, 'b');
  const collect = async ([root]) => {
    if (root === B.root) throw new Error('journal unreadable');
    return [{ kind: 'human', id: 'x\u0007y', title: 'Rotate sk-ant-' + 'a'.repeat(30) + ' now \u001b[31mred', steps: [], unblocks: 0, since: new Date(NOW).toISOString() }, ...Array.from({ length: 80 }, (_, i) => ({ kind: 'blocker', id: `b${i}`, title: 't', unblocks: 0, since: new Date(NOW).toISOString() }))];
  };
  const inbox = await boardInbox({ projects: [A, B], now: NOW, collect, ledgerOf: async () => null, phoneDirectory: path.join(home, 'none') });
  assert.equal(inbox.items.length, 50);
  assert.deepEqual([inbox.total, inbox.hidden], [81, 31], 'the cap is reported, not hidden');
  assert.match(inboxText(inbox), /\.\.\. and 61 more/);
  assert.deepEqual(inbox.problems.map(p => p.project), ['b']);
  const all = JSON.stringify(inbox);
  assert.doesNotMatch(all, /sk-ant-a{10}|\u001b|\u0007/);
  assert.equal(inbox.items[0].command, null, 'an id with a control character gets no copy-paste command');
});

test('the text view says how many need you, with the command, and stays quiet when nothing does', async t => {
  const w = await world(t);
  const text = inboxText(await boardInbox({ projects: [w.A, w.B], now: NOW, phoneDirectory: w.phoneDirectory }));
  assert.match(text, /^Needs you: 5/);
  assert.match(text, /\[decision\] shop: Which logo\?  \(asked on your phone, confirming\)/);
  assert.match(text, /at the computer: swarm --root .* decide logo blue/);
  assert.equal(inboxText({ total: 0, items: [] }), '');
  assert.equal(inboxText(null), '');
});

test('the board serves it read-only behind the token: /api/board carries inbox, a wrong token is refused, the page has the panel and builds it with textContent only', async t => {
  const w = await world(t);
  const env = { ...process.env, SWARM_PROJECTS_FILE: path.join(w.home, 'projects.json'), SWARM_PHONE_DIR: w.phoneDirectory, SWARM_LANES_DIR: path.join(w.home, 'lanes') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [w.A, w.B].map(p => ({ ...p, addedAt: new Date(NOW).toISOString(), lastSeen: new Date(NOW).toISOString() })) }));
  const api = createBoardApi({ env, now: () => NOW, live: async () => [], cacheMs: 0 });
  const server = createWatchServer({ root: w.home, getRunSnapshot: async () => null, getPlanSnapshot: async () => ({ present: false }), getGallery: async () => ({ schema: 1, screens: [] }), getBoard: async () => ({ runs: [] }), board: api, indexName: 'board.html', assetDir: assets, deltaFile, commandList: [], contextCommands: () => [] });
  const { url } = await server.listen();
  t.after(() => server.close());
  const token = new URL(url).searchParams.get('t');
  const get = (p, headers = {}) => new Promise((resolve, reject) => http.get(new URL(p, url), { headers }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
  const board = await get(`/api/board?t=${token}`);
  assert.equal(board.status, 200);
  const data = JSON.parse(board.body);
  assert.equal(data.inbox.total, 5);
  assert.equal((await get('/api/board?t=wrong')).status, 403);
  assert.equal((await get('/api/board')).status, 403);
  const html = await get(`/?t=${token}`);
  assert.match(html.body, /id="needs"/);
  assert.match(html.body, /id="needsChip"/);
  const js = await get(`/assets/board.js?t=${token}`);
  assert.doesNotMatch(js.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js.body, /Read-only: the board never answers anything/);
  const post = await new Promise((resolve, reject) => { const r = http.request(new URL(`/api/board?t=${token}`, url), { method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r.on('error', reject); r.end(); });
  assert.ok(post >= 400, 'no write method');
});

test('review fixes: a choice that reads as a flag or holds look-alike characters gets no command; a bad expiry date does not hide a project; an expired phone question says expired; a project that hangs is named and the rest still show; the list is sorted across projects', async t => {
  const home = await tmp(t);
  const A = proj(home, 'a'), B = proj(home, 'b'), C = proj(home, 'c');
  const since = n => new Date(NOW - n * 3600000).toISOString();
  const phoneDirectory = path.join(home, 'phone');
  await writePhoneConfig(phoneDirectory, { repo: 'o/r', owner: 'me', owners: ['me'], enabled: true });
  await fs.writeFile(path.join(phoneDirectory, 'state.json'), JSON.stringify({ repo: 'o/r', issues: { 1: { key: `${A.root}|decision|d1`, status: 'open', number: 1, expiresAt: 'tomorrow-ish' }, 2: { key: `${A.root}|decision|d2`, status: 'open', number: 2, expiresAt: NOW - 1000 } } }));
  const collect = async ([root]) => {
    if (root === C.root) return new Promise(() => {});
    if (root === B.root) return [{ kind: 'human', id: 'old', title: 'oldest', since: since(50), unblocks: 0 }];
    return [
      { kind: 'decision', id: 'd1', title: 'bad expiry', choices: ['-rf', 'x'], default: '-rf', since: since(1), unblocks: 0 },
      { kind: 'decision', id: 'd2', title: 'expired question', choices: ['a', 'b'], default: 'a', since: since(2), unblocks: 0 },
      { kind: 'decision', id: 'd3', title: 'bidi', choices: ['ok\u202egpj.exe', 'b'], default: 'ok\u202egpj.exe', since: since(3), unblocks: 0 },
      { kind: 'decision', id: 'd4', title: 'fine', choices: ['yes', 'no'], default: 'yes', since: since(4), unblocks: 5 },
    ];
  };
  const started = Date.now();
  const inbox = await boardInbox({ projects: [A, B, C], now: NOW, collect, ledgerOf: async () => null, phoneDirectory, projectMs: 150 });
  assert.ok(Date.now() - started < 3000, 'the hung project did not stall the board');
  assert.deepEqual(inbox.problems.map(p => p.project), ['c']);
  assert.match(inbox.problems[0].problem, /took longer than/);
  const by = id => inbox.items.find(i => i.id === id);
  assert.equal(by('d1').command, null, 'a choice that starts with a dash');
  assert.equal(by('d3').command, null, 'a right-to-left override in a choice');
  assert.equal(by('d4').command, `swarm --root ${A.root} decide d4 yes`);
  assert.deepEqual([by('d1').phone.status, by('d1').phone.expiresAt], ['open', null], 'a bad date is dropped, the item stays');
  assert.equal(by('d2').phone.status, 'expired');
  assert.deepEqual(inbox.items.map(i => i.id), ['d4', 'old', 'd3', 'd2', 'd1'], 'most blocking first, then oldest, across projects');
  assert.doesNotMatch(JSON.stringify(inbox), /\u202e/);
});
