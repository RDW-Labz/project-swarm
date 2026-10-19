// SPDX-License-Identifier: Apache-2.0
// The weekly client progress report (Phase 19, D1): files only, nothing is sent.
// It is built from the REQUIREMENTS of the scope (the owner's own words), the stage names and the ticket progress: never from ticket titles, notes, costs, models or code.
// After it is built a scan refuses it if anything internal is in it; the owner reads it, approves it (a hash of the exact files), and sends it themselves.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requirementWired, logPath } from './tickets.mjs';
import { findUnsafeText } from './lesson-schema.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';

export const REPORTS_DIR = '.swarm/reports';
const DAY = 86400000;
const NEXT_LIMIT = 5;
const clean = (v, n = 300) => sanitizeWorkerText(v ?? '', n);

// ---- what happened, from the ticket log ---------------------------------------------------------------------------------------------------------

// When each ticket last reached done (ms), from the log's transition lines. A ticket with no line is "done earlier" (no time known).
export async function doneTimes(root) {
  const times = new Map();
  let text = '';
  try { text = await fs.readFile(logPath(root), 'utf8'); } catch { return times; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.event === 'transition' && e.to === 'done' && typeof e.id === 'string') { const at = Date.parse(e.at); if (Number.isFinite(at)) times.set(e.id, Math.max(times.get(e.id) ?? 0, at)); }
    } catch { /* a damaged line is skipped */ }
  }
  return times;
}

const live = t => t && !['cancelled', 'proposed'].includes(t.status);

// The data of one report. `scope` is the parsed approved scope, `ledger` the ticket ledger.
export function buildReport({ scope, ledger, times = new Map(), now = Date.now(), sinceDays = 7, previewUrl = null }) {
  const tickets = (ledger?.tickets ?? []).filter(live);
  const since = now - sinceDays * DAY;
  const reqs = scope.requirements.map(req => {
    const mine = tickets.filter(t => (t.scopeRefs ?? []).includes(req.id));
    const allDone = mine.length > 0 && mine.every(t => t.status === 'done') && requirementWired(ledger, req.id);
    const started = mine.some(t => ['running', 'review', 'done'].includes(t.status));
    const doneAt = allDone ? Math.min(now, Math.max(0, ...mine.map(t => times.get(t.id) ?? 0))) : 0;
    return { id: req.id, text: clean(req.text, 240), stage: req.stage, state: allDone ? 'done' : started ? 'progress' : 'later', doneAt, hasTickets: mine.length > 0 };
  });
  const total = reqs.length;
  const done = reqs.filter(r => r.state === 'done');
  const stageOrder = new Map(scope.stages.map(s => [s.id, s.order]));
  const byStage = scope.stages.map(s => { const inStage = reqs.filter(r => r.stage === s.id); return { id: s.id, title: clean(s.title, 80), total: inStage.length, done: inStage.filter(r => r.state === 'done').length }; });
  const later = reqs.filter(r => r.state === 'later' && r.hasTickets).sort((a, b) => (stageOrder.get(a.stage) ?? 99) - (stageOrder.get(b.stage) ?? 99) || (a.id < b.id ? -1 : 1));
  const decisionSection = scope.sections.find(s => /^(client )?decisions( needed)?( from the client)?$/i.test(s.title.trim()));
  const decisions = String(decisionSection?.text ?? '').split('\n').map(l => /^-\s+(.*)$/.exec(l)?.[1]).filter(Boolean).map(l => clean(l, 240)).slice(0, 10);
  return {
    name: clean(scope.name, 80) || 'Project',
    sinceDays,
    periodEnd: new Date(now).toISOString().slice(0, 10),
    periodStart: new Date(since).toISOString().slice(0, 10),
    percent: total ? Math.round(100 * done.length / total) : 0,
    done: done.length, total,
    byStage,
    doneThisWeek: done.filter(r => r.doneAt >= since).map(r => r.text),
    inProgress: reqs.filter(r => r.state === 'progress').map(r => r.text),
    next: later.slice(0, NEXT_LIMIT).map(r => r.text),
    decisions,
    previewUrl: previewUrl && /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[\w./%~+-]*)?$/.test(previewUrl) ? previewUrl : null,
  };
}

// ---- the two renderings (nothing is interpreted: all text is escaped) ----------------------------------------------------------------------------

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderText(r) {
  const list = items => (items.length ? items.map(i => `- ${i}`) : ['- Nothing this week.']);
  return [
    `${r.name}: progress report`,
    `Week of ${r.periodStart} to ${r.periodEnd}`,
    '',
    `Overall: ${r.percent}% complete (${r.done} of ${r.total} features).`,
    ...r.byStage.filter(s => s.total).map(s => `  ${s.title || s.id}: ${s.done} of ${s.total}`),
    '',
    r.sinceDays === 7 ? 'Done this week' : `Done in the last ${r.sinceDays} days`,
    ...list(r.doneThisWeek),
    '',
    'In progress',
    ...(r.inProgress.length ? r.inProgress.map(i => `- ${i}`) : ['- Nothing right now.']),
    '',
    'Coming up next',
    ...(r.next.length ? r.next.map(i => `- ${i}`) : ['- Nothing further is planned.']),
    '',
    'Decisions we need from you',
    ...(r.decisions.length ? r.decisions.map(i => `- ${i}`) : ['- None this week.']),
    ...(r.previewUrl ? ['', `Preview: ${r.previewUrl}`] : []),
    '',
  ].join('\n');
}

export function renderHtml(r) {
  const ul = (items, empty) => (items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p class="none">${esc(empty)}</p>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.name)}: progress report</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#1b1b1f;background:#fff}h1{margin-bottom:.2rem}h2{margin-top:2rem}.week{color:#555}.bar{height:12px;background:#e5e5ea;border-radius:6px;overflow:hidden}.bar>span{display:block;height:100%;background:#2f7d4f}.none{color:#666}@media (prefers-color-scheme:dark){body{background:#141416;color:#eee}.week,.none{color:#aaa}.bar{background:#333}}</style></head>
<body>
<h1>${esc(r.name)}</h1>
<p class="week">Progress report, week of ${esc(r.periodStart)} to ${esc(r.periodEnd)}</p>
<p><strong>${r.percent}% complete</strong> (${r.done} of ${r.total} features)</p>
<div class="bar" role="img" aria-label="${r.percent} percent complete"><span style="width:${r.percent}%"></span></div>
${r.byStage.filter(s => s.total).length ? `<ul>${r.byStage.filter(s => s.total).map(s => `<li>${esc(s.title || s.id)}: ${s.done} of ${s.total}</li>`).join('')}</ul>` : ''}
<h2>${esc(r.sinceDays === 7 ? 'Done this week' : `Done in the last ${r.sinceDays} days`)}</h2>${ul(r.doneThisWeek, 'Nothing this week.')}
<h2>In progress</h2>${ul(r.inProgress, 'Nothing right now.')}
<h2>Coming up next</h2>${ul(r.next, 'Nothing further is planned.')}
<h2>Decisions we need from you</h2>${ul(r.decisions, 'None this week.')}
${r.previewUrl ? `<h2>Preview</h2><p><a href="${esc(r.previewUrl)}">${esc(r.previewUrl)}</a></p>` : ''}
</body></html>
`;
}

// ---- the scan: nothing internal may reach a client -----------------------------------------------------------------------------------------------

// What may never reach a client. `override: true` kinds can be allowed phrase by phrase by the owner (a scope section "Report allow"): a client feature may really be
// about a "support ticket" or an "agent". Money, vendors, ids, paths, secrets, emails and addresses can never be allowed.
const BANNED = [
  { what: 'a cost or price', re: /[$€£¥]\s?\.?\d|\bUS\$|\b(?:usd|eur|gbp|dollars?|euros?|pounds?)\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|\b(?:model|token|compute|api|ai|gpu|build|swarm|agent|our)\s+(?:cost|costs|spend|spending|budget)\b/i },
  { what: 'a model or vendor name', re: /\b(?:haiku|sonnet|opus|claude|anthropic|openai|chatgpt|gpts?(?:[- ]?\d\w*)?|gpt4\w*|codex|cursor|gemini|gemma|qwen|llamas?|mistral|deepseek|openrouter|ollama|hermes|llms?|grok|copilot|o[134](?:-\w+)?|rented)\b/i },
  { what: 'a ticket, commit or run id', re: /\bT-?\d{2,}\b|\bERR-[0-9a-f]{6,}\b|\b\d{12,}-[0-9a-f]{6,}\b|\bR-\d{3,}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\b(?:feat|fix|chore|docs|hotfix)\/[\w./-]+|\bPR\s?#\d+/i },
  { what: 'a file path', re: /(?:^|[\s(])(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[a-z0-9]{1,6}\b|\b(?:src|app|pages|lib|api|node_modules|supabase|migrations|docs|tests?)\/[\w./-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|sql|py|css|vue|ya?ml|sh|go|rs|rb|php|toml|lock|mdx?|html)\b|\.env\b|\b[A-Za-z]:\\|\/(?:Users|home|var|etc|usr|opt|tmp|root)\//i },
  { what: 'code', override: true, re: /```|`[^`\n]+`|<\/?[a-z][^>]*>|\b(?:const|let|var)\s+\w+\s*=|\bimport\s+[\w{*][^\n]*\bfrom\s+['"]|\bfunction\s+\w+\s*\(|\bexport\s+(?:default|const|function|class)\b|=>\s*[{(]|\bSELECT\b[^\n]{1,80}\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i },
  { what: 'an internal word', override: true, re: /\b(?:swarm|workers?|agents?|lanes?|prompts?|tickets?|pull requests?|merge queue|escalat\w+|sandbox|gpus?)\b/i },
  { what: 'a secret-looking value', re: /\b(?:sk|pk|rk|whsec|ghp|xox[abp])[_-][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.|\bAKIA[0-9A-Z]{8,}/ },
];

// Text as a person would read it: Unicode folded (fullwidth and look-alike forms), invisible characters removed, entities decoded (once, & last).
export function readable(text) {
  let t = String(text ?? '').normalize('NFKC').replace(/[\p{Cf}\u00ad]/gu, '');
  t = t.replace(/&#x([0-9a-f]{1,6});/gi, (_m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d{1,7});/g, (_m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  return t.normalize('NFKC').replace(/[\p{Cf}\u00ad]/gu, '');
}

// Returns what was found (an empty list is a pass). `allowed` are owner-approved phrases for the kinds that can be allowed.
export function scanClientText(text, { allowed = [] } = {}) {
  const whole = readable(text);
  let body = whole;
  for (const phrase of allowed) body = body.split(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ');
  const found = [];
  for (const { what, re, override } of BANNED) {
    const src = override ? body : whole;
    const m = re.exec(src);
    if (m) found.push({ what, override: Boolean(override), sample: clean(src.slice(Math.max(0, m.index - 20), m.index + (m[0]?.length ?? 0) + 20), 80) });
    else if (!override && what === 'a model or vendor name' && /(?:haiku|sonnet|opus|claude|anthropic|openai|chatgpt|codex|gemini|deepseek|openrouter)/i.test(whole.replace(/\s+/g, ''))) found.push({ what, override: false, sample: '(letters spread apart)' });
  }
  if (findUnsafeText(body).length) found.push({ what: 'a secret-looking value', override: false, sample: '(withheld)' });
  if (/https?:\/\//i.test(body)) found.push({ what: 'a web address', override: false, sample: clean(/https?:\/\/\S{0,60}/i.exec(body)?.[0] ?? '', 70) });
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(body)) found.push({ what: 'an email address', override: false, sample: '(withheld)' });
  return found;
}

// The preview link: https, a bare host (path none or /), no query, no credentials; and its decoded text passes the same scan (a branch address can carry a ticket id).
export function checkPreviewUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/?$/.test(url)) return { ok: false, reason: 'the preview address must be https, a host only (no path, query or credentials)' };
  let host = url;
  try { host = decodeURIComponent(new URL(url).hostname); } catch { /* as written */ }
  const hit = [...scanClientText(host), ...scanClientText(host.replace(/[.-]/g, ' '))].find(p => p.what !== 'a web address');
  return hit ? { ok: false, reason: `the preview address holds ${hit.what} (use the production or a plain address)` } : { ok: true };
}

// The owner's own list of phrases that are fine for THIS client ("support ticket"): a scope section titled "Report allow", one "- phrase" per line.
export function allowedPhrases(scope) {
  const section = scope.sections.find(s => /^report allow(ed)?( phrases| words)?$/i.test(s.title.trim()));
  return String(section?.text ?? '').split('\n').map(l => /^-\s+(.{2,40})$/.exec(l)?.[1]?.trim()).filter(Boolean).slice(0, 20);
}

// ---- reading the HTML as the client would: only our own page shape is accepted ----------------------------------------------------------------------

const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'h1', 'h2', 'p', 'strong', 'div', 'span', 'ul', 'li', 'a']);
const ATTRS = new Set(['lang', 'charset', 'name', 'content', 'class', 'role', 'aria-label', 'style', 'href', 'http-equiv']);

// Text of a report.html (every text node and every visible attribute value, joined and spaced), or a refusal when the file is not the page this tool writes
// (a comment, a script, an image, a tag or an attribute we never write): hand edits to the words are fine, edits that add markup are not.
export function htmlText(html, { previewUrl = null } = {}) {
  const source = String(html ?? '');
  if (/<!--/.test(source) || /<!\[CDATA\[/.test(source)) return { ok: false, reason: 'the HTML holds a comment' };
  const parts = [];
  let styleBody = '';
  const re = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>|<!doctype html>|([^<]+)/gi;
  let m, last = 0;
  while ((m = re.exec(source)) !== null) {
    if (m.index !== last) return { ok: false, reason: 'the HTML holds markup this tool does not write' };
    last = re.lastIndex;
    if (m[4] !== undefined) { parts.push(m[4]); continue; }
    if (m[2] === undefined) continue;
    const name = m[2].toLowerCase();
    if (!TAGS.has(name)) return { ok: false, reason: `the HTML holds a <${name}> tag` };
    if (m[1]) continue;
    for (const attr of m[3].matchAll(/([A-Za-z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
      const key = attr[1].toLowerCase(), value = attr[2] ?? attr[3] ?? '';
      if (!ATTRS.has(key)) return { ok: false, reason: `the HTML holds an attribute ${key}` };
      if (key === 'href') { if (!(name === 'a' && previewUrl && readable(value) === previewUrl)) return { ok: false, reason: 'a link in the HTML is not the preview link' }; }
      else if (key === 'style') { if (!/^width:\d{1,3}%$/.test(value)) return { ok: false, reason: 'the HTML holds an inline style this tool does not write' }; }
      else if (['aria-label', 'content'].includes(key) || (key === 'name' && name !== 'meta')) parts.push(value);
    }
    if (name === 'style') { const end = source.indexOf('</style>', re.lastIndex); if (end < 0) return { ok: false, reason: 'unterminated style' }; styleBody = source.slice(re.lastIndex, end); re.lastIndex = end; last = end; }
  }
  if (/url\(|@import|expression\(|javascript:/i.test(styleBody)) return { ok: false, reason: 'the style holds an outside load' };
  return { ok: true, text: [parts.join(''), parts.join(' ')] };
}

// ---- the files, the draft and the approval -------------------------------------------------------------------------------------------------------

const sha = text => createHash('sha256').update(text).digest('hex');
const hashFiles = (html, txt) => sha(`${sha(html)}:${sha(txt)}`);
const folderFor = (root, date) => path.join(root, REPORTS_DIR, `client-${date}`);
const DIR_RE = /^client-\d{4}-\d{2}-\d{2}(?:-\d+)?$/;

// Writes a DRAFT (report.html, report.txt, report.json). Refuses, naming what is wrong, if the scan finds anything internal in either file.
export async function writeDraft(root, data, { now = Date.now, allowed = [] } = {}) {
  if (data.previewUrl) { const check = checkPreviewUrl(data.previewUrl); if (!check.ok) return { ok: false, problems: [{ what: 'the preview link', sample: check.reason }] }; }
  const html = renderHtml(data), txt = renderText(data);
  const fromHtml = htmlText(html, { previewUrl: data.previewUrl });
  const texts = [txt, ...(fromHtml.ok ? fromHtml.text : [])];
  const problems = [];
  for (const text of texts) for (const p of scanClientText(data.previewUrl ? text.split(data.previewUrl).join('') : text, { allowed })) if (!problems.some(q => q.what === p.what)) problems.push(p);
  if (!fromHtml.ok) problems.push({ what: 'the page itself', sample: fromHtml.reason });
  if (problems.length) return { ok: false, problems };
  let dir, n = 1;
  await fs.mkdir(path.join(root, REPORTS_DIR), { recursive: true, mode: 0o700 });
  for (;;) {
    dir = folderFor(root, n === 1 ? data.periodEnd : `${data.periodEnd}-${n}`);
    try { await fs.mkdir(dir, { mode: 0o700 }); break; } catch (error) { if (error.code !== 'EEXIST' || n > 99) throw error; n += 1; }
  }
  await fs.writeFile(path.join(dir, 'report.html'), html, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(dir, 'report.txt'), txt, { mode: 0o600, flag: 'wx' });
  const meta = { version: 1, status: 'draft', createdAt: new Date(now()).toISOString(), periodStart: data.periodStart, periodEnd: data.periodEnd, percent: data.percent, previewUrl: data.previewUrl ?? null, allowed, builtHash: hashFiles(html, txt), approvedHash: null, approvedAt: null };
  await fs.writeFile(path.join(dir, 'report.json'), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { ok: true, dir: path.relative(root, dir), meta };
}

async function loadReport(root, name) {
  const dirName = name === undefined || name === 'latest' ? (await listReports(root)).at(-1)?.dir : path.basename(String(name));
  if (dirName && DIR_RE.test(dirName)) { const info = await fs.lstat(path.join(root, REPORTS_DIR, dirName)).catch(() => null); if (!info || info.isSymbolicLink() || !info.isDirectory()) return null; }
  if (!dirName || !DIR_RE.test(dirName)) return null;
  const dir = path.join(root, REPORTS_DIR, dirName);
  try {
    const [html, txt, meta] = await Promise.all([fs.readFile(path.join(dir, 'report.html'), 'utf8'), fs.readFile(path.join(dir, 'report.txt'), 'utf8'), fs.readFile(path.join(dir, 'report.json'), 'utf8').then(JSON.parse)]);
    return { dirName, dir, html, txt, meta };
  } catch { return null; }
}

export async function listReports(root) {
  let names = [];
  try { names = (await fs.readdir(path.join(root, REPORTS_DIR))).filter(n => DIR_RE.test(n)).sort((a, b) => { const [da, na = '1'] = [a.slice(7, 17), a.slice(18)]; const [db, nb = '1'] = [b.slice(7, 17), b.slice(18)]; return da < db ? -1 : da > db ? 1 : Number(na || 1) - Number(nb || 1); }); } catch { return []; }
  const out = [];
  for (const dir of names) { const r = await loadReport(root, dir); if (r) out.push({ dir, ...(await verifiedStatus(r)) }); }
  return out;
}

// draft (built, not approved), approved (the files are exactly what was approved) or edited (the files changed after the build or after the approval).
export function reportStatus({ html, txt, meta }) {
  const hash = hashFiles(html, txt);
  if (meta.approvedHash) return { status: hash === meta.approvedHash ? 'approved' : 'edited', hash, approvedAt: meta.approvedAt };
  return { status: hash === meta.builtHash ? 'draft' : 'edited', hash, approvedAt: null };
}

// The scan of the files as they are now: the text file, and the text a reader of the page would see.
function scanFiles(r) {
  const url = r.meta.previewUrl ?? null;
  const html = htmlText(r.html, { previewUrl: url });
  const problems = [];
  const add = list => { for (const p of list) if (!problems.some(q => q.what === p.what)) problems.push(p); };
  for (const text of [r.txt, ...(html.ok ? html.text : [])]) add(scanClientText(url ? text.split(url).join('') : text, { allowed: r.meta.allowed ?? [] }));
  if (!html.ok) add([{ what: 'the page itself', sample: html.reason }]);
  if (url && !checkPreviewUrl(url).ok) add([{ what: 'the preview link', sample: checkPreviewUrl(url).reason }]);
  return problems;
}

// `approved` only while the files still pass the scan: a record edited by hand to say approved is not believed.
async function verifiedStatus(r) {
  const status = reportStatus(r);
  if (status.status === 'approved' && scanFiles(r).length) return { ...status, status: 'edited' };
  return status;
}

// The owner's approval: of the files as they are NOW (they may have been read and touched up). The scan runs again on those files, and on the page as a reader sees it.
export async function approveReport(root, name, { now = Date.now } = {}) {
  const r = await loadReport(root, name);
  if (!r) return { ok: false, error: 'no such report (swarm report --client builds one)' };
  const problems = scanFiles(r);
  if (problems.length) return { ok: false, error: 'the files hold something that must not reach a client', problems };
  const hash = hashFiles(r.html, r.txt);
  const meta = { ...r.meta, status: 'approved', approvedHash: hash, approvedAt: new Date(now()).toISOString() };
  await fs.writeFile(path.join(r.dir, 'report.json'), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, dir: r.dirName, hash, approvedAt: meta.approvedAt };
}
