// SPDX-License-Identifier: Apache-2.0
// Lessons keeper orchestrator: propose a test or rule for each logged lesson and close it (T-0222 / R-039).

import { listLessons } from '../../lesson-store.mjs';
import { lessonPath } from '../../lesson-schema.mjs';
import { BaseManager } from '../base.mjs';
import { managerActionGroup } from '../registry.mjs';
import {
  managerActionModeAppliesChanges,
  managerActionModeRunsManager,
} from '../modes.mjs';
import { closeLoggedLesson } from './close.mjs';
import { lessonOpenForKeeper, proposeLessonDraft } from './draft.mjs';

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */

export const LESSONS_KEEPER_MANAGER_ID = 'lessons-keeper';

/** Safe lessons-keeper action (registry.mjs MANAGER_ACTION_GROUPS). */
export const WRITE_LESSON_DRAFT_ACTION = 'write-lesson-draft';

/**
 * @param {string} action
 */
function assertLessonsKeeperSafeAction(action) {
  if (action !== WRITE_LESSON_DRAFT_ACTION) {
    throw new Error(`lessons-keeper-orchestrator-action-unknown: ${String(action)}`);
  }
  if (managerActionGroup(LESSONS_KEEPER_MANAGER_ID, action) !== 'safe') {
    throw new Error(`lessons-keeper-orchestrator-action-not-safe: ${String(action)}`);
  }
}

assertLessonsKeeperSafeAction(WRITE_LESSON_DRAFT_ACTION);

/**
 * @param {string} text
 * @param {number} [max]
 */
function clip(text, max = 400) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

/**
 * @param {readonly object[]} lessons
 * @returns {object[]}
 */
export function lessonsOpenForKeeper(lessons) {
  return lessons.filter((lesson) => lessonOpenForKeeper(lesson, false));
}

/**
 * @param {object} lesson
 * @param {Awaited<ReturnType<typeof closeLoggedLesson>>} result
 * @returns {null | {
 *   severity: 'info'|'warn',
 *   code: string,
 *   action: string,
 *   reason: string,
 *   recommendation: string,
 * }}
 */
export function lessonKeeperFindingFromCloseResult(lesson, result) {
  if (result.skipped && result.reason === 'guard-closed') return null;

  const proposal = result.proposal ?? proposeLessonDraft(lesson);
  const artifact = proposal.artifact ?? 'rule';
  const lessonId = result.lessonId ?? lesson.id;

  if (result.closed && result.landed) {
    return {
      severity: 'info',
      code: 'lesson-shipped',
      action: WRITE_LESSON_DRAFT_ACTION,
      reason: `Lesson ${lessonId} closed after ${artifact} landed at ${result.landed}`,
      recommendation: 'No further lessons-keeper action is required for this lesson',
    };
  }

  if (result.wouldDraft || (result.drafted && !result.skipped)) {
    const kind = proposal.kind ?? 'guard';
    const symptom = clip(proposal.what ?? lesson.what ?? '', 220);
    return {
      severity: 'info',
      code: artifact === 'test' ? 'lesson-propose-test' : 'lesson-propose-rule',
      action: WRITE_LESSON_DRAFT_ACTION,
      reason: `Lesson ${lessonId}: propose ${artifact} (${kind}) from failure — ${symptom}`,
      recommendation:
        artifact === 'test'
          ? 'Land the failing test from the draft ship target, then re-run lessons keeper to mark the lesson shipped'
          : 'Land the rule or check from the draft ship target, then re-run lessons keeper to mark the lesson shipped',
    };
  }

  if (result.reason === 'not-landed') {
    const ref = typeof lesson.guard?.ref === 'string' ? lesson.guard.ref : 'draft';
    return {
      severity: 'warn',
      code: 'lesson-not-landed',
      action: WRITE_LESSON_DRAFT_ACTION,
      reason: `Lesson ${lessonId} is built (${ref}) but no landed ${artifact} was found yet`,
      recommendation:
        'Merge the test or rule from the draft ship target, then re-run lessons keeper to close the lesson',
    };
  }

  if (result.skipped && result.reason === 'draft-exists') {
    return {
      severity: 'info',
      code: 'lesson-draft-exists',
      action: WRITE_LESSON_DRAFT_ACTION,
      reason: `Lesson ${lessonId} already has a ${artifact} draft on disk; keeper did not overwrite it`,
      recommendation: 'Review the existing draft under coordination/lesson-drafts/, land it, then re-run lessons keeper',
    };
  }

  if (result.skipped && result.reason === 'guard-not-built') {
    return {
      severity: 'warn',
      code: 'lesson-guard-not-built',
      action: WRITE_LESSON_DRAFT_ACTION,
      reason: `Lesson ${lessonId} could not be advanced to a built guard`,
      recommendation: 'Fix the lesson file or draft path, then re-run lessons keeper',
    };
  }

  return null;
}

/**
 * @param {string} root
 * @param {{ lessons?: object[] }} [fixture]
 */
async function resolveLoggedLessons(root, fixture) {
  if (fixture?.lessons) return fixture.lessons.slice();
  const { lessons } = await listLessons(root);
  return lessons;
}

class LessonsKeeperManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   fixture?: { lessons?: object[] },
   *   lessonIds?: string[],
   * }} config
   */
  constructor({ root, modeSettings, trigger = 'scope', fixture, lessonIds }) {
    super({ managerId: LESSONS_KEEPER_MANAGER_ID, root, modeSettings, trigger });
    this.fixture = fixture;
    this.lessonIds = lessonIds ?? [];
  }

  /**
   * Lessons keeper runs after waves and in replay fixtures (failures → tests/rules).
   * @returns {boolean}
   */
  shouldRun() {
    return this.trigger === 'wave' || this.trigger === 'idle' || this.trigger === 'replay';
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} _ctx
   */
  async execute(_ctx) {
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
      const draftMode = this.actionMode(WRITE_LESSON_DRAFT_ACTION);
      if (!managerActionModeRunsManager(draftMode)) {
        record('skip', { reason: 'write-lesson-draft-off' });
        return;
      }

      const write = managerActionModeAppliesChanges(draftMode);
      let lessons = await resolveLoggedLessons(this.root, this.fixture);
      if (this.lessonIds.length > 0) {
        const wanted = new Set(this.lessonIds);
        lessons = lessons.filter((lesson) => wanted.has(lesson.id));
      }
      const open = lessonsOpenForKeeper(lessons);
      record('scan', { open: open.length, write });

      for (const lesson of open) {
        const rel = lessonPath(lesson.project, lesson.id);
        const result = await closeLoggedLesson(this.root, rel, { write });
        record('lesson', {
          lessonId: lesson.id,
          skipped: result.skipped,
          closed: result.closed,
          landed: result.landed ?? null,
          reason: result.reason ?? null,
        });

        const draft = lessonKeeperFindingFromCloseResult(lesson, result);
        if (!draft) continue;

        await this.emitFinding({
          severity: draft.severity,
          code: draft.code,
          reason: draft.reason,
          action: draft.action,
          recommendation: draft.recommendation,
        });
      }
    } catch (error) {
      flushOnFailure(error);
      throw error;
    }
  }
}

/**
 * @param {{
 *   managerId: import('../modes.mjs').ManagerId,
 *   root: string,
 *   modeSettings: ManagerActionModeSettings,
 *   trigger?: ManagerTrigger,
 *   fixture?: LessonsKeeperManager['fixture'],
 *   lessonIds?: string[],
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== LESSONS_KEEPER_MANAGER_ID) {
    throw new Error(
      `lessons-keeper manager createManager expected managerId ${LESSONS_KEEPER_MANAGER_ID}, got ${String(options.managerId)}`,
    );
  }
  return new LessonsKeeperManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & {
 *   fixture?: LessonsKeeperManager['fixture'],
 *   lessonIds?: string[],
 * }} options
 */
export async function runBuiltinManager(options) {
  const manager = new LessonsKeeperManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
    fixture: options.fixture,
    lessonIds: options.lessonIds,
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {typeof runBuiltinManager} */
export const run = runBuiltinManager;
