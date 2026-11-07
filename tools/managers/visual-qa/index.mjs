// SPDX-License-Identifier: Apache-2.0
// Visual QA manager orchestrator: phone and desktop screenshots after UI integration (T-0219).

import { BaseManager } from '../base.mjs';
import { managerActionModeRunsManager } from '../modes.mjs';
import { captureScreenshotsForChangedPages, VISUAL_QA_VIEWPORT_NAMES } from './screenshots.mjs';
import { attachScreenshotsToPullRequest } from './pr-attach.mjs';

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */

const ATTACH_SCREENSHOTS_ACTION = 'attach-screenshots';

class VisualQaManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   pr?: string|number,
   *   repo?: string,
   *   ticketIds?: string[],
   *   screenIds?: string[],
   *   mergeBase?: string,
   *   deps?: object,
   * }} config
   */
  constructor({
    root,
    modeSettings,
    trigger = 'scope',
    pr,
    repo,
    ticketIds,
    screenIds,
    mergeBase,
    deps,
  }) {
    super({ managerId: 'visual-qa', root, modeSettings, trigger });
    this.pr = pr;
    this.repo = repo;
    this.ticketIds = ticketIds ?? [];
    this.screenIds = screenIds ?? [];
    this.mergeBase = mergeBase;
    this.deps = deps ?? {};
  }

  /**
   * Visual QA runs after integration (and in replay fixtures).
   * @returns {boolean}
   */
  shouldRun() {
    return this.trigger === 'integration' || this.trigger === 'replay';
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} ctx
   */
  async execute(ctx) {
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
      const attachMode = this.actionMode(ATTACH_SCREENSHOTS_ACTION);
      if (!managerActionModeRunsManager(attachMode)) {
        record('skip', { reason: 'attach-screenshots-off' });
        return;
      }

      record('capture-start', {
        ticketIds: this.ticketIds,
        screenIds: this.screenIds,
        viewports: VISUAL_QA_VIEWPORT_NAMES,
      });

      const capture = await captureScreenshotsForChangedPages(this.root, {
        pr: this.pr,
        ticketIds: this.ticketIds,
        screenIds: this.screenIds,
        mergeBase: this.mergeBase,
        deps: this.deps,
      });

      if (capture.skipped) {
        record('skip', { reason: 'no-changed-ui-pages' });
        return;
      }

      record('capture-done', {
        screens: capture.screens,
        artifacts: capture.artifacts?.length ?? 0,
        failed: capture.failed?.length ?? 0,
      });

      const failed = capture.failed ?? [];
      if (failed.length > 0) {
        const sample = failed
          .slice(0, 3)
          .map((f) => `${f.screenId}/${f.captureKey} ${f.viewport}`)
          .join('; ');
        await this.emitFinding({
          severity: 'warn',
          code: 'screenshot-capture-failed',
          action: ATTACH_SCREENSHOTS_ACTION,
          reason: `Some phone or desktop screenshots failed (${failed.length}): ${sample}`,
          recommendation: 'Fix the page or dev server, then re-run visual QA after integration',
          ...(this.ticketIds[0] ? { ticket: this.ticketIds[0] } : {}),
        });
      }

      const artifacts = capture.artifacts ?? [];
      if (!artifacts.length) {
        throw new Error('visual-qa-no-artifacts');
      }

      const screensLabel = (capture.screens ?? []).join(', ') || 'changed pages';
      const viewportLabel = VISUAL_QA_VIEWPORT_NAMES.join(' and ');

      await this.emitFinding(
        {
          severity: 'info',
          code: 'attach-screenshots',
          action: ATTACH_SCREENSHOTS_ACTION,
          reason: `Captured ${viewportLabel} screenshots for ${screensLabel} (${artifacts.length} image(s))`,
          recommendation: 'Review the screenshot comment on the pull request',
          ...(this.ticketIds[0] ? { ticket: this.ticketIds[0] } : {}),
        },
        {
          apply: async () => {
            record('attach-start', { count: artifacts.length });
            await attachScreenshotsToPullRequest(this.root, {
              pr: this.pr,
              artifacts,
              repo: this.repo,
              deps: this.deps,
            });
            record('attach-done', { count: artifacts.length });
          },
        },
      );
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
 *   pr?: string|number,
 *   repo?: string,
 *   ticketIds?: string[],
 *   screenIds?: string[],
 *   mergeBase?: string,
 *   deps?: object,
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== 'visual-qa') {
    throw new Error(`visual-qa manager createManager expected managerId visual-qa, got ${String(options.managerId)}`);
  }
  return new VisualQaManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & {
 *   pr?: string|number,
 *   repo?: string,
 *   ticketIds?: string[],
 *   screenIds?: string[],
 *   mergeBase?: string,
 *   deps?: object,
 * }} options
 */
export async function runBuiltinManager(options) {
  const manager = new VisualQaManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
    pr: options.pr,
    repo: options.repo,
    ticketIds: options.ticketIds,
    screenIds: options.screenIds,
    mergeBase: options.mergeBase,
    deps: options.deps,
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {typeof runBuiltinManager} */
export const run = runBuiltinManager;
