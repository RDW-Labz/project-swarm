// SPDX-License-Identifier: Apache-2.0

const METRIC_SPEC = {
  pass_rate: 'higher',
  first_try_rate: 'higher',
  throughput_per_min: 'higher',
  median_ms: 'lower',
  p90_ms: 'lower',
  billed_usd_per_case: 'lower',
  list_usd_per_case: 'lower',
  retries_per_case: 'lower',
  flaky_rate: 'lower',
  idle_slot_pct: 'lower',
};

const COMPARE_METRICS = Object.keys(METRIC_SPEC);

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function deltaPct(before, after) {
  if (before === null || after === null) return null;
  if (before === 0) {
    const abs = after - before;
    return abs;
  }
  return (after - before) / Math.abs(before);
}

function direction(before, after, better) {
  if (before === null || after === null) return 'same';
  if (after === before) return 'same';
  if (better === 'higher') return after > before ? 'better' : 'worse';
  return after < before ? 'better' : 'worse';
}

function isRegression(before, after, better, tolerance) {
  if (before === null || after === null) return false;
  const dir = direction(before, after, better);
  if (dir !== 'worse') return false;
  if (before === 0) {
    const worsening = better === 'higher' ? before - after : after - before;
    return worsening > 0.01;
  }
  const pct = Math.abs(deltaPct(before, after));
  return pct > tolerance;
}

export function compareReplays(before, after, { target, tolerance = 0.1 } = {}) {
  const rows = [];
  const regressions = [];
  const notComparable = [];

  for (const metric of COMPARE_METRICS) {
    const b = num(before?.metrics?.[metric]);
    const a = num(after?.metrics?.[metric]);
    if (b === null || a === null) {
      notComparable.push(metric);
      rows.push({
        metric,
        before: b,
        after: a,
        deltaPct: null,
        direction: 'same',
        regression: false,
        comparable: false,
      });
      continue;
    }
    const better = METRIC_SPEC[metric];
    const d = direction(b, a, better);
    const dp = deltaPct(b, a);
    const regression = isRegression(b, a, better, tolerance);
    if (regression) regressions.push(metric);
    rows.push({
      metric,
      before: b,
      after: a,
      deltaPct: dp,
      direction: d,
      regression,
      comparable: true,
    });
  }

  const targetBetter = METRIC_SPEC[target];
  const tb = num(before?.metrics?.[target]);
  const ta = num(after?.metrics?.[target]);
  let targetImproved = false;
  if (tb !== null && ta !== null && targetBetter) {
    targetImproved = direction(tb, ta, targetBetter) === 'better';
  }

  const verdict = targetImproved && regressions.length === 0 ? 'pass' : 'fail';
  let reason = '';
  if (!targetImproved) reason = `target metric ${target} did not improve`;
  else if (regressions.length) reason = `regressions: ${regressions.join(', ')}`;
  else reason = 'target improved with no regressions';

  return {
    rows,
    targetImproved,
    regressions,
    notComparable,
    verdict,
    reason,
  };
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (typeof n !== 'number') return String(n);
  if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(2);
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, '');
}

function fmtDelta(row) {
  if (row.deltaPct === null) return 'n/a';
  if (row.before === 0 && typeof row.deltaPct === 'number' && Math.abs(row.deltaPct) <= 1) {
    return `${row.deltaPct >= 0 ? '+' : ''}${fmt(row.deltaPct)} abs`;
  }
  if (typeof row.deltaPct === 'number') {
    const pct = row.deltaPct * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }
  return 'n/a';
}

function mark(row) {
  if (!row.comparable) return '~';
  if (row.regression) return '✗';
  if (row.direction === 'better') return '✓';
  return '·';
}

export function formatCompareTable(result) {
  const header = ['metric', 'before', 'after', 'change', 'mark'];
  const lines = [header.join('\t')];
  for (const row of result.rows) {
    lines.push(
      [row.metric, fmt(row.before), fmt(row.after), fmtDelta(row), mark(row)].join('\t'),
    );
  }
  lines.push('');
  lines.push(`verdict: ${result.verdict} — ${result.reason}`);
  const text = lines.join('\n');
  const out = text.split('\n');
  if (out.length > 30) return out.slice(0, 30).join('\n');
  return text;
}

export function formatCompareMarkdown(result) {
  const lines = [
    '## Bench compare',
    '',
    '| metric | before | after | change | |',
    '| --- | ---: | ---: | ---: | :---: |',
  ];
  for (const row of result.rows) {
    lines.push(
      `| ${row.metric} | ${fmt(row.before)} | ${fmt(row.after)} | ${fmtDelta(row)} | ${mark(row)} |`,
    );
  }
  lines.push('');
  lines.push(`**Verdict:** ${result.verdict} — ${result.reason}`);
  if (result.notComparable?.length) {
    lines.push('');
    lines.push(`Not comparable: ${result.notComparable.join(', ')}`);
  }
  return lines.join('\n');
}
