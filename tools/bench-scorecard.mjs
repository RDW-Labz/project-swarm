// SPDX-License-Identifier: Apache-2.0

const HOUR_MS = 60 * 60 * 1000;

/** @type {Readonly<Record<string, { direction: 'higher' | 'lower', green: number, amber: number }>>} */
export const THRESHOLDS = Object.freeze({
  ready_to_merged_ms: Object.freeze({ direction: 'lower', green: 4 * HOUR_MS, amber: 12 * HOUR_MS }),
  billed_usd: Object.freeze({ direction: 'lower', green: 0.5, amber: 2 }),
  list_usd: Object.freeze({ direction: 'lower', green: 0.75, amber: 3 }),
  first_try_pass_rate: Object.freeze({ direction: 'higher', green: 0.8, amber: 0.6 }),
  retries: Object.freeze({ direction: 'lower', green: 0, amber: 0.5 }),
  flaky_failures: Object.freeze({ direction: 'lower', green: 0, amber: 2 }),
  owner_interruptions_per_day: Object.freeze({ direction: 'lower', green: 5, amber: 15 }),
  idle_slot_pct: Object.freeze({ direction: 'lower', green: 20, amber: 40 }),
  dirty_tree_incidents: Object.freeze({ direction: 'lower', green: 0, amber: 1 }),
  branch_switch_incidents: Object.freeze({ direction: 'lower', green: 0, amber: 2 }),
  guard_false_positives: Object.freeze({ direction: 'lower', green: 0, amber: 3 }),
  orchestrator_tokens_per_merged_ticket: Object.freeze({ direction: 'lower', green: 200_000, amber: 600_000 }),
});

export const SCORECARD_METRIC_NAMES = Object.freeze(Object.keys(THRESHOLDS));

const TREND_DEAD_BAND = 0.05;

export function isoWeekString(ms) {
  const date = new Date(ms);
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function mergeThresholds(overrides = {}) {
  const out = { ...THRESHOLDS };
  for (const [name, patch] of Object.entries(overrides ?? {})) {
    if (!patch || typeof patch !== 'object') continue;
    const base = THRESHOLDS[name];
    if (!base) continue;
    out[name] = Object.freeze({
      direction: patch.direction === 'higher' || patch.direction === 'lower' ? patch.direction : base.direction,
      green: Number.isFinite(Number(patch.green)) ? Number(patch.green) : base.green,
      amber: Number.isFinite(Number(patch.amber)) ? Number(patch.amber) : base.amber,
    });
  }
  return Object.freeze(out);
}

/**
 * @param {string} name
 * @param {number | null | undefined} value
 * @param {'measured' | 'estimated' | 'missing'} status
 * @param {typeof THRESHOLDS} thresholds
 */
export function gradeMetric(name, value, status, thresholds = THRESHOLDS) {
  if (status === 'missing' || value == null || !Number.isFinite(Number(value))) return 'unknown';
  const t = thresholds[name];
  if (!t) return 'unknown';
  const v = Number(value);
  if (t.direction === 'higher') {
    if (v >= t.green) return 'green';
    if (v >= t.amber) return 'amber';
    return 'red';
  }
  if (v <= t.green) return 'green';
  if (v <= t.amber) return 'amber';
  return 'red';
}

/**
 * @param {number | null | undefined} current
 * @param {number | null | undefined} previous
 */
export function metricTrend(current, previous) {
  if (previous == null || previous === undefined) return 'new';
  if (current == null || current === undefined) return 'new';
  const prev = Number(previous);
  const curr = Number(current);
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return 'flat';
  if (prev === 0) {
    if (curr === 0) return 'flat';
    return curr > prev ? 'up' : 'down';
  }
  const deltaPct = (curr - prev) / Math.abs(prev);
  if (Math.abs(deltaPct) <= TREND_DEAD_BAND) return 'flat';
  return curr > prev ? 'up' : 'down';
}

function baselineMetrics(baseline) {
  const metrics = baseline?.metrics;
  if (!metrics || typeof metrics !== 'object') return [];
  return Object.entries(metrics).map(([name, entry]) => ({
    name,
    value: entry?.value ?? null,
    status: entry?.status === 'measured' || entry?.status === 'estimated' ? entry.status : 'missing',
  }));
}

function previousMetricMap(previous) {
  const map = new Map();
  for (const proj of previous?.projects ?? []) {
    for (const m of proj?.metrics ?? []) map.set(`${proj.project}\0${m.name}`, m);
  }
  return map;
}

function formatMetricValue(name, value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  if (name === 'first_try_pass_rate') return `${Math.round(v * 100)}%`;
  if (name.endsWith('_ms')) return `${Math.round(v / 1000)}s`;
  if (name.includes('usd')) return `$${v.toFixed(2)}`;
  if (name.includes('_pct')) return `${v.toFixed(1)}%`;
  if (name.includes('tokens')) return String(Math.round(v));
  return String(v);
}

function buildHeadline(overall, projects, previous) {
  const summary = `${overall.green} green, ${overall.amber} amber, ${overall.red} red`;
  const prevMap = previousMetricMap(previous);
  for (const proj of projects) {
    for (const m of proj.metrics) {
      if (m.name !== 'first_try_pass_rate') continue;
      const prev = prevMap.get(`${proj.project}\0${m.name}`);
      if (!prev || prev.value == null || m.value == null) continue;
      const before = Math.round(Number(prev.value) * 100);
      const after = Math.round(Number(m.value) * 100);
      if (before !== after) {
        return `${summary}; first-try pass rate improved from ${before} to ${after} percent`;
      }
    }
  }
  return summary;
}

/**
 * @param {{ baselines?: object[], replays?: object[], previous?: object, now?: number, thresholds?: object }} input
 */
export function buildScorecard({ baselines = [], replays = [], previous, now = Date.now(), thresholds: thresholdOverrides } = {}) {
  const thresholds = mergeThresholds(thresholdOverrides);
  const prevMap = previousMetricMap(previous);
  const byProject = new Map();

  for (const baseline of baselines ?? []) {
    const project = baseline?.project ?? 'default';
    const existing = byProject.get(project) ?? { project, raw: [] };
    existing.raw.push(...baselineMetrics(baseline));
    byProject.set(project, existing);
  }

  for (const replay of replays ?? []) {
    const project = replay?.project ?? `replay:${replay?.label ?? 'unknown'}`;
    const existing = byProject.get(project) ?? { project, raw: [] };
    const rm = replay?.metrics ?? {};
    if (rm.first_try_rate != null) {
      existing.raw.push({ name: 'first_try_pass_rate', value: rm.first_try_rate, status: 'measured' });
    }
    if (rm.idle_slot_pct != null) {
      existing.raw.push({ name: 'idle_slot_pct', value: rm.idle_slot_pct, status: 'measured' });
    }
    byProject.set(project, existing);
  }

  const projects = [];
  const overall = { green: 0, amber: 0, red: 0, unknown: 0 };

  for (const { project, raw } of byProject.values()) {
    const merged = new Map();
    for (const m of raw) {
      const cur = merged.get(m.name);
      if (!cur) merged.set(m.name, m);
      else if (cur.status === 'missing' && m.status !== 'missing') merged.set(m.name, m);
    }
    const metrics = [];
    for (const name of SCORECARD_METRIC_NAMES) {
      const entry = merged.get(name);
      const value = entry?.value ?? null;
      const status = entry?.status ?? 'missing';
      const grade = gradeMetric(name, value, status, thresholds);
      const prevEntry = prevMap.get(`${project}\0${name}`);
      const trend = metricTrend(value, prevEntry?.value);
      overall[grade] += 1;
      metrics.push({
        name,
        value,
        status,
        grade,
        trend,
        previous: prevEntry?.value ?? null,
      });
    }
    projects.push({ project, metrics });
  }

  projects.sort((a, b) => a.project.localeCompare(b.project));
  const headline = buildHeadline(overall, projects, previous);

  return {
    week: isoWeekString(now),
    generatedAt: new Date(now).toISOString(),
    projects,
    overall,
    headline,
  };
}

export function formatScorecard(card) {
  const lines = [
    `Weekly scorecard ${card.week}`,
    `Generated: ${card.generatedAt}`,
    '',
  ];
  for (const proj of card.projects ?? []) {
    lines.push(`Project: ${proj.project}`);
    for (const m of proj.metrics) {
      lines.push(`  ${m.name}: ${formatMetricValue(m.name, m.value)} (${m.grade}, ${m.trend})`);
    }
    lines.push('');
  }
  lines.push(`Overall: ${card.overall.green} green, ${card.overall.amber} amber, ${card.overall.red} red, ${card.overall.unknown} unknown`);
  lines.push(card.headline);
  const text = lines.join('\n').trimEnd();
  const lineCount = text.split('\n').length;
  if (lineCount > 40) {
    return text.split('\n').slice(0, 39).join('\n') + '\n…';
  }
  return text;
}

export function scorecardForBoard(card) {
  return {
    week: card.week,
    headline: card.headline,
    projects: (card.projects ?? []).map(p => ({
      project: p.project,
      metrics: Object.fromEntries((p.metrics ?? []).map(m => [m.name, m.grade])),
    })),
  };
}
