// SPDX-License-Identifier: Apache-2.0
// swarm scope new [--type web-portal] [--out FILE] [--answers FILE]: a structured interview that writes the scope file (requirement IDs, stages, acceptance lines).
// No model is used and nothing is spent: the questions are fixed, the answers are the owner's own words, and the scope is built from them by plain code.
// What the starter kit already provides is listed in its own section, so no ticket is made for it.
import { parseScope, checkScope } from './scope.mjs';

const MAX_FEATURES = 12;
const MAX_ACCEPT = 4;
// One line of plain text: every kind of line break and control character becomes a space (including NEL and the Unicode line and paragraph separators).
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const APP_TYPES = {
  'web-portal': {
    label: 'web portal (the web-portal starter kit)',
    roles: ['customer', 'staff', 'admin'],
    kitProvides: [
      'Sign-in by email link, sessions, and the roles customer, staff and admin',
      'Page layout, navigation and the design system (navy and lime)',
      'Forms with field errors, and sortable searchable tables',
      'An admin panel to list people and change their role',
      'Error tracking to the app\'s own table, CI (typecheck, lint, tests, build) and the deploy setup',
    ],
    optionalKit: { email: 'Email sending (Resend) with safe templates', uploads: 'File upload with type, size and name rules', payments: 'Payments in the provider\'s test mode, with a checked webhook' },
    services: { email: 'Resend: email', payments: 'Stripe: payments (test mode first)', uploads: 'Supabase storage: file uploads' },
    always: ['Supabase: sign-in, database and storage', 'Vercel: hosting and preview deploys'],
  },
};

export const appTypes = () => Object.keys(APP_TYPES);

/** The questions, in order. `ask(question, { hint })` returns the person's answer as text. */
export const QUESTIONS = {
  name: 'What is the product called?',
  summary: 'In one or two sentences: what does it do, and who is it for?',
  roles: 'Who signs in? Choose from customer, staff, admin (comma separated)',
  feature: 'Feature {n}: write it as "WHO can DO WHAT" (for example: A customer can request a quote). Press Enter to finish.',
  accept: 'How will you know it works? Give 1 to 3 checks, one per line, with a number where you can (for example: the quote email arrives within 2 minutes). Press Enter on an empty line to finish.',
  payments: 'Does it take payments? (y/N)',
  email: 'Does it send email to people? (y/N)',
  uploads: 'Can people upload files? (y/N)',
  other: 'Any other outside services (comma separated, or Enter for none)?',
  sensitive: 'Does it hold personal, payment or login data? (y/N)',
  outOfScope: 'Anything that is clearly NOT part of this first version? (one sentence, or Enter for none)',
};

const yes = v => /^y(es)?$/i.test(String(v ?? '').trim());

export function validateAnswers(raw, type = 'web-portal') {
  const def = APP_TYPES[type];
  const errors = [];
  if (!def) return { ok: false, errors: [`unknown app type "${type}" (known: ${appTypes().join(', ')})`], answers: null };
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = clean(a.name, 80);
  if (!name) errors.push('name: the product needs a name');
  const summary = clean(a.summary, 400);
  if (!summary) errors.push('summary: say in a sentence what it does and who it is for');
  const roles = [...new Set((Array.isArray(a.roles) ? a.roles : String(a.roles ?? '').split(',')).map(r => clean(r, 20).toLowerCase()).filter(Boolean))];
  for (const r of roles) if (!def.roles.includes(r)) errors.push(`roles: "${r}" is not one of ${def.roles.join(', ')}`);
  if (!roles.length) roles.push('customer', 'admin');
  const features = [];
  const list = Array.isArray(a.features) ? a.features : [];
  if (list.length > MAX_FEATURES) errors.push(`features: at most ${MAX_FEATURES} for a first scope (more belong in a later stage)`);
  list.slice(0, MAX_FEATURES).forEach((f, i) => {
    const text = clean(typeof f === 'string' ? f : f?.text, 200);
    if (!/^.{2,}\s+can\s+.{3,}$/i.test(text)) { errors.push(`features[${i + 1}]: write it as "WHO can DO WHAT"`); return; }
    const accept = (Array.isArray(f?.accept) ? f.accept : []).map(x => clean(x, 200)).filter(Boolean).slice(0, MAX_ACCEPT);
    if (!accept.length) errors.push(`features[${i + 1}]: give at least one check for "${text}"`);
    const stage = Number.isInteger(f?.stage) && f.stage >= 1 && f.stage <= 6 ? f.stage : null;
    features.push({ text: text.replace(/\.$/, ''), accept, stage });
  });
  if (!features.length) errors.push('features: list at least one thing people can do');
  const flag = k => a[k] === true || yes(a[k]);
  const other = (Array.isArray(a.other) ? a.other : String(a.other ?? '').split(',')).map(x => clean(x, 60)).filter(Boolean).slice(0, 8);
  return { ok: errors.length === 0, errors, answers: { name, summary, roles, features, payments: flag('payments'), email: flag('email'), uploads: flag('uploads'), sensitive: flag('sensitive'), other, outOfScope: clean(a.outOfScope, 300) } };
}

// Features go into stages in the order given: a stage holds up to four, unless the person chose a stage for it.
function assignStages(features) {
  let auto = 0;
  return features.map(f => (f.stage ? { ...f, stageNo: f.stage } : { ...f, stageNo: Math.floor(auto++ / 4) + 1 }));
}

export function buildScope(answers, type = 'web-portal') {
  const def = APP_TYPES[type];
  const feats = assignStages(answers.features);
  const stageNos = [...new Set(feats.map(f => f.stageNo))].sort((x, y) => x - y);
  // Stages are numbered S1..Sn without gaps (the scope checker requires it).
  const stageOf = new Map(stageNos.map((n, i) => [n, i + 1]));
  const L = ['# Scope: ' + answers.name, 'Version: 1', '', '## Overview', `Summary: ${answers.summary}`, `Who signs in: ${answers.roles.join(', ')}.`, ...(answers.outOfScope ? [`Not in the first version: ${answers.outOfScope}`] : []), '', '## Stages'];
  stageNos.forEach((n, i) => L.push(`- S${i + 1}: ${i === 0 ? 'First release' : `Release ${i + 1}`}`));
  L.push('');
  let id = 0;
  for (const n of stageNos) {
    L.push(`## S${stageOf.get(n)} ${stageOf.get(n) === 1 ? 'First release' : `Release ${stageOf.get(n)}`}`);
    for (const f of feats.filter(x => x.stageNo === n)) {
      id += 1;
      L.push(`### R-${String(id).padStart(3, '0')} ${f.text}.`, 'Acceptance:', ...f.accept.map(x => `- ${x.replace(/^[-*]\s*/, '')}`), '');
    }
  }
  L.push('## Provided by the kit', ...def.kitProvides.map(x => `- ${x}`));
  for (const k of ['email', 'uploads', 'payments']) if (answers[k]) L.push(`- ${def.optionalKit[k]}`);
  L.push('', '## External', ...def.always.map(x => `- ${x}`));
  for (const k of ['email', 'uploads', 'payments']) if (answers[k]) L.push(`- ${def.services[k]}`);
  for (const o of answers.other) L.push(`- ${o}: (what it is used for)`);
  L.push('', '## Sensitive', ...(answers.sensitive || answers.payments ? [answers.payments ? '- payments' : null, '- customer data, sign-in'].filter(Boolean) : ['- sign-in']), '', '## Protected', '- .env', '');
  return L.join('\n');
}

/** Asks the questions in order. `ask(question)` returns text ('' for Enter); `ask` returning null means the input ended. */
export async function runInterview(ask, type = 'web-portal') {
  const def = APP_TYPES[type];
  const a = { features: [] };
  const q = async (text) => { const r = await ask(text); return r === null ? null : String(r); };
  a.name = await q(QUESTIONS.name); if (a.name === null) return null;
  a.summary = await q(QUESTIONS.summary);
  a.roles = await q(`${QUESTIONS.roles} [${def.roles.join(', ')}]`);
  let again = '';
  for (let n = 1; n <= MAX_FEATURES; n += 1) {
    const text = await q(again + QUESTIONS.feature.replace('{n}', String(n)));
    if (!text || !text.trim()) break;
    if (!/^.{2,}\s+can\s+.{3,}$/i.test(text.trim())) { n -= 1; again = 'Please write it as "WHO can DO WHAT", for example: A customer can request a quote.\n'; continue; }
    again = '';
    const accept = [];
    for (let k = 0; k < MAX_ACCEPT; k += 1) { const line = await q(k === 0 ? QUESTIONS.accept : '  another check (Enter to finish)'); if (!line || !line.trim()) break; accept.push(line); }
    a.features.push({ text, accept });
  }
  for (const k of ['payments', 'email', 'uploads']) a[k] = await q(QUESTIONS[k]);
  a.other = await q(QUESTIONS.other);
  a.sensitive = await q(QUESTIONS.sensitive);
  a.outOfScope = await q(QUESTIONS.outOfScope);
  return a;
}

/** The scope text for validated answers, plus what the scope checker says about it (vague words, missing checks). */
export function scopeFromAnswers(raw, type = 'web-portal') {
  const v = validateAnswers(raw, type);
  if (!v.ok) return { ok: false, errors: v.errors };
  const text = buildScope(v.answers, type);
  const check = checkScope(parseScope(text));
  return { ok: true, text, findings: check.findings, requirements: parseScope(text).requirements.length };
}
