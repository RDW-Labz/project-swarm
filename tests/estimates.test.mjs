// SPDX-License-Identifier: Apache-2.0
// Estimates scale with ticket count, lane and size, from this project's own history. The numbers below are the parts app's real stages (tickets and requirements from its ledger;
// S11's cost from its run files; S12's runs were mostly gone, so its cost is not used). The old estimate said "11 requirements: 11 tickets, $0.03" for a stage that needs 40 to 50 tickets.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stageHistory, laneRates, historyRates, estimateWork } from '../tools/estimates.mjs';
import { impactAnalysis, diffScopes } from '../tools/change-orders.mjs';
import { buildQuote, estimatedFull } from '../tools/quotes.mjs';
import { needsHuman } from '../tools/approval-policy.mjs';

// stage: [tickets, requirements, costed jobs, lane of those jobs, cost per job]
const STAGES = { S9: [14, 3, 14, 'anthropic', 0.005], S10: [14, 3, 14, 'anthropic', 0.005], S11: [48, 15, 43, 'claude', 0.133], S12: [42, 15, 15, 'claude', 0.187] };
function parts() {
  const tickets = [], runs = [];
  let n = 0;
  for (const [stage, [t, r, costed, lane, cost]] of Object.entries(STAGES)) {
    const jobs = [];
    for (let i = 0; i < t; i += 1) {
      n += 1;
      const id = `T-${String(n).padStart(4, '0')}`;
      tickets.push({ id, stage, status: 'done', type: 'build', scopeRefs: [`R-${stage}-${i % r}`] });
      if (i < costed) jobs.push({ id, agent: lane, status: 'complete', costUsd: cost });
    }
    runs.push({ id: stage, state: { jobs } });
  }
  tickets.push({ id: 'T-9001', stage: 'S11', status: 'cancelled', type: 'build', scopeRefs: ['R-x'] }, { id: 'T-9002', stage: 'S12', status: 'proposed', type: 'build', scopeRefs: ['R-y'] }, { id: 'T-9003', stage: 'S12', status: 'done', type: 'human', scopeRefs: [] });
  return { tickets, runs };
}

test('stage history: tickets and requirements per finished stage, cancelled, proposed and human tickets left out, a stage with little cost on record is marked', () => {
  const { tickets, runs } = parts();
  const h = Object.fromEntries(stageHistory({ tickets, runs }).map(s => [s.stage, s]));
  assert.deepEqual(Object.keys(h).sort(), ['S10', 'S11', 'S12', 'S9']);
  assert.equal(h.S11.tickets, 48); assert.equal(h.S11.requirements, 15);
  assert.equal(h.S11.costedTickets, 43);
  assert.ok(Math.abs(h.S11.usd - 43 * 0.133) < 1e-6);
  assert.equal(h.S12.costedTickets, 15, 'S12 cost is mostly missing');
  const rates = historyRates(Object.values(h));
  assert.equal(rates.costStages, 3, 'S12 (36 percent of its tickets costed) is not used for cost');
  assert.equal(rates.latestUsdPerTicket.stage, 'S11');
});

test('for 11 new requirements the estimate is 40 to 50 tickets at about $5 to $12, not 11 tickets and $0.03', () => {
  const { tickets, runs } = parts();
  const work = estimateWork({ requirements: 11, stages: stageHistory({ tickets, runs }), lanes: laneRates({ tickets, runs }) });
  assert.ok(work.tickets.low >= 30 && work.tickets.low <= 36, `low ${work.tickets.low}`);
  assert.ok(work.tickets.mid >= 40 && work.tickets.mid <= 46, `mid ${work.tickets.mid}`);
  assert.ok(work.tickets.high >= 48 && work.tickets.high <= 54, `high ${work.tickets.high}`);
  assert.ok(work.usd.mid >= 5 && work.usd.mid <= 7, `mid $${work.usd.mid}`);
  assert.ok(work.usd.high >= 6 && work.usd.high <= 12, `high $${work.usd.high}`);
  assert.ok(work.usd.low < 1, 'every ticket on the cheap lane is cheap');
  assert.ok(work.usd.low < work.usd.mid && work.usd.mid < work.usd.high);
  assert.equal(work.learned, true);
  assert.match(work.basis, /finished stages of this project/);
  assert.deepEqual(work.byLane.map(l => l.lane), ['anthropic', 'claude'], 'cheapest lane first');
  assert.ok(work.byLane[1].usd > work.byLane[0].usd * 10, 'the lane the ticket runs on decides the price');
});

test('the estimate scales with the number of requirements, and with the lane', () => {
  const { tickets, runs } = parts();
  const stages = stageHistory({ tickets, runs }), lanes = laneRates({ tickets, runs });
  const one = estimateWork({ requirements: 5, stages, lanes }), two = estimateWork({ requirements: 10, stages, lanes });
  assert.ok(Math.abs(two.tickets.mid - 2 * one.tickets.mid) <= 1);
  assert.ok(Math.abs(two.usd.mid / one.usd.mid - 2) < 0.2);
  assert.equal(estimateWork({ requirements: 0, stages, lanes }).tickets.mid, 0);
});

test('no history: tickets use a stated default and the cost is unknown, never an invented price', () => {
  const w = estimateWork({ requirements: 11, stages: [], lanes: null });
  assert.deepEqual(w.tickets, { low: 44, mid: 44, high: 44 });
  assert.equal(w.usd, null);
  assert.equal(w.learned, false);
  assert.match(w.basis, /no finished stage to learn from/);
});

test('swarm change: impactAnalysis carries the range and the basis; the approval check uses the high end; no history means the cost is unknown (so it needs you)', () => {
  const { tickets, runs } = parts();
  const mk = ids => ({ requirements: ids.map(id => ({ id, stage: 'S13', text: `A user can ${id}.`, acceptance: ['works in 2 seconds'], line: 1 })), stages: [{ id: 'S13', title: 'x', order: 13 }], sections: [], external: [], sensitive: [], protected: [], errors: [], strays: [], context: [], name: 'x', version: 1, overview: '', layout: '' });
  const ids = Array.from({ length: 11 }, (_, i) => `R-${100 + i}`);
  const diff = diffScopes(mk([]), mk(ids));
  const impact = impactAnalysis({ diff, tickets, history: { stages: stageHistory({ tickets, runs }), lanes: laneRates({ tickets, runs }) } });
  assert.equal(impact.estimate.requirements, 11);
  assert.ok(impact.estimate.ticketsRange.high >= 48);
  assert.equal(impact.estimate.usd, impact.estimate.usdRange.high, 'the figure the policy checks is the high end');
  assert.ok(impact.estimate.usd > 5);
  const blind = impactAnalysis({ diff, tickets: [], history: {} });
  assert.equal(blind.estimate.usd, null);
});

test('quotes scale each similar project to the new scope\'s size, so a smaller scope is not quoted as the whole earlier project', () => {
  const rec = (id, requirements, billed, hours, days) => ({ id, name: id, source: 'recorded', requirements, stages: 4, screens: 6, services: 3, billedUsd: billed, flatRateListUsd: 0, estimatedFullUsd: billed, ownerHours: hours, calendarDays: days, gpuHours: null });
  const records = [rec('a', 60, 27, 30, 8), rec('b', 50, 24, 25, 7), rec('c', 70, 33, 36, 9)];
  const config = { hourlyRate: null, margin: null };
  const half = buildQuote({ traits: { requirements: 30, stages: 4, screens: 5, services: 3 }, records, config });
  assert.ok(half.cost.high < 17, `a 30-requirement scope quoted at up to $${half.cost.high}; the 60-requirement project cost $27`);
  assert.ok(Math.abs(half.cost.low - 24 * 30 / 50) < 2.5, 'cost per requirement times the size');
  assert.ok(half.hours.high < 18);
  assert.ok(half.days.low > 4.5 && half.days.high < 7, `calendar time by the square root: ${half.days.low} to ${half.days.high}`);
  assert.deepEqual(half.scale.map(x => x.factor).sort(), [0.43, 0.5, 0.6]);
  const same = buildQuote({ traits: { requirements: 60, stages: 4, screens: 6, services: 3 }, records, config });
  assert.ok(same.cost.low > 20 && same.cost.high < 36);
  const blind = buildQuote({ traits: { requirements: 15, stages: 4, screens: 6, services: 3 }, records: [{ ...rec('d', null, 30, 30, 8), requirements: null }], config });
  assert.match(blind.why, /not scaled for size/);
  assert.equal(estimatedFull(rec('x', 1, 2, 3, 4)), 2);
});

test('work in progress, held jobs and jobs with no cost do not distort the estimate', () => {
  const { tickets, runs } = parts();
  // 30 tickets of S11 still running with large costs, a held job with no cost, a job with a null cost: none of it is a finished ticket's price.
  for (let i = 0; i < 30; i += 1) { tickets.push({ id: `T-W${i}`, stage: 'S11', status: 'running', type: 'build', scopeRefs: ['R-S11-0'] }); runs[2].state.jobs.push({ id: `T-W${i}`, agent: 'claude', status: 'complete', costUsd: 2 }); }
  runs[2].state.jobs.push({ id: 'T-0001', agent: 'claude', status: 'held', costUsd: 0 }, { id: 'T-0002', agent: 'claude', status: 'complete', costUsd: null });
  const clean = parts();
  const a = estimateWork({ requirements: 11, stages: stageHistory(clean), lanes: laneRates(clean) });
  const b = estimateWork({ requirements: 11, stages: stageHistory({ tickets, runs }), lanes: laneRates({ tickets, runs }) });
  assert.deepEqual(b.tickets, a.tickets);
  assert.ok(Math.abs(b.usd.mid - a.usd.mid) < 1e-6, `mid ${b.usd.mid} vs ${a.usd.mid}`);
  assert.ok(Math.abs(b.usd.high - a.usd.high) < 1e-6);
  assert.ok(b.usd.low > 0, 'a free-looking job does not pull the low end to zero');
});

test('a gap in the cost record is a gap: a stage with most of its tickets uncosted is not used for the price', () => {
  const { tickets, runs } = parts();
  const h = historyRates(stageHistory({ tickets, runs }));
  assert.equal(h.latestUsdPerTicket.stage, 'S11');
  assert.equal(stageHistory({ tickets, runs }).find(s => s.stage === 'S12').costedTickets, 15);
  assert.equal(h.costStages, 3);
});

test('an unknown cost needs the owner: the change-order check treats a missing dollar figure as over the limit', () => {
  const policy = { humanApprovals: [], changeOrderOverUsd: 5 };
  assert.equal(needsHuman(policy, { kind: 'change-order', usd: null }), true);
  assert.equal(needsHuman(policy, { kind: 'change-order', usd: 4.9 }), false);
  assert.equal(needsHuman(policy, { kind: 'change-order', usd: 5.1 }), true);
});

test('a project more than five times larger or smaller is not scaled into a quote', () => {
  const rec = (id, requirements) => ({ id, name: id, source: 'recorded', requirements, stages: 4, screens: 6, services: 3, billedUsd: 10, flatRateListUsd: 0, estimatedFullUsd: 10, ownerHours: 10, calendarDays: 5, gpuHours: null });
  const q = buildQuote({ traits: { requirements: 12, stages: 4, screens: 6, services: 3 }, records: [rec('huge', 150), rec('near', 14)], config: { hourlyRate: null, margin: null } });
  assert.deepEqual(q.similar.map(s => s.name), ['near']);
  const none = buildQuote({ traits: { requirements: null, stages: 4, screens: 6, services: 3 }, records: [rec('near', 14)], config: { hourlyRate: null, margin: null } });
  assert.match(none.why, /this scope has no requirement count/);
});
