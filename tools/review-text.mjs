// SPDX-License-Identifier: Apache-2.0
// Reading the verdict line of a review answer. Only the LAST line counts, so an object quoted from the reviewed code can never win, with one exception:
// a single trailing runner status line ({"status":"complete","summary":...}, which the runner asks every review job to finish with) is not the verdict and is skipped.
// It is skipped only when it has exactly the runner's shape and says complete; a blocked or failed footer means there is no verdict at all.
const FOOTER_KEYS = new Set(['status', 'summary', 'findings', 'files', 'risks', 'followups', 'deviations']);

function footerOf(line) {
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!['complete', 'blocked', 'failed'].includes(v.status)) return null;
  if (Object.keys(v).some(key => !FOOTER_KEYS.has(key))) return null;
  if (v.summary !== undefined && typeof v.summary !== 'string') return null;
  for (const key of ['findings', 'files', 'risks', 'followups', 'deviations']) if (v[key] !== undefined && !Array.isArray(v[key])) return null;
  return v.status;
}

export function verdictLine(text) {
  const rows = String(text ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  const status = rows.length ? footerOf(rows[rows.length - 1]) : null;
  if (status === null) return rows.pop() ?? '';
  if (status !== 'complete') return '';
  rows.pop();
  return rows.pop() ?? '';
}
