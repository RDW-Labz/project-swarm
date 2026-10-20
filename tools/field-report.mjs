// SPDX-License-Identifier: Apache-2.0

const ROUTING_MIN_SAMPLE = 5;
const ROUTING_MIN_RATE = 0.8;

const arr = value => (Array.isArray(value) ? value : []);
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = value => (typeof value === 'string' && value.length ? value : null);

function jobKey(job) {
  const runId = str(job?.runId) ?? '';
  const jobId = str(job?.jobId) ?? '';
  return runId && jobId ? `${runId}\0${jobId}` : null;
}

function mergeExports(exports) {
  const byProject = new Map();
  for (const raw of arr(exports)) {
    const project = str(raw?.project);
    if (!project) continue;
    let bucket = byProject.get(project);
    if (!bucket) {
      bucket = {
        project,
        machines: new Set(),
        generatedAt: [],
        tickets: new Map(),
        jobs: new Map(),
        waves: new Map(),
        guardBlocks: [],
      };
      byProject.set(project, bucket);
    }
    const machine = str(raw?.machine);
    if (machine) bucket.machines.add(machine);
    const at = str(raw?.generatedAt);
    if (at) bucket.generatedAt.push(at);
    for (const ticket of arr(raw?.tickets)) {
      const id = str(ticket?.id);
      if (!id || bucket.tickets.has(id)) continue;
      bucket.tickets.set(id, ticket);
    }
    for (const job of arr(raw?.jobs)) {
      const key = jobKey(job);
      if (!key || bucket.jobs.has(key)) continue;
      bucket.jobs.set(key, job);
    }
    for (const wave of arr(raw?.waves)) {
      const id = str(wave?.id);
      if (!id) continue;
      const wkey = id;
      if (!bucket.waves.has(wkey)) bucket.waves.set(wkey, wave);
    }
    for (const block of arr(raw?.guard?.blocks)) bucket.guardBlocks.push(block);
  }
  return byProject;
}

function buildProjects(byProject) {
  return [...byProject.values()]
    .map(bucket => ({
      project: bucket.project,
      machines: [...bucket.machines].sort(),
      generatedAt: bucket.generatedAt.sort().at(-1) ?? null,
      tickets: bucket.tickets.size,
      jobs: bucket.jobs.size,
      doneTickets: [...bucket.tickets.values()].filter(t => t?.status === 'done').length,
    }))
    .sort((a, b) => (a.project < b.project ? -1 : 1));
}

function collectFailureCauses(byProject) {
  const counts = new Map();
  const projectSets = new Map();
  const bump = (cause, project) => {
    if (!cause) return;
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
    if (!projectSets.has(cause)) projectSets.set(cause, new Set());
    projectSets.get(cause).add(project);
  };
  for (const bucket of byProject.values()) {
    for (const job of bucket.jobs.values()) bump(str(job?.failureCause), bucket.project);
    for (const ticket of bucket.tickets.values()) bump(str(ticket?.failureCause), bucket.project);
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return [...counts.entries()]
    .map(([cause, count]) => ({
      cause,
      count,
      share: total ? count / total : 0,
      projects: [...projectSets.get(cause)].sort(),
    }))
    .sort((a, b) => b.count - a.count || (a.cause < b.cause ? -1 : 1));
}

function buildLanePassRate(byProject) {
  const groups = new Map();
  for (const bucket of byProject.values()) {
    for (const job of bucket.jobs.values()) {
      const jobType = str(job?.jobType) ?? 'unknown';
      const lane = str(job?.lane) ?? 'unknown';
      const model = str(job?.model) ?? 'unknown';
      const key = `${jobType}\0${lane}\0${model}`;
      let g = groups.get(key);
      if (!g) {
        g = { jobType, lane, model, jobs: 0, passed: 0 };
        groups.set(key, g);
      }
      g.jobs += 1;
      if (job?.status === 'complete') g.passed += 1;
    }
  }
  return [...groups.values()]
    .map(g => ({ ...g, rate: g.jobs ? g.passed / g.jobs : 0 }))
    .sort((a, b) => a.jobType.localeCompare(b.jobType) || a.lane.localeCompare(b.lane) || a.model.localeCompare(b.model));
}

function jobCostForRouting(job) {
  const cost = num(job?.costUsd);
  return cost === 0 ? 0 : cost;
}

function buildCostPerDoneTicket(byProject) {
  const rows = [];
  for (const bucket of byProject.values()) {
    const doneByLane = new Map();
    for (const ticket of bucket.tickets.values()) {
      if (ticket?.status !== 'done') continue;
      const lane = str(ticket?.lane) ?? 'unknown';
      doneByLane.set(lane, (doneByLane.get(lane) ?? 0) + 1);
    }
    const costByLane = new Map();
    for (const job of bucket.jobs.values()) {
      const lane = str(job?.lane) ?? 'unknown';
      costByLane.set(lane, (costByLane.get(lane) ?? 0) + num(job?.costUsd));
    }
    const lanes = new Set([...doneByLane.keys(), ...costByLane.keys()]);
    for (const lane of [...lanes].sort()) {
      const doneTickets = doneByLane.get(lane) ?? 0;
      const cost = costByLane.get(lane) ?? 0;
      rows.push({
        project: bucket.project,
        lane,
        usdPerDone: doneTickets ? cost / doneTickets : null,
        doneTickets,
      });
    }
  }
  return rows.sort((a, b) => a.project.localeCompare(b.project) || a.lane.localeCompare(b.lane));
}

function buildUnderFilledWaves(byProject) {
  const rows = [];
  for (const bucket of byProject.values()) {
    for (const wave of bucket.waves.values()) {
      const ready = num(wave?.readyAtStart);
      const slots = num(wave?.slots);
      if (ready >= slots) continue;
      rows.push({
        project: bucket.project,
        wave: str(wave?.id) ?? 'unknown',
        ready,
        slots,
      });
    }
  }
  return rows.sort((a, b) => a.project.localeCompare(b.project) || a.wave.localeCompare(b.wave));
}

function buildGuardFalsePositives(byProject) {
  const counts = new Map();
  const projectSets = new Map();
  for (const bucket of byProject.values()) {
    for (const block of bucket.guardBlocks) {
      if (!block?.falsePositive) continue;
      const rule = str(block?.rule) ?? 'unknown';
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
      if (!projectSets.has(rule)) projectSets.set(rule, new Set());
      projectSets.get(rule).add(bucket.project);
    }
  }
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count, projects: [...projectSets.get(rule)].sort() }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

function buildRoutingHints(byProject) {
  const byJobType = new Map();
  for (const bucket of byProject.values()) {
    for (const job of bucket.jobs.values()) {
      const jobType = str(job?.jobType) ?? 'unknown';
      const lane = str(job?.lane) ?? 'unknown';
      if (!byJobType.has(jobType)) byJobType.set(jobType, new Map());
      const lanes = byJobType.get(jobType);
      if (!lanes.has(lane)) lanes.set(lane, { jobs: 0, passed: 0, costSum: 0 });
      const g = lanes.get(lane);
      g.jobs += 1;
      if (job?.status === 'complete') g.passed += 1;
      g.costSum += jobCostForRouting(job);
    }
  }
  const hints = [];
  for (const jobType of [...byJobType.keys()].sort()) {
    const lanes = byJobType.get(jobType);
    let best = null;
    for (const [lane, g] of lanes) {
      if (g.jobs < ROUTING_MIN_SAMPLE) continue;
      const rate = g.passed / g.jobs;
      if (rate < ROUTING_MIN_RATE) continue;
      const avgCost = g.costSum / g.jobs;
      if (!best || avgCost < best.avgCost || (avgCost === best.avgCost && lane < best.lane)) {
        best = { lane, rate, avgCost };
      }
    }
    hints.push({
      jobType,
      cheapestLaneThatPasses: best?.lane ?? null,
      rate: best?.rate ?? null,
      minSample: ROUTING_MIN_SAMPLE,
    });
  }
  return hints;
}

export function buildFieldReport(exports, { now = Date.now() } = {}) {
  void now;
  const byProject = mergeExports(exports);
  return {
    projects: buildProjects(byProject),
    topFailureCauses: collectFailureCauses(byProject),
    lanePassRate: buildLanePassRate(byProject),
    costPerDoneTicket: buildCostPerDoneTicket(byProject),
    underFilledWaves: buildUnderFilledWaves(byProject),
    guardFalsePositives: buildGuardFalsePositives(byProject),
    routingHints: buildRoutingHints(byProject),
  };
}

const cap = (items, max) => items.slice(0, max);
const line = parts => parts.filter(p => p !== null && p !== undefined && p !== '').join(' ');

export function formatFieldReport(report) {
  const r = report ?? {};
  const lines = ['Field report', ''];

  lines.push(`Projects (${arr(r.projects).length})`);
  for (const p of cap(arr(r.projects), 8)) {
    lines.push(line(['-', p.project, `machines=${(p.machines ?? []).join(',')}`, `tickets=${p.tickets}`, `jobs=${p.jobs}`, `done=${p.doneTickets}`]));
  }
  if (arr(r.projects).length > 8) lines.push(`  ... +${arr(r.projects).length - 8} more`);

  lines.push('', `Top failure causes (${arr(r.topFailureCauses).length})`);
  for (const row of cap(arr(r.topFailureCauses), 6)) {
    lines.push(line(['-', row.cause, row.count, `${Math.round(row.share * 100)}%`, `[${(row.projects ?? []).join(',')}]`]));
  }
  if (arr(r.topFailureCauses).length > 6) lines.push(`  ... +${arr(r.topFailureCauses).length - 6} more`);

  lines.push('', `Lane pass rate (${arr(r.lanePassRate).length})`);
  for (const row of cap(arr(r.lanePassRate), 8)) {
    lines.push(line(['-', row.jobType, row.lane, row.model, `${row.passed}/${row.jobs}`, `${Math.round(row.rate * 100)}%`]));
  }
  if (arr(r.lanePassRate).length > 8) lines.push(`  ... +${arr(r.lanePassRate).length - 8} more`);

  lines.push('', `Cost per done ticket (${arr(r.costPerDoneTicket).length})`);
  for (const row of cap(arr(r.costPerDoneTicket), 8)) {
    const usd = row.usdPerDone === null ? 'n/a' : `$${row.usdPerDone.toFixed(2)}`;
    lines.push(line(['-', row.project, row.lane, usd, `done=${row.doneTickets}`]));
  }
  if (arr(r.costPerDoneTicket).length > 8) lines.push(`  ... +${arr(r.costPerDoneTicket).length - 8} more`);

  lines.push('', `Under-filled waves (${arr(r.underFilledWaves).length})`);
  for (const row of cap(arr(r.underFilledWaves), 8)) {
    lines.push(line(['-', row.project, `wave=${row.wave}`, `ready=${row.ready}`, `slots=${row.slots}`]));
  }
  if (arr(r.underFilledWaves).length > 8) lines.push(`  ... +${arr(r.underFilledWaves).length - 8} more`);

  lines.push('', `Guard false positives (${arr(r.guardFalsePositives).length})`);
  for (const row of cap(arr(r.guardFalsePositives), 6)) {
    lines.push(line(['-', row.rule, row.count, `[${(row.projects ?? []).join(',')}]`]));
  }
  if (arr(r.guardFalsePositives).length > 6) lines.push(`  ... +${arr(r.guardFalsePositives).length - 6} more`);

  lines.push('', `Routing hints (${arr(r.routingHints).length})`);
  for (const row of cap(arr(r.routingHints), 8)) {
    const rate = row.rate === null ? 'n/a' : `${Math.round(row.rate * 100)}%`;
    lines.push(line(['-', row.jobType, row.cheapestLaneThatPasses ?? 'none', rate, `min=${row.minSample}`]));
  }
  if (arr(r.routingHints).length > 8) lines.push(`  ... +${arr(r.routingHints).length - 8} more`);

  const text = lines.join('\n');
  const out = text.split('\n');
  if (out.length >= 60) {
    return out.slice(0, 59).join('\n') + '\n(truncated)';
  }
  return text;
}
