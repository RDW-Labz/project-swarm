// SPDX-License-Identifier: Apache-2.0
// Better quotes (Phase 19, part 3): the owner's hours per project, the numbers kept for each finished project, and a quote for a new scope
// as RANGES taken from the most similar finished projects. The price line stays blank until the owner sets an hourly rate and a margin.
// Nothing here calls a model or the network. Private to the owner: never part of a client report.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseScope } from './scope.mjs';
import { readLedger } from './tickets.mjs';
import { costOf } from './board-data.mjs';

export const quotesDir = (env = process.env, home = os.homedir()) => env.SWARM_QUOTES_DIR || path.join(home, '.project-swarm', 'quotes');
const recordsFile = dir => path.join(dir, 'projects.json');
const configFile = dir => path.join(dir, 'config.json');
export const TIME_FILE = '.swarm/project/time.ndjson';

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const clean = (t, n) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- the owner's hours -------------------------------------------------------------------------------------------------------------------------

export async function logTime(root, hours, note, { now = Date.now } = {}) {
  const h = Number(hours);
  if (!/^\d+(\.\d{1,2})?$/.test(String(hours)) || !(h >= 0.05 && h <= 24)) return { ok: false, error: 'hours must be a number from 0.05 to 24 (at most two decimals), for one entry' };
  const entry = { at: new Date(now()).toISOString(), hours: h, note: clean(note, 200) };
  const file = path.join(root, TIME_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return { ok: true, entry };
}

export async function readTime(root) {
  let text = '';
  try { text = await fs.readFile(path.join(root, TIME_FILE), 'utf8'); } catch { return { entries: [], total: 0, skipped: 0 }; }
  const entries = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (isObj(e) && typeof e.hours === 'number' && e.hours > 0 && e.hours <= 24 && Number.isFinite(Date.parse(e.at))) entries.push({ at: e.at, hours: e.hours, note: clean(e.note, 200) });
      else skipped += 1;
    } catch { skipped += 1; }
  }
  return { entries, total: round(entries.reduce((s, e) => s + e.hours, 0)), skipped };
}

// ---- rate and margin (the owner's numbers: no default is invented) -----------------------------------------------------------------------------

export async function readQuoteConfig(dir = quotesDir()) {
  try {
    const c = JSON.parse(await fs.readFile(configFile(dir), 'utf8'));
    const rate = isObj(c) && typeof c.hourlyRate === 'number' && c.hourlyRate > 0 && c.hourlyRate <= 10000 ? c.hourlyRate : null;
    const margin = isObj(c) && typeof c.margin === 'number' && c.margin >= 0 && c.margin <= 0.9 ? c.margin : null;
    return { hourlyRate: rate, margin };
  } catch { return { hourlyRate: null, margin: null }; }
}

export async function writeQuoteConfig(dir, { rate, margin }) {
  const current = await readQuoteConfig(dir);
  const next = { ...current };
  if (rate !== undefined) { const r = Number(rate); if (!(r > 0 && r <= 10000)) return { ok: false, error: '--rate must be dollars per hour, above 0 and at most 10000' }; next.hourlyRate = r; }
  if (margin !== undefined) { const m = Number(String(margin).replace(/%$/, '')); if (!(m >= 0 && m <= 90) || (m > 0 && m < 1 && !/%$/.test(String(margin)))) return { ok: false, error: '--margin must be a percent from 0 to 90 of the price, like 30 or 30% (0.3 is refused: it could mean 0.3% or 30%)' }; next.margin = round(m / 100, 4); }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(configFile(dir), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, config: next };
}

// ---- the numbers kept for each project ---------------------------------------------------------------------------------------------------------

// A file that exists but cannot be read is "damaged", not "empty": saving over it would silently lose every kept project.
export async function recordsDamaged(dir = quotesDir()) {
  let text;
  try { text = await fs.readFile(recordsFile(dir), 'utf8'); } catch (error) { return error.code === 'ENOENT' ? null : `cannot read ${recordsFile(dir)}`; }
  try { const d = JSON.parse(text); return isObj(d) && Array.isArray(d.projects) ? null : `${recordsFile(dir)} has the wrong shape`; } catch { return `${recordsFile(dir)} is not valid JSON`; }
}

export async function readRecords(dir = quotesDir()) {
  try {
    const data = JSON.parse(await fs.readFile(recordsFile(dir), 'utf8'));
    return (isObj(data) && Array.isArray(data.projects) ? data.projects : []).filter(p => isObj(p) && typeof p.id === 'string' && typeof p.name === 'string');
  } catch { return []; }
}

// Two names that slug alike ("Shop!" and "shop") keep separate entries: the id carries a short hash of the exact name.
const slug = t => `${String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project'}-${createHash('sha256').update(String(t)).digest('hex').slice(0, 6)}`;

export async function saveRecord(dir, record) {
  const damaged = await recordsDamaged(dir);
  if (damaged) throw new Error(`${damaged}; nothing was changed. Fix it or move it aside, then record again.`);
  const list = await readRecords(dir);
  const next = list.filter(p => p.id !== record.id);
  next.push(record);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${recordsFile(dir)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ version: 1, projects: next }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, recordsFile(dir));
  return { replaced: next.length === list.length };
}

async function readRuns(root) {
  const dir = path.join(root, '.swarm', 'runs');
  let ids = [];
  try { ids = await fs.readdir(dir); } catch { return []; }
  const runs = [];
  for (const id of ids) {
    try { const state = JSON.parse(await fs.readFile(path.join(dir, id, 'state.json'), 'utf8')); if (isObj(state)) runs.push({ id, state }); } catch { /* an unreadable run is skipped */ }
  }
  return runs;
}

export async function scopeText(root, ledger) {
  for (const file of ['.swarm/project/scope.snapshot.md', ledger?.scope?.file ?? 'docs/scope/scope.md']) {
    try { return await fs.readFile(path.join(root, file), 'utf8'); } catch { /* the next one */ }
  }
  return null;
}

// What a scope says about size: counts only (a missing section is null, not 0, so it does not pull a match toward "none").
export function traitsOf(scope) {
  const screens = scope.sections.find(s => /^screens?$/i.test(s.title.trim()));
  const top = text => String(text ?? '').split('\n').filter(l => /^- \S/.test(l)).length;
  return {
    requirements: scope.requirements.length || null,
    stages: scope.stages.length || null,
    screens: screens ? top(screens.text) || null : null,
    services: scope.external.length || null,
  };
}

export async function buildRecord(root, { name, source = 'recorded', charged, changeOrders, gpuHours, now = Date.now } = {}) {
  const ledger = await readLedger(root).catch(() => null);
  const text = await scopeText(root, ledger);
  const traits = text === null ? { requirements: null, stages: null, screens: null, services: null } : traitsOf(parseScope(text));
  const tickets = (ledger?.tickets ?? []).filter(t => t.status !== 'cancelled' && t.status !== 'proposed').length;
  const runs = await readRuns(root);
  const cost = costOf(runs, now());
  const times = runs.flatMap(r => [Date.parse(r.state.startedAt ?? ''), Date.parse(r.state.finishedAt ?? '')]).filter(Number.isFinite);
  const time = await readTime(root);
  const rentalHours = runs.reduce((s, r) => s + (num(r.state.rental?.hours) ?? 0), 0);
  return {
    id: slug(name), name: clean(name, 80), source, recordedAt: new Date(now()).toISOString(),
    ...traits, tickets: tickets || null,
    billedUsd: runs.length ? round(cost.paidUsd, 4) : null, flatRateListUsd: runs.length ? round(cost.flatRateListUsd, 4) : null,
    estimatedFullUsd: runs.length ? round(cost.paidUsd + cost.flatRateListUsd, 4) : null,
    gpuHours: gpuHours !== undefined ? gpuHours : (rentalHours || null),
    ownerHours: time.entries.length ? time.total : null,
    changeOrders: changeOrders ?? null,
    calendarDays: times.length > 1 ? Math.max(1, Math.ceil((Math.max(...times) - Math.min(...times)) / 86400000)) : null,
    chargedUsd: charged ?? null,
    runs: runs.length,
  };
}

// ---- the quote ---------------------------------------------------------------------------------------------------------------------------------

const TRAITS = ['requirements', 'stages', 'screens', 'services'];
const MAX_DISTANCE = 0.7;   // about twice the size on average: further than that is not "similar"

// How far apart two projects are: the average of |ln(a/b)| over the traits both have. No shared trait = not comparable (null).
export function distance(a, b) {
  const ds = TRAITS.filter(k => a[k] > 0 && b[k] > 0).map(k => Math.abs(Math.log(a[k] / b[k])));
  return ds.length ? ds.reduce((s, d) => s + d, 0) / ds.length : null;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// A range from the values the similar projects have: the middle half with three or more, the lowest and highest with two, one point with one (no range), nothing with none.
export function rangeOf(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return { low: v[0], high: v[0], n: 1, single: true };
  if (v.length === 2) return { low: v[0], high: v[1], n: 2, single: false };
  return { low: quantile(v, 0.25), high: quantile(v, 0.75), n: v.length, single: false };
}

// What the work would cost at list prices: billed plus the list value of subscription lanes (a quote must not pretend flat-rate work was free).
export const estimatedFull = r => (typeof r.estimatedFullUsd === 'number' ? r.estimatedFullUsd : typeof r.billedUsd === 'number' && typeof r.flatRateListUsd === 'number' ? r.billedUsd + r.flatRateListUsd : null);

export function buildQuote({ traits, records, config, k = 5 }) {
  const ranked = records.map(r => ({ r, d: distance(traits, r) })).filter(x => x.d !== null).sort((a, b) => a.d - b.d || a.r.id.localeCompare(b.r.id));
  const similar = ranked.filter(x => x.d <= MAX_DISTANCE).slice(0, k);
  const items = similar.map(x => x.r);
  const cost = rangeOf(items.map(estimatedFull));
  const billed = rangeOf(items.map(r => r.billedUsd));
  const hours = rangeOf(items.map(r => r.ownerHours));
  const days = rangeOf(items.map(r => r.calendarDays));
  const gpu = rangeOf(items.map(r => r.gpuHours));
  const medianD = similar.length ? similar[Math.floor(similar.length / 2)].d : null;
  let confidence = 'none', why = records.length ? 'no finished project shares a size measure with this scope' : 'no finished project has been recorded yet (swarm quote record)';
  if (similar.length) {
    const backfilled = items.filter(r => r.source === 'backfill').length;
    const thin = Math.min(...[cost, hours].filter(Boolean).map(r => r.n));
    if (similar.length < 3) { confidence = 'low'; why = `only ${similar.length} similar finished project${similar.length === 1 ? '' : 's'}`; }
    else if (thin < 3) { confidence = 'low'; why = `${similar.length} similar projects, but only ${thin} have ${cost && hours && cost.n === thin && hours.n === thin ? 'cost and hours' : hours && hours.n === thin ? 'owner hours' : 'an estimated cost'} recorded`; }
    else if (similar.length >= 5 && medianD < 0.35) { confidence = 'high'; why = `${similar.length} similar projects, close in size`; }
    else { confidence = 'medium'; why = `${similar.length} similar projects${medianD >= 0.35 ? ', but not close in size' : ''}`; }
    if (backfilled) why += `; ${backfilled} backfilled from earlier work, not recorded as they happened`;
    if (!hours) why += '; none of them has owner hours logged';
    if (!cost) why += '; none of them has a cost recorded';
  }
  let price = null;
  const priceBlank = config.hourlyRate === null || config.margin === null;
  if (!priceBlank && cost && hours) {
    const at = (c, h) => round((c + h * config.hourlyRate) / (1 - config.margin), 0);
    price = { low: at(cost.low, hours.low), high: at(cost.high, hours.high) };
  }
  return { traits, billed, confidence, why, similar: similar.map(x => ({ name: x.r.name, source: x.r.source, distance: round(x.d, 2) })), cost, hours, days, gpu, price, priceBlank };
}

const usd = v => `$${v >= 100 ? Math.round(v) : round(v, 2)}`;
const span = (r, fmt, unit = '') => (!r ? 'no data' : r.single ? `${fmt(r.low)}${unit} (one project, no range)` : `${fmt(r.low)} to ${fmt(r.high)}${unit}`);
const plain = v => String(round(v, 1));

export function renderQuote(q) {
  const t = TRAITS.map(k => `${k} ${q.traits[k] ?? '?'}`).join(', ');
  if (!q.similar.length) return [`Scope size: ${t}`, `Confidence: none. ${q.why}.`, 'No number is given without similar finished projects.', 'Price: blank (also set your rate and margin: swarm quote config --rate USD_PER_HOUR --margin PERCENT)'].join('\n');
  return [
    `Scope size: ${t}`,
    `Similar finished projects: ${q.similar.map(s => `${s.name}${s.source === 'backfill' ? ' (backfilled)' : ''}`).join(', ')}`,
    `Model cost (estimated full, list prices): ${span(q.cost, usd)}`,
    `  of which billed:    ${span(q.billed, usd)} (the rest is subscription lanes, not charged per use)`,
    `Calendar time:        ${span(q.days, plain, ' days')}`,
    `Your hours:           ${span(q.hours, plain, ' hours')}`,
    ...(q.gpu ? [`Rented GPU:          ${span(q.gpu, plain, ' hours')}`] : []),
    q.price ? `Price:                ${usd(q.price.low)} to ${usd(q.price.high)} (cost plus hours at your rate, with your margin)` : `Price:                blank until you set both: swarm quote config --rate USD_PER_HOUR --margin PERCENT${q.cost && q.hours ? '' : ' (and the similar projects need cost and hours)'}`,
    `Confidence: ${q.confidence}. ${q.why}.`,
    'Ranges are the middle half of the similar projects (the lowest to the highest when there are only two). They are not scaled for size.',
  ].join('\n');
}
