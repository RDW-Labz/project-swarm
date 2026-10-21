// SPDX-License-Identifier: Apache-2.0

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCORECARD_METRIC_NAMES } from './bench-scorecard.mjs';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const WEEK_PATTERN = /^\d{4}-W\d{2}$/;

function skipped(file, reason) {
  return { file, reason };
}

function validCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'JSON must be an object';
  if (typeof value.week !== 'string' || !WEEK_PATTERN.test(value.week)) return 'week must match YYYY-Www';
  if (!Array.isArray(value.projects)) return 'projects must be an array';
  return null;
}

/**
 * Read scorecard cards written by `swarm eval scorecard`.
 * Invalid and unreadable files are reported and never make this function reject.
 */
export async function readScorecards(root) {
  const directory = typeof root === 'string' ? path.join(root, 'evals', 'scorecard') : null;
  if (!directory) return { cards: [], files: 0, skipped: [skipped(String(root), 'root must be a path')] };

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return { cards: [], files: 0, skipped: [skipped(directory, `cannot read directory: ${error?.code || 'error'}`)] };
  }

  const jsonFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const output = { cards: [], files: 0, skipped: [] };

  for (let index = 0; index < jsonFiles.length; index += 1) {
    const file = jsonFiles[index].name;
    if (index >= MAX_FILES) {
      output.skipped.push(skipped(file, 'file limit exceeded'));
      continue;
    }

    const fullPath = path.join(directory, file);
    let size;
    try {
      size = (await stat(fullPath)).size;
    } catch (error) {
      output.skipped.push(skipped(file, `cannot stat file: ${error?.code || 'error'}`));
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      output.skipped.push(skipped(file, 'file is larger than 512 KB'));
      continue;
    }

    let value;
    try {
      value = JSON.parse(await readFile(fullPath, 'utf8'));
    } catch (error) {
      output.skipped.push(skipped(file, error instanceof SyntaxError ? 'invalid JSON' : `cannot read file: ${error?.code || 'error'}`));
      continue;
    }

    const reason = validCard(value);
    if (reason) {
      output.skipped.push(skipped(file, reason));
      continue;
    }
    output.cards.push(value);
  }

  output.files = output.cards.length;
  return output;
}

function inputParts(input) {
  if (Array.isArray(input)) return { cards: input, files: input.length, skipped: [] };
  if (!input || typeof input !== 'object') return { cards: [], files: 0, skipped: [] };
  return {
    cards: Array.isArray(input.cards) ? input.cards : [],
    files: Number.isFinite(input.files) ? input.files : (Array.isArray(input.cards) ? input.cards.length : 0),
    skipped: Array.isArray(input.skipped) ? [...input.skipped] : [],
  };
}

function generatedAtMs(card) {
  const parsed = Date.parse(card?.generatedAt ?? '');
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function dedupeCards(cards) {
  const byWeek = new Map();
  for (const card of cards) {
    if (!card || typeof card !== 'object' || !WEEK_PATTERN.test(card.week) || !Array.isArray(card.projects)) continue;
    const current = byWeek.get(card.week);
    if (!current || generatedAtMs(card) > generatedAtMs(current)) byWeek.set(card.week, card);
  }
  return [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));
}

function projectFor(card, project) {
  return (card?.projects ?? []).find(entry => entry && entry.project === project) ?? null;
}

function metricFor(project, name) {
  return (project?.metrics ?? []).find(metric => metric && metric.name === name) ?? null;
}

function verdictFor(trend) {
  if (trend === 'up') return 'better';
  if (trend === 'down') return 'worse';
  if (trend === 'flat') return 'flat';
  return 'unknown';
}

/** Build the board's scorecard history from parsed cards. */
export function scorecardHistory(input, { weeks = 12 } = {}) {
  const source = inputParts(input);
  const cards = dedupeCards(source.cards);
  const latest = cards.length ? cards[cards.length - 1] : null;
  const count = Number.isFinite(weeks) && weeks > 0 ? Math.floor(weeks) : 0;
  const history = cards.slice(Math.max(0, cards.length - count));
  const projects = (latest?.projects ?? []).filter(project => project && typeof project === 'object').map(project => ({
    project: project.project,
    metrics: SCORECARD_METRIC_NAMES.map(name => {
      const current = metricFor(project, name);
      const weekly = history.flatMap(card => {
        const metric = metricFor(projectFor(card, project.project), name);
        return metric && metric.value !== null && metric.value !== undefined
          ? [{ week: card.week, value: metric.value, grade: metric.grade ?? 'unknown' }]
          : [];
      });
      const trend = current?.trend ?? 'new';
      return {
        name,
        label: name.replaceAll('_', ' '),
        value: current?.value ?? null,
        grade: current?.grade ?? 'unknown',
        trend,
        previous: current?.previous ?? null,
        status: current?.status ?? 'missing',
        weekly,
        verdict: verdictFor(trend),
      };
    }),
  }));

  return {
    week: latest?.week ?? null,
    generatedAt: latest?.generatedAt ?? null,
    headline: latest?.headline ?? null,
    overall: latest?.overall ?? null,
    projects,
    weeks: history.map(card => card.week),
    files: source.files,
    skipped: source.skipped,
  };
}
