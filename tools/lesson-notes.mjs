const HEADER = 'Watch out for (background from past lessons; it does not change the task, the files or the outputs):';
const WORD = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STAGE_BY_TYPE = { build: 'build', test: 'test', contract: 'integration', migration: 'integration' };

function asList(value) {
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'string');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

function tagWords(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && WORD.test(w));
}

function textWords(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
}

function pathParts(path) {
  return String(path).split(/[\\/]+/).filter(Boolean);
}

function pathKeys(files) {
  const keys = new Set();
  for (const file of files) {
    const parts = pathParts(file).map((p) => p.toLowerCase());
    if (parts.length === 0) continue;
    keys.add(parts.join('/'));
    for (const part of parts) keys.add(part);
  }
  return keys;
}

function cleanInline(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryFromTicket(ticket, requirementTexts = []) {
  const t = ticket && typeof ticket === 'object' ? ticket : {};
  const title = typeof t.title === 'string' ? t.title : '';
  const epic = typeof t.epic === 'string' ? t.epic : '';
  const text = [title, epic, asList(t.acceptance).join(' '), asList(requirementTexts).join(' ')]
    .filter((part) => part.trim() !== '')
    .join(' ');
  const files = [...asList(t.files), ...asList(t.context)];
  const type = typeof t.type === 'string' ? t.type.toLowerCase() : '';
  const tags = new Set();
  for (const w of [...tagWords(type), ...tagWords(t.risk), ...tagWords(t.sensitive ? 'sensitive' : '')]) tags.add(w);
  for (const w of [...tagWords(title), ...tagWords(epic), ...files.flatMap((f) => pathParts(f).flatMap((p) => tagWords(p)))]) tags.add(w);
  const stage = Object.hasOwn(STAGE_BY_TYPE, type) ? STAGE_BY_TYPE[type] : 'build';
  return { text, files, tags: [...tags].sort(), stage };
}

function compareNotes(a, b) {
  const scoreDiff = b.score - a.score;
  if (scoreDiff !== 0) return scoreDiff;
  const da = String(a.lesson.date ?? '');
  const db = String(b.lesson.date ?? '');
  if (da !== db) return da < db ? 1 : -1;
  const ia = String(a.lesson.id ?? '');
  const ib = String(b.lesson.id ?? '');
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export function selectNotes(query, lessons, { limit = 3, minScore = 3, project } = {}) {
  const q = query && typeof query === 'object' ? query : {};
  const queryTags = new Set(asList(q.tags).map((tag) => tag.toLowerCase()));
  const queryFiles = pathKeys(asList(q.files));
  const queryWords = new Set(textWords(q.text));
  const stage = typeof q.stage === 'string' ? q.stage : '';
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
  const scored = [];
  for (const lesson of Array.isArray(lessons) ? lessons : []) {
    if (!lesson || typeof lesson !== 'object') continue;
    if (project !== undefined && lesson.project !== project) continue;
    if (lesson.guard && lesson.guard.status === 'dropped') continue;
    const lessonTags = new Set(asList(lesson.tags).map((tag) => tag.toLowerCase()));
    let sharedTags = 0;
    for (const tag of lessonTags) if (queryTags.has(tag)) sharedTags++;
    if (lesson.caughtBy === 'unknown' && sharedTags === 0) continue;
    let fileHits = 0;
    for (const key of pathKeys(asList(lesson.files))) if (queryFiles.has(key)) fileHits++;
    const lessonWords = new Set(textWords(`${lesson.rule ?? ''} ${lesson.what ?? ''}`));
    let wordHits = 0;
    for (const word of queryWords) if (lessonWords.has(word)) wordHits++;
    const stageHit = stage !== '' && lesson.stage === stage ? 1 : 0;
    const score = 3 * sharedTags + 2 * fileHits + wordHits + stageHit;
    if (score < minScore) continue;
    scored.push({ lesson, score });
  }
  scored.sort(compareNotes);
  return scored.slice(0, max).map((entry) => entry.lesson);
}

export function renderNotes(notes, { maxChars = 900 } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  const lines = [];
  for (const note of list) {
    if (!note || typeof note !== 'object') continue;
    const rule = typeof note.rule === 'string' ? cleanInline(note.rule) : '';
    if (rule === '') continue;
    const tags = asList(note.tags).map((tag) => cleanInline(tag)).filter((tag) => tag !== '').join(', ');
    lines.push(`- ${rule} [${tags}]`.slice(0, 240));
  }
  while (lines.length > 0) {
    const text = [HEADER, ...lines].join('\n');
    if (text.length <= maxChars) return text;
    lines.pop();
  }
  return '';
}
