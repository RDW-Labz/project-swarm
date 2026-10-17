import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanSnapshot } from '../tools/watch-plan.mjs';

function tk(id, extra) {
  return Object.assign({ id: id, title: 'T ' + id, type: 'build', status: 'todo' }, extra || {});
}

function sortById(list) {
  return list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

test('null ledger gives a not-present snapshot', () => {
  assert.deepEqual(buildPlanSnapshot(null), { schema: 1, present: false });
});

test('ledger with no tickets gives a not-present snapshot', () => {
  assert.deepEqual(buildPlanSnapshot({ tickets: [] }), { schema: 1, present: false });
});

test('present snapshot has the contract top-level keys', () => {
  const s = buildPlanSnapshot({ tickets: [tk('a')] });
  assert.equal(s.schema, 1);
  assert.equal(s.present, true);
  for (const k of ['header', 'stages', 'requirements', 'dependencies', 'changeOrders', 'tickets']) {
    assert.ok(k in s, 'missing key ' + k);
  }
});

test('header reads scope, estimate, change orders and spend', () => {
  const s = buildPlanSnapshot({
    scope: { name: 'Shop', version: '2' },
    estimate: { usd: 12.5 },
    changeOrders: [{ id: 'co1' }, { id: 'co2' }],
    tickets: [tk('a', { costUsd: 1.25 }), tk('b', { costUsd: 0.75 })],
  });
  assert.equal(s.header.scopeName, 'Shop');
  assert.equal(s.header.scopeVersion, '2');
  assert.equal(s.header.spendUsd, 2);
  assert.equal(s.header.estimateUsd, 12.5);
  assert.equal(s.header.changeOrderCount, 2);
  assert.equal(s.header.total, 2);
});

test('header uses null scope and estimate when absent and 0 spend when no costs', () => {
  const s = buildPlanSnapshot({ tickets: [tk('a')] });
  assert.equal(s.header.scopeName, null);
  assert.equal(s.header.scopeVersion, null);
  assert.equal(s.header.estimateUsd, null);
  assert.equal(s.header.spendUsd, 0);
  assert.equal(s.header.changeOrderCount, 0);
});

test('stages follow first-seen order and missing stage is none', () => {
  const s = buildPlanSnapshot({
    tickets: [
      tk('a', { stage: 'S1', status: 'done' }),
      tk('b', { stage: 'S1', status: 'todo' }),
      tk('c', { status: 'todo' }),
      tk('d', { stage: 'S2', status: 'done' }),
    ],
  });
  assert.deepEqual(s.stages.map((x) => x.id), ['S1', 'none', 'S2']);
});

test('stage percent is done over non-cancelled tickets, rounded', () => {
  const s = buildPlanSnapshot({
    tickets: [
      tk('a', { stage: 'S1', status: 'done' }),
      tk('b', { stage: 'S1', status: 'todo' }),
      tk('c', { stage: 'S1', status: 'cancelled' }),
      tk('d', { stage: 'S2', status: 'done' }),
      tk('e', { stage: 'S3', status: 'cancelled' }),
    ],
  });
  const byId = {};
  for (const st of s.stages) byId[st.id] = st;
  assert.equal(byId.S1.done, 1);
  assert.equal(byId.S1.percent, 50);
  assert.equal(byId.S2.percent, 100);
  assert.equal(byId.S3.percent, 0);
});

test('stage percent rounds to nearest whole percent', () => {
  const s = buildPlanSnapshot({
    tickets: [
      tk('a', { stage: 'S1', status: 'done' }),
      tk('b', { stage: 'S1', status: 'todo' }),
      tk('c', { stage: 'S1', status: 'todo' }),
    ],
  });
  assert.equal(s.stages[0].percent, 33);
});

test('epics group by epic with general default and card shape', () => {
  const s = buildPlanSnapshot({
    tickets: [
      tk('a', { stage: 'S1', epic: 'E1', status: 'done', risk: 'high', sensitive: true, lane: 'x' }),
      tk('b', { stage: 'S1', status: 'todo' }),
    ],
  });
  const epics = s.stages[0].epics;
  assert.deepEqual(epics.map((e) => e.id), ['E1', 'general']);
  assert.equal(epics[0].total, 1);
  assert.equal(epics[0].done, 1);
  assert.deepEqual(epics[0].cards, [
    { id: 'a', title: 'T a', type: 'build', status: 'done', risk: 'high', sensitive: true, lane: 'x' },
  ]);
  assert.equal(epics[1].cards[0].lane, null);
});

test('requirements come from scopeRefs union when ledger has none', () => {
  const s = buildPlanSnapshot({
    tickets: [
      tk('a', { scopeRefs: ['R2'], status: 'done' }),
      tk('b', { scopeRefs: ['R1', 'R2'], status: 'todo' }),
      tk('c', { scopeRefs: ['R1'], status: 'cancelled' }),
    ],
  });
  const reqs = s.requirements;
  assert.deepEqual(reqs.map((r) => r.id), ['R1', 'R2']);
  assert.deepEqual(reqs[0].tickets, ['b']);
  assert.equal(reqs[0].state, 'partial');
  assert.deepEqual(reqs[1].tickets, ['a', 'b']);
  assert.equal(reqs[1].state, 'partial');
});

test('explicit ledger requirements accept string and object forms with states', () => {
  const s = buildPlanSnapshot({
    requirements: ['Z', { id: 'Y', title: 'Why' }],
    tickets: [tk('x', { scopeRefs: ['Y'], status: 'done' })],
  });
  const reqs = sortById(s.requirements);
  assert.deepEqual(reqs.map((r) => r.id), ['Y', 'Z']);
  assert.equal(reqs[0].title, 'Why');
  assert.deepEqual(reqs[0].tickets, ['x']);
  assert.equal(reqs[0].state, 'done');
  assert.deepEqual(reqs[1].tickets, []);
  assert.equal(reqs[1].state, 'missing');
});

test('dependency nodes exclude cancelled and edges only join listed nodes', () => {
  const s = buildPlanSnapshot({
    tickets: [
      tk('A', { status: 'blocked' }),
      tk('B', { status: 'todo', dependsOn: ['A'] }),
      tk('C', { status: 'todo', dependsOn: ['B'] }),
      tk('D', { status: 'done', dependsOn: ['A'] }),
      tk('E', { status: 'todo', dependsOn: ['Q'] }),
      tk('F', { status: 'cancelled', dependsOn: ['A'] }),
      tk('G', { status: 'todo', dependsOn: ['F'] }),
    ],
  });
  const nodes = sortById(s.dependencies.nodes);
  assert.deepEqual(nodes.map((n) => n.id), ['A', 'B', 'C', 'D', 'E', 'G']);
  assert.deepEqual(nodes[0], { id: 'A', status: 'blocked' });
  const edges = s.dependencies.edges.slice().sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  assert.deepEqual(edges, [
    { from: 'B', to: 'A' },
    { from: 'C', to: 'B' },
    { from: 'D', to: 'A' },
  ]);
});

test('blocked includes blocked tickets and open tickets chained behind them', () => {
  const s = buildPlanSnapshot({
    tickets: [
      tk('A', { status: 'blocked' }),
      tk('B', { status: 'todo', dependsOn: ['A'] }),
      tk('C', { status: 'todo', dependsOn: ['B'] }),
      tk('D', { status: 'done', dependsOn: ['A'] }),
      tk('E', { status: 'todo', dependsOn: ['Q'] }),
    ],
  });
  assert.deepEqual(s.dependencies.blocked.slice().sort(), ['A', 'B', 'C']);
});

test('change orders are listed oldest first with added counts', () => {
  const s = buildPlanSnapshot({
    changeOrders: [
      { id: 'co1', at: '2024-01-01T00:00:00Z', by: 'owner', reason: 'first', cancelled: false, reopened: true, diff: { added: 2 } },
      { id: 'co2', at: '2024-01-02T00:00:00Z', by: 'owner', reason: 'second', cancelled: true, diff: {} },
    ],
    tickets: [tk('a')],
  });
  assert.equal(s.changeOrders.length, 2);
  assert.deepEqual(s.changeOrders[0], {
    id: 'co1',
    at: '2024-01-01T00:00:00Z',
    by: 'owner',
    reason: 'first',
    cancelled: false,
    reopened: true,
    added: 2,
  });
  assert.equal(s.changeOrders[1].id, 'co2');
  assert.equal(s.changeOrders[1].cancelled, true);
  assert.equal(s.changeOrders[1].added, 0);
});

test('tickets are keyed by id with null scalars and empty arrays for missing values', () => {
  const s = buildPlanSnapshot({ tickets: [{ id: 't1' }] });
  const t = s.tickets.t1;
  assert.equal(t.id, 't1');
  assert.equal(t.title, null);
  assert.equal(t.lane, null);
  assert.equal(t.pr, null);
  assert.deepEqual(t.scopeRefs, []);
  assert.deepEqual(t.acceptance, []);
  assert.deepEqual(t.files, []);
  assert.deepEqual(t.dependsOn, []);
  assert.deepEqual(t.drift, []);
});

test('ticket drift is kept as an array of strings', () => {
  const s = buildPlanSnapshot({ tickets: [tk('a', { drift: ['one', 'two'] })] });
  assert.deepEqual(s.tickets.a.drift, ['one', 'two']);
});

test('ticket text is sanitized and control characters are removed', () => {
  const s = buildPlanSnapshot({ tickets: [tk('a', { title: 'A\u0007B' })] });
  assert.equal(typeof s.tickets.a.title, 'string');
  assert.ok(!s.tickets.a.title.includes('\u0007'));
});
