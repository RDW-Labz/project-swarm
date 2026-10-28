// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, readJournal, openItems } from '../tools/journal.mjs';
import { supersededSplitParks, parseSplitParkIngestRun } from '../tools/split-park-supersede.mjs';
import { runInboxCommand } from '../tools/inbox-commands.mjs';
import { parkedBlockers } from '../tools/split-repair.mjs';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const iso = offset => new Date(NOW + offset).toISOString();

function parkText(ticketId, stage, runId) {
  return `Split parked ${ticketId} (title) in stage ${stage}: err. Retry with: swarm scope split --ingest ${runId} --merge --max-repairs 3`;
}

function splitParkEvent({ stage, ticket, run, ts, resolved = false }) {
  const id = `split-park-${stage}-${ticket}`;
  return {
    kind: 'blocker',
    id,
    text: parkText(ticket, stage, run),
    ticket,
    ts,
    ...(resolved ? { resolved: true } : {}),
  };
}

test('older-run open split-park blocker is superseded', () => {
  const events = [
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0099', run: 'run-new', ts: iso(1000) }),
  ];
  const { superseded, kept } = supersededSplitParks(events);
  assert.deepEqual(superseded.map(s => s.id), ['split-park-S19-T-0001']);
  assert.equal(superseded[0].newerRun, 'run-new');
  assert.deepEqual(kept.map(k => k.id), ['split-park-S19-T-0099']);
});

test('blocker re-raised by newest ingest run is kept', () => {
  const events = [
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-new', ts: iso(2000) }),
  ];
  const { superseded, kept } = supersededSplitParks(events);
  assert.equal(superseded.length, 0);
  assert.equal(kept.length, 1);
  assert.match(kept[0].reason, /newest ingest run/);
  assert.equal(kept[0].run, 'run-new');
});

test('unparseable ingest run is kept with reason', () => {
  const events = [{
    kind: 'blocker',
    id: 'split-park-S19-T-0001',
    text: 'Split parked without retry line',
    ticket: 'T-0001',
    ts: iso(0),
  }];
  const { superseded, kept } = supersededSplitParks(events);
  assert.equal(superseded.length, 0);
  assert.equal(kept.length, 1);
  assert.match(kept[0].reason, /unparseable ingest run/);
});

test('stage filter limits evaluation', () => {
  const events = [
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-a-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-a-new', ts: iso(1000) }),
    splitParkEvent({ stage: 'S20', ticket: 'T-0003', run: 'run-b-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S20', ticket: 'T-0004', run: 'run-b-new', ts: iso(1000) }),
  ];
  const { superseded } = supersededSplitParks(events, { stage: 'S19' });
  assert.deepEqual(superseded.map(s => s.id), ['split-park-S19-T-0001']);
});

test('resolved blockers do not set newest ingest run per stage', () => {
  const events = [
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-new', ts: iso(500), resolved: true }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0003', run: 'run-stale-open', ts: iso(100) }),
  ];
  const { superseded } = supersededSplitParks(events);
  assert.deepEqual(superseded.map(s => s.id), ['split-park-S19-T-0001']);
  assert.equal(superseded[0].newerRun, 'run-stale-open');
});

test('superseded resolution events with old run text do not rewind newest run', () => {
  const events = [
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-old', ts: iso(500) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0003', run: 'run-new', ts: iso(1000) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(2000), resolved: true }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-old', ts: iso(2500), resolved: true }),
  ];
  const { superseded, kept } = supersededSplitParks(events);
  assert.equal(superseded.length, 0);
  assert.deepEqual(kept.map(k => k.id), ['split-park-S19-T-0003']);
  assert.match(kept[0].reason, /newest ingest run/);
});

test('manual resolve of newest-run blocker does not make older runs current', () => {
  const events = [
    splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-new', ts: iso(1000) }),
    splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-new', ts: iso(2000), resolved: true }),
  ];
  const { superseded, kept } = supersededSplitParks(events);
  assert.deepEqual(superseded.map(s => s.id), ['split-park-S19-T-0001']);
  assert.equal(superseded[0].newerRun, 'run-new');
  assert.equal(kept.length, 0);
});

test('non-split blockers are untouched', () => {
  const events = [
    { kind: 'blocker', id: 'integrate-r1', text: 'x', ts: iso(0) },
    splitParkEvent({ stage: 'S1', ticket: 'T-0001', run: 'only-run', ts: iso(0) }),
  ];
  const { superseded, kept } = supersededSplitParks(events);
  assert.equal(superseded.length, 0);
  assert.equal(kept.length, 1);
});

test('two stages with different newest runs', () => {
  const events = [
    splitParkEvent({ stage: 'S1', ticket: 'T-0001', run: 'r1-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S1', ticket: 'T-0002', run: 'r1-new', ts: iso(1000) }),
    splitParkEvent({ stage: 'S2', ticket: 'T-0003', run: 'r2-old', ts: iso(0) }),
    splitParkEvent({ stage: 'S2', ticket: 'T-0004', run: 'r2-new', ts: iso(1000) }),
  ];
  const { superseded } = supersededSplitParks(events);
  assert.deepEqual(
    superseded.map(s => [s.id, s.newerRun]).sort(),
    [['split-park-S1-T-0001', 'r1-new'], ['split-park-S2-T-0003', 'r2-new']].sort(),
  );
});

test('parseSplitParkIngestRun reads parkedBlockers text', () => {
  const [blocker] = parkedBlockers([{ ticket: { id: 'T-0100', title: 't' }, stage: 'S3', issues: [{ reason: 'bad' }] }], { runId: 'ingest-xyz' });
  assert.equal(parseSplitParkIngestRun(blocker.text), 'ingest-xyz');
  assert.equal(blocker.id, 'split-park-S3-T-0100');
});

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'split-park-supersede-'));
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('resolve --superseded-splits dry-run writes nothing; real run resolves only superseded', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(0) }), { now: () => NOW });
  await appendEvent(root, splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-old', ts: iso(500) }), { now: () => NOW + 500 });
  await appendEvent(root, splitParkEvent({ stage: 'S19', ticket: 'T-0003', run: 'run-new', ts: iso(1000) }), { now: () => NOW + 1000 });

  const before = await readJournal(root, { limit: Infinity });
  const dry = await runInboxCommand(root, 'resolve', ['--superseded-splits', '--dry-run'], { now: () => NOW });
  assert.equal(dry.exitCode, 0);
  assert.match(dry.stdout, /would resolve: split-park-S19-T-0001/);
  assert.match(dry.stdout, /would resolve: split-park-S19-T-0002/);
  assert.doesNotMatch(dry.stdout, /would resolve: split-park-S19-T-0003/);
  assert.match(dry.stdout, /kept: split-park-S19-T-0003/);
  assert.deepEqual(await readJournal(root, { limit: Infinity }), before);

  const done = await runInboxCommand(root, 'resolve', ['--superseded-splits'], { now: () => NOW });
  assert.equal(done.exitCode, 0);
  assert.match(done.stdout, /resolved: split-park-S19-T-0001 \(superseded by ingest run-new\)/);
  assert.match(done.stdout, /resolved 2 superseded split blockers; kept 1/);
  assert.match(done.stdout, /split-park-S19-T-0003/);

  const open = openItems(await readJournal(root, { limit: Infinity }));
  assert.deepEqual(open.filter(e => String(e.id).startsWith('split-park-')).map(e => e.id), ['split-park-S19-T-0003']);
  const inbox = await runInboxCommand(root, 'inbox', [], { now: () => NOW });
  assert.doesNotMatch(inbox.stdout, /split-park-S19-T-0001/);
  assert.doesNotMatch(inbox.stdout, /split-park-S19-T-0002/);
  assert.match(inbox.stdout, /split-park-S19-T-0003/);
});

test('resolve --superseded-splits twice resolves 0 on second run', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, splitParkEvent({ stage: 'S19', ticket: 'T-0001', run: 'run-old', ts: iso(0) }), { now: () => NOW });
  await appendEvent(root, splitParkEvent({ stage: 'S19', ticket: 'T-0002', run: 'run-old', ts: iso(500) }), { now: () => NOW + 500 });
  await appendEvent(root, splitParkEvent({ stage: 'S19', ticket: 'T-0003', run: 'run-new', ts: iso(1000) }), { now: () => NOW + 1000 });

  const first = await runInboxCommand(root, 'resolve', ['--superseded-splits'], { now: () => NOW + 2000 });
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /resolved 2 superseded split blockers/);

  const second = await runInboxCommand(root, 'resolve', ['--superseded-splits'], { now: () => NOW + 3000 });
  assert.equal(second.exitCode, 0);
  assert.match(second.stdout, /resolved 0 superseded split blockers/);
  assert.doesNotMatch(second.stdout, /resolved: split-park/);

  const open = openItems(await readJournal(root, { limit: Infinity }));
  assert.deepEqual(open.filter(e => String(e.id).startsWith('split-park-')).map(e => e.id), ['split-park-S19-T-0003']);
  const inbox = await runInboxCommand(root, 'inbox', [], { now: () => NOW + 3000 });
  assert.match(inbox.stdout, /split-park-S19-T-0003/);
  assert.doesNotMatch(inbox.stdout, /split-park-S19-T-0001/);
  assert.doesNotMatch(inbox.stdout, /split-park-S19-T-0002/);
});

test('resolve --superseded-splits --json and bad flags', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, splitParkEvent({ stage: 'S1', ticket: 'T-0001', run: 'a', ts: iso(0) }), { now: () => NOW });
  await appendEvent(root, splitParkEvent({ stage: 'S1', ticket: 'T-0002', run: 'b', ts: iso(1) }), { now: () => NOW });

  const json = await runInboxCommand(root, 'resolve', ['--superseded-splits', '--json', '--dry-run'], { now: () => NOW });
  assert.equal(json.exitCode, 0);
  const payload = JSON.parse(json.stdout.trim());
  assert.equal(payload.dryRun, true);
  assert.equal(payload.resolved.length, 1);
  assert.equal(payload.resolved[0].id, 'split-park-S1-T-0001');

  const badStage = await runInboxCommand(root, 'resolve', ['--superseded-splits', '--stage', 'bad'], { now: () => NOW });
  assert.equal(badStage.exitCode, 1);
  assert.match(badStage.stdout, /Usage: swarm resolve/);

  const badFlag = await runInboxCommand(root, 'resolve', ['--superseded-splits', '--nope'], { now: () => NOW });
  assert.equal(badFlag.exitCode, 1);
});
