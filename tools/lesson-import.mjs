// SPDX-License-Identifier: Apache-2.0
// `swarm lessons import <project-path>`: bring another project's lessons (its coordination/swarm-lessons.jsonl) into lessons/<project>/.
// The other project is only READ: one regular file, size capped, never written to. Only the lesson text is copied (redacted by the same
// rules as every lesson); no app code, no files, nothing else from that project.
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { lessonsFromStore, parseStoreRows, stageFor, tagsFor } from './lesson-backfill.mjs';
import { listLessons, writeLesson } from './lesson-store.mjs';
import { validateLesson } from './lesson-schema.mjs';

export const IMPORT_FILE = path.join('coordination', 'swarm-lessons.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_LIMIT = 5000;

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const norm = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function projectNameFor(projectPath) {
  return path.basename(path.resolve(projectPath)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Reads the other project's lessons file: the coordination folder and the file must be real (no symlink anywhere on the way), the file is opened
// once without following a link, and the size is checked on that open handle (not on a path that could change) before and while reading.
export async function readProjectLessons(projectPath) {
  const dir = await fs.realpath(path.resolve(projectPath)).catch(() => { throw fail('import-path', `${projectPath} is not a folder`); });
  if (!(await fs.stat(dir)).isDirectory()) throw fail('import-path', `${projectPath} is not a folder`);
  const folder = path.join(dir, path.dirname(IMPORT_FILE));
  let folderInfo;
  try { folderInfo = await fs.lstat(folder); } catch (error) { if (error.code === 'ENOENT') throw fail('import-missing', `${IMPORT_FILE} not found in ${projectPath}`); throw error; }
  if (folderInfo.isSymbolicLink() || !folderInfo.isDirectory()) throw fail('import-path', `${path.dirname(IMPORT_FILE)} is not a plain folder (a symlink is refused)`);
  let handle;
  try {
    handle = await fs.open(path.join(dir, IMPORT_FILE), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('import-missing', `${IMPORT_FILE} not found in ${projectPath}`);
    if (error.code === 'ELOOP') throw fail('import-path', `${IMPORT_FILE} is not a regular file (a symlink is refused)`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail('import-path', `${IMPORT_FILE} is not a regular file`);
    if (info.size > MAX_BYTES) throw fail('import-too-large', `${IMPORT_FILE} is larger than ${MAX_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_BYTES) throw fail('import-too-large', `${IMPORT_FILE} is larger than ${MAX_BYTES} bytes`);
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Returns {written, skipped, failed, total, project}. A row is skipped when its id already exists for the project or an existing lesson has the
// same rule text; a row that cannot become a valid lesson (or carries a secret that redaction cannot fix) is listed in failed and never written.
export async function importLessons(root, projectPath, { project, dryRun = false, dir = 'lessons', date } = {}) {
  if (project !== undefined && typeof project !== 'string') throw fail('import-project', '--project needs a name');
  const name = project ?? projectNameFor(projectPath);
  if (!PROJECT_RE.test(name)) throw fail('import-project', `"${name}" is not a usable project name (use --project)`);
  if (name === 'swarm') throw fail('import-project', 'the name "swarm" is the swarm\'s own lessons; use --project for the other project');
  const text = await readProjectLessons(projectPath);
  const parsed = parseStoreRows(text);
  if (parsed.rows.length + parsed.failed.length > MAX_ROWS) throw fail('import-too-large', `more than ${MAX_ROWS} rows`);
  const failed = parsed.failed.map(item => ({ ref: item.ref, reason: item.reason }));
  // One hostile row can only fail itself.
  const candidates = parsed.rows.map(row => { try { return lessonsFromStore([row], { project: name, idOffset: 0, date })[0]; } catch (error) { return { ref: 'coordination/swarm-lessons.jsonl#row', lesson: null, warnings: [String(error?.code ?? 'invalid-row')] }; } });
  const listed = await listLessons(root, { project: name, dir });
  const ids = new Set(listed.lessons.map(l => l.id));
  for (const bad of listed.invalid) ids.add(path.basename(String(bad.file ?? ''), '.json'));
  const rules = new Map(listed.lessons.filter(l => norm(l.rule)).map(l => [norm(l.rule), l.id]));
  const seen = new Map();
  for (const item of candidates) if (item.lesson) seen.set(item.lesson.id, (seen.get(item.lesson.id) ?? 0) + 1);
  const written = [];
  const skipped = [];
  const duplicates = [];
  for (const [index, item] of candidates.entries()) {
    const ref = item.ref;
    if (!item.lesson) { failed.push({ ref, reason: item.warnings[0] ?? 'invalid' }); continue; }
    let lesson = item.lesson;
    const rowId = Number(parsed.rows[index]?.id);
    if (!Number.isInteger(rowId) || rowId < 1 || rowId >= ID_LIMIT || seen.get(lesson.id) > 1) { failed.push({ ref, reason: seen.get(lesson.id) > 1 ? 'id-collision' : 'bad-id' }); continue; }
    // An existing id with a different rule is a conflict to look at, never a quiet skip.
    if (ids.has(lesson.id)) {
      const existingRule = listed.lessons.find(l => l.id === lesson.id)?.rule;
      if (existingRule === undefined || norm(existingRule) === norm(lesson.rule)) skipped.push(lesson.id);
      else failed.push({ ref, reason: 'id-conflict' });
      continue;
    }
    const sameRule = norm(lesson.rule) ? rules.get(norm(lesson.rule)) : undefined;
    if (sameRule) { skipped.push(lesson.id); duplicates.push({ id: lesson.id, of: sameRule }); continue; }
    // The row's area says little ("tool" for most): the stage and tags come from the text, as for the swarm's own lessons.
    const area = String(parsed.rows[index].area ?? '').toLowerCase();
    if (area === 'tool' || area === '') {
      const words = `${lesson.what} ${lesson.rule}`;
      const stage = stageFor(words);
      lesson = { ...lesson, stage, tags: tagsFor(`${area} ${words}`, [stage, area]) };
      const checked = validateLesson(lesson);
      if (!checked.ok) { failed.push({ ref, reason: checked.errors[0] ?? 'invalid' }); continue; }
    }
    if (dryRun) { written.push(lesson.id); ids.add(lesson.id); if (norm(lesson.rule)) rules.set(norm(lesson.rule), lesson.id); continue; }
    try { await writeLesson(root, lesson, { dir }); written.push(lesson.id); ids.add(lesson.id); if (norm(lesson.rule)) rules.set(norm(lesson.rule), lesson.id); } catch (error) { failed.push({ ref, reason: error?.code ?? 'write-failed' }); }
  }
  return { project: name, written, skipped, duplicates, failed, total: parsed.rows.length + parsed.failed.length };
}
