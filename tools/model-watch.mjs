// SPDX-License-Identifier: Apache-2.0
// Model watch (spec B3): once a week, look for new open coding models that fit our GPUs and new model versions on the API lanes,
// and put each new one in the owner's inbox as a decision. Evaluating a candidate rents a GPU, so the watcher never does it:
// it prints the exact command (with the owner's pre-approved cap, if any) and the owner approves any switch.
// The first run only records what exists (a baseline), so it never floods the inbox.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendEvent } from './journal.mjs';

export const WATCH_DEFAULTS = Object.freeze({ gpuMemGb: 96, gpus: 1, minDownloads: 1000, maxAgeDays: 120, evalCapUsd: null, intervalDays: 7 });
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const API_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const CODE_RE = /coder|code/i;
const BYTES_PER = { F64: 8, F32: 4, BF16: 2, F16: 2, F8_E4M3: 1, F8_E5M2: 1, FP8: 1, I8: 1, U8: 1, I4: 0.5, U4: 0.5, NVFP4: 0.5, FP4: 0.5 };
const DAY = 86400000;
// The share of GPU memory the weights may take; the rest is for the KV cache and the server.
const WEIGHT_SHARE = 0.8;

export function modelsDir(env = process.env, home = os.homedir()) { return env.SWARM_MODELS_DIR || path.join(home, '.project-swarm', 'models'); }
const stateFile = (env, home) => path.join(modelsDir(env, home), 'watch.json');

export function watchConfig(local = {}) {
  const raw = local?.modelWatch && typeof local.modelWatch === 'object' ? local.modelWatch : {};
  const num = (key, ok) => (ok(raw[key]) ? raw[key] : WATCH_DEFAULTS[key]);
  const pos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return {
    gpuMemGb: num('gpuMemGb', pos), gpus: num('gpus', v => Number.isInteger(v) && v > 0 && v <= 16), minDownloads: num('minDownloads', v => Number.isInteger(v) && v >= 0),
    maxAgeDays: num('maxAgeDays', pos), intervalDays: num('intervalDays', pos), evalCapUsd: pos(raw.evalCapUsd) ? raw.evalCapUsd : null,
  };
}

export async function readState(env = process.env, home = os.homedir()) {
  try { const s = JSON.parse(await fs.readFile(stateFile(env, home), 'utf8')); return s && typeof s === 'object' && s.seen && typeof s.seen === 'object' ? s : { version: 1, lastRunAt: null, seen: {} }; }
  catch { return { version: 1, lastRunAt: null, seen: {} }; }
}

async function writeState(state, env, home) {
  const file = stateFile(env, home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export const isDue = (state, now, config) => !state.lastRunAt || now - Date.parse(state.lastRunAt) >= config.intervalDays * DAY || !Number.isFinite(Date.parse(state.lastRunAt));

// Weight bytes from the Hugging Face safetensors summary: per-dtype parameter counts when given, else the total as 16-bit (flagged as an estimate).
export function weightBytes(safetensors) {
  if (!safetensors || typeof safetensors !== 'object') return null;
  const by = safetensors.parameters;
  if (by && typeof by === 'object') {
    let total = 0;
    for (const [dtype, count] of Object.entries(by)) {
      if (!Number.isFinite(count) || count < 0) return null;
      total += count * (BYTES_PER[String(dtype).toUpperCase()] ?? 2);
    }
    if (total > 0) return { bytes: total, estimated: false };
  }
  return Number.isFinite(safetensors.total) && safetensors.total > 0 ? { bytes: safetensors.total * 2, estimated: true } : null;
}

export function fitsGpu(bytes, config) {
  return bytes <= config.gpuMemGb * config.gpus * 1e9 * WEIGHT_SHARE;
}

// Normalises one Hugging Face listing row; null for anything that is not a usable public coding model.
export function normalizeHf(row, config, now) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !MODEL_ID_RE.test(row.id)) return null;
  if (row.gated || row.private || row.disabled || !CODE_RE.test(row.id)) return null;
  const downloads = Number.isFinite(row.downloads) ? row.downloads : 0;
  const created = Date.parse(row.createdAt ?? '');
  if (downloads < config.minDownloads) return null;
  if (!Number.isFinite(created) || now - created > config.maxAgeDays * DAY) return null;
  const w = weightBytes(row.safetensors);
  return { id: row.id, downloads, createdAt: new Date(created).toISOString(), weightGb: w ? Math.round(w.bytes / 1e8) / 10 : null, estimated: w ? w.estimated : null, fits: w ? fitsGpu(w.bytes, config) : null };
}

export async function fetchOpenCandidates({ fetchImpl = fetch, config, now = Date.now() }) {
  const url = 'https://huggingface.co/api/models?pipeline_tag=text-generation&search=coder&sort=createdAt&direction=-1&limit=60&expand[]=safetensors&expand[]=downloads&expand[]=createdAt&expand[]=gated&expand[]=private';
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout?.(20000) });
  if (!res.ok) throw Object.assign(new Error(`model-watch: Hugging Face answered ${res.status}`), { code: 'model-watch-source' });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw Object.assign(new Error('model-watch: Hugging Face gave no list'), { code: 'model-watch-source' });
  return rows.map(row => normalizeHf(row, config, now)).filter(Boolean);
}

// The model ids the Anthropic API lists for this key (new versions show up here). No key: nothing to check, said so.
export async function fetchApiModels({ fetchImpl = fetch, key }) {
  if (!key) return { ids: [], skipped: 'no Anthropic key' };
  const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout?.(20000) });
  if (!res.ok) throw Object.assign(new Error(`model-watch: the Anthropic models list answered ${res.status}`), { code: 'model-watch-source' });
  const body = await res.json();
  const ids = (Array.isArray(body?.data) ? body.data : []).map(m => m?.id).filter(id => typeof id === 'string' && API_ID_RE.test(id));
  return { ids, skipped: null };
}

const slug = id => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

export function describeOpen(c, config) {
  const size = c.weightGb === null ? 'size unknown' : `${c.weightGb} GB of weights${c.estimated ? ' (estimated)' : ''}`;
  const fit = c.fits === null ? 'fit unknown' : c.fits ? `fits ${config.gpus} GPU(s) of ${config.gpuMemGb} GB` : `too big for ${config.gpus} GPU(s) of ${config.gpuMemGb} GB`;
  return `New open coding model ${c.id}: ${size}, ${fit}, ${c.downloads} downloads. `;
}

export function evalAdvice(id, config) {
  return config.evalCapUsd
    ? `Evaluating it rents a GPU (cap you pre-approved: $${config.evalCapUsd}): swarm gpu bakeoff --models ${id} --max-usd ${config.evalCapUsd} (plan first, add --yes only when you agree). Nothing was rented.`
    : `Evaluating it rents a GPU and no cap is pre-approved (set modelWatch.evalCapUsd in the local config): nothing was rented.`;
}

/**
 * One watch pass. `sources` are injected: { open(): candidates, api(): { ids, skipped } }.
 * Returns { ran, baseline, due, newOpen, newApi, decisions, notes }. The inbox gets one decision per new model that fits (or whose fit is unknown);
 * a model that is too big is recorded and listed but is not worth the owner's time.
 */
export async function watchModels({ root, sources, local = {}, env = process.env, home = os.homedir(), now = Date.now, force = false, journal = appendEvent }) {
  const config = watchConfig(local);
  const state = await readState(env, home);
  const t = now();
  if (!force && !isDue(state, t, config)) return { ran: false, due: false, nextAt: new Date(Date.parse(state.lastRunAt) + config.intervalDays * DAY).toISOString(), config };
  const notes = [];
  // Each source is baselined on its own first SUCCESSFUL read, so an outage on the first run never makes the second report everything as new.
  state.baselined ??= {};
  let open = [], api = { ids: [], skipped: null };
  let openOk = false, apiOk = false;
  try { open = await sources.open(); openOk = true; } catch (error) { notes.push(`open models not checked: ${error.message}`); }
  try { api = await sources.api(); apiOk = !api.skipped; } catch (error) { notes.push(`API models not checked: ${error.message}`); }
  if (api.skipped) notes.push(`API models not checked: ${api.skipped}`);
  const baselineOpen = openOk && !state.baselined.open, baselineApi = apiOk && !state.baselined.api;
  const baseline = (baselineOpen || baselineApi) && Object.keys(state.seen).length === 0;
  if (openOk) state.baselined.open = true;
  if (apiOk) state.baselined.api = true;
  const newOpen = [], newApi = [];
  for (const c of open) {
    const key = `hf:${c.id}`;
    if (!state.seen[key]) { state.seen[key] = { firstSeen: new Date(t).toISOString(), ...c }; if (!baselineOpen) newOpen.push(c); }
  }
  for (const id of api.ids) {
    const key = `api:${id}`;
    if (!state.seen[key]) { state.seen[key] = { firstSeen: new Date(t).toISOString(), id }; if (!baselineApi) newApi.push(id); }
  }
  const decisions = [];
  if (root) {
    for (const c of newOpen.filter(x => x.fits !== false)) {
      const id = `model-${slug(c.id)}`;
      await journal(root, { kind: 'decision', id, text: `${describeOpen(c, config)}${evalAdvice(c.id, config)}`, choice: 'skip', options: ['evaluate', 'skip'], confirm: true }, { now: () => t });
      decisions.push(id);
    }
    for (const id of newApi) {
      const did = `model-api-${slug(id)}`;
      await journal(root, { kind: 'decision', id: did, text: `New model on the Anthropic API: ${id}. It is not used until you switch a lane to it (the lanes' model setting); compare it first with the eval set: swarm eval manifest --agent anthropic --model ${id}.`, choice: 'skip', options: ['evaluate', 'skip'], confirm: true }, { now: () => t });
      decisions.push(did);
    }
  }
  state.lastRunAt = new Date(t).toISOString();
  await writeState(state, env, home);
  return { ran: true, baseline, newOpen, newApi, tooBig: newOpen.filter(x => x.fits === false).map(x => x.id), decisions, notes, config, seen: Object.keys(state.seen).length };
}

// "Model X beats the current one by Y points at $Z per eval run", from the recorded eval runs (docs/state/eval-scores.ndjson).
export function compareModels(rows, current, candidate) {
  const stat = model => {
    const mine = rows.filter(r => Array.isArray(r.models) && r.models.length === 1 && r.models[0] === model && Number.isFinite(r.total) && r.total > 0);
    if (!mine.length) return null;
    const passed = mine.reduce((s, r) => s + (r.passed ?? 0), 0), total = mine.reduce((s, r) => s + r.total, 0);
    return { runs: mine.length, passRate: passed / total, avgCostUsd: mine.reduce((s, r) => s + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0) / mine.length };
  };
  const a = stat(current), b = stat(candidate);
  if (!a || !b) return { ok: false, message: `no recorded eval runs for ${!a ? current : candidate}${!a && !b ? ` or ${candidate}` : ''} (swarm eval score RUN --record)` };
  const points = Math.round((b.passRate - a.passRate) * 1000) / 10;
  const verdict = points > 0 ? `${candidate} beats ${current} by ${points} points` : points < 0 ? `${candidate} is ${-points} points behind ${current}` : `${candidate} ties ${current}`;
  const cost = `at $${b.avgCostUsd.toFixed(4)} per eval run (${current}: $${a.avgCostUsd.toFixed(4)})`;
  const thin = Math.min(a.runs, b.runs) < 3 ? ` Thin evidence: ${a.runs} and ${b.runs} run(s); run the eval more before switching.` : '';
  return { ok: true, points, current: a, candidate: b, message: `${verdict} (pass rate ${(b.passRate * 100).toFixed(1)}% vs ${(a.passRate * 100).toFixed(1)}%) ${cost}.${thin} Switching is your decision.` };
}
