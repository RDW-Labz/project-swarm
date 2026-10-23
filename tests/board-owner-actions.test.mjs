// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatchServer } from '../tools/watch-server.mjs';
import {
  createOwnerActions,
  decisionOptionsForItem,
  isYesNoDecisionOptions,
  ownerItemsFromBoardInbox,
} from '../tools/board-owner-actions.mjs';
import { guardBoardAction, isProtectedTopic } from '../tools/board-action-guard.mjs';
import { ownerActionAvailable, renderOwnerActions } from '../tools/watch-assets/board-owner-actions.js';
import { allowedChatUrl } from '../tools/watch-assets/orchestrator-view.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const DNS = 'board.tail.test.ts.net';
const LOGIN = 'owner@tail.test';
const HOST = `${DNS}:8443`;
const BOARD_HDR = 'hdr-test';

function ownerActionsFixture(overrides = {}) {
  const audit = [];
  let time = overrides.now ?? 1_000_000;
  let seq = 0;
  const items = overrides.items ?? [{
    id: 'scope-1',
    kind: 'scope',
    title: 'Review scope',
    approvalPolicy: { humanApprovals: ['scope'] },
  }];
  const actions = createOwnerActions({
    listItems: () => items,
    appendAudit: entry => audit.push(entry),
    readAudit: () => audit,
    guard: guardBoardAction,
    now: () => time,
    randomId: () => `cfm-${++seq}`,
    ownerIdentities: [LOGIN],
    confirmTtlMs: overrides.confirmTtlMs ?? 120_000,
    verifyIdentity: (req, identity) => req.tailnetVerified === true && identity === LOGIN,
    apply: overrides.apply ?? (async () => ({ ok: true })),
    ...overrides.ownerActions,
  });
  return { actions, audit, setTime: value => { time = value; }, items };
}

function httpRequest(port, reqPath, { method = 'GET', host, headers = {}, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: {
        host: host ?? HOST,
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

async function startRemoteServer(t, ownerActions, token = 'a'.repeat(48)) {
  const assetDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'owner-acc-'));
  await fsPromises.writeFile(path.join(assetDir, 'board.html'), '<!doctype html><title>board</title>');
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
    remote: { hosts: [HOST.toLowerCase()], login: LOGIN },
    ownerActions,
  });
  const { port } = await server.listen();
  t.after(async () => {
    await server.close();
    await fsPromises.rm(assetDir, { recursive: true, force: true });
  });
  return { port, token, server };
}

function ownerItem(overrides = {}) {
  return {
    id: 'dec-1',
    kind: 'decision',
    needsOwner: true,
    boardSafe: true,
    title: 'Pick a lane',
    options: [
      { label: 'approve', recommended: true },
      { label: 'deny' },
    ],
    ...overrides,
  };
}

function makeDoc() {
  const nodes = [];
  function createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      _text: '',
      hidden: false,
      disabled: false,
      childNodes: [],
      addEventListener(type, fn) {
        el._listeners = el._listeners || {};
        (el._listeners[type] = el._listeners[type] || []).push(fn);
      },
      appendChild(child) {
        el.childNodes.push(child);
        child.parentNode = el;
        return child;
      },
      querySelectorAll() {
        const out = [];
        function walk(n) {
          if (n.tagName === 'BUTTON') out.push(n);
          for (const c of n.childNodes || []) walk(c);
        }
        walk(el);
        return out;
      },
      click() {
        const fns = el._listeners?.click;
        if (fns) fns.forEach(fn => fn());
      },
    };
    Object.defineProperty(el, 'textContent', {
      get() { return el._text; },
      set(v) {
        el._text = v == null ? '' : String(v);
        el.childNodes.length = 0;
      },
    });
    nodes.push(el);
    return el;
  }
  return { createElement, nodes };
}

function buttonTexts(root) {
  const texts = [];
  function walk(n) {
    if (n.tagName === 'BUTTON' && n.textContent) texts.push(n.textContent);
    for (const c of n.childNodes || []) walk(c);
  }
  walk(root);
  return texts;
}

test('acceptance: Approve and Deny appear only with tailnet sign-in and owner-policy items', () => {
  const item = ownerItem();
  assert.equal(ownerActionAvailable(item, { signedIn: false }), false);
  assert.equal(ownerActionAvailable(item, { signedIn: true }), true);
  assert.equal(ownerActionAvailable({ ...item, needsOwner: false }, { signedIn: true }), false);

  const doc = makeDoc();
  const container = doc.createElement('div');
  renderOwnerActions(container, item, { fetchImpl: () => {}, token: BOARD_HDR, signedIn: false, doc });
  assert.equal(container.childNodes.length, 0);
  renderOwnerActions(container, item, { fetchImpl: () => {}, token: BOARD_HDR, signedIn: true, doc });
  assert.deepEqual(buttonTexts(container), ['Approve', 'Deny']);

  const doc2 = makeDoc();
  const container2 = doc2.createElement('div');
  renderOwnerActions(container2, item, { fetchImpl: () => {}, token: BOARD_HDR, signedIn: true, doc: doc2 });
  doc2.nodes.find(n => n.textContent === 'Approve').click();
  assert.deepEqual(buttonTexts(container2), ['Confirm approve?', 'Cancel']);
});

test('acceptance: tailnet owner prepare, confirm, approve/deny, and audit log over watch-server', async t => {
  const { actions, audit } = ownerActionsFixture({
    items: [
      { id: 'scope-1', kind: 'scope', title: 'Scope A', approvalPolicy: { humanApprovals: ['scope'] } },
      { id: 'scope-2', kind: 'scope', title: 'Scope B', approvalPolicy: { humanApprovals: ['scope'] } },
    ],
  });
  const { port, token } = await startRemoteServer(t, actions);
  const headers = { 'x-watch-token': token };

  const prepared = await tailnet(port, '/api/owner/actions/scope-1/prepare', { method: 'POST', headers });
  assert.equal(prepared.status, 200);
  assert.ok(prepared.json.confirmToken);
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

  const auditGet = await tailnet(port, '/api/owner/audit', { headers });
  assert.equal(auditGet.status, 200);
  assert.equal(auditGet.json.length, 2);
  assert.deepEqual(new Set(auditGet.json.map(entry => entry.outcome)), new Set(['approved', 'denied']));
  assert.equal(JSON.stringify(auditGet.json).includes(token), false);
  assert.equal(audit.filter(e => e.outcome === 'approved' || e.outcome === 'denied').length, 2);
});

test('acceptance: fail-closed owner routes (unsigned, wrong tailnet, funnel, protected decision)', async t => {
  const { actions } = ownerActionsFixture();
  const { port, token } = await startRemoteServer(t, actions);
  const headers = { 'x-watch-token': token };
  const preparePath = '/api/owner/actions/scope-1/prepare';

  assert.equal((await tailnet(port, preparePath, { method: 'POST' })).status, 403);
  assert.equal((await tailnet(port, `${preparePath}?t=${token}`, { method: 'POST' })).status, 401);
  assert.equal((await httpRequest(port, preparePath, {
    method: 'POST',
    host: `127.0.0.1:${port}`,
    headers: { 'x-watch-token': token, 'Tailscale-User-Login': LOGIN },
  })).status, 401);
  assert.equal((await tailnet(port, preparePath, {
    method: 'POST',
    headers: { ...headers, 'Tailscale-Funnel-Request': '?1' },
  })).status, 401);
  assert.equal((await tailnet(port, preparePath, {
    method: 'POST',
    headers: { ...headers, 'Tailscale-User-Login': 'stranger@tail.test' },
  })).status, 401);

  const refusedKind = await tailnet(port, '/api/owner/actions/deploy-1/prepare', {
    method: 'POST',
    headers,
  });
  assert.equal(refusedKind.status, 404);

  const { actions: protectedActions, audit } = ownerActionsFixture({
    items: [{
      id: 'unsafe-dec',
      kind: 'decision',
      boardSafe: true,
      protectedTopic: true,
      title: 'deploy tonight',
      choiceOptions: ['yes', 'no'],
      approvalPolicy: { humanApprovals: [] },
    }],
  });
  const { port: port2, token: token2 } = await startRemoteServer(t, protectedActions, token);
  const refused = await tailnet(port2, '/api/owner/actions/unsafe-dec/prepare', {
    method: 'POST',
    headers: { 'x-watch-token': token2 },
    body: { choice: 'yes' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, 'decision-not-board-safe');
  assert.equal(audit.some(e => e.outcome === 'approved'), false);
  assert.equal(isProtectedTopic('deploy tonight'), true);
});

test('owner inbox mapping exposes yes/no approve and deny options for handbuild decisions', () => {
  const inbox = {
    items: [{
      id: 'handbuild-hb-1',
      kind: 'decision',
      title: 'Approve handbuild',
      boardSafe: true,
      protectedTopic: false,
      projectId: 'p1',
    }],
  };
  const mapped = ownerItemsFromBoardInbox(inbox);
  assert.equal(mapped.length, 1);
  const options = decisionOptionsForItem(mapped[0]);
  assert.equal(isYesNoDecisionOptions(options), true);
  assert.deepEqual(options.map(o => o.label).sort(), ['approve', 'deny']);
});

test('acceptance: orchestrator cards ship an Open chat link gated to Remote Control URLs', () => {
  const orchSrc = fs.readFileSync(path.join(repo, 'tools/watch-assets/orchestrator-view.js'), 'utf8');
  assert.match(orchSrc, /Open chat/);
  assert.match(orchSrc, /allowedChatUrl/);
  assert.equal(allowedChatUrl('https://claude.ai/code/session_ABCDEFGHIJ'), true);
  assert.equal(allowedChatUrl('https://evil.test/session_ABCDEFGHIJ'), false);
});

test('owner routes are absent without remote board mode', async t => {
  const { actions } = ownerActionsFixture();
  const assetDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'owner-local-'));
  await fsPromises.writeFile(path.join(assetDir, 'board.html'), '<!doctype html>');
  const server = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    board: null,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    commandList: [],
    contextCommands: () => [],
    indexName: 'board.html',
    ownerActions: actions,
    token: 'b'.repeat(48),
  });
  const { port } = await server.listen();
  t.after(async () => {
    await server.close();
    await fsPromises.rm(assetDir, { recursive: true, force: true });
  });
  assert.equal((await httpRequest(port, '/api/owner/audit', {
    host: `127.0.0.1:${port}`,
    headers: { 'x-watch-token': 'b'.repeat(48) },
  })).status, 404);
});
