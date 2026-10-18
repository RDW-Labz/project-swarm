// SPDX-License-Identifier: Apache-2.0
// Speed and accessibility budgets (spec A2). On a preview deploy, Lighthouse and axe run on the key screens and the scores are checked
// against the project's budgets. A failure becomes a fix ticket (made by the caller); it blocks only the PR that finishes the last stage.
// The tools are the owner's own commands (argv in the profile, like a ci hook); each writes its JSON report to {out}.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isProductionArgv, defaultRun, filterEnv } from './ci-hooks.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';

export const BUDGET_STATE = '.swarm/project/budgets.json';
export const DEFAULT_LIGHTHOUSE = Object.freeze(['npx', 'lighthouse', '{url}', '--output=json', '--output-path={out}', '--quiet', '--chrome-flags=--headless']);
export const DEFAULT_AXE = Object.freeze(['npx', '@axe-core/cli', '{url}', '--save', '{out}']);
const IMPACTS = ['minor', 'moderate', 'serious', 'critical'];
const SCORES = ['performance', 'accessibility', 'bestPractices', 'seo'];
const KEYS = [...SCORES, 'axeBlock', 'screens', 'lighthouse', 'axe'];
const TOOL_KEYS = ['argv', 'timeoutSec'];
const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;
const SCREEN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH_RE = /^\/[A-Za-z0-9._~%/-]{0,200}$/;
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const control = s => /[\u0000-\u001f\u007f]/.test(s);

function checkTool(name, raw, errors) {
  if (raw === undefined) return { argv: [...(name === 'lighthouse' ? DEFAULT_LIGHTHOUSE : DEFAULT_AXE)], timeoutSec: 300 };
  if (!isObj(raw)) { errors.push(`budgets.${name} must be an object`); return null; }
  for (const key of Object.keys(raw)) if (!TOOL_KEYS.includes(key)) errors.push(`budgets.${name}.${key}: unknown key`);
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 20 || !argv.every(a => typeof a === 'string' && a.length > 0 && !control(a))) { errors.push(`budgets.${name}.argv must be 1 to 20 non-empty strings`); return null; }
  if (!PROGRAM_RE.test(argv[0]) || argv[0].includes('..')) errors.push(`budgets.${name}.argv[0] must be a program name`);
  if (isProductionArgv(argv)) errors.push(`budgets.${name}.argv must not be a shell or a production command`);
  if (!argv.some(a => a.includes('{url}'))) errors.push(`budgets.${name}.argv must contain {url}`);
  if (!argv.some(a => a.includes('{out}'))) errors.push(`budgets.${name}.argv must contain {out} (the tool writes its JSON report there)`);
  const timeoutSec = raw.timeoutSec ?? 300;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 30 || timeoutSec > 1800) errors.push(`budgets.${name}.timeoutSec must be an integer 30 to 1800`);
  return { argv, timeoutSec };
}

export function validateBudgetsConfig(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, config: null, errors: ['budgets must be an object'] };
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) errors.push(`budgets.${key}: unknown key`);
  const config = {};
  for (const key of SCORES) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] > 100) errors.push(`budgets.${key} must be a whole number 0 to 100`);
    else config[key] = raw[key];
  }
  if (!SCORES.some(key => config[key] !== undefined) && raw.axeBlock === undefined) { config.performance = 85; config.accessibility = 95; }
  const block = raw.axeBlock ?? ['serious', 'critical'];
  if (!Array.isArray(block) || !block.every(i => IMPACTS.includes(i))) errors.push(`budgets.axeBlock must list impacts from ${IMPACTS.join(', ')}`);
  else config.axeBlock = [...new Set(block)];
  const screens = raw.screens ?? [{ id: 'home', path: '/' }];
  if (!Array.isArray(screens) || screens.length < 1 || screens.length > 10) errors.push('budgets.screens must list 1 to 10 screens');
  else {
    const seen = new Set();
    for (const s of screens) {
      if (!isObj(s) || !SCREEN_ID_RE.test(s.id ?? '') || !PATH_RE.test(s.path ?? '') || String(s.path).includes('..') || seen.has(s.id)) { errors.push('budgets.screens entries need a unique id (lowercase words) and a path starting with /'); break; }
      seen.add(s.id);
    }
    config.screens = screens.map(s => ({ id: s?.id, path: s?.path }));
  }
  config.lighthouse = checkTool('lighthouse', raw.lighthouse, errors);
  config.axe = checkTool('axe', raw.axe, errors);
  return errors.length ? { ok: false, config: null, errors } : { ok: true, config, errors };
}

const score = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);
export function parseLighthouse(json) {
  const c = isObj(json) && isObj(json.categories) ? json.categories : {};
  return { performance: score(c.performance?.score), accessibility: score(c.accessibility?.score), bestPractices: score(c['best-practices']?.score), seo: score(c.seo?.score) };
}

// axe-core's own result object, or the CLI's array of them.
export function parseAxe(json) {
  const results = Array.isArray(json) ? json : [json];
  const out = [];
  for (const result of results) {
    for (const v of isObj(result) && Array.isArray(result.violations) ? result.violations : []) {
      if (!isObj(v)) continue;
      out.push({ id: sanitizeWorkerText(v.id ?? 'unknown', 80), impact: IMPACTS.includes(v.impact) ? v.impact : 'minor', nodes: Array.isArray(v.nodes) ? v.nodes.length : 0 });
    }
  }
  return out;
}

export function evaluateBudgets({ lighthouse, axe }, config) {
  const failures = [];
  for (const key of SCORES) {
    if (config[key] === undefined) continue;
    const actual = lighthouse?.[key];
    if (actual === null || actual === undefined) failures.push({ kind: 'lighthouse', metric: key, actual: null, budget: config[key], message: `${key}: no score in the Lighthouse report (budget ${config[key]})` });
    else if (actual < config[key]) failures.push({ kind: 'lighthouse', metric: key, actual, budget: config[key], message: `${key} ${actual} is below the budget ${config[key]}` });
  }
  for (const v of axe ?? []) if ((config.axeBlock ?? []).includes(v.impact)) failures.push({ kind: 'axe', metric: v.id, impact: v.impact, nodes: v.nodes, message: `axe ${v.impact}: ${v.id} on ${v.nodes} element(s)` });
  return { pass: failures.length === 0, failures };
}

// The base address a budget run may use: a preview (https) or a local server. No credentials in it.
export function checkBaseUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  const local = ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return null;
  return `${u.protocol}//${u.host}`;
}

async function runTool(tool, url, out, { cwd, env, run }) {
  const argv = tool.argv.map(a => a.replaceAll('{url}', url).replaceAll('{out}', out));
  const res = await run(argv[0], argv.slice(1), { cwd, env: filterEnv(env), timeoutMs: tool.timeoutSec * 1000 });
  if (res?.timedOut) return { ok: false, reason: 'timed out' };
  const wrote = await fs.stat(out).then(s => s.size > 0, () => false);
  if (res?.spawnError || (res?.code !== 0 && !wrote)) return { ok: false, reason: sanitizeWorkerText(`${res?.stderr ?? ''}`.split('\n').filter(Boolean).pop() ?? `exit ${res?.code}`, 200) };
  try { return { ok: true, json: JSON.parse(await fs.readFile(out, 'utf8')) }; } catch { return { ok: false, reason: 'the tool wrote no readable JSON report' }; }
}

// Runs both tools on each screen of the base URL. A tool that cannot run is a `cannot-run` result for that screen, never a pass.
export async function runBudgets({ root, baseUrl, config, screens = null, env = process.env, run = defaultRun, now = Date.now }) {
  const base = checkBaseUrl(baseUrl);
  if (!base) throw Object.assign(new Error('budgets: the address must be an https preview or a local http server'), { code: 'budgets-url' });
  const dir = path.join(root, '.swarm', 'budgets-tmp');
  await fs.mkdir(dir, { recursive: true });
  const results = [];
  for (const screen of config.screens.filter(s => !screens || screens.includes(s.id))) {
    const url = `${base}${screen.path}`;
    const stem = path.join(dir, `${screen.id}-${randomBytes(4).toString('hex')}`);
    const lh = await runTool(config.lighthouse, url, `${stem}.lighthouse.json`, { cwd: root, env, run });
    const ax = await runTool(config.axe, url, `${stem}.axe.json`, { cwd: root, env, run });
    await fs.rm(`${stem}.lighthouse.json`, { force: true }); await fs.rm(`${stem}.axe.json`, { force: true });
    const at = new Date(now()).toISOString();
    if (!lh.ok || !ax.ok) { results.push({ id: screen.id, url, at, status: 'cannot-run', pass: false, failures: [{ kind: 'tool', metric: !lh.ok ? 'lighthouse' : 'axe', message: `${!lh.ok ? 'Lighthouse' : 'axe'} could not run: ${!lh.ok ? lh.reason : ax.reason}` }] }); continue; }
    const scores = parseLighthouse(lh.json);
    const verdict = evaluateBudgets({ lighthouse: scores, axe: parseAxe(ax.json) }, config);
    results.push({ id: screen.id, url, at, status: verdict.pass ? 'passed' : 'failed', pass: verdict.pass, scores, failures: verdict.failures.slice(0, 20) });
  }
  return results;
}

async function writeState(root, state) {
  const file = path.join(root, BUDGET_STATE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readBudgetState(root) {
  try { const state = JSON.parse(await fs.readFile(path.join(root, BUDGET_STATE), 'utf8')); return isObj(state) && isObj(state.screens) ? state : { version: 1, screens: {} }; }
  catch { return { version: 1, screens: {} }; }
}

// The latest result of each screen replaces the one before it; a passing run clears the screen.
export async function recordBudgetResults(root, results) {
  const state = await readBudgetState(root);
  for (const r of results) state.screens[r.id] = { at: r.at, url: r.url, status: r.status, scores: r.scores ?? null, failures: r.failures, ticket: r.status === 'passed' ? null : state.screens[r.id]?.ticket ?? null };
  await writeState(root, state);
  return state;
}

export async function linkBudgetTicket(root, id, ticket) {
  const state = await readBudgetState(root);
  if (!state.screens[id]) return;
  state.screens[id].ticket = ticket;
  await writeState(root, state);
}

export const openFailures = state => Object.entries(state.screens ?? {}).filter(([, s]) => s.status !== 'passed').map(([id, s]) => ({ id, ...s }));

// The stage number of a ticket: S1 < S2 < ... Fix tickets (S0) and cancelled or proposed tickets are not part of a stage.
const stageNumber = stage => { const m = /^S(\d+)$/.exec(String(stage ?? '')); return m ? Number(m[1]) : null; };
export function finishesLastStage(ledger) {
  const live = (ledger?.tickets ?? []).filter(t => !['cancelled', 'proposed'].includes(t.status) && stageNumber(t.stage) > 0);
  if (!live.length) return false;
  const last = Math.max(...live.map(t => stageNumber(t.stage)));
  return live.filter(t => stageNumber(t.stage) === last).every(t => ['done', 'review'].includes(t.status));
}

// Blocks only the PR that finishes the last stage, and only while a screen's latest budget run is failing (or could not run).
export function budgetShipGate({ budgets, state, ledger }) {
  if (!budgets) return null;
  const open = openFailures(state);
  if (!open.length || !finishesLastStage(ledger)) return null;
  const first = open[0];
  return { message: `budgets-failing: this PR finishes the last stage and ${open.length} screen(s) fail their speed or accessibility budget (${open.slice(0, 3).map(o => `${o.id}: ${o.failures?.[0]?.message ?? o.status}`).join('; ')}). Fix them (fix ticket ${first.ticket ?? 'none yet'}), then swarm budgets check --url PREVIEW_URL` };
}
