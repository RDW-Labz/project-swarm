// SPDX-License-Identifier: Apache-2.0

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function finiteNumbers(list) {
  return (list ?? []).filter((n) => typeof n === 'number' && Number.isFinite(n));
}

function readyToMergedSamples(sampleSet) {
  if (Array.isArray(sampleSet?.readyToMergedMs)) {
    return finiteNumbers(sampleSet.readyToMergedMs);
  }
  const tickets = sampleSet?.tickets ?? [];
  return finiteNumbers(tickets.map((t) => t?.readyToMergedMs));
}

function waveRows(sampleSet) {
  if (Array.isArray(sampleSet?.waves)) return sampleSet.waves;
  const runs = sampleSet?.runs ?? [];
  return runs.flatMap((run) => (Array.isArray(run?.waves) ? run.waves : []));
}

/** Idle machine-slot percent (0–100) from wave snapshots, matching bench-baseline wave math. */
export function idleSlotPercentFromWaves(waves) {
  const rows = waveRows({ waves });
  if (!rows.length) return null;
  let idle = 0;
  let slots = 0;
  for (const w of rows) {
    const ready = Array.isArray(w.readyTickets) ? w.readyTickets.length : Number(w.ready ?? 0);
    const cap = Number(w.slots);
    if (!Number.isFinite(cap) || cap <= 0 || ready <= 0) continue;
    const used = Math.min(ready, cap);
    idle += cap - used;
    slots += cap;
  }
  if (!slots) return null;
  return Math.round((idle / slots) * 1000) / 10;
}

function idleSlotPercent(sampleSet) {
  if (typeof sampleSet?.idleSlotPct === 'number' && Number.isFinite(sampleSet.idleSlotPct)) {
    return sampleSet.idleSlotPct;
  }
  const runs = sampleSet?.runs ?? [];
  let idleMs = 0;
  let totalMs = 0;
  for (const run of runs) {
    const idle = Number(run?.idleSlotMs);
    const total = Number(run?.totalSlotMs);
    if (Number.isFinite(idle) && Number.isFinite(total) && total > 0) {
      idleMs += idle;
      totalMs += total;
    }
  }
  if (totalMs > 0) {
    return Math.round((idleMs / totalMs) * 1000) / 10;
  }
  return idleSlotPercentFromWaves(waveRows(sampleSet));
}

function summarizePeriod(sampleSet) {
  const readyMs = readyToMergedSamples(sampleSet);
  return {
    readyToMergedMs: {
      median: median(readyMs),
      mean: mean(readyMs),
      n: readyMs.length,
    },
    idleSlotPct: idleSlotPercent(sampleSet),
  };
}

function periodImproved(before, after) {
  const bMed = before.readyToMergedMs.median;
  const bMean = before.readyToMergedMs.mean;
  const aMed = after.readyToMergedMs.median;
  const aMean = after.readyToMergedMs.mean;
  const bIdle = before.idleSlotPct;
  const aIdle = after.idleSlotPct;
  if (
    bMed === null || bMean === null || aMed === null || aMean === null
    || bIdle === null || aIdle === null
  ) {
    return false;
  }
  return aMed < bMed && aMean < bMean && aIdle < bIdle;
}

/** Compare burst benchmark samples before vs after a scheduling or runner change. */
export function buildBurstScorecard(before, after) {
  const beforeSummary = summarizePeriod(before);
  const afterSummary = summarizePeriod(after);
  return {
    before: beforeSummary,
    after: afterSummary,
    improved: periodImproved(beforeSummary, afterSummary),
  };
}
