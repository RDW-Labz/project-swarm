// Activity telemetry is content free: byte counts and timestamps only, never worker output text.
// A job that has produced nothing keeps null timestamps; that is the silent-versus-working signal.
export const unobservableProgress = reason => ({ observable: false, reason, stdoutBytes: null, stderrBytes: null, firstOutputAt: null, lastOutputAt: null, lastActivityAt: null, sampledAt: null });

function updateRunPause(state, now) {
  const held = state.jobs.filter(record => record.heldReason);
  if (!held.length) { delete state.pause; return; }
  const untils = held.map(record => record.heldUntil).filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b));
  const reasons = [...new Set(held.map(record => record.heldReason))];
  state.pause = { reasons, until: untils.at(-1) ?? null, message: held.map(record => record.error ?? record.heldReason).join('; '), jobs: held.map(record => record.id), at: new Date(now()).toISOString() };
  if (state.jobs.every(record => record.status === 'complete' || record.heldReason)) state.status = 'paused';
}

function quotaOnlyPause(state) {
  return state.status === 'paused' && state.pause.reasons.every(reason => reason === 'quota' || /^after .+ held$/.test(reason));
}

// State written before this field existed carries no telemetry; report null instead of
// inventing activity. silentMs is time without observed output, not proof of idleness.
function progressReport(job, now) {
 const progress=job.progress??null;
 if(!progress)return null;
 const since=progress.lastOutputAt??job.startedAt??null;
 const until=job.finishedAt?Date.parse(job.finishedAt):now;
 return {...progress,silentMs:progress.observable&&since?Math.max(0,until-Date.parse(since)):null};
}

// A provider that never reports usage.total_tokens (or never ran) reports null, not 0: absence
// of evidence, not evidence of zero cost.
const jobTokens = record => typeof record?.usage?.total_tokens === 'number' ? record.usage.total_tokens : null;

const tokensTotal = values => { const known = values.filter(value => value !== null); return known.length ? known.reduce((sum, value) => sum + value, 0) : null; };

const costNotReported = jobs => jobs.filter(job => job.costUsd === null).map(job => job.id);

// Field lesson 107: cost per 1k output tokens, only when both a cost and an output-token count
// were actually reported — never estimated from a total or an input count.
export const costPer1kOutputTokens = record => {
  const outputTokens = typeof record?.usage?.output_tokens === 'number' ? record.usage.output_tokens : null;
  const costUsd = typeof record?.costUsd === 'number' ? record.costUsd : null;
  return outputTokens && costUsd !== null ? costUsd / (outputTokens / 1000) : null;
};

export { costNotReported, jobTokens, progressReport, quotaOnlyPause, tokensTotal, updateRunPause };
