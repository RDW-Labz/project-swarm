import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redactText, validateLesson } from './lesson-schema.mjs';
import { writeLesson, listLessons } from './lesson-store.mjs';

const ENTRY_RE = /^(\d+)\. (\S.*)$/;
const BOLD_RE = /^\*\*(.+?)\*\*\s*(.*)$/;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const RULE_LABEL_RE = /\bRule:/;
const RULE_END_RE = /\b(?:Enforcement:|Documentation:|Regression coverage|Test:)/;
const FIX_LABEL_RE = /\b(?:Enforcement|Documentation):/;
const TEST_WORD_RE = /\btests?\b/i;
const GUARD_DONE_RE = /Enforcement:|Documentation:/;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_ID_LIMIT = 5000;

const STAGE_RULES = [
  [/scope|requirement/, 'scope'],
  [/split|ticket/, 'split'],
  [/review/, 'review'],
  [/merge|queue|bisect/, 'merge'],
  [/integrat/, 'integration'],
  [/deploy|release|tag/, 'deploy'],
  [/test|mutant|flake|redcheck/, 'test'],
];

const TAG_RULES = [
  ['mutant', 'mutation-testing'],
  ['flak', 'flaky-test'],
  ['timeout', 'timeout'],
  ['secret', 'secrets'],
  ['symlink', 'symlink'],
  ['path', 'path-safety'],
  ['race', 'race-condition'],
  ['ci', 'ci'],
  ['lane', 'lane-routing'],
  ['rate limit', 'rate-limit'],
  ['lock', 'locking'],
  ['cost', 'spend'],
  ['spend', 'spend'],
  ['review', 'review'],
  ['schema', 'schema'],
  ['manifest', 'manifest'],
  ['worker', 'worker-output'],
  ['prompt', 'prompt'],
  ['retr', 'retries'],
  ['docs', 'documentation'],
  ['sandbox', 'sandbox'],
  ['ssh', 'ssh-remote'],
  ['update', 'updater'],
  ['install', 'installer'],
  ['lint', 'lint'],
  ['regex', 'regex'],
  ['redact', 'redaction'],
  ['eval', 'evals'],
  ['merge', 'merge-queue'],
  ['deploy', 'deploy'],
  ['release', 'release'],
  ['token', 'tokens'],
  ['email', 'privacy'],
];

const STORE_STAGE = {
  tool: 'build',
  process: 'review',
  security: 'merge',
  data: 'build',
  release: 'deploy',
  docs: 'build',
  operations: 'deploy',
  product: 'scope',
};

const STORE_STATUS = { shipped: 'shipped', dropped: 'dropped', built: 'built' };

function today() {
  return new Date().toISOString().slice(0, 10);
}

function lessonId(n) {
  return 'L-' + String(n).padStart(4, '0');
}

function cut(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const win = t.slice(0, max);
  const ends = [...win.matchAll(/[.!?](?=\s|$)/g)];
  if (ends.length) {
    const last = ends[ends.length - 1].index;
    if (last >= 1) return win.slice(0, last + 1).trim();
  }
  return win.trimEnd();
}

function ensureEnd(text, max) {
  const c = cut(text, max);
  if (c && !/[.!?]$/.test(c) && c.length < max) return c + '.';
  return c;
}

function hasWord(lower, kw) {
  let i = lower.indexOf(kw);
  while (i >= 0) {
    if (i === 0 || !/[a-z0-9]/.test(lower[i - 1])) return true;
    i = lower.indexOf(kw, i + 1);
  }
  return false;
}

const upperFirst = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function stageFor(text) {
  const lower = String(text).toLowerCase();
  for (const [re, stage] of STAGE_RULES) {
    if (re.test(lower)) return stage;
  }
  return 'build';
}

export function tagsFor(text, extra) {
  const lower = String(text).toLowerCase();
  const matched = [];
  for (const [kw, tag] of TAG_RULES) {
    if (hasWord(lower, kw)) matched.push(tag);
  }
  const extras = extra.filter((t) => KEBAB_RE.test(t) && t.length >= 2 && t.length <= 40);
  return [...new Set([...extras, ...matched])].slice(0, 12).sort();
}

// The bold title may wrap over several lines, so the entry is joined first. A numbered line without a bold title is not a lesson.
function finishEntry(cur) {
  const joined = cur.parts.join(' ').replace(/\s+/g, ' ').trim();
  const m = BOLD_RE.exec(joined);
  if (!m) return null;
  const title = m[1].replace(LINK_RE, '$1').trim().replace(/\.$/, '').trim();
  const body = m[2].replace(LINK_RE, '$1').replace(/\s+/g, ' ').trim();
  return { number: cur.number, title, body };
}

export function parseFieldLessons(markdown) {
  const out = [];
  let cur = null;
  let blank = false;
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const m = ENTRY_RE.exec(line);
    if (m) {
      if (cur) out.push(finishEntry(cur));
      cur = { number: Number(m[1]), parts: [m[2]] };
      blank = false;
      continue;
    }
    if (!cur) continue;
    if (line.trim() === '') {
      blank = true;
      continue;
    }
    const indented = /^\s/.test(line);
    if (blank && !indented) {
      out.push(finishEntry(cur));
      cur = null;
      blank = false;
      continue;
    }
    cur.parts.push(line.trim());
    blank = false;
  }
  if (cur) out.push(finishEntry(cur));
  return out.filter(Boolean);
}

function finalize(lesson) {
  const notes = [];
  const scrub = (text) => {
    const out = redactText(text);
    if (out !== text) notes.push('redacted');
    return out;
  };
  const red = {
    ...lesson,
    what: cut(scrub(lesson.what), 600),
    rule: ensureEnd(scrub(lesson.rule), 300),
    fix: cut(scrub(lesson.fix), 600),
    guard: { ...lesson.guard, text: cut(scrub(lesson.guard.text), 300) },
  };
  const v = validateLesson(red);
  if (!v.ok) return { lesson: null, warnings: [v.errors[0] ?? 'invalid'] };
  return { lesson: red, warnings: [...new Set(notes)] };
}

export function lessonFromFieldEntry(entry, { project = 'swarm', date, idOffset = 0 } = {}) {
  const n = Number(entry?.number) + idOffset;
  if (!Number.isInteger(n) || n < 0) return { lesson: null, warnings: ['bad-number'] };
  const title = String(entry.title ?? '').trim();
  const body = String(entry.body ?? '').trim();
  const ruleAt = body.search(RULE_LABEL_RE);
  const beforeRule = ruleAt >= 0 ? body.slice(0, ruleAt) : body;
  const what = cut([title ? `${title}.` : '', beforeRule].filter(Boolean).join(' '), 600);
  let rule = '';
  if (ruleAt >= 0) {
    const after = body.slice(ruleAt + 5);
    const end = after.search(RULE_END_RE);
    rule = ensureEnd(upperFirst((end >= 0 ? after.slice(0, end) : after).trim()), 300);
  }
  if (!rule) rule = ensureEnd(title, 300);
  const fixAt = body.search(FIX_LABEL_RE);
  const fix = fixAt >= 0 ? cut(body.slice(fixAt), 600) : '';
  const text = `${title} ${body}`;
  const stage = stageFor(title) !== 'build' ? stageFor(title) : stageFor(body);
  const kind = TEST_WORD_RE.test(body) ? 'test-template' : stage === 'review' ? 'review-item' : 'lint';
  const status = GUARD_DONE_RE.test(body) ? 'shipped' : 'proposed';
  const lesson = {
    version: 1,
    id: lessonId(n),
    project,
    date: date ?? today(),
    stage,
    what,
    rule,
    caughtBy: 'unknown',
    cost: { retries: 0, minutes: 0, usd: 0 },
    laneModel: null,
    fix,
    guard: { kind, text: '', status },
    tags: tagsFor(text, [stage]),
    source: { kind: 'backfill', ref: `docs/lessons.md#${entry.number}` },
  };
  return finalize(lesson);
}

function storeRowToLesson(row, project, idOffset, date) {
  // Only a whole number (or a short digit string) is an id; anything else never reaches the ref or the lesson id.
  const rawId = row?.id;
  const idOk = Number.isInteger(rawId) || (typeof rawId === 'string' && /^[1-9]\d{0,3}$/.test(rawId));
  const ref = `coordination/swarm-lessons.jsonl#${idOk ? Number(rawId) : 'row'}`;
  const n = idOk ? Number(rawId) + idOffset : NaN;
  if (!Number.isInteger(n) || n < 0) return { ref, lesson: null, warnings: ['bad-id'] };
  const area = String(row.area ?? '').toLowerCase();
  const stage = Object.hasOwn(STORE_STAGE, area) ? STORE_STAGE[area] : 'build';
  const evidence = String(row.evidence ?? '');
  const rule = String(row.rule ?? '').trim();
  const testText = typeof row.test === 'string' ? row.test : '';
  const lesson = {
    version: 1,
    id: lessonId(n),
    project,
    date: row.date ?? (date ?? today()),
    stage,
    // Not cut here: finalize redacts the whole text first and cuts after (a cut can split a token below what the detectors see).
    what: evidence,
    rule,
    caughtBy: 'unknown',
    cost: { retries: 0, minutes: 0, usd: 0 },
    laneModel: null,
    fix: String(row.fix ?? ''),
    guard: {
      kind: testText ? 'test-template' : 'none',
      text: testText,
      status: Object.hasOwn(STORE_STATUS, row.status) ? STORE_STATUS[row.status] : 'proposed',
    },
    tags: tagsFor(`${area} ${evidence} ${rule}`, [stage, area]),
    source: { kind: 'backfill', ref },
  };
  return { ref, ...finalize(lesson) };
}

export function lessonsFromStore(rows, { project = 'swarm', idOffset = 5000, date } = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => storeRowToLesson(row, project, idOffset, date));
}

export function parseStoreRows(text) {
  const rows = [];
  const failed = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const ref = `coordination/swarm-lessons.jsonl:${i + 1}`;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      failed.push({ ref, reason: 'invalid-json' });
      return;
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) rows.push(obj);
    else failed.push({ ref, reason: 'not-an-object' });
  });
  return { rows, failed };
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function backfill(root, { project = 'swarm', dir = 'lessons', dryRun = false, date } = {}) {
  const day = date ?? today();
  const written = [];
  const skipped = [];
  const failed = [];
  const fieldText = await readOptional(path.join(root, 'docs', 'lessons.md'));
  const storeText = await readOptional(path.join(root, 'coordination', 'swarm-lessons.jsonl'));
  const candidates = [];
  if (fieldText !== null) {
    for (const entry of parseFieldLessons(fieldText)) {
      const r = lessonFromFieldEntry(entry, { project, date: day });
      candidates.push({ ref: `docs/lessons.md#${entry.number}`, fieldNumber: entry.number, ...r });
    }
  }
  if (storeText !== null) {
    const parsed = parseStoreRows(storeText);
    failed.push(...parsed.failed);
    candidates.push(...lessonsFromStore(parsed.rows, { project, date: day }));
  }
  const total = candidates.length + failed.length;
  const listed = await listLessons(root, { project, dir });
  const existing = new Set(listed.lessons.map((l) => l.id));
  for (const bad of listed.invalid) {
    existing.add(path.basename(String(bad.file ?? ''), '.json'));
  }
  const counts = new Map();
  for (const c of candidates) {
    if (c.lesson) counts.set(c.lesson.id, (counts.get(c.lesson.id) ?? 0) + 1);
  }
  for (const c of candidates) {
    if (!c.lesson) {
      failed.push({ ref: c.ref, reason: c.warnings[0] ?? 'invalid' });
      continue;
    }
    const id = c.lesson.id;
    if (c.fieldNumber >= FIELD_ID_LIMIT || counts.get(id) > 1) {
      failed.push({ ref: c.ref, reason: 'id-collision' });
      continue;
    }
    if (existing.has(id)) {
      skipped.push(id);
      continue;
    }
    if (dryRun) {
      written.push(id);
      continue;
    }
    try {
      await writeLesson(root, c.lesson, { dir });
      written.push(id);
      existing.add(id);
    } catch (err) {
      failed.push({ ref: c.ref, reason: err?.code ?? 'write-failed' });
    }
  }
  return { written, skipped, failed, total };
}
