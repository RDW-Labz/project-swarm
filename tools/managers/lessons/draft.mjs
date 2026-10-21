// SPDX-License-Identifier: Apache-2.0
// Lessons keeper: turn one logged lesson file into a test or rule draft and close it (T-0220).

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  GENERIC_TAGS,
  classifyCluster,
  proposeGuard,
} from '../../lesson-mine.mjs';
import { validateLesson, normalizeLesson, lessonPath } from '../../lesson-schema.mjs';
import { writeLesson } from '../../lesson-store.mjs';
import { safeWritableDir, assertRegularOrMissing } from '../../journal.mjs';

export const LESSON_DRAFT_OUT_DIR = 'coordination/lesson-drafts';

const LINE_MAX = 400;
const MAX_BYTES = 64 * 1024;
const TEST_GUARD_KINDS = new Set(['contract-test', 'test-template']);

const fail = (code, message) => Object.assign(new Error(message), { code });

const tagsOf = (lesson) => (Array.isArray(lesson.tags) ? lesson.tags : []);

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function fit(line) {
  return line.length > LINE_MAX ? line.slice(0, LINE_MAX - 1) + '…' : line;
}

function checkOutDir(outDir) {
  const parts = String(outDir).split('/').filter(Boolean);
  if (path.posix.isAbsolute(String(outDir)) || parts.includes('..') || String(outDir).includes('\\')) {
    throw fail('lesson-draft-dir', 'outDir must be a relative folder');
  }
  return parts;
}

function draftSlug(lesson) {
  const project = String(lesson.project ?? 'lesson').toLowerCase();
  const id = String(lesson.id ?? 'L-0000').toLowerCase();
  const slug = `${project}-${id}`.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug || 'lesson-draft';
}

function clusterForLesson(lesson) {
  const tags = tagsOf(lesson);
  const specific = tags.find((t) => !GENERIC_TAGS.includes(t));
  const key = specific ?? tags[0] ?? lesson.id;
  return {
    key,
    lessonIds: [lesson.id],
    tags,
    stages: { [lesson.stage]: 1 },
    caughtBy: { [lesson.caughtBy]: 1 },
    guardKinds: { [lesson.guard?.kind ?? 'none']: 1 },
  };
}

/**
 * Pick the guard kind for one lesson (respects guard.kind when not `none`).
 *
 * @param {object} lesson
 * @returns {{ kind: string, why: string }}
 */
export function classifyLesson(lesson) {
  const kind = lesson.guard?.kind;
  if (kind && kind !== 'none') {
    return { kind, why: 'lesson guard.kind is already set' };
  }
  return classifyCluster(clusterForLesson(lesson));
}

/**
 * @param {string} kind
 * @returns {'test'|'rule'}
 */
export function lessonDraftArtifact(kind) {
  return TEST_GUARD_KINDS.has(kind) ? 'test' : 'rule';
}

/**
 * @param {object} lesson
 * @returns {object}
 */
export function proposeLessonDraft(lesson) {
  const { kind, why } = classifyLesson(lesson);
  const cluster = clusterForLesson(lesson);
  const base = proposeGuard(cluster, [lesson]);
  const artifact = lessonDraftArtifact(kind);
  return {
    ...base,
    lessonId: lesson.id,
    project: lesson.project,
    artifact,
    why,
    slug: draftSlug(lesson),
  };
}

/**
 * @param {ReturnType<typeof proposeLessonDraft>} proposal
 * @param {{ date?: string }} [options]
 * @returns {string}
 */
export function renderLessonDraft(proposal, { date } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const lines = [
    `# Lesson ${proposal.lessonId}: ${proposal.artifact} draft`,
    '',
    `Project: ${proposal.project}`,
    `Proposed ${proposal.artifact}: ${proposal.kind}`,
    `Why this kind: ${proposal.why}`,
    '',
    proposal.text,
    '',
  ];
  if (proposal.example) {
    lines.push('## Example', `Bad: ${proposal.example.bad}`, `Good: ${proposal.example.good}`, '');
  }
  lines.push(
    'Logged lesson:',
    `- ${proposal.lessonId}: ${clip(proposal.lessons?.[0]?.rule ?? '', 300)}`,
    '',
    `Where to build it: ${proposal.target}`,
    '',
    'Done when:',
    proposal.artifact === 'test'
      ? '- a test fails without the guard and passes with it'
      : '- the rule or check refuses the bad case',
    '- the eval set still passes',
    "- the lesson guard status is set to built",
    '',
    `Proposed by lessons-keeper write-lesson-draft on ${day}. Not merged automatically.`,
  );
  return lines.map(fit).join('\n') + '\n';
}

async function readCappedLessonFile(full) {
  const handle = await fs.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw fail('lesson-path', 'lesson path is not a regular file');
    if (st.size > MAX_BYTES) throw fail('lesson-too-large', 'lesson file is too large');
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_BYTES) throw fail('lesson-too-large', 'lesson file is too large');
    return buf.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<object>}
 */
export async function readLoggedLessonFile(root, rel) {
  const normalized = path.posix.normalize(String(rel).replace(/\\/g, '/'));
  if (normalized.includes('..') || !normalized.startsWith('lessons/') || !normalized.endsWith('.json')) {
    throw fail('lesson-path', 'lesson file must be lessons/<project>/<id>.json');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length !== 3) throw fail('lesson-path', 'lesson file must be lessons/<project>/<id>.json');
  const full = path.join(root, ...parts);
  let text;
  try {
    text = await readCappedLessonFile(full);
  } catch (error) {
    if (error?.code === 'ENOENT') throw fail('lesson-missing', normalized);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail('lesson-invalid', 'lesson file is not valid JSON');
  }
  const norm = normalizeLesson(parsed);
  const check = validateLesson(norm);
  if (!check.ok) throw fail('lesson-invalid', check.errors[0]);
  if (`${norm.id}.json` !== parts[2]) throw fail('lesson-invalid', 'id-mismatch');
  if (norm.project !== parts[1]) throw fail('lesson-invalid', 'project-mismatch');
  lessonPath(norm.project, norm.id);
  return norm;
}

/**
 * @param {string} root
 * @param {object} lesson
 * @param {string} draftRel
 * @param {ReturnType<typeof proposeLessonDraft>} proposal
 */
async function closeLessonAfterDraft(root, lesson, draftRel, proposal) {
  const guardKind = proposal.kind && proposal.kind !== 'none' ? proposal.kind : 'lint';
  const updated = {
    ...lesson,
    guard: {
      kind: guardKind,
      text: clip(proposal.text, 300),
      status: 'built',
      ref: draftRel,
    },
  };
  await writeLesson(root, updated, { overwrite: true });
}

/**
 * Turn one logged lesson into a test or rule draft; optionally write the markdown and close the lesson.
 *
 * @param {string} root
 * @param {string|object} lessonOrRel
 * @param {{
 *   outDir?: string,
 *   write?: boolean,
 *   close?: boolean,
 *   includeGuarded?: boolean,
 *   date?: string,
 * }} [options]
 */
export async function draftLoggedLesson(root, lessonOrRel, options = {}) {
  const {
    outDir = LESSON_DRAFT_OUT_DIR,
    write = false,
    close = true,
    includeGuarded = false,
    date,
  } = options;

  const lesson =
    typeof lessonOrRel === 'string'
      ? await readLoggedLessonFile(root, lessonOrRel)
      : normalizeLesson(lessonOrRel);

  const check = validateLesson(lesson);
  if (!check.ok) throw fail('lesson-invalid', check.errors[0]);

  if (!includeGuarded && lesson.guard?.status !== 'proposed') {
    return {
      lessonId: lesson.id,
      skipped: true,
      reason: 'guard-not-proposed',
      proposal: null,
      written: null,
      closed: false,
    };
  }

  const proposal = proposeLessonDraft(lesson);
  const rel = path.posix.join(...checkOutDir(outDir), `${proposal.slug}.md`);

  if (!write) {
    return {
      lessonId: lesson.id,
      skipped: false,
      proposal,
      written: null,
      closed: false,
      markdown: renderLessonDraft(proposal, { date }),
    };
  }

  const parts = checkOutDir(outDir);
  const folder = await safeWritableDir(root, parts);
  const file = path.join(folder, `${proposal.slug}.md`);
  await assertRegularOrMissing(file);

  const tmp = path.join(folder, `.${proposal.slug}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(renderLessonDraft(proposal, { date }));
  } finally {
    await handle.close();
  }

  try {
    await fs.link(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    if (error.code === 'EEXIST') {
      return {
        lessonId: lesson.id,
        skipped: true,
        reason: 'draft-exists',
        proposal,
        written: null,
        closed: false,
      };
    }
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }

  let closed = false;
  if (close) {
    await closeLessonAfterDraft(root, lesson, rel, proposal);
    closed = true;
  }

  return {
    lessonId: lesson.id,
    skipped: false,
    proposal,
    written: rel,
    closed,
  };
}
