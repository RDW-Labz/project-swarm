// SPDX-License-Identifier: Apache-2.0
// Handoff docs (Phase 19, part 5): at the end of a stage, a user guide, an admin guide and a runbook for the client, written into docs/handoff/ of the project.
//  - The RUNBOOK is never written by a model. Deploy, roll back, rotate keys, logs and who to call come from the profile's `handoff` block (the owner's own file);
//    anything missing is written as "TODO (owner)", and the handoff cannot be marked final while one is left.
//  - The GUIDES are written by a worker under a cap (a normal manifest, run and integrated like any other), from the approved scope (the owner's own words),
//    the screens and the external services: never from ticket titles. Each step that names a screen or visible text carries a machine-readable check line.
//  - `check` runs those lines against a preview (page answers, text is there); a failing step becomes a PROPOSED ticket.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseScope } from './scope.mjs';
import { checkBaseUrl, hostAllowed } from './budgets.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';

export const HANDOFF_DIR = 'docs/handoff';
export const HANDOFF_STATE = '.swarm/handoff/state.json';
export const DEFAULT_CAP_USD = 2;
export const TODO = 'TODO (owner)';
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
// A name, not an address: the last label has a letter; a wildcard covers a name with at least two labels after it (not *.com).
const HOST_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$|^\\*\\.(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$`, 'i');
const wildcardOk = h => !h.startsWith('*.') || h.slice(2).split('.').length >= 2;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\r\n\u0000-\u001f]/.test(v);

// ---- the profile's handoff block (the owner's file) ---------------------------------------------------------------------------------------
const KEYS = ['deploy', 'rollback', 'rotateKeys', 'logs', 'contacts', 'previewUrl', 'previewHosts'];
const argvOk = v => Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every(a => oneLine(a, 200) && !/[|;&$`<>]/.test(a));
export function validateHandoffConfig(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, config: null, errors: ['handoff must be an object'] };
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) errors.push(`handoff.${key}: unknown key`);
  const config = {};
  for (const key of ['deploy', 'rollback']) if (raw[key] !== undefined) { if (argvOk(raw[key])) config[key] = [...raw[key]]; else errors.push(`handoff.${key} must be a command as a list of 1 to 20 short words (arguments, not one shell line: no pipe, semicolon, ampersand, dollar, backtick, less-than or greater-than)`); }
  const list = (key, max, shape) => {
    if (raw[key] === undefined) return;
    if (!Array.isArray(raw[key]) || raw[key].length > max || !raw[key].every(shape)) errors.push(`handoff.${key} must list at most ${max} well-formed entries`);
    else config[key] = raw[key].map(e => ({ ...e }));
  };
  list('rotateKeys', 10, e => isObj(e) && oneLine(e.service, 40) && oneLine(e.steps, 400));
  list('logs', 10, e => isObj(e) && oneLine(e.name, 60) && checkBaseUrl(e.url) !== null && e.url.startsWith('https://'));
  list('contacts', 10, e => isObj(e) && oneLine(e.role, 60) && oneLine(e.name, 80) && oneLine(e.phone, 40));
  if (raw.previewUrl !== undefined) { const u = typeof raw.previewUrl === 'string' ? checkBaseUrl(raw.previewUrl) : null; if (u) config.previewUrl = u; else errors.push('handoff.previewUrl must be an https address (or http on this computer) without credentials'); }
  if (raw.previewHosts !== undefined) { if (Array.isArray(raw.previewHosts) && raw.previewHosts.length >= 1 && raw.previewHosts.length <= 10 && raw.previewHosts.every(h => typeof h === 'string' && HOST_RE.test(h) && wildcardOk(h))) config.previewHosts = [...new Set(raw.previewHosts)]; else errors.push('handoff.previewHosts must list 1 to 10 hosts like app.example.com or *.vercel.app'); }
  if (config.previewUrl && !config.previewHosts) errors.push('handoff.previewUrl needs handoff.previewHosts (the hosts a preview may have)');
  return errors.length ? { ok: false, config: null, errors } : { ok: true, config, errors };
}

// ---- the runbook: only the owner's facts, TODO where there is none -------------------------------------------------------------------------
export function renderRunbook(config = {}, { project = 'this project', stage = null } = {}) {
  const c = config ?? {};
  const cmd = argv => `\`${argv.join(' ')}\``;
  const lines = [`# Runbook${stage ? ` (${stage})` : ''}: ${project}`, '', 'Every fact below comes from the project owner. Nothing was invented; a gap is flagged for the owner to fill.', ''];
  lines.push('## Deploy', '', c.deploy ? `Run ${cmd(c.deploy)} from the project folder.` : `${TODO}: the command that deploys to production (profile.handoff.deploy).`, '');
  lines.push('## Roll back', '', c.rollback ? `Run ${cmd(c.rollback)} from the project folder.` : `${TODO}: the command that rolls the last deploy back (profile.handoff.rollback).`, '');
  lines.push('## Rotate keys', '');
  if (c.rotateKeys?.length) c.rotateKeys.forEach(k => lines.push(`- **${k.service}:** ${k.steps}`)); else lines.push(`${TODO}: for each service, how to rotate its key (profile.handoff.rotateKeys).`);
  lines.push('', '## Where the logs are', '');
  if (c.logs?.length) c.logs.forEach(l => lines.push(`- ${l.name}: ${l.url}`)); else lines.push(`${TODO}: links to the logs (profile.handoff.logs).`);
  lines.push('', '## Who to call', '');
  if (c.contacts?.length) c.contacts.forEach(p => lines.push(`- ${p.role}: ${p.name}, ${p.phone}`)); else lines.push(`${TODO}: who to call and their numbers (profile.handoff.contacts).`);
  return `${lines.join('\n')}\n`;
}

// Any spelling of the marker (case, spaces); the bare word "todo" is fine (a product may have a todo list).
const TODO_RE = /\bTODO\s*\(\s*owner\s*\)/i;
export const todoLines = text => String(text).split('\n').map((l, i) => ({ line: i + 1, text: l })).filter(l => TODO_RE.test(l.text));

// ---- the inputs the guides are written from: the owner's words, never worker text -----------------------------------------------------------
export function renderInputs({ scope, stage, screens = [], images = {} }) {
  const reqs = scope.requirements.filter(r => r.stage === stage || (r.stage && scope.stages.some(s => s.id === r.stage && s.order <= (scope.stages.find(x => x.id === stage)?.order ?? 0))));
  const lines = [`# Inputs for the ${stage} guides`, '', `Project: ${scope.name}`, '', '## What the product does (the owner\'s overview)', '', scope.overview || '(none given)', '', '## Requirements and how each is accepted', ''];
  for (const r of reqs) { lines.push(`### ${r.id} ${r.text}`); for (const a of r.acceptance) lines.push(`- ${a}`); lines.push(''); }
  lines.push('## Screens', '');
  if (screens.length) screens.forEach(id => lines.push(`- ${id}${images[id] ? `: ![${id}](img/${images[id]})` : ''}`)); else lines.push('(no approved screens)');
  lines.push('', '## External services', '');
  if (scope.external.length) scope.external.forEach(e => lines.push(`- ${e.name}${e.note ? `: ${e.note}` : ''}`)); else lines.push('(none)');
  return `${lines.join('\n')}\n`;
}

const PROMPT = audience => [
  `Write the ${audience} guide for the product described in the inputs file, for people who have never seen it. Use plain words and short numbered steps.`,
  'Use only facts that are in the inputs file. Do not invent screens, buttons, web addresses, commands, names, numbers or settings. When a fact you need is missing, write TODO (owner) in its place.',
  'After every step that names a screen, a web address or text a person will see, add one line that looks exactly like this, with the real values: <!-- check: route=/the-page text="a visible word or phrase" --> (the text part is optional; the route starts with one slash and has no host).',
  'Keep every check line on its own line. Do not add any other HTML. Write the guide only to the output file named in this job.',
].join(' ');

export const MAX_OUTPUT_TOKENS = 8000;
export function buildManifest({ stage, capUsd, model, agent = 'anthropic', inputsFile }) {
  const job = (id, audience, out) => ({ id, agent, model, tier: 'mid', type: 'docs', prompt: PROMPT(audience), context: [inputsFile], outputs: [out], maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: 600000 });
  return { version: 1, concurrency: 2, budget: { maxUsd: capUsd }, jobs: [job(`handoff-${stage.toLowerCase()}-user`, 'user', `${HANDOFF_DIR}/user-guide.md`), job(`handoff-${stage.toLowerCase()}-admin`, 'administrator', `${HANDOFF_DIR}/admin-guide.md`)] };
}

// ---- the check lines ------------------------------------------------------------------------------------------------------------------------
const CHECK = /<!--\s*check:\s*route=(\/[A-Za-z0-9._~\/-]{0,100})(?:\s+text="([^"<>]{1,120})")?\s*-->/g;
export function extractChecks(markdown, guide = '') {
  const out = [];
  const seen = new Set();
  for (const m of String(markdown).matchAll(CHECK)) {
    const route = m[1];
    if (route.length > 200 || route.includes('..') || route.startsWith('//') || route.includes('\\')) continue;
    const key = `${route}|${m[2] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ guide, route, text: m[2] ?? null });
  }
  return out.slice(0, 60);
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plain = html => String(html)
  .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
  .replace(/<(script|style|noscript|template|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')   // an unclosed one runs to the end
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (m, d, h, n) => (d ? String.fromCodePoint(Math.min(Number(d), 0x10ffff)) : h ? String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)) : ENT[n.toLowerCase()] ?? m))
  .replace(/\s+/g, ' ');

// One check against the preview: the page answers (2xx, on the same host) and the text is there. `get` is injectable.
export async function runCheck(base, check, { get }) {
  const url = `${base}${check.route}`;
  let res;
  try { res = await get(url); } catch (error) { return { ...check, ok: false, reason: `could not reach it (${sanitizeWorkerText(String(error?.message ?? error), 80)})` }; }
  if (!res || res.status < 200 || res.status > 299) return { ...check, ok: false, reason: `the page answered ${res?.status ?? 'nothing'}` };
  if (check.text && !plain(res.body ?? '').toLowerCase().includes(check.text.toLowerCase())) return { ...check, ok: false, reason: `the text "${check.text}" is not on the page` };
  return { ...check, ok: true };
}

const MAX_BODY = 2 * 1024 * 1024;
// A redirect is followed by hand, at most 5 hops, and only to the same protocol and host: nothing off the preview is ever fetched (a redirect to an address inside the network is not followed).
export async function realGet(url, { fetchImpl = fetch } = {}) {
  const first = new URL(url);
  let current = first;
  for (let hop = 0; hop <= 5; hop += 1) {
    const res = await fetchImpl(current.href, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let next;
      try { next = new URL(res.headers.get('location'), current); } catch { return { status: 0, body: '' }; }
      if (next.protocol !== first.protocol || next.host !== first.host) return { status: 0, body: '' };
      try { await res.body?.cancel(); } catch (error) {
        if (!(error instanceof TypeError || error?.code === 'ERR_INVALID_STATE')) {
          console.error('[tools/handoff-docs.mjs] cancel response body:', error?.message ?? error);
        }
      }
      current = next;
      continue;
    }
    // Read at most MAX_BODY bytes, then stop (a huge answer is not held in memory).
    const chunks = []; let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      while (size < MAX_BODY) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
      try { await reader.cancel(); } catch (error) {
        if (!(error instanceof TypeError || error?.code === 'ERR_INVALID_STATE')) {
          console.error('[tools/handoff-docs.mjs] cancel reader:', error?.message ?? error);
        }
      }
    }
    return { status: res.status, body: Buffer.concat(chunks.map(c => Buffer.from(c))).subarray(0, MAX_BODY).toString('utf8') };
  }
  return { status: 0, body: '' };
}

// The preview address a check may use: the one in the profile or given by hand; an automatic one must be on an allowed host.
export function previewBase({ url, config }) {
  const base = checkBaseUrl(url ?? config?.previewUrl);
  if (!base) return { error: 'give the preview address: swarm handoff check --url https://... (https, no credentials), or set profile.handoff.previewUrl' };
  if (!url && !(config?.previewHosts && hostAllowed(base, config.previewHosts))) return { error: 'the profile\'s preview address needs handoff.previewHosts, and must be on it' };
  return { base };
}

// Fixed text and a strictly limited route only; what the guide said (the check text, the reason) goes in notes, which a worker sees fenced as untrusted.
export function failureTicket(f) {
  const route = /^\/[A-Za-z0-9._~\/-]{0,100}$/.test(String(f.route)) ? f.route : '/';
  return {
    title: `Fix handoff step: ${route}`,
    type: 'build', stage: 'S0', epic: 'E-97 Handoff checks', scopeRefs: [],
    acceptance: [`The page ${route} answers on the preview and shows what its handoff guide step says it shows (see notes).`],
    files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'medium', sensitive: true, status: 'proposed',
    origin: 'handoff', source: { guide: String(f.guide).slice(0, 40), route },
    notes: sanitizeWorkerText(`${f.reason}${f.text ? `; text: ${f.text}` : ''}`, 300),
  };
}

export async function readHandoffState(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, HANDOFF_STATE), 'utf8')); } catch { return null; }
}
export async function writeHandoffState(root, state) {
  const file = path.join(root, HANDOFF_STATE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
import { createHash } from 'node:crypto';
export const guidesHash = guides => createHash('sha256').update(guides.filter(g => g.name !== 'runbook.md').sort((a, b) => (a.name < b.name ? -1 : 1)).map(g => `${g.name}\n${g.text}`).join('\n---\n')).digest('hex');
export async function guideFiles(root) {
  const dir = path.join(root, HANDOFF_DIR);
  const names = ['user-guide.md', 'admin-guide.md', 'runbook.md'];
  const out = [];
  for (const name of names) {
    try { out.push({ name, text: await fs.readFile(path.join(dir, name), 'utf8') }); } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error('[tools/handoff-docs.mjs] read guide file:', name, error?.message ?? error);
      }
    }
  }
  return out;
}
export { parseScope };
