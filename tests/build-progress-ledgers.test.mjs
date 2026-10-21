// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgress } from '../tools/build-progress.mjs';
import { parseScope } from '../tools/scope.mjs';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const fixturesDir = fileURLToPath(new URL('./fixtures/ledgers/', import.meta.url));
const roadmapScopeFile = fileURLToPath(new URL('../docs/scope/roadmap.md', import.meta.url));

const COUNTED = ticket => ticket && ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status);
const requirementIdRe = /R-\d{3,}/gi;

function requirementIds(ticket) {
  const ids = new Set();
  const visit = value => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(requirementIdRe)) ids.add(match[0].toUpperCase());
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      visit(value.id);
      visit(value.requirement);
    }
  };
  visit(ticket?.scopeRefs);
  visit(ticket?.requirement);
  visit(ticket?.requirements);
  return [...ids];
}

function expectedTicketPercent(ledger) {
  const tickets = ledger.tickets.filter(COUNTED);
  const done = tickets.filter(ticket => ticket.status === 'done').length;
  return { done, total: tickets.length };
}

function expectedRequirements(scope, ledger) {
  const tickets = ledger.tickets.filter(COUNTED);
  const requirements = scope?.requirements ?? [];
  let covered = 0;
  for (const requirement of requirements) {
    const mine = tickets.filter(ticket => requirementIds(ticket).includes(String(requirement.id).toUpperCase()));
    if (mine.length > 0 && mine.every(ticket => ticket.status === 'done')) covered += 1;
  }
  return { covered, total: requirements.length };
}

function hasWaveCompletionEvidence(ledger) {
  return ledger.tickets.some(ticket => ticket.status === 'done' && Number.isFinite(Date.parse(ticket.waveAt ?? '')));
}

async function copyLedgerFixture(t, name, { scopeFile = null, scopeRelative = null } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `build-progress-ledger-${name}-`)));
  const historyFile = path.join(root, 'history.ndjson');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const fixturePath = path.join(fixturesDir, name);
  let ledger = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  if (scopeRelative) {
    ledger = { ...ledger, scope: { ...ledger.scope, file: scopeRelative } };
    await fs.mkdir(path.dirname(path.join(root, scopeRelative)), { recursive: true });
    await fs.writeFile(path.join(root, scopeRelative), await fs.readFile(scopeFile, 'utf8'));
  }
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), `${JSON.stringify(ledger, null, 2)}\n`);
  await fs.writeFile(historyFile, '');
  return { root, historyFile, ledger };
}

function assertStageRows(progress) {
  for (const stage of progress.stages) {
    assert.ok(stage.title && String(stage.title).trim().length > 0, `stage ${stage.stageId} has empty title`);
    assert.notEqual(stage.title, '', `stage ${stage.stageId} must not use a raw empty title`);
    assert.ok(stage.done + stage.open + stage.blocked <= stage.total, `stage ${stage.stageId} counts exceed total`);
  }
}

function assertTicketPercent(progress, ledger) {
  const expected = expectedTicketPercent(ledger);
  assert.deepEqual(progress.percent.tickets.done, expected.done);
  assert.deepEqual(progress.percent.tickets.total, expected.total);
}

test('roadmap ledger fixture matches ticket counts, scope requirements, stage titles, and ETA from wave timestamps', async t => {
  const { root, historyFile, ledger } = await copyLedgerFixture(t, 'roadmap-ledger.json', {
    scopeFile: roadmapScopeFile,
    scopeRelative: 'docs/scope/roadmap.md',
  });
  const scope = parseScope(await fs.readFile(path.join(root, 'docs/scope/roadmap.md'), 'utf8'));
  const progress = await buildProgress({ root, projectId: 'roadmap-fixture', now: NOW, historyFile });

  assertTicketPercent(progress, ledger);
  const req = expectedRequirements(scope, ledger);
  assert.equal(progress.percent.requirements.total, req.total);
  assert.equal(progress.percent.requirements.covered, req.covered);
  assert.equal(typeof progress.percent.requirements.covered, 'number');
  assert.equal(typeof progress.percent.requirements.total, 'number');

  assertStageRows(progress);
  for (const stage of progress.stages) {
    if (/^S\d+$/.test(stage.stageId) && !scope.stages.some(item => item.id === stage.stageId)) {
      assert.match(stage.title, /^Stage \d+$/, `unknown stage ${stage.stageId} should use Stage N titling`);
    }
  }

  // 76 done tickets carry waveAt from integrated runs; tickets.log is absent in the fixture copy.
  assert.ok(hasWaveCompletionEvidence(ledger), 'fixture should expose run wave timestamps for done tickets');
  assert.notEqual(progress.eta, null);
  assert.ok(progress.eta.remaining >= 0);
  assert.ok(Number.isFinite(progress.eta.days));
});

test('anonymized parts-app ledger fixture uses ticket percent only when scope file is missing', async t => {
  const { root, historyFile, ledger } = await copyLedgerFixture(t, 'parts-app-ledger.anon.json');
  const progress = await buildProgress({ root, projectId: 'parts-app-fixture', now: NOW, historyFile });

  assertTicketPercent(progress, ledger);
  assert.equal(progress.percent.requirements, null);
  assertStageRows(progress);
  for (const stage of progress.stages) {
    assert.notEqual(stage.title, stage.stageId, `stage ${stage.stageId} should use a display title, not the raw id`);
  }
});
