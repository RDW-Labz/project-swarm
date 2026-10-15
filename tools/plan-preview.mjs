// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const PRIORS = Object.freeze({
  childrenPerLead: 6,
  child: { inTokens: 15000, outTokens: 5000, seconds: 60 },
  lead: { inTokens: 6000, outTokens: 3000, seconds: 120 },
});

const PLAN_ID = /^[a-z0-9][a-z0-9-]{5,60}$/;
const SENSITIVE = new Set(['secrets', 'credentials', '.ssh', '.aws', '.gnupg', 'private', 'keys']);
const MAX_RUNS = 20;
const WRITE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const txt = s => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
const money = n => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const applied = x => (isNum(x) && x > 0 ? x : 1);
const usd = (inTok, outTok, price) => (price ? (inTok * price.inPerM + outTok * price.outPerM) / 1e6 : 0);
const leadCap = lead => Math.max(1, lead.area?.maxJobs ?? 25);
const EMPTY = () => ({ runs: [], costRatio: 1, timeRatio: 1 });

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]));
  return value;
}

export function planHash(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeys(manifest))).digest('hex');
}

function isSensitive(p) {
  return String(p).split(/[/\\]/).some(seg => {
    const s = seg.toLowerCase();
    return s === '.env' || s.startsWith('.env.') || SENSITIVE.has(s);
  });
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function estimatePlan(manifest, { lanes = {}, calibration = {} } = {}) {
  const jobs = Array.isArray(manifest?.jobs) ? manifest.jobs : [];
  const leads = jobs.filter(j => j.type === 'lead');
  const costRatio = isNum(calibration.costRatio) ? calibration.costRatio : 1;
  const timeRatio = isNum(calibration.timeRatio) ? calibration.timeRatio : 1;
  const cpl = isNum(calibration.childrenPerLead) ? calibration.childrenPerLead : PRIORS.childrenPerLead;
  const expectedChildren = leads.length ? leads.reduce((s, l) => s + clamp(cpl, 1, leadCap(l)), 0) : jobs.length;
  const maxChildren = leads.length ? leads.reduce((s, l) => s + leadCap(l), 0) : jobs.length;
  const leadUsd = leads.length * usd(PRIORS.lead.inTokens, PRIORS.lead.outTokens, lanes.lead?.price ?? null) * costRatio;
  const childUsd = expectedChildren * usd(PRIORS.child.inTokens, PRIORS.child.outTokens, lanes.child?.price ?? null) * costRatio;
  const point = round(leadUsd + childUsd, 4);
  const tokens = Math.round(leads.length * (PRIORS.lead.inTokens + PRIORS.lead.outTokens) + expectedChildren * (PRIORS.child.inTokens + PRIORS.child.outTokens));
  const spread = expectedChildren > 0 ? maxChildren / expectedChildren : 1;
  const costRange = [round(point * 0.5, 4), round(Math.min(point * spread, point * 5), 4)];
  const parallel = Math.max(1, Math.min(lanes.runConcurrency ?? 1, lanes.child?.concurrency ?? Infinity, expectedChildren));
  const seconds = (leads.length ? PRIORS.lead.seconds : 0) + (expectedChildren ? Math.ceil(expectedChildren / parallel) * PRIORS.child.seconds : 0);
  const minutes = round((seconds / 60) * timeRatio, 1);
  const childCap = lanes.child?.concurrency ?? Infinity;
  const width = leads.length ? leads.length * (leads[0].area?.concurrency ?? 1) : (manifest?.concurrency ?? 1);
  const peakConcurrency = Math.max(1, Math.min(width, childCap, expectedChildren));
  const rows = [];
  if (leads.length) rows.push({ agent: lanes.lead?.agent ?? null, model: lanes.lead?.model ?? null, role: 'lead', jobs: leads.length, costUsd: round(leadUsd, 4) });
  if (expectedChildren) rows.push({ agent: lanes.child?.agent ?? null, model: lanes.child?.model ?? null, role: 'child', jobs: expectedChildren, costUsd: round(childUsd, 4) });
  const risks = [];
  const paths = jobs.flatMap(j => [...(j.area?.scope ?? []), ...(j.context ?? []), ...(j.outputs ?? [])]).filter(p => typeof p === 'string');
  const sensitive = paths.filter(isSensitive);
  if (sensitive.length) risks.push({ code: 'sensitive-folder', message: `sensitive paths: ${sensitive.slice(0, 3).join(', ')}` });
  const deletes = jobs.reduce((s, j) => s + (Array.isArray(j.deletes) ? j.deletes.length : 0), 0);
  if (deletes > 20) risks.push({ code: 'big-delete', message: `${deletes} paths in deletes` });
  const maxUsd = manifest?.budget?.maxUsd ?? null;
  const maxTokens = manifest?.budget?.maxTokens ?? null;
  if (isNum(maxUsd)) {
    const over = [point > maxUsd && `point estimate ${money(point)}`, costRange[1] > maxUsd && `high end ${money(costRange[1])}`].filter(Boolean);
    if (over.length) risks.push({ code: 'over-budget', message: `${over.join(' and ')} above budget ${money(maxUsd)}` });
  }
  if (isNum(maxTokens) && tokens > maxTokens) risks.push({ code: 'over-tokens', message: `about ${tokens} tokens above budget ${maxTokens}` });
  if (maxChildren > 100) risks.push({ code: 'many-jobs', message: `up to ${maxChildren} child jobs` });
  if (leads.length) risks.push({ code: 'deletes-unknown', message: 'children are written at run time; their deletes and files are not known yet' });
  return {
    goal: leads[0]?.area?.goal ?? null,
    leads: leads.map(l => ({ id: l.id, scope: l.area?.scope ?? [], maxJobs: l.area?.maxJobs ?? null })),
    jobs: { leads: leads.length, expectedChildren, maxChildren },
    lanes: rows,
    estimate: { costUsd: point, costRange, tokens, minutes, peakConcurrency, calibrated: costRatio !== 1 || timeRatio !== 1 },
    budget: { maxUsd, maxTokens },
    risks,
  };
}

export function formatPreview(p) {
  const lines = [];
  const scopes = p.leads.flatMap(l => l.scope ?? []).map(txt);
  lines.push(`Goal: ${txt(p.goal ?? '(none)')}`);
  lines.push(`Leads: ${p.leads.length}${scopes.length ? ` (scopes: ${scopes.join(', ')})` : ''}`);
  lines.push(`Jobs: about ${p.jobs.expectedChildren} (at most ${p.jobs.maxChildren})`);
  for (const l of p.lanes) lines.push(`${txt(l.agent)} ${txt(l.model)}: ${l.jobs} ${l.role} jobs, about ${money(l.costUsd)}`);
  const e = p.estimate;
  const free = p.lanes.some(l => l.costUsd === 0 && l.jobs > 0) ? ' (subscription lanes are not counted)' : '';
  lines.push(`Cost: about ${money(e.costUsd)} (range ${money(e.costRange[0])} to ${money(e.costRange[1])})${free}`);
  lines.push(`Time: about ${e.minutes} min`);
  lines.push(`Peak concurrency: ${e.peakConcurrency}`);
  lines.push(`Budget: ${p.budget.maxUsd === null ? 'no USD cap' : money(p.budget.maxUsd)}, ${p.budget.maxTokens ?? 'no'} tokens`);
  if (!p.risks.length) lines.push('Risks: none seen');
  else {
    lines.push('Risks:');
    const shown = p.risks.slice(0, 20);
    for (const r of shown) lines.push(`- ${r.code}: ${txt(r.message)}`);
    if (p.risks.length > shown.length) lines.push(`- ... ${p.risks.length - shown.length} more`);
  }
  return lines.join('\n');
}

async function writeNew(dir, name, text, replace) {
  const file = path.join(dir, name);
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(tmp, WRITE, 0o600);
    await handle.writeFile(text);
    await handle.close();
    handle = null;
    if (replace) await fs.rename(tmp, file);
    else await fs.link(tmp, file);
  } finally {
    if (handle) await handle.close();
    await fs.rm(tmp, { force: true });
  }
  return file;
}

export async function savePlan(root, plan) {
  if (typeof plan?.id !== 'string' || !PLAN_ID.test(plan.id)) throw new Error('plan-invalid: id');
  if (plan.hash !== planHash(plan.manifest)) throw new Error('plan-invalid: hash');
  const dir = await safeWritableDir(root, ['.swarm', 'plans']);
  try {
    return await writeNew(dir, `${plan.id}.json`, JSON.stringify(plan, null, 2) + '\n', false);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`plan-exists: ${plan.id}`);
    throw error;
  }
}

export async function loadPlan(root, id) {
  if (typeof id !== 'string' || !PLAN_ID.test(id)) throw new Error('plan-invalid: id');
  const file = path.join(root, '.swarm', 'plans', `${id}.json`);
  try { await assertRegularOrMissing(file); } catch { throw new Error('plan-invalid: not a regular file'); }
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`plan-not-found: ${id}`); throw error; }
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error('plan-invalid: json'); }
  if (!plan || plan.id !== id || !plan.manifest) throw new Error('plan-invalid: shape');
  if (plan.hash !== planHash(plan.manifest)) throw new Error('plan-invalid: hash');
  return plan;
}

export async function readCalibration(root) {
  const file = path.join(root, '.swarm', 'project', 'estimates.json');
  await assertRegularOrMissing(file);
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return EMPTY(); throw error; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return EMPTY(); }
  return { ...EMPTY(), ...parsed, runs: Array.isArray(parsed?.runs) ? parsed.runs : [] };
}

export function recordActual(calibration, { id, estimate = {}, actual = {} }) {
  const prior = calibration ?? EMPTY();
  const raw = {
    costUsd: isNum(estimate.costUsd) ? estimate.costUsd / applied(estimate.appliedCostRatio) : estimate.costUsd,
    minutes: isNum(estimate.minutes) ? estimate.minutes / applied(estimate.appliedTimeRatio) : estimate.minutes,
  };
  if (isNum(estimate.children)) raw.children = estimate.children;
  const runs = [...(prior.runs ?? []), { id, estimate: raw, actual, at: new Date().toISOString() }].slice(-MAX_RUNS);
  const ratio = key => {
    const m = median(runs.flatMap(r => {
      const e = r?.estimate?.[key];
      const a = r?.actual?.[key];
      return isNum(e) && isNum(a) && e > 0 ? [a / e] : [];
    }));
    return m === null ? 1 : clamp(m, 0.1, 10);
  };
  const pairs = runs.flatMap(r => (isNum(r?.actual?.children) && isNum(r?.actual?.leads) && r.actual.leads > 0 ? [r.actual.children / r.actual.leads] : []));
  const cpl = median(pairs);
  const out = { runs, costRatio: ratio('costUsd'), timeRatio: ratio('minutes') };
  const childrenPerLead = cpl === null ? prior.childrenPerLead : Math.max(1, Math.round(cpl));
  if (isNum(childrenPerLead)) out.childrenPerLead = childrenPerLead;
  return out;
}

export async function writeCalibration(root, calibration) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  return writeNew(dir, 'estimates.json', JSON.stringify(calibration, null, 2) + '\n', true);
}
