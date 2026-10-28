// SPDX-License-Identifier: Apache-2.0
// Lessons keeper: close a built lesson after its linked test or rule lands (T-0221).

import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeLesson, validateLesson } from '../../lesson-schema.mjs';
import { writeLesson } from '../../lesson-store.mjs';
import { assertRegularOrMissing } from '../../journal.mjs';
import {
  readLoggedLessonFile,
  proposeLessonDraft,
  lessonDraftArtifact,
  draftLoggedLesson,
  lessonOpenForKeeper,
} from './draft.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

const MAX_BYTES = 64 * 1024;
const TEST_DRAFT_SUFFIX = '.test-draft.mjs';
const RULE_DRAFT_SUFFIX = '.rule-draft.md';
const LESSON_GUARD_STUB = 'lesson guard not implemented';
const DRAFT_DIR_SEGMENT = 'coordination/lesson-drafts/';

export const LESSON_SHIP_CLOSE_STATUS = 'built';

const isRepoRel = (rel) => {
  const f = String(rel ?? '').trim();
  if (!f || f.startsWith('/') || /^[A-Za-z]:/.test(f)) return false;
  if (f.includes(String.fromCharCode(92))) return false;
  return !f.split('/').includes('..');
};

function posixNorm(rel) {
  return path.posix.normalize(String(rel).replace(/\\/g, '/'));
}

function lessonRel(lesson) {
  return `lessons/${lesson.project}/${lesson.id}.json`;
}

async function reloadLoggedLesson(root, lesson) {
  return readLoggedLessonFile(root, lessonRel(lesson));
}

/**
 * @param {object} lesson
 * @returns {boolean}
 */
export function lessonReadyForShipClose(lesson) {
  const status = lesson.guard?.status ?? 'proposed';
  return status === LESSON_SHIP_CLOSE_STATUS && typeof lesson.guard?.ref === 'string' && lesson.guard.ref.length > 0;
}

/**
 * @param {string} ref
 * @returns {boolean}
 */
export function lessonRefLooksLikeDraft(ref) {
  const norm = posixNorm(ref);
  return norm.includes(DRAFT_DIR_SEGMENT) && (norm.endsWith(TEST_DRAFT_SUFFIX) || norm.endsWith(RULE_DRAFT_SUFFIX));
}

/**
 * @param {string} draftRef
 * @returns {string[]}
 */
export function landedPathsFromDraftRef(draftRef) {
  const norm = posixNorm(draftRef);
  const base = path.posix.basename(norm);
  const out = [];
  if (base.endsWith(TEST_DRAFT_SUFFIX)) {
    const stem = base.slice(0, -TEST_DRAFT_SUFFIX.length);
    out.push(`tests/${stem}.test.mjs`);
  }
  if (base.endsWith(RULE_DRAFT_SUFFIX)) {
    const stem = base.slice(0, -RULE_DRAFT_SUFFIX.length);
    out.push(`docs/lessons-loop.md`);
    out.push(`.cursor/rules/${stem}.mdc`);
    out.push(`tools/${stem}.mjs`);
  }
  return [...new Set(out.filter(isRepoRel))];
}

/**
 * @param {string} line
 * @returns {string[]}
 */
export function shipTargetPathsFromLine(line) {
  const parts = String(line ?? '').split(/\s+and\s+/i);
  const paths = [];
  for (const part of parts) {
    const token = part.trim().split(/\s+/)[0]?.replace(/[,.;]+$/, '') ?? '';
    if (isRepoRel(token)) paths.push(token);
  }
  return paths;
}

/**
 * @param {string} text
 * @param {'test'|'rule'} artifact
 * @returns {string[]}
 */
export function shipTargetPathsFromDraft(text, artifact) {
  const paths = [];
  if (artifact === 'test') {
    const match = text.match(/^\/\/ Ship target: (.+)$/m);
    if (match) paths.push(...shipTargetPathsFromLine(match[1]));
  } else {
    const match = text.match(/^Ship target: (.+)$/m);
    if (match) paths.push(...shipTargetPathsFromLine(match[1]));
  }
  return [...new Set(paths.filter(isRepoRel))];
}

/**
 * @param {object} lesson
 * @param {ReturnType<typeof proposeLessonDraft>} proposal
 * @returns {string[]}
 */
export function landedPathCandidates(lesson, proposal) {
  const artifact = proposal.artifact ?? lessonDraftArtifact(proposal.kind);
  const candidates = [];
  if (Array.isArray(lesson.files)) {
    for (const file of lesson.files) {
      if (isRepoRel(file)) candidates.push(posixNorm(file));
    }
  }
  const ref = lesson.guard?.ref;
  if (typeof ref === 'string' && ref.length) {
    const norm = posixNorm(ref);
    if (!lessonRefLooksLikeDraft(norm)) candidates.push(norm);
    candidates.push(...landedPathsFromDraftRef(norm));
  }
  const preferTests = artifact === 'test';
  const preferRules = artifact === 'rule';
  const sorted = [...new Set(candidates)].sort((a, b) => {
    const score = (p) => {
      let s = 0;
      if (preferTests && p.startsWith('tests/') && p.endsWith('.test.mjs')) s += 4;
      if (preferRules && !p.includes('lesson-drafts') && (p.endsWith('.md') || p.endsWith('.mdc') || p.startsWith('tools/'))) s += 3;
      if (p.includes('lesson-drafts')) s -= 5;
      if (p.endsWith(TEST_DRAFT_SUFFIX) || p.endsWith(RULE_DRAFT_SUFFIX)) s -= 5;
      return s;
    };
    return score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0);
  });
  return sorted;
}

async function readCappedRepoFile(root, rel) {
  const norm = posixNorm(rel);
  if (!isRepoRel(norm)) throw fail('lesson-close-path', 'path must be a relative repo path');
  const full = path.join(root, ...norm.split('/'));
  await assertRegularOrMissing(full);
  const handle = await fs.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw fail('lesson-close-path', 'path is not a regular file');
    if (st.size > MAX_BYTES) throw fail('lesson-close-too-large', 'artifact file is too large');
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_BYTES) throw fail('lesson-close-too-large', 'artifact file is too large');
    return buf.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} rel
 * @param {string} text
 * @param {'test'|'rule'} artifact
 * @returns {boolean}
 */
export function lessonArtifactLooksLanded(rel, text, artifact) {
  const norm = posixNorm(rel);
  if (!isRepoRel(norm)) return false;
  if (norm.endsWith(TEST_DRAFT_SUFFIX) || norm.endsWith(RULE_DRAFT_SUFFIX)) return false;
  if (norm.includes(DRAFT_DIR_SEGMENT)) return false;
  if (artifact === 'test') {
    if (!norm.endsWith('.test.mjs')) return false;
    if (text.includes(LESSON_GUARD_STUB)) return false;
    return true;
  }
  if (text.includes('rule draft') && text.includes('Not merged automatically')) return false;
  return text.trim().length > 0;
}

/**
 * @param {string} root
 * @param {object} lesson
 * @param {ReturnType<typeof proposeLessonDraft>} proposal
 * @returns {Promise<string|null>}
 */
export async function findLandedArtifact(root, lesson, proposal) {
  const artifact = proposal.artifact ?? lessonDraftArtifact(proposal.kind);
  const ref = lesson.guard?.ref;
  let draftText = '';
  if (typeof ref === 'string' && lessonRefLooksLikeDraft(ref)) {
    try {
      draftText = await readCappedRepoFile(root, ref);
    } catch {
      draftText = '';
    }
  }
  const fromDraft = shipTargetPathsFromDraft(draftText, artifact);
  const candidates = [...new Set([...fromDraft, ...landedPathCandidates(lesson, proposal)])];
  for (const rel of candidates) {
    try {
      const text = await readCappedRepoFile(root, rel);
      if (lessonArtifactLooksLanded(rel, text, artifact)) return rel;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[tools/managers/lessons/close.mjs] landed path candidate read:', error?.message ?? error);
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Turn a logged lesson into a test or rule when needed, then mark it shipped once that guard lands.
 *
 * @param {string} root
 * @param {string|object} lessonOrRel
 * @param {{ write?: boolean }} [options]
 */
export async function closeLoggedLesson(root, lessonOrRel, options = {}) {
  const { write = false } = options;
  const events = [];
  const record = (kind, detail) => {
    events.push({ at: new Date().toISOString(), kind, ...detail });
  };
  const flushOnFailure = (error) => {
    if (error) {
      process.stderr.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    }
  };

  try {
    let lesson =
      typeof lessonOrRel === 'string'
        ? await readLoggedLessonFile(root, lessonOrRel)
        : normalizeLesson(lessonOrRel);

    const check = validateLesson(lesson);
    if (!check.ok) throw fail('lesson-invalid', check.errors[0]);

    const status = lesson.guard?.status ?? 'proposed';
    if (status === 'shipped' || status === 'dropped') {
      return {
        lessonId: lesson.id,
        skipped: true,
        reason: 'guard-closed',
        closed: false,
        landed: null,
      };
    }

    let drafted = null;
    let proposal = proposeLessonDraft(lesson);

    if (status !== LESSON_SHIP_CLOSE_STATUS) {
      if (!lessonOpenForKeeper(lesson, false)) {
        return {
          lessonId: lesson.id,
          skipped: true,
          reason: 'guard-closed',
          closed: false,
          landed: null,
        };
      }
      if (!write) {
        const landedPreview = await findLandedArtifact(root, lesson, proposal);
        record('preview', { lessonId: lesson.id, wouldDraft: true, landed: landedPreview });
        return {
          lessonId: lesson.id,
          skipped: false,
          proposal,
          drafted: null,
          wouldDraft: true,
          landed: landedPreview,
          closed: false,
        };
      }
      drafted = await draftLoggedLesson(root, lesson, { write: true, close: true });
      record('draft', { lessonId: lesson.id, drafted });
      if (drafted.skipped && drafted.reason !== 'draft-exists') {
        return {
          lessonId: lesson.id,
          skipped: true,
          reason: drafted.reason ?? 'draft-skipped',
          proposal: drafted.proposal ?? proposal,
          drafted,
          closed: false,
          landed: null,
        };
      }
      lesson = await reloadLoggedLesson(root, lesson);
      proposal = proposeLessonDraft(lesson);
    }

    if ((lesson.guard?.status ?? 'proposed') !== LESSON_SHIP_CLOSE_STATUS) {
      return {
        lessonId: lesson.id,
        skipped: true,
        reason: 'guard-not-built',
        proposal,
        drafted,
        closed: false,
        landed: null,
      };
    }
    if (!lesson.guard?.ref) {
      return {
        lessonId: lesson.id,
        skipped: true,
        reason: 'missing-ref',
        proposal,
        drafted,
        closed: false,
        landed: null,
      };
    }

    const landed = await findLandedArtifact(root, lesson, proposal);
    record('scan', { lessonId: lesson.id, ref: lesson.guard.ref, landed });
    if (!landed) {
      const builtClosed = Boolean(drafted?.closed);
      return {
        lessonId: lesson.id,
        skipped: !builtClosed,
        reason: builtClosed ? undefined : 'not-landed',
        proposal,
        drafted,
        closed: builtClosed,
        landed: null,
      };
    }

    if (!write) {
      return {
        lessonId: lesson.id,
        skipped: false,
        proposal,
        drafted,
        landed,
        closed: false,
      };
    }

    const updated = {
      ...lesson,
      guard: {
        ...lesson.guard,
        status: 'shipped',
        ref: landed,
      },
    };
    await writeLesson(root, updated, { overwrite: true });
    record('close', { lessonId: lesson.id, landed });
    return {
      lessonId: lesson.id,
      skipped: false,
      proposal,
      drafted,
      landed,
      closed: true,
    };
  } catch (error) {
    flushOnFailure(error);
    throw error;
  }
}
