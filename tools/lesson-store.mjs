// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { validateLesson, lessonPath, normalizeLesson } from './lesson-schema.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

const MAX_BYTES = 64 * 1024;
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILE_RE = /^L-([0-9]{4,})[.]json$/;

const fail = (code, message) => Object.assign(new Error(message), { code });
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const lower = v => String(v ?? '').toLowerCase();

async function lstatOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readCapped(full) {
  const handle = await fs.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { skip: true };
    if (st.size > MAX_BYTES) return { tooLarge: true };
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_BYTES) return { tooLarge: true };
    return { text: buf.subarray(0, filled).toString('utf8') };
  } finally {
    await handle.close();
  }
}

async function readProject(folder, project, relDir, lessons, invalid) {
  const entries = (await fs.readdir(folder, { withFileTypes: true })).sort(byName);
  for (const entry of entries) {
    const file = `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      invalid.push({ file, errors: ['symlink'] });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const full = path.join(folder, entry.name);
    let read;
    try {
      read = await readCapped(full);
    } catch (error) {
      if (error.code === 'ELOOP') {
        invalid.push({ file, errors: ['symlink'] });
        continue;
      }
      throw error;
    }
    if (read.skip) continue;
    if (read.tooLarge) {
      invalid.push({ file, errors: ['too-large'] });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      invalid.push({ file, errors: ['not valid JSON'] });
      continue;
    }
    const check = validateLesson(parsed);
    if (!check.ok) {
      invalid.push({ file, errors: check.errors });
      continue;
    }
    const errors = [];
    if (`${parsed.id}.json` !== entry.name) errors.push('id-mismatch');
    if (parsed.project !== project) errors.push('project-mismatch');
    if (errors.length > 0) {
      invalid.push({ file, errors });
      continue;
    }
    lessons.push(parsed);
  }
}

export async function listLessons(root, { project, dir = 'lessons' } = {}) {
  if (project !== undefined && !PROJECT_RE.test(project)) throw fail('lesson-id', `bad project: ${project}`);
  const lessons = [];
  const invalid = [];
  const base = path.join(root, dir);
  const baseStat = await lstatOrNull(base);
  if (!baseStat) return { lessons, invalid };
  if (baseStat.isSymbolicLink()) return { lessons, invalid: [{ file: dir, errors: ['symlink'] }] };
  if (!baseStat.isDirectory()) return { lessons, invalid };
  const entries = (await fs.readdir(base, { withFileTypes: true })).sort(byName);
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      invalid.push({ file: rel, errors: ['symlink'] });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (project !== undefined && entry.name !== project) continue;
    await readProject(path.join(base, entry.name), entry.name, rel, lessons, invalid);
  }
  lessons.sort(byId);
  return { lessons, invalid };
}

export async function readLessons(roots = []) {
  const seen = new Map();
  for (const root of roots) {
    const { lessons } = await listLessons(root);
    for (const lesson of lessons) {
      const key = `${lesson.project}/${lesson.id}`;
      if (!seen.has(key)) seen.set(key, lesson);
    }
  }
  return [...seen.values()];
}

export async function nextLessonId(root, { project, dir = 'lessons' } = {}) {
  lessonPath(project, 'L-0001');
  const folder = path.join(root, dir, project);
  let names;
  try {
    names = await fs.readdir(folder);
  } catch (error) {
    if (error.code === 'ENOENT') names = [];
    else throw error;
  }
  let max = 0;
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `L-${String(max + 1).padStart(4, '0')}`;
}

export async function writeLesson(root, lesson, { dir = 'lessons', overwrite = false } = {}) {
  const norm = normalizeLesson(lesson);
  const check = validateLesson(norm);
  if (!check.ok) throw fail('lesson-invalid', check.errors[0]);
  lessonPath(norm.project, norm.id);
  const folder = await safeWritableDir(root, [dir, norm.project]);
  const file = path.join(folder, `${norm.id}.json`);
  await assertRegularOrMissing(file);
  const tmp = path.join(folder, `.${norm.id}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(norm, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    if (overwrite) {
      await fs.rename(tmp, file);
    } else {
      await fs.link(tmp, file).catch(error => {
        if (error.code === 'EEXIST') throw fail('lesson-exists', `${norm.id} already exists in ${norm.project}`);
        throw error;
      });
    }
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return path.posix.join(dir, norm.project, `${norm.id}.json`);
}

export function filterLessons(lessons, { stage, tag, caughtBy, project, text } = {}) {
  const needle = text === undefined || text === null || text === '' ? null : lower(text);
  return lessons.filter(l =>
    (!stage || l.stage === stage) &&
    (!tag || (l.tags ?? []).includes(tag)) &&
    (!caughtBy || l.caughtBy === caughtBy) &&
    (!project || l.project === project) &&
    (!needle || [l.what, l.rule, l.fix].some(s => lower(s).includes(needle))));
}

export function lessonStats(lessons) {
  const byStage = {};
  const byCaughtBy = {};
  const tagCounts = new Map();
  let missed = 0;
  for (const l of lessons) {
    byStage[l.stage] = (byStage[l.stage] ?? 0) + 1;
    byCaughtBy[l.caughtBy] = (byCaughtBy[l.caughtBy] ?? 0) + 1;
    if (l.caughtBy === 'missed' || l.caughtBy === 'production') missed++;
    for (const tag of new Set(l.tags ?? [])) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const byTag = [...tagCounts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 20);
  return { total: lessons.length, byStage, byCaughtBy, byTag, missed };
}
