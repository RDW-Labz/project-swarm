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
import { createOwnerActions, ownerItemsFromBoardInbox } from '../tools/board-owner-actions.mjs';
import { boardInbox } from '../tools/board-inbox.mjs';
import { runInboxCommand } from '../tools/inbox-commands.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { appendEvent, readJournal } from '../tools/journal.mjs';
import { projectId } from '../tools/projects.mjs';
import { cleanupTestProject } from './_isolate-config.mjs';
import { guardBoardAction } from '../tools/board-action-guard.mjs';
import { startBoardServer, readOwnerAudit, boardOwnerApply } from '../tools/watch-cli.mjs';
import { readState as readHandbuildState } from '../tools/handbuild.mjs';
import { remoteFile } from '../tools/remote.mjs';

const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const DNS = 'board.tail1234.ts.net';
const LOGIN = 'owner@example.com';
const HOST = `${DNS}:8443`;

function ownerActionsFixture(overrides = {}) {
  const audit = [];
  let time = overrides.now ?? 1_000_000;
  let seq = 0;
  const items = overrides.items ?? [{ id: 'scope-1', kind: 'scope', title: 'Review scope' }];
  return {
    audit,
    setTime: value => { time = value; },
    actions: createOwnerActions({
      listItems: () => items,
      appendAudit: entry => audit.push(entry),
      readAudit: () => audit,
      guard: guardBoardAction,
      now: () => time,
      randomId: () => `confirm-${++seq}`,
      ownerIdentities: [LOGIN],
      confirmTtlMs: overrides.confirmTtlMs ?? 120_000,
      verifyIdentity: (req, identity) => req.tailnetVerified === true && identity === LOGIN,
      apply: overrides.apply ?? (async () => ({ ok: true })),
      ...overrides.ownerActions,
    }),
  };
}

async function startServer(t, { remote = true, ownerActions, token = 'c'.repeat(48) } = {}) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-routes-'));
  await fs.writeFile(path.join(assetDir, 'board.html'), '<!doctype html><title>board</title>');
  const board = {
    snapshot: async () => ({ projects: [] }),
    project: async () => null,
    live: async () => null,
    history: async () => ({ events: [], total: 0 }),
    historyCsv: async () => 'at,kind\n',
    run: async () => null,
    openRun: async () => null,
  };
  const server = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    board,
    getBoard: async () => ({ runs: [] }),
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    commandList: [],
    contextCommands: () => [],
    indexName: 'board.html',
    idleMs: 600_000,
    token,
    ...(remote ? { remote: { hosts: [HOST.toLowerCase()], login: LOGIN }, ownerActions } : {}),
    ...(!remote && ownerActions ? { ownerActions } : {}),
  });
  await server.listen();
  const port = Number(new URL(server.url).port);
  t.after(async () => {
    await server.close();
    await fs.rm(assetDir, { recursive: true, force: true });
  });
  return { port, token, server };
}

function httpRequest(port, reqPath, { method = 'GET', headers = {}, body = null, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: {
        Host: host,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* plain */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const tailnet = (port, reqPath, opts = {}) => httpRequest(port, reqPath, {
  ...opts,
  headers: {
    'Tailscale-User-Login': LOGIN,
    ...(opts.headers ?? {}),
  },
});

test('owner routes are absent without remote board mode', async t => {
  const { actions } = ownerActionsFixture();
  const { port, token } = await startServer(t, { remote: false, ownerActions: actions });
  assert.equal((await httpRequest(port, '/api/owner/audit', { headers: { 'x-watch-token': token } })).status, 404);
  assert.equal((await httpRequest(port, '/api/owner/actions/scope-1/prepare', {
    method: 'POST',
    headers: { 'x-watch-token': token },
  })).status, 404);
  const { port: port2, token: token2 } = await startServer(t, { remote: false, ownerActions: undefined });
  assert.equal((await httpRequest(port2, '/api/owner/audit', { headers: { 'x-watch-token': token2 } })).status, 404);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-local-board-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = await startBoardServer({ env: process.env, root });
  t.after(async () => { await local.server.close(); await local.api.close(); });
  const localPort = Number(new URL(local.url).port);
  assert.equal((await httpRequest(localPort, '/api/owner/audit', { headers: { 'x-watch-token': local.server.token } })).status, 404);
});

test('owner routes refuse missing header token, query-only token, cookie-only POST, bad login, funnel, and local=1', async t => {
  const { actions } = ownerActionsFixture();
  const { port, token } = await startServer(t, { ownerActions: actions });
  const item = 'scope-1';
  const preparePath = `/api/owner/actions/${item}/prepare`;
  const decisionPath = `/api/owner/actions/${item}/decision`;
  assert.equal((await tailnet(port, preparePath, { method: 'POST' })).status, 403);
  assert.equal((await tailnet(port, `${preparePath}?t=${token}`, { method: 'POST' })).status, 401);
  assert.equal((await tailnet(port, preparePath, {
    method: 'POST',
    headers: { Cookie: `swarm_watch_${port}=${token}` },
  })).status, 403);
  assert.equal((await tailnet(port, preparePath, {
    method: 'POST',
    headers: { 'x-watch-token': token, 'Tailscale-User-Login': 'other@example.com' },
  })).status, 401);
  assert.equal((await httpRequest(port, preparePath, {
    method: 'POST',
    host: HOST,
    headers: { 'x-watch-token': token },
  })).status, 401);
  assert.equal((await tailnet(port, preparePath, {
    method: 'POST',
    headers: { 'x-watch-token': token, 'Tailscale-Funnel-Request': '?1' },
  })).status, 401);
  assert.equal((await tailnet(port, `${preparePath}?local=1`, {
    method: 'POST',
    headers: { 'x-watch-token': token },
  })).json?.error, 'owner-forbidden');
  assert.equal((await tailnet(port, decisionPath, {
    method: 'POST',
    headers: { Cookie: `swarm_watch_${port}=${token}` },
    body: { decision: 'approve', confirm: 'x' },
  })).status, 403);
  assert.equal((await tailnet(port, '/api/owner/audit', {
    headers: { Cookie: `swarm_watch_${port}=${token}` },
  })).status, 403);
  assert.equal((await tailnet(port, `/api/owner/audit?t=${token}`)).status, 401);
});

test('prepare with invalid JSON body returns 400 invalid-body', async t => {
  const { actions } = ownerActionsFixture();
  const { port, token } = await startServer(t, { ownerActions: actions });
  const rawBody = '{not json}';
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/owner/actions/scope-1/prepare',
      headers: {
        Host: HOST,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        'Tailscale-User-Login': LOGIN,
        'x-watch-token': token,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* plain */ }
        resolve({ status: response.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
  assert.equal(res.status, 400);
  assert.equal(res.json?.error, 'invalid-body');
});

test('readOwnerAudit skips corrupt lines and returns valid entries', async t => {
  const env = { ...process.env };
  const auditFile = path.join(path.dirname(remoteFile(env, env.HOME)), '.swarm', 'owner', 'audit.ndjson');
  await fs.mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
  const good = JSON.stringify({
    at: '2020-01-01T00:00:00.000Z',
    itemId: 'scope-1',
    decision: 'approve',
    identity: LOGIN,
    outcome: 'approved',
  });
  await fs.writeFile(auditFile, `{not json}\n${good}\n`, { mode: 0o600 });
  t.after(() => fs.rm(path.dirname(auditFile), { recursive: true, force: true }));
  const parsed = await readOwnerAudit(env);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].itemId, 'scope-1');
});

test('owner audit HTTP returns parsed entries when the audit file has a corrupt line', async t => {
  const env = { ...process.env };
  const auditFile = path.join(path.dirname(remoteFile(env, env.HOME)), '.swarm', 'owner', 'audit.ndjson');
  await fs.mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
  const good = JSON.stringify({
    at: '2020-01-02T00:00:00.000Z',
    itemId: 'scope-9',
    decision: 'deny',
    identity: LOGIN,
    outcome: 'denied',
  });
  await fs.writeFile(auditFile, `broken line\n${good}\n`, { mode: 0o600 });
  t.after(() => fs.rm(path.dirname(auditFile), { recursive: true, force: true }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-audit-board-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const board = await startBoardServer({
    env,
    root,
    remote: { port: 0, token: 'd'.repeat(48), hosts: [HOST.toLowerCase()], login: LOGIN },
  });
  t.after(async () => { await board.server.close(); await board.api.close(); });
  const port = Number(new URL(board.url).port);
  const auditGet = await tailnet(port, '/api/owner/audit', { headers: { 'x-watch-token': board.server.token } });
  assert.equal(auditGet.status, 200);
  assert.equal(auditGet.json.length, 1);
  assert.equal(auditGet.json[0].itemId, 'scope-9');
  assert.equal(auditGet.json[0].outcome, 'denied');
});

test('owner prepare, decide, and audit work over the tailnet path', async t => {
  const { actions, audit } = ownerActionsFixture({
    items: [
      { id: 'scope-1', kind: 'scope', title: 'Scope A' },
      { id: 'scope-2', kind: 'scope', title: 'Scope B' },
    ],
  });
  const { port, token } = await startServer(t, { ownerActions: actions });
  const headers = { 'x-watch-token': token };
  const prepared = await tailnet(port, '/api/owner/actions/scope-1/prepare', { method: 'POST', headers });
  assert.equal(prepared.status, 200);
  const approved = await tailnet(port, '/api/owner/actions/scope-1/decision', {
    method: 'POST',
    headers,
    body: { decision: 'approve', confirm: prepared.json.confirmToken },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.result, 'approved');
  const preparedDeny = await tailnet(port, '/api/owner/actions/scope-2/prepare', { method: 'POST', headers });
  const denied = await tailnet(port, '/api/owner/actions/scope-2/decision', {
    method: 'POST',
    headers,
    body: { decision: 'deny', confirm: preparedDeny.json.confirmToken },
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.json.result, 'denied');
  assert.equal(audit.filter(entry => entry.outcome === 'approved' || entry.outcome === 'denied').length, 2);
  const auditGet = await tailnet(port, '/api/owner/audit', { headers });
  assert.equal(auditGet.status, 200);
  assert.ok(auditGet.json.length >= 2);
  assert.equal(JSON.stringify(auditGet.json).includes(token), false);
  for (let i = 1; i < auditGet.json.length; i += 1) {
    assert.ok(String(auditGet.json[i - 1].at).localeCompare(String(auditGet.json[i].at)) >= 0);
  }
});

test('limit-up inbox items are refused end to end with no approved audit entry', async t => {
  const { actions, audit } = ownerActionsFixture({
    items: [{ id: 'limit-1', kind: 'limit-up', title: 'Raise daily limit' }],
  });
  const { port, token } = await startServer(t, { ownerActions: actions });
  const headers = { 'x-watch-token': token };
  const refused = await tailnet(port, '/api/owner/actions/limit-1/prepare', { method: 'POST', headers });
  assert.equal(refused.status, 403);
  assert.equal(audit.some(entry => entry.outcome === 'approved'), false);
});

test('refused item kinds, replayed confirms, expiry sweep, and pending cap are enforced', async t => {
  for (const kind of ['deploy', 'merge', 'cap-raise']) {
    const { actions } = ownerActionsFixture({ items: [{ id: `${kind}-1`, kind, title: kind }] });
    const { port, token } = await startServer(t, { ownerActions: actions });
    const headers = { 'x-watch-token': token };
    const refused = await tailnet(port, `/api/owner/actions/${kind}-1/prepare`, { method: 'POST', headers });
    assert.equal(refused.status, 403);
  }

  const replay = ownerActionsFixture();
  const replayServer = await startServer(t, { ownerActions: replay.actions });
  const headers = { 'x-watch-token': replayServer.token };
  const prepared = await tailnet(replayServer.port, '/api/owner/actions/scope-1/prepare', { method: 'POST', headers });
  await tailnet(replayServer.port, '/api/owner/actions/scope-1/decision', {
    method: 'POST',
    headers,
    body: { decision: 'approve', confirm: prepared.json.confirmToken },
  });
  const replayed = await tailnet(replayServer.port, '/api/owner/actions/scope-1/decision', {
    method: 'POST',
    headers,
    body: { decision: 'approve', confirm: prepared.json.confirmToken },
  });
  assert.equal(replayed.status, 409);

  const expiry = ownerActionsFixture({ confirmTtlMs: 50, now: 10_000 });
  const expiryServer = await startServer(t, { ownerActions: expiry.actions });
  const expiryHeaders = { 'x-watch-token': expiryServer.token };
  const first = await tailnet(expiryServer.port, '/api/owner/actions/scope-1/prepare', { method: 'POST', headers: expiryHeaders });
  expiry.setTime(10_100);
  const expired = await tailnet(expiryServer.port, '/api/owner/actions/scope-1/decision', {
    method: 'POST',
    headers: expiryHeaders,
    body: { decision: 'approve', confirm: first.json.confirmToken },
  });
  assert.equal(expired.status, 409);

  const capItems = Array.from({ length: 6 }, (_, i) => ({ id: `cap-${i}`, kind: 'scope', title: `Cap ${i}` }));
  const cap = ownerActionsFixture({ items: capItems });
  const capServer = await startServer(t, { ownerActions: cap.actions });
  const capHeaders = { 'x-watch-token': capServer.token };
  const tokens = [];
  for (const item of capItems) {
    const out = await tailnet(capServer.port, `/api/owner/actions/${item.id}/prepare`, { method: 'POST', headers: capHeaders });
    assert.equal(out.status, 200);
    tokens.push(out.json.confirmToken);
  }
  const dropped = await tailnet(capServer.port, '/api/owner/actions/cap-0/decision', {
    method: 'POST',
    headers: capHeaders,
    body: { decision: 'approve', confirm: tokens[0] },
  });
  assert.equal(dropped.status, 409);
  const kept = await tailnet(capServer.port, '/api/owner/actions/cap-5/decision', {
    method: 'POST',
    headers: capHeaders,
    body: { decision: 'approve', confirm: tokens[5] },
  });
  assert.equal(kept.status, 200);
});

function ownerActionsFromInbox(project, env, now = () => Date.now()) {
  const audit = [];
  let time = now();
  let seq = 0;
  const actions = createOwnerActions({
    listItems: async () => {
      const inbox = await boardInbox({
        projects: [project],
        now: time,
        env,
        forOwner: true,
        ownerInbox: true,
        phoneDirectory: path.join(env.HOME, 'no-phone'),
      });
      return ownerItemsFromBoardInbox(inbox);
    },
    appendAudit: entry => audit.push(entry),
    readAudit: () => audit,
    guard: guardBoardAction,
    now: () => time,
    randomId: () => `confirm-${++seq}`,
    ownerIdentities: [LOGIN],
    confirmTtlMs: 120_000,
    verifyIdentity: (req, identity) => req.tailnetVerified === true && identity === LOGIN,
    apply: boardOwnerApply(env, () => time),
  });
  return { actions, audit, setTime: value => { time = value; } };
}

test('decisions without boardSafe are refused with decision-not-board-safe', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-board-safe-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'app');
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const project = { id: projectId(root), name: 'app', root };
  const env = { ...process.env, HOME: home, SWARM_PROJECTS_FILE: path.join(home, 'projects.json') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ ...project, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }] }));
  await runInboxCommand(root, 'decision', ['Pick the default theme?', '--choice', 'light', '--id', 'theme-default'], { now: () => 1_700_000_000_000 });
  const { actions, audit } = ownerActionsFromInbox(project, env, () => 1_700_000_000_000);
  const { port, token } = await startServer(t, { ownerActions: actions });
  const headers = { 'x-watch-token': token };
  const refused = await tailnet(port, '/api/owner/actions/theme-default/prepare', { method: 'POST', headers });
  assert.equal(refused.status, 403);
  assert.equal(refused.json?.error, 'decision-not-board-safe');
  assert.equal(audit.some(entry => entry.outcome === 'refused-decision-not-board-safe'), false);
  assert.equal(audit.some(entry => entry.outcome === 'approved'), false);
});

test('a journal decision with boardSafe but protected merge text is still refused', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-board-safe-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'app');
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const project = { id: projectId(root), name: 'app', root };
  const env = { ...process.env, HOME: home, SWARM_PROJECTS_FILE: path.join(home, 'projects.json') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ ...project, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }] }));
  await appendEvent(root, {
    kind: 'decision',
    id: 'merge-pr-12',
    text: 'Merge PR 12 into main?',
    choice: 'yes',
    options: ['yes', 'no'],
    confirm: true,
    boardSafe: true,
  }, { now: () => 1_700_000_000_000 });
  const { actions, audit } = ownerActionsFromInbox(project, env, () => 1_700_000_000_000);
  const { port, token } = await startServer(t, { ownerActions: actions });
  const headers = { 'x-watch-token': token };
  const refused = await tailnet(port, '/api/owner/actions/merge-pr-12/prepare', { method: 'POST', headers });
  assert.equal(refused.status, 403);
  assert.equal(refused.json?.error, 'decision-not-board-safe');
  assert.equal(audit.some(entry => entry.outcome === 'approved'), false);
});

test('a board-safe decision raised with --board-safe can be approved end to end', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-board-safe-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'app');
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const project = { id: projectId(root), name: 'app', root };
  const env = { ...process.env, HOME: home, SWARM_PROJECTS_FILE: path.join(home, 'projects.json') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ ...project, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }] }));
  await runInboxCommand(root, 'decision', ['Use pnpm for installs?', '--choice', 'yes', '--option', 'no', '--id', 'use-pnpm', '--board-safe'], { now: () => 1_700_000_000_000 });
  const { actions, audit } = ownerActionsFromInbox(project, env, () => 1_700_000_000_000);
  const { port, token } = await startServer(t, { ownerActions: actions });
  const headers = { 'x-watch-token': token };
  const prepared = await tailnet(port, '/api/owner/actions/use-pnpm/prepare', { method: 'POST', headers, body: { choice: 'yes' } });
  assert.equal(prepared.status, 200);
  const approved = await tailnet(port, '/api/owner/actions/use-pnpm/decision', {
    method: 'POST',
    headers,
    body: { choice: 'yes', confirm: prepared.json.confirmToken },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.result, 'answered');
  assert.equal(audit.some(entry => entry.outcome === 'answered'), true);
});

test('a hand-build request decision is answerable from the board', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-handbuild-board-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'app');
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'fix.ts'), 'export const x = 1;\n');
  const project = { id: projectId(root), name: 'app', root };
  const env = { ...process.env, HOME: home, SWARM_PROJECTS_FILE: path.join(home, 'projects.json') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ ...project, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }] }));
  const requested = await runHandbuildCommand(root, ['request', '--kind', 'tiny', '--reason', 'The swarm cannot reach this one-off file today', '--files', 'src/fix.ts'], { env, now: () => 1_700_000_000_000 });
  assert.equal(requested.exitCode, 0);
  const open = (await readJournal(root, { limit: Infinity })).find(e => e.kind === 'decision' && String(e.id).startsWith('handbuild-'));
  assert.equal(open?.boardSafe, true);
  const { actions, audit } = ownerActionsFromInbox(project, env, () => 1_700_000_000_000);
  const { port, token } = await startServer(t, { ownerActions: actions });
  const headers = { 'x-watch-token': token };
  const prepared = await tailnet(port, `/api/owner/actions/${open.id}/prepare`, { method: 'POST', headers, body: { choice: 'approve' } });
  assert.equal(prepared.status, 200);
  const approved = await tailnet(port, `/api/owner/actions/${open.id}/decision`, {
    method: 'POST',
    headers,
    body: { decision: 'approve', confirm: prepared.json.confirmToken },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.result, 'answered');
  assert.equal(audit.some(entry => entry.outcome === 'answered'), true);
  await cleanupTestProject(root);
});

test('production remote board lists inbox decisions through ownerItemsFromBoardInbox and enforces board-safe rules', async t => {
  const suiteHome = await fs.mkdtemp(path.join(process.env.HOME, 'owner-remote-e2e-'));
  const root = path.join(suiteHome, 'repos', 'owner-e2e-app');
  const scratchRoot = path.join(suiteHome, '.project-swarm-scratch', 'worktrees', 'owner-e2e-scratch');
  t.after(() => fs.rm(suiteHome, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'scope', 'roadmap.md'), '# roadmap\n');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'fix.ts'), 'export const x = 1;\n');
  await fs.mkdir(path.join(scratchRoot, '.swarm', 'project'), { recursive: true, mode: 0o700 });
  const project = { id: projectId(root), name: 'owner-e2e-app', root };
  const scratchProject = { id: projectId(scratchRoot), name: 'scratch-e2e', root: scratchRoot };
  const env = {
    ...process.env,
    HOME: suiteHome,
    SWARM_PROJECTS_FILE: path.join(suiteHome, 'projects.json'),
    SWARM_PHONE_DIR: path.join(suiteHome, 'no-phone'),
    SWARM_LANES_DIR: path.join(suiteHome, 'lanes'),
  };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({
    version: 1,
    projects: [
      { ...project, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() },
      { ...scratchProject, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() },
    ],
  }));
  const now = () => 1_700_000_000_000;
  await runInboxCommand(root, 'decision', ['Pick the accent color?', '--choice', 'blue', '--id', 'safe-accent', '--board-safe'], { now });
  await runInboxCommand(root, 'decision', ['Pick the default theme?', '--choice', 'light', '--id', 'theme-default'], { now });
  await runInboxCommand(scratchRoot, 'decision', ['Scratch-only choice?', '--choice', 'yes', '--id', 'scratch-only', '--board-safe'], { now, env });
  const harmlessLong = `${'alpha '.repeat(50).slice(0, 300).trimEnd()} merge to main`;
  await appendEvent(root, {
    kind: 'decision',
    id: 'long-merge-tail',
    text: harmlessLong,
    choice: 'yes',
    options: ['yes', 'no'],
    confirm: true,
    boardSafe: true,
  }, { now });
  const handbuild = await runHandbuildCommand(root, ['request', '--kind', 'tiny', '--reason', 'One-off fix', '--files', 'src/fix.ts'], { env, now });
  assert.equal(handbuild.exitCode, 0);
  const handbuildId = (await readJournal(root, { limit: Infinity })).find(e => e.kind === 'decision' && String(e.id).startsWith('handbuild-'))?.id;
  assert.ok(handbuildId);

  const board = await startBoardServer({
    env,
    root: suiteHome,
    now,
    remote: { port: 0, token: 'e'.repeat(48), hosts: [HOST.toLowerCase()], login: LOGIN },
  });
  t.after(async () => { await board.server.close(); await board.api.close(); });
  const port = Number(new URL(board.url).port);
  const headers = { 'x-watch-token': board.server.token };

  async function approveItem(itemId, { choice } = {}) {
    const prepareBody = choice ? { choice } : {};
    const prepared = await tailnet(port, `/api/owner/actions/${itemId}/prepare`, { method: 'POST', headers, body: prepareBody });
    assert.equal(prepared.status, 200, `prepare ${itemId}`);
    const decideBody = choice
      ? { choice, confirm: prepared.json.confirmToken }
      : { decision: 'approve', confirm: prepared.json.confirmToken };
    const decided = await tailnet(port, `/api/owner/actions/${itemId}/decision`, {
      method: 'POST',
      headers,
      body: decideBody,
    });
    assert.equal(decided.status, 200, `decide ${itemId}`);
    assert.equal(['approved', 'answered'].includes(decided.json.result), true);
  }

  async function refuseItem(itemId) {
    const refused = await tailnet(port, `/api/owner/actions/${itemId}/prepare`, { method: 'POST', headers });
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.error, 'decision-not-board-safe');
  }

  await approveItem('safe-accent', { choice: 'blue' });
  await approveItem(handbuildId, { choice: 'approve' });
  await refuseItem('theme-default');
  await refuseItem('long-merge-tail');
  assert.equal((await tailnet(port, '/api/owner/actions/scratch-only/prepare', { method: 'POST', headers })).status, 404);

  const auditGet = await tailnet(port, '/api/owner/audit', { headers });
  assert.equal(auditGet.status, 200);
  const answeredIds = auditGet.json.filter(entry => entry.outcome === 'answered' || entry.outcome === 'approved').map(entry => entry.itemId);
  assert.deepEqual(answeredIds.sort(), ['safe-accent', handbuildId].sort());
  assert.equal(auditGet.json.some(entry => entry.itemId === 'theme-default' && entry.outcome === 'approved'), false);
  assert.equal(auditGet.json.some(entry => entry.itemId === 'long-merge-tail' && entry.outcome === 'approved'), false);

  await cleanupTestProject(root);
});

test('board answers apply to journal, handbuild, tickets, and refuse scope', async t => {
  const home = await fs.mkdtemp(path.join(process.env.HOME, 'owner-apply-e2e-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'repos', 'owner-apply-app');
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'scope', 'roadmap.md'), '# roadmap\n');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'fix.ts'), 'export const x = 1;\n');
  const project = { id: projectId(root), name: 'owner-apply-app', root };
  const env = {
    ...process.env,
    HOME: home,
    SWARM_PROJECTS_FILE: path.join(home, 'projects.json'),
    SWARM_PHONE_DIR: path.join(home, 'no-phone'),
    SWARM_LANES_DIR: path.join(home, 'lanes'),
  };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({
    version: 1,
    projects: [{ ...project, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }],
  }));
  const now = () => 1_700_000_000_100;
  await runInboxCommand(root, 'decision', [
    'pick a theme',
    '--choice', 'dark',
    '--option', 'light',
    '--option', 'system',
    '--id', 'theme-pick',
    '--board-safe',
  ], { now });
  const handbuild = await runHandbuildCommand(root, ['request', '--kind', 'tiny', '--reason', 'One-off fix for apply e2e', '--files', 'src/fix.ts'], { env, now });
  assert.equal(handbuild.exitCode, 0);
  const handbuildId = (await readJournal(root, { limit: Infinity })).find(e => e.kind === 'decision' && String(e.id).startsWith('handbuild-'))?.id;
  assert.ok(handbuildId);
  const hbRequestId = handbuildId.slice('handbuild-'.length);

  const board = await startBoardServer({
    env,
    root: home,
    now,
    remote: { port: 0, token: 'f'.repeat(48), hosts: [HOST.toLowerCase()], login: LOGIN },
  });
  t.after(async () => { await board.server.close(); await board.api.close(); });
  const port = Number(new URL(board.url).port);
  const headers = { 'x-watch-token': board.server.token };

  const themePrepared = await tailnet(port, '/api/owner/actions/theme-pick/prepare', {
    method: 'POST',
    headers,
    body: { choice: 'system' },
  });
  assert.equal(themePrepared.status, 200);
  const themeDecided = await tailnet(port, '/api/owner/actions/theme-pick/decision', {
    method: 'POST',
    headers,
    body: { choice: 'system', confirm: themePrepared.json.confirmToken },
  });
  assert.equal(themeDecided.status, 200);
  const themeEvent = (await readJournal(root, { limit: Infinity })).find(e => e.kind === 'decision' && e.id === 'theme-pick' && e.confirmed === true);
  assert.equal(themeEvent?.choice, 'system');

  const hbPrepared = await tailnet(port, `/api/owner/actions/${handbuildId}/prepare`, {
    method: 'POST',
    headers,
    body: { choice: 'approve' },
  });
  assert.equal(hbPrepared.status, 200);
  const hbDecided = await tailnet(port, `/api/owner/actions/${handbuildId}/decision`, {
    method: 'POST',
    headers,
    body: { decision: 'approve', confirm: hbPrepared.json.confirmToken },
  });
  assert.equal(hbDecided.status, 200);
  assert.equal(readHandbuildState(root).requests[hbRequestId]?.status, 'approved');

  const scopeFixture = ownerActionsFixture({
    items: [{ id: 'scope-approval', kind: 'scope', title: 'Approve scope', projectRoot: root }],
    apply: boardOwnerApply(env, now),
  });
  const scopeServer = await startServer(t, { ownerActions: scopeFixture.actions });
  const scopeHeaders = { 'x-watch-token': scopeServer.token };
  const scopePrepared = await tailnet(scopeServer.port, '/api/owner/actions/scope-approval/prepare', { method: 'POST', headers: scopeHeaders });
  assert.equal(scopePrepared.status, 200);
  const scopeFail = await tailnet(scopeServer.port, '/api/owner/actions/scope-approval/decision', {
    method: 'POST',
    headers: scopeHeaders,
    body: { decision: 'approve', confirm: scopePrepared.json.confirmToken },
  });
  assert.equal(scopeFail.status, 409);
  assert.equal(scopeFail.json.error, 'apply-failed');

  await cleanupTestProject(root);
});
