export const REASK_SUMMARY_MESSAGE =
  'Reply with only your final report JSON line. It must include a one-line summary of what you changed (or, if blocked, why).';

function splitLines(buf) {
  if (buf === null) return [];
  const text = buf.toString('utf8');
  if (text.length === 0) return [];
  return text.split('\n');
}

function lineCounts(baseBuf, currentBuf) {
  const baseCounts = new Map();
  const curCounts = new Map();
  for (const line of splitLines(baseBuf)) baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  for (const line of splitLines(currentBuf)) curCounts.set(line, (curCounts.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  const keys = new Set([...baseCounts.keys(), ...curCounts.keys()]);
  for (const key of keys) {
    const b = baseCounts.get(key) ?? 0;
    const c = curCounts.get(key) ?? 0;
    if (c > b) added += c - b;
    if (b > c) removed += b - c;
  }
  return { added, removed };
}

function bytesChanged(baseBuf, currentBuf) {
  if (baseBuf === null && currentBuf === null) return false;
  if (baseBuf === null || currentBuf === null) return true;
  return !baseBuf.equals(currentBuf);
}

function cap300(text) {
  return text.length <= 300 ? text : text.slice(0, 300);
}

export function diffSummary(outputs, { readBase, readCurrent }) {
  const parts = [];
  const changed = [];
  let allWritten = outputs.length > 0;

  for (const file of outputs) {
    const base = readBase(file);
    const current = readCurrent(file);
    const fileChanged = bytesChanged(base, current);
    if (current === null) allWritten = false;
    else if (!fileChanged) allWritten = false;

    if (fileChanged) {
      changed.push(file);
      const { added, removed } = lineCounts(base, current);
      parts.push(`Changed ${file} (+${added}/-${removed} lines)`);
    }
  }

  let text;
  if (parts.length === 0) text = 'No declared output changed';
  else text = cap300(parts.join('; '));

  return { text, allWritten, changed };
}

function emptySummary(summary) {
  return summary === undefined || summary === null || (typeof summary === 'string' && summary.trim() === '');
}

function applyDiffRule(status, d) {
  const warnings = ['summary-from-diff: worker gave no summary'];
  if (d.allWritten) {
    return {
      status: 'complete',
      summary: d.text,
      error: null,
      summaryReasked: false,
      summaryFromDiff: true,
      warnings,
    };
  }
  const error = cap300(`blocked: no summary given; ${d.text}`);
  return {
    status: 'blocked',
    summary: d.text,
    error,
    summaryReasked: false,
    summaryFromDiff: true,
    warnings,
  };
}

export async function settleMissingSummary({
  status,
  summary,
  cancelled,
  alreadyReasked,
  reask,
  diff,
}) {
  if (!emptySummary(summary)) {
    return {
      status,
      summary,
      error: null,
      summaryReasked: false,
      summaryFromDiff: false,
      warnings: [],
    };
  }

  if (cancelled || alreadyReasked) {
    const d = await diff();
    const base = applyDiffRule(status, d);
    return { ...base, summaryReasked: false };
  }

  let summaryReasked = true;
  let reaskSummary;
  try {
    const result = await reask();
    reaskSummary = result?.summary;
  } catch {
    reaskSummary = undefined;
  }

  if (!emptySummary(reaskSummary)) {
    return {
      status,
      summary: reaskSummary,
      error: null,
      summaryReasked,
      summaryFromDiff: false,
      warnings: [],
    };
  }

  const d = await diff();
  return { ...applyDiffRule(status, d), summaryReasked };
}
