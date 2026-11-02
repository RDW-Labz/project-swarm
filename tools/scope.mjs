// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export const SCOPE_TEMPLATE = [
'# Scope: <Product name>',
'Version: 1',
'',
'## Overview',
'<Users, goals, out of scope. Free text.>',
'',
'## Stages',
'- S1: <Foundations>',
'- S2: <Core features>',
'',
'## S1 <Foundations>',
'### R-001 <One testable sentence: who can do what.>',
'Acceptance:',
'- <Observable check, with a number where possible.>',
'- <A second observable check.>',
'',
'## External',
'- <Service>: <what it is used for>',
'',
'## Sensitive',
'- <payments, auth, customer data>',
'',
'## Protected',
'- <.env>',
''].join('\n');

const UNTESTABLE = ['fast', 'quick', 'nice', 'good', 'easy', 'intuitive', 'user-friendly', 'robust', 'scalable', 'modern', 'clean', 'seamless', 'simple', 'beautiful', 'secure', 'flexible', 'efficient', 'reliable', 'better'];

export function parseScope(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = { name: '', version: 1, overview: '', stages: [], requirements: [], external: [], sensitive: [], protected: [], sections: [], context: [], layout: '', errors: [], strays: [] };
  const over = [];
  const layout = [];
  let other = null;
  let section = 'overview', stage = null, req = null, inAcc = false;
  const addStage = (id, title) => {
    const s = out.stages.find(x => x.id === id);
    if (!s) out.stages.push({ id, title: title || '', order: out.stages.length + 1 });
    else if (title && !s.title) s.title = title;
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    const no = i + 1;
    let m;
    if ((m = /^# Scope:\s*(.*)$/.exec(line))) { out.name = m[1].trim(); return; }
    if ((m = /^Version:\s*(\d+)\s*$/.exec(line))) { out.version = Number(m[1]); return; }
    if (/^## /.test(line)) {
      const h = line.slice(3).trim();
      req = null; inAcc = false; stage = null; other = null;
      if ((m = /^(S\d+)\b\s*(.*)$/.exec(h))) { section = 'stage'; stage = m[1]; addStage(m[1], m[2].trim()); }
      else section = /^stages$/i.test(h) ? 'stages' : /^external$/i.test(h) ? 'external' : /^sensitive$/i.test(h) ? 'sensitive' : /^protected$/i.test(h) ? 'protected' : /^overview$/i.test(h) ? 'overview' : /^context$/i.test(h) ? 'context' : /^layout$/i.test(h) ? 'layout' : 'other';
      if (section === 'other') { other = { title: h, slug: h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60), lines: [] }; out.sections.push(other); }
      return;
    }
    if (/^### /.test(line)) {
      req = null; inAcc = false;
      if (section === 'stage') {
        m = /^### (\S*)\s*(.*)$/.exec(line);
        req = { id: m[1], stage, text: m[2].trim(), acceptance: [], line: no };
        if (!req.text) out.errors.push(`line ${no}: requirement ${req.id} has no text`);
        out.requirements.push(req);
      }
      return;
    }
    if (/^acceptance:\s*$/i.test(line)) { if (req) inAcc = true; return; }
    if (/^- /.test(line)) {
      const item = line.slice(2).trim();
      if (section === 'stages') {
        if ((m = /^(S\d+):\s*(.*)$/.exec(item))) addStage(m[1], m[2].trim());
        else out.errors.push(`line ${no}: stage list item needs "S<n>: Title"`);
      } else if (section === 'stage') {
        if (req) { if (inAcc) req.acceptance.push(item); }
        else out.strays.push({ stage, text: item, line: no });
      } else if (section === 'external') {
        m = /^([^:]+):\s*(.*)$/.exec(item);
        out.external.push(m ? { name: m[1].trim(), note: m[2].trim() } : { name: item, note: '' });
      } else if (section === 'sensitive') out.sensitive.push(item);
      else if (section === 'protected') out.protected.push(item);
      else if (section === 'context') {
        // "path" or "path [db, ui, api, test, all]": files every ticket of those kinds gets as context.
        m = /^`?([^`\s\[]+)`?\s*(?:\[([^\]]*)\])?\s*(?::.*)?$/.exec(item);
        if (m) out.context.push({ path: m[1], kinds: (m[2] ? m[2].split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : ['all']) });
        else out.errors.push(`line ${no}: context item needs "path [kinds]"`);
      } else if (section === 'overview') over.push(line);
      else if (section === 'layout') layout.push(line);
      else if (section === 'other' && other) other.lines.push(line);
      return;
    }
    if (section === 'overview') over.push(line);
    else if (section === 'layout') layout.push(line);
    else if (section === 'other' && other) other.lines.push(line);
  });
  out.overview = over.join('\n').trim();
  out.layout = layout.join('\n').trim();
  for (const s of out.sections) { s.text = s.lines.join('\n').trim(); delete s.lines; }
  if (!out.name) out.errors.push('missing "# Scope: NAME" title');
  return out;
}

export function checkScope(scope) {
  const findings = [];
  const add = (level, code, id, message, fix) => findings.push({ level, code, id, message, fix });
  for (const e of scope.errors ?? []) add('error', 'parse', null, e, 'Fix the line named in the message');
  for (const s of scope.strays ?? []) add('warn', 'missing-id', null, `Line ${s.line}: dash line under ${s.stage} is not a requirement: ${s.text}`, 'Make it a ### R-NNN heading with an Acceptance list, or move it');
  const stageIds = new Set(scope.stages.map(s => s.id));
  const seen = new Map();
  for (const r of scope.requirements) {
    if (!/^R-\d{3,}$/.test(r.id)) add('error', 'bad-id', r.id, `Requirement at line ${r.line} has ID "${r.id}"`, 'Use an ID like R-001 (R-, then three or more digits)');
    seen.set(r.id, (seen.get(r.id) || 0) + 1);
    if (seen.get(r.id) > 1) add('error', 'duplicate-id', r.id, `ID ${r.id} is used more than once`, 'Give each requirement a unique ID');
    if (!r.acceptance.length) add('error', 'missing-acceptance', r.id, `${r.id} has no acceptance criteria`, 'Add an Acceptance: list with testable checks');
    const hits = new Set();
    for (const s of [r.text, ...r.acceptance]) {
      if (/\d/.test(s)) continue;
      for (const w of UNTESTABLE) if (new RegExp('\\b' + w + '\\b', 'i').test(s)) hits.add(w);
    }
    if (hits.size) add('warn', 'untestable-wording', r.id, `${r.id} uses vague wording: ${[...hits].join(', ')}`, 'Replace with a measurable check, or add a number');
    if (!stageIds.has(r.stage)) add('error', 'unknown-stage', r.id, `${r.id} is under stage ${r.stage}, which is not listed`, 'List the stage under ## Stages or move the requirement');
  }
  scope.stages.forEach((s, i) => {
    if (s.id !== 'S' + (i + 1)) add('error', 'bad-stage-order', s.id, `Stage ${s.id} is at position ${i + 1}; expected S${i + 1}`, 'Renumber stages S1..Sn in build order');
  });
  if (!scope.requirements.length) add('error', 'no-requirements', null, 'The scope has no requirements', 'Add ### R-NNN requirements under stage headings');
  return { ok: !findings.some(f => f.level === 'error'), findings };
}

export function requirementText(scope, id) {
  const r = (scope.requirements ?? []).find(x => x.id === id);
  return r ? { text: r.text, acceptance: [...r.acceptance] } : null;
}

export function scopeHash(markdown) {
  const norm = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isSensitiveText(scope, text) {
  if (typeof text !== 'string' || !Array.isArray(scope?.sensitive)) return false;
  for (const entry of scope.sensitive) {
    if (typeof entry !== 'string') continue;
    const phrase = entry.trim();
    if (!phrase) continue;
    const words = phrase.split(/\s+/);
    const candidates = [phrase];
    if (words.length > 1) for (const w of words) if (w.length >= 3) candidates.push(w);
    for (const c of candidates) {
      const body = c.split(/\s+/).map(escapeRegExp).join('\\s+');
      if (new RegExp('(?<![\\p{L}\\p{N}_])' + body + '(?![\\p{L}\\p{N}_])', 'iu').test(text)) return true;
    }
  }
  return false;
}
