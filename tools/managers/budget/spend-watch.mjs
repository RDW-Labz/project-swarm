// SPDX-License-Identifier: Apache-2.0
// T-0191: daily billed spend rollup per project from the spend ledger (budget manager).
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseLedgerRow, spendDir, withSpendStore } from '../../spend.mjs';
import { readProjectCap } from '../../project-spend.mjs';
import { REPLAY_SNAPSHOT_PATHS } from '../replay.mjs';

/** Replay harness and fixtures materialize the spend ledger here (R-037 / evals/managers). */
export const REPLAY_SPEND_LEDGER_REL = REPLAY_SNAPSHOT_PATHS.spendLedger;

/** Safe budget-manager action when spend nears the project cap (registry.mjs). */
export const WARN_CAP_ACTION = 'warn-cap';

/** Default fraction of projectMaxUsd at which the budget manager should warn before the hard stop. */
export const DEFAULT_WARN_BEFORE_CAP_RATIO = 0.85;

const utcDay = now => new Date(typeof now === 'function' ? now() : now).toISOString().slice(0, 10);
const roundUsd = value => Math.round(value * 1e6) / 1e6;

/**
 * @param {string} key
 * @param {string} reason
 * @returns {Error & { code: string }}
 */
function invalid(key, reason) {
  return Object.assign(new Error(`spend-watch-invalid: ${key} ${reason}`), { code: 'spend-watch-invalid' });
}

/**
 * @param {unknown} value
 * @returns {{ version: 1, day: string, entries: Record<string, object> }}
 */
export function parseSpendLedgerSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('spend-ledger', 'must be an object');
  if (value.version !== 1) throw invalid('spend-ledger.version', 'must be 1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.day)) throw invalid('spend-ledger.day', 'must be YYYY-MM-DD');
  if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw invalid('spend-ledger.entries', 'must be an object');
  }
  return { version: 1, day: value.day, entries: value.entries };
}

/**
 * @param {Record<string, object>} entries
 * @param {{ day: string, root?: string|null }} options
 */
export function rollupBilledSpendFromEntries(entries, { day, root = null }) {
  const byLane = {};
  let usd = 0;
  let tokens = 0;
  let entryCount = 0;
  const projectRoot = root ? path.resolve(root) : null;
  for (const entry of Object.values(entries ?? {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const entryDay = entry.day ?? day;
    if (entryDay !== day) continue;
    if (projectRoot && entry.root && path.resolve(String(entry.root)) !== projectRoot) continue;
    const entryUsd = typeof entry.usd === 'number' && Number.isFinite(entry.usd) && entry.usd >= 0 ? entry.usd : 0;
    const entryTokens = typeof entry.tokens === 'number' && Number.isFinite(entry.tokens) && entry.tokens >= 0 ? entry.tokens : 0;
    usd += entryUsd;
    tokens += entryTokens;
    entryCount += 1;
    if (entry.lane) byLane[String(entry.lane)] = (byLane[String(entry.lane)] ?? 0) + entryUsd;
  }
  const roundedByLane = Object.fromEntries(
    Object.entries(byLane).map(([lane, laneUsd]) => [lane, roundUsd(laneUsd)]),
  );
  return { usd: roundUsd(usd), tokens, byLane: roundedByLane, entryCount };
}

/**
 * Sum billed dollar costs for one UTC day from a usage-ledger markdown table (docs/state/usage-ledger.md).
 *
 * @param {string} text
 * @param {{ day: string }} options
 */
export function rollupBilledSpendFromUsageLedger(text, { day }) {
  const byLane = {};
  let usd = 0;
  for (const line of String(text ?? '').split('\n')) {
    const row = parseLedgerRow(line);
    if (!row || row.date !== day) continue;
    const paid = /^\$(\d+(?:\.\d+)?)/.exec(row.cost);
    if (!paid) continue;
    const amount = Number(paid[1]);
    usd += amount;
    byLane[row.worker] = (byLane[row.worker] ?? 0) + amount;
  }
  return {
    usd: roundUsd(usd),
    byLane: Object.fromEntries(Object.entries(byLane).map(([lane, laneUsd]) => [lane, roundUsd(laneUsd)])),
  };
}

/**
 * @param {string} root
 */
async function readUsageLedgerText(root) {
  for (const rel of ['docs/state/usage-ledger.md', '.swarm/usage-ledger.md']) {
    try {
      return { path: rel, text: await fs.readFile(path.join(root, rel), 'utf8') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

/**
 * Machine-wide spend store entries for one project and UTC day (running reservations count).
 *
 * @param {string} root
 * @param {{ day?: string, dir?: string, env?: NodeJS.ProcessEnv, now?: () => number }} [options]
 */
export async function projectDailySpendFromStore(root, { day, dir, env = process.env, now = Date.now } = {}) {
  const projectRoot = await fs.realpath(root);
  const utc = day ?? utcDay(now);
  return withSpendStore(
    store => rollupBilledSpendFromEntries(store.entries, { day: utc, root: projectRoot }),
    { dir: dir ?? spendDir(env), now },
  );
}

/**
 * Daily billed spend rollup for one project (replay spend ledger, else spend store, else usage ledger).
 *
 * @param {string} root
 * @param {{ day?: string, dir?: string, env?: NodeJS.ProcessEnv, now?: () => number }} [options]
 */
export async function projectDailySpendRollup(root, options = {}) {
  const projectRoot = await fs.realpath(root);
  const day = options.day ?? utcDay(options.now ?? Date.now);

  const replayFile = path.join(projectRoot, REPLAY_SPEND_LEDGER_REL);
  try {
    const ledger = parseSpendLedgerSnapshot(JSON.parse(await fs.readFile(replayFile, 'utf8')));
    const effectiveDay = ledger.day ?? day;
    const rolled = rollupBilledSpendFromEntries(ledger.entries, { day: effectiveDay, root: null });
    return { day: effectiveDay, ...rolled, source: 'spend-ledger-replay' };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    const fromStore = await projectDailySpendFromStore(projectRoot, { ...options, day });
    if (fromStore.entryCount > 0) return { day, ...fromStore, source: 'spend-store' };
  } catch (error) {
    if (error.code !== 'spend-store-invalid' && error.code !== 'spend-store-locked') throw error;
  }

  const usage = await readUsageLedgerText(projectRoot);
  if (usage) {
    const rolled = rollupBilledSpendFromUsageLedger(usage.text, { day });
    return { day, usd: rolled.usd, tokens: 0, byLane: rolled.byLane, entryCount: 0, source: `usage-ledger:${usage.path}` };
  }

  return { day, usd: 0, tokens: 0, byLane: {}, entryCount: 0, source: 'none' };
}

/**
 * @param {{ spentUsd: number, capUsd: number|null|undefined, warnRatio?: number }} input
 */
export function capWatchStatus({ spentUsd, capUsd, warnRatio = DEFAULT_WARN_BEFORE_CAP_RATIO }) {
  if (capUsd === null || capUsd === undefined) {
    return { phase: 'no-cap', spentUsd, capUsd: null, headroomUsd: null, warnRatio };
  }
  if (spentUsd >= capUsd) {
    return { phase: 'at-cap', spentUsd, capUsd, headroomUsd: 0, warnRatio };
  }
  const threshold = capUsd * warnRatio;
  if (spentUsd >= threshold) {
    return { phase: 'warn', spentUsd, capUsd, headroomUsd: roundUsd(capUsd - spentUsd), warnRatio };
  }
  return { phase: 'ok', spentUsd, capUsd, headroomUsd: roundUsd(capUsd - spentUsd), warnRatio };
}

/**
 * Roll up today's billed spend for a project and compare it to the project cap (AC1 watch input).
 *
 * @param {string} root
 * @param {{ day?: string, dir?: string, env?: NodeJS.ProcessEnv, now?: () => number, warnRatio?: number }} [options]
 */
export async function watchProjectDailySpend(root, options = {}) {
  const rollup = await projectDailySpendRollup(root, options);
  const capInfo = await readProjectCap(root, { env: options.env ?? process.env });
  const watch = capWatchStatus({
    spentUsd: rollup.usd,
    capUsd: capInfo?.cap ?? null,
    warnRatio: options.warnRatio,
  });
  return {
    ...rollup,
    capUsd: capInfo?.cap ?? null,
    capSource: capInfo?.source ?? null,
    watch,
  };
}

/**
 * One-line reason for a warn-cap finding (journal / board).
 *
 * @param {{ spentUsd: number, capUsd: number, capSource?: string, warnRatio?: number }} input
 */
export function warnCapReason({ spentUsd, capUsd, capSource, warnRatio = DEFAULT_WARN_BEFORE_CAP_RATIO }) {
  const source = capSource ?? 'profile budget.projectMaxUsd';
  return `budget-warn: project billed $${spentUsd.toFixed(2)} today >= ${Math.round(warnRatio * 100)}% of the project cap $${capUsd.toFixed(2)} (${source}); lower wave size or raise the cap before the hard stop`;
}
