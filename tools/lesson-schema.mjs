import { scanSecrets } from './security-scan.mjs';

export const STAGES = Object.freeze(['scope', 'split', 'build', 'test', 'review', 'merge', 'integration', 'deploy']);
export const CAUGHT_BY = Object.freeze(['test', 'review', 'merge-check', 'owner', 'production', 'missed', 'unknown']);
export const GUARD_KINDS = Object.freeze(['scope-rule', 'lint', 'test-template', 'contract-test', 'router-rule', 'review-item', 'prompt-rule', 'none']);
export const GUARD_STATUSES = Object.freeze(['proposed', 'built', 'shipped', 'dropped']);

const TOP_KEYS = ['version', 'id', 'project', 'date', 'ticket', 'requirement', 'stage', 'what', 'rule', 'caughtBy', 'cost', 'laneModel', 'fix', 'guard', 'tags', 'files', 'source'];
const COST_KEYS = ['retries', 'minutes', 'usd'];
const GUARD_KEYS = ['kind', 'text', 'status', 'ref'];
const SOURCE_KEYS = ['kind', 'ref'];
const SOURCE_KINDS = ['manual', 'auto', 'backfill'];

const ID_RE = /^L-\d{4,}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_PW_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:[^\s\/@]+@/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HOME_RE = /\/Users\/[^\s\/]+|\/home\/[^\s\/]+|[A-Za-z]:[\\\/]Users[\\\/][^\s\\\/]+/gi;
const IP_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
const RUN_RE = /\d{13}-[0-9A-Fa-f]{8}/g;
const HEX_RE = /[A-Fa-f0-9]{32,}/g;
const B64_RE = /[A-Za-z0-9+\/=_-]{40,}/g;
const FORMAT_RE = /\p{Cf}/gu;
const ALLOWED_IP = new Set(['127.0.0.1', '0.0.0.0']);

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const matches = (v, re) => typeof v === 'string' && re.test(v);
const validDate = (v) => {
  if (!matches(v, DATE_RE)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const normalizeText = (text) => text.normalize('NFKC').replace(FORMAT_RE, '');
const hasSecret = (text) => scanSecrets([{ path: 'text', content: text }]).length > 0;
const isMixed = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
const isB64Token = (m) => m.length >= 40 && isMixed(m);

function textLen(value, min, max, field, errors) {
  if (typeof value !== 'string') { errors.push(`${field} must be a string`); return; }
  const n = value.trim().length;
  if (n < min || n > max) errors.push(`${field} must be ${min} to ${max} characters`);
}

function checkUnknown(obj, keys, where, errors) {
  const n = Object.keys(obj).filter((k) => !keys.includes(k)).length;
  if (n) errors.push(`${n} unknown key${n === 1 ? '' : 's'} in ${where}`);
}

function kindsIn(text, kinds) {
  if (hasSecret(text)) kinds.add('secret');
  if (text.match(URL_PW_RE)) kinds.add('url');
  if (text.match(EMAIL_RE)) kinds.add('email');
  if (text.match(HOME_RE)) kinds.add('home');
  if (text.match(RUN_RE)) kinds.add('run-id');
  if ((text.match(IP_RE) || []).some((ip) => !ALLOWED_IP.has(ip))) kinds.add('ip');
  if (text.match(HEX_RE) || (text.match(B64_RE) || []).some(isB64Token)) kinds.add('token');
  return kinds;
}

export function findUnsafeText(text) {
  if (typeof text !== 'string' || !text) return [];
  const norm = normalizeText(text);
  const kinds = new Set();
  kindsIn(norm, kinds);
  // A copy with the whitespace removed catches a token or an address split by spaces; only the narrow kinds run on it,
  // because joined prose would trip the broad token rules.
  const joined = norm.replace(/\s+/g, '');
  if (joined.match(EMAIL_RE)) kinds.add('email');
  if (joined.match(RUN_RE)) kinds.add('run-id');
  if (joined.match(HEX_RE)) kinds.add('token');
  return [...kinds].map((kind) => ({ kind }));
}

export function redactText(text) {
  if (typeof text !== 'string') return text;
  try {
    if (findUnsafeText(text).length === 0) return text;
    const norm = normalizeText(text);
    let out = norm.replace(URL_PW_RE, (m) => (hasSecret(m) ? m : '<token>'));
    out = out.replace(EMAIL_RE, '<email>');
    out = out.replace(HOME_RE, '<home>');
    out = out.replace(RUN_RE, '<run-id>');
    out = out.replace(IP_RE, (ip) => (ALLOWED_IP.has(ip) ? ip : '<ip>'));
    out = out.replace(B64_RE, (m) => (isB64Token(m) && !hasSecret(m) ? '<token>' : m));
    out = out.replace(HEX_RE, (m) => (hasSecret(m) ? m : '<token>'));
    return out;
  } catch {
    return text;
  }
}

function checkCost(cost, errors) {
  if (!isObj(cost)) { errors.push('cost must be an object'); return; }
  checkUnknown(cost, COST_KEYS, 'cost', errors);
  if (!Number.isInteger(cost.retries) || cost.retries < 0) errors.push('cost.retries must be an integer >= 0');
  for (const k of ['minutes', 'usd']) {
    if (typeof cost[k] !== 'number' || !Number.isFinite(cost[k]) || cost[k] < 0) errors.push(`cost.${k} must be a number >= 0`);
  }
}

function checkFile(f) {
  if (typeof f !== 'string' || !f.trim()) return false;
  if (f.startsWith('/') || /^[A-Za-z]:/.test(f)) return false;
  if (f.includes(String.fromCharCode(92))) return false;
  return !f.split('/').includes('..');
}

export function validateLesson(lesson) {
  const errors = [];
  if (!isObj(lesson)) return { ok: false, errors: ['lesson must be an object'] };
  checkUnknown(lesson, TOP_KEYS, 'lesson', errors);
  if (lesson.version !== 1) errors.push('version must be 1');
  if (!matches(lesson.id, ID_RE)) errors.push('id must look like L-0001');
  if (!matches(lesson.project, PROJECT_RE)) errors.push('project is invalid');
  if (!validDate(lesson.date)) errors.push('date must be YYYY-MM-DD');
  for (const k of ['ticket', 'requirement']) {
    if (lesson[k] !== undefined) textLen(lesson[k], 1, 40, k, errors);
  }
  if (!STAGES.includes(lesson.stage)) errors.push('stage is invalid');
  textLen(lesson.what, 1, 600, 'what', errors);
  textLen(lesson.rule, 1, 300, 'rule', errors);
  if (typeof lesson.rule === 'string' && /[\r\n]/.test(lesson.rule.trim())) errors.push('rule must be one line');
  if (!CAUGHT_BY.includes(lesson.caughtBy)) errors.push('caughtBy is invalid');
  checkCost(lesson.cost, errors);
  if (lesson.laneModel !== null) textLen(lesson.laneModel, 1, 80, 'laneModel', errors);
  textLen(lesson.fix, 0, 600, 'fix', errors);
  if (!isObj(lesson.guard)) {
    errors.push('guard must be an object');
  } else {
    checkUnknown(lesson.guard, GUARD_KEYS, 'guard', errors);
    if (!GUARD_KINDS.includes(lesson.guard.kind)) errors.push('guard.kind is invalid');
    textLen(lesson.guard.text, 0, 300, 'guard.text', errors);
    if (!GUARD_STATUSES.includes(lesson.guard.status)) errors.push('guard.status is invalid');
    if (lesson.guard.ref !== undefined) textLen(lesson.guard.ref, 0, 120, 'guard.ref', errors);
  }
  if (!Array.isArray(lesson.tags) || lesson.tags.length < 1 || lesson.tags.length > 12) {
    errors.push('tags must be 1 to 12 entries');
  } else if (!lesson.tags.every((t) => typeof t === 'string' && TAG_RE.test(t) && t.length >= 2 && t.length <= 40)) {
    errors.push('tags contain an invalid entry');
  }
  if (lesson.files !== undefined) {
    if (!Array.isArray(lesson.files) || lesson.files.length > 10) errors.push('files must be up to 10 entries');
    else if (!lesson.files.every(checkFile)) errors.push('files contain an invalid path');
  }
  if (!isObj(lesson.source)) {
    errors.push('source must be an object');
  } else {
    checkUnknown(lesson.source, SOURCE_KEYS, 'source', errors);
    if (!SOURCE_KINDS.includes(lesson.source.kind)) errors.push('source.kind is invalid');
    if (lesson.source.ref !== undefined) textLen(lesson.source.ref, 0, 120, 'source.ref', errors);
  }
  const textFields = [
    ['project', lesson.project], ['id', lesson.id], ['date', lesson.date],
    ['ticket', lesson.ticket], ['requirement', lesson.requirement],
    ['what', lesson.what], ['rule', lesson.rule], ['fix', lesson.fix], ['laneModel', lesson.laneModel],
    ['guard.text', lesson.guard?.text], ['guard.ref', lesson.guard?.ref], ['source.ref', lesson.source?.ref]
  ];
  if (Array.isArray(lesson.tags)) for (const t of lesson.tags) textFields.push(['tags', t]);
  if (Array.isArray(lesson.files)) for (const f of lesson.files) textFields.push(['files', f]);
  for (const [field, value] of textFields) {
    for (const { kind } of findUnsafeText(value)) errors.push(`${field} contains unsafe ${kind}`);
  }
  const joined = textFields.map(([, v]) => (typeof v === 'string' ? v : '')).join('\n');
  for (const { kind } of findUnsafeText(joined)) {
    const msg = `text contains unsafe ${kind}`;
    if (!errors.includes(msg)) errors.push(msg);
  }
  return { ok: errors.length === 0, errors };
}

export function lessonPath(project, id) {
  if (!matches(project, PROJECT_RE) || !matches(id, ID_RE)) {
    const err = new Error('invalid project or lesson id');
    err.code = 'lesson-id';
    throw err;
  }
  return `lessons/${project}/${id}.json`;
}

export function normalizeLesson(raw) {
  if (!isObj(raw)) throw new TypeError('lesson must be an object');
  const trim = (v) => (typeof v === 'string' ? v.trim() : v);
  const cost = isObj(raw.cost) ? raw.cost : {};
  const guard = isObj(raw.guard) ? raw.guard : {};
  const source = isObj(raw.source) ? raw.source : {};
  const tags = Array.isArray(raw.tags) ? [...new Set(raw.tags.map(trim))].sort() : [];
  const out = {
    version: raw.version ?? 1,
    id: trim(raw.id),
    project: trim(raw.project),
    date: trim(raw.date)
  };
  if (raw.ticket !== undefined) out.ticket = trim(raw.ticket);
  if (raw.requirement !== undefined) out.requirement = trim(raw.requirement);
  out.stage = trim(raw.stage);
  out.what = trim(raw.what);
  out.rule = trim(raw.rule);
  out.caughtBy = trim(raw.caughtBy);
  out.cost = { retries: cost.retries ?? 0, minutes: cost.minutes ?? 0, usd: cost.usd ?? 0 };
  out.laneModel = raw.laneModel == null ? null : trim(raw.laneModel);
  out.fix = raw.fix == null ? '' : trim(raw.fix);
  out.guard = {
    kind: guard.kind ?? 'none',
    text: guard.text == null ? '' : trim(guard.text),
    status: guard.status ?? 'proposed'
  };
  if (guard.ref !== undefined) out.guard.ref = trim(guard.ref);
  out.tags = tags;
  if (raw.files !== undefined) out.files = Array.isArray(raw.files) ? raw.files.map(trim) : raw.files;
  out.source = { kind: source.kind ?? 'manual' };
  if (source.ref !== undefined) out.source.ref = trim(source.ref);
  return out;
}
