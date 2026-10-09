// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRA_CLI_AGENTS } from './cli-adapters.mjs';
import { CODEX_MODEL } from './codex-adapter.mjs';
import {
  CURSOR_MODEL,
  cursorArgs,
  cursorEnvironment,
  cursorLaunchArgs,
  cursorProfile,
  parseCursorOutput,
  resolveCursorBinary,
} from './cursor-adapter.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN_LOOP_SKILL = path.join(packageRoot, 'skills', 'design-loop');
const DEFAULT_MAX_ROUNDS = 6;
const DESIGNER_ADAPTERS = new Set(['codex', 'cursor', 'claude']);

export function parseWorkerString(worker) {
  if (typeof worker !== 'string' || !worker.includes(':')) return null;
  const index = worker.indexOf(':');
  return { adapter: worker.slice(0, index), model: worker.slice(index + 1) };
}

function workerModelsDistinct(designer, primary, cheap) {
  const d = parseWorkerString(designer);
  const p = parseWorkerString(primary);
  const c = parseWorkerString(cheap);
  if (!d || !p || !c) return false;
  const key = w => `${w.adapter}:${w.model}`;
  const dk = key(d);
  return dk !== key(p) && dk !== key(c);
}

export function validateConfig(cfg, { knownAdapters } = {}) {
  const adapters = new Set([...(knownAdapters ?? ['codex', 'claude', 'cursor', ...EXTRA_CLI_AGENTS])]);
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['config must be an object'] };

  const required = ['target', 'screens', 'designer', 'reviewer', 'rubric', 'done', 'rounds', 'out'];
  for (const key of required) {
    if (cfg[key] === undefined || cfg[key] === null) errors.push(`missing required key: ${key}`);
  }
  if (!Array.isArray(cfg.screens) || cfg.screens.length === 0) errors.push('screens must be a non-empty array');
  else {
    for (const [index, screen] of cfg.screens.entries()) {
      if (!screen || typeof screen !== 'object') errors.push(`screens[${index}] must be an object`);
      else {
        if (typeof screen.name !== 'string' || !screen.name) errors.push(`screens[${index}].name required`);
        if (typeof screen.url_or_selector !== 'string' || !screen.url_or_selector) errors.push(`screens[${index}].url_or_selector required`);
        if (!Array.isArray(screen.widths) || screen.widths.length === 0) errors.push(`screens[${index}].widths must be non-empty`);
        else for (const w of screen.widths) {
          if (!Number.isInteger(w) || w <= 0) errors.push(`screens[${index}].widths must be positive integers`);
        }
      }
    }
  }

  if (cfg.reviewer && typeof cfg.reviewer === 'object') {
    if (!cfg.reviewer.primary) errors.push('reviewer.primary required');
    if (!cfg.reviewer.cheap) errors.push('reviewer.cheap required');
  } else errors.push('reviewer must be an object with primary and cheap');

  const max = cfg.rounds?.max ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(max) || max < 1) errors.push('rounds.max must be an integer >= 1');

  const checkpoints = cfg.rounds?.checkpoints ?? [1, 3, 6];
  const primaryAt = cfg.rounds?.primary_reviewer_at ?? checkpoints;
  if (!Array.isArray(checkpoints)) errors.push('rounds.checkpoints must be an array');
  else for (const c of checkpoints) {
    if (!Number.isInteger(c) || c < 1 || c > max) errors.push(`checkpoint ${c} must be within 1..${max}`);
  }
  if (!Array.isArray(primaryAt)) errors.push('rounds.primary_reviewer_at must be an array');
  else for (const r of primaryAt) {
    if (!Number.isInteger(r) || r < 1 || r > max) errors.push(`primary_reviewer_at ${r} must be within 1..${max}`);
  }

  if (cfg.locks && typeof cfg.locks === 'object' && !Array.isArray(cfg.locks)) {
    for (const [key, round] of Object.entries(cfg.locks)) {
      if (!Number.isInteger(round) || round < 1 || round > max) errors.push(`locks.${key} must be within 1..${max}`);
    }
  } else if (cfg.locks !== undefined && cfg.locks !== null && typeof cfg.locks !== 'object') errors.push('locks must be an object');

  for (const label of ['designer', 'reviewer.primary', 'reviewer.cheap']) {
    const value = label === 'designer' ? cfg.designer : label === 'reviewer.primary' ? cfg.reviewer?.primary : cfg.reviewer?.cheap;
    if (typeof value !== 'string') continue;
    const parsed = parseWorkerString(value);
    if (!parsed) errors.push(`${label} must be "<adapter>:<model>"`);
    else if (!adapters.has(parsed.adapter)) errors.push(`${label} unknown adapter: ${parsed.adapter}`);
    else if (parsed.adapter === 'cursor' && label.startsWith('reviewer.')) {
      errors.push(`${label} cannot use cursor (reviewers need image input)`);
    }
  }

  const designerParsed = parseWorkerString(cfg.designer ?? '');
  if (designerParsed && !DESIGNER_ADAPTERS.has(designerParsed.adapter)) {
    errors.push('designer must be a worktree writer (codex, cursor, or claude)');
  }

  if (cfg.designer && cfg.reviewer?.primary && cfg.reviewer?.cheap && !workerModelsDistinct(cfg.designer, cfg.reviewer.primary, cfg.reviewer.cheap)) {
    errors.push('designer model must differ from reviewer.primary and reviewer.cheap');
  }

  if (typeof cfg.target !== 'string' || !cfg.target) errors.push('target must be a non-empty string');
  if (typeof cfg.rubric !== 'string' || !cfg.rubric) errors.push('rubric must be a path string');
  if (typeof cfg.done !== 'string' || !cfg.done) errors.push('done must be a path string');
  if (typeof cfg.out !== 'string' || !cfg.out) errors.push('out must be a path string');
  if (cfg.motion !== undefined && cfg.motion !== null && typeof cfg.motion !== 'boolean' && typeof cfg.motion !== 'object') {
    errors.push('motion must be boolean or { screen } object');
  }

  return { ok: errors.length === 0, errors };
}

export function reviewerFor(round, cfg, { visionTestPassed = true } = {}) {
  const max = cfg.rounds?.max ?? DEFAULT_MAX_ROUNDS;
  const checkpoints = cfg.rounds?.checkpoints ?? [1, 3, 6];
  const primaryAt = cfg.rounds?.primary_reviewer_at ?? checkpoints;
  const usePrimary = !visionTestPassed || primaryAt.includes(round);
  return usePrimary ? cfg.reviewer.primary : cfg.reviewer.cheap;
}

function normalizeVisionItem(text) {
  return String(text).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function visionTokens(item) {
  const tokens = normalizeVisionItem(item);
  const screen = tokens.find(t => ['dashboard', 'lot', 'pickups', 'screen', 'modal', 'nav', 'header', 'footer'].includes(t)) ?? tokens[0] ?? '';
  const element = tokens.find(t => ['button', 'table', 'row', 'sticker', 'font', 'contrast', 'motion', 'gradient'].includes(t)) ?? tokens[1] ?? '';
  return `${screen}:${element}`;
}

export function visionOverlap(listA, listB) {
  const setA = new Set((listA ?? []).map(visionTokens));
  let count = 0;
  for (const item of listB ?? []) {
    const key = visionTokens(item);
    if (setA.has(key)) count += 1;
  }
  return count;
}

export function visionTestPassedFromLists(listA, listB) {
  return visionOverlap(listA, listB) >= 3;
}

export function workerUnavailableError(cause, message) {
  const error = new Error(message ?? cause?.message ?? 'required worker unavailable');
  error.code = 'worker-unavailable';
  if (cause) error.cause = cause;
  return error;
}

const RESUME_ARG_RE = /--resume\b|--continue\b|(?:^|\s)resume(?:\s|$)/;

export function assertFreshWorkerArgv(argv) {
  const joined = argv.join(' ');
  if (RESUME_ARG_RE.test(joined)) throw new Error(`worker argv must not resume sessions: ${joined}`);
}

// Minimal codex argv for design-loop (no sandbox-exec profile — full codexArgs wraps seatbelt jobs).
export function designLoopCodexArgv({ model, cwd, lastMessageFile, sandbox, imagePaths = [] }) {
  if (!CODEX_MODEL.test(model)) throw new Error('invalid codex model');
  const args = ['exec', '-m', model, '--skip-git-repo-check', '--ephemeral', '-s', sandbox, '-C', cwd, '-o', lastMessageFile];
  for (const image of imagePaths) args.push('-i', image);
  args.push('-');
  assertFreshWorkerArgv(args);
  return args;
}

export function designLoopClaudeArgv({ model, role }) {
  const tools = role === 'designer' ? 'Read,Edit,Write' : 'Read';
  const args = ['-p', '--model', model, '--output-format', 'json', '--allowedTools', tools, '--no-session-persistence'];
  assertFreshWorkerArgv(args);
  return args;
}

export function designLoopCursorArgv(job, { worktree, message }) {
  const args = cursorArgs(job, { worktree, message });
  assertFreshWorkerArgv(args);
  return args;
}

export function fillReviewPromptTemplate(template, slots) {
  let out = String(template);
  for (const key of Object.keys(slots).sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(`{{${key}}}`, String(slots[key]));
  }
  const unfilled = [...out.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]);
  if (unfilled.length) throw new Error(`review prompt has unfilled slots: ${unfilled.join(', ')}`);
  return out;
}

export function buildDesignerPrompt({ target, changeList, rubric, done, round }) {
  const list = (changeList ?? []).length
    ? changeList.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '(no ranked items yet)';
  return [
    `Design loop round ${round}: apply the ranked change list to the target.`,
    `Target: ${target}`,
    `RUBRIC: ${rubric}`,
    `DONE: ${done}`,
    '',
    'Ranked changes for this round (human items first):',
    list,
    '',
    'Apply items top to bottom only. Never fix an item by deleting the element; change it in place.',
  ].join('\n');
}

export function buildVisionTestPrompt(imagePaths) {
  const paths = imagePaths.length ? imagePaths.join('\n') : '(no images)';
  return [
    'Round 0 vision test. You have no memory of other rounds.',
    'From the round-0 screenshots, list exactly five ranked UI issues you would fix first.',
    'Output only a numbered list (1–5), one line per item: screen · element · exact observation.',
    'No other sections or prose.',
    '',
    'Screenshot paths:',
    paths,
  ].join('\n');
}

export function parseTopFiveList(markdown) {
  const items = [];
  for (const line of String(markdown ?? '').split('\n')) {
    const match = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (match) items.push(match[1].trim());
    if (items.length >= 5) break;
  }
  return items.slice(0, 5);
}

export async function listCaptureImages(roundDir) {
  try {
    const names = await fs.readdir(roundDir);
    return names.filter(name => /\.png$/i.test(name)).sort().map(name => path.join(roundDir, name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listBaselineImages(outDir, baseline) {
  if (!baseline || baseline === 'none') return [];
  const dir = path.join(outDir, 'baseline');
  return listCaptureImages(dir);
}

export async function buildReviewPromptSlots(cfg, round, { outDir, history, skillDir = DESIGN_LOOP_SKILL }) {
  const roundDir = path.join(outDir, `round-${round}`);
  const prevRound = Math.max(0, round - 1);
  const prevDir = path.join(outDir, `round-${prevRound}`);
  const paths = await listCaptureImages(roundDir);
  const prevPaths = round > 0 ? await listCaptureImages(prevDir) : [];
  const historyPrev = (history ?? []).find(entry => entry.round === prevRound);
  const prevChanges = historyPrev?.changes ?? [];
  const baselinePaths = await listBaselineImages(outDir, cfg.baseline);
  return {
    N: String(round),
    'N-1': String(prevRound),
    paths: paths.join(', ') || roundDir,
    axe_path: path.join(roundDir, 'axe.json'),
    prev_paths: prevPaths.join(', ') || (round > 0 ? prevDir : '(none)'),
    prev_changes: prevChanges.length
      ? prevChanges.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : '(none)',
    baseline_paths: baselinePaths.join(', ') || '(none)',
  };
}

export async function buildReviewPrompt(cfg, round, context, { skillDir = DESIGN_LOOP_SKILL } = {}) {
  const template = await fs.readFile(path.join(skillDir, 'review.prompt.md'), 'utf8');
  const slots = context?.slots ?? await buildReviewPromptSlots(cfg, round, context);
  return fillReviewPromptTemplate(template, slots);
}

export async function listDesignLoopSkillFiles(skillDir = DESIGN_LOOP_SKILL) {
  const files = [];
  async function walk(dir, base) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, base);
      else files.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  await walk(skillDir, skillDir);
  return files.sort();
}

function spawnAuthFailure(text) {
  return /\b(?:not authenticated|authentication failed|login required|unauthorized|invalid api key|api[_-]?key)\b/i.test(text);
}

async function spawnWithStdin(command, args, { cwd, env, stdin, spawnImpl }) {
  assertFreshWorkerArgv(args);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (error.code === 'ENOENT') reject(workerUnavailableError(error));
      else reject(error);
    });
    child.stdin?.end(stdin ?? '');
    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      const tail = `${stderr}\n${stdout}`;
      if (spawnAuthFailure(tail)) return reject(workerUnavailableError(new Error(tail.trim())));
      reject(new Error(tail.trim() || `${command} exited ${code}`));
    });
  });
}

function claudeResponseText(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value?.result && typeof value.result === 'string') return value.result;
      if (typeof value?.content === 'string') return value.content;
    } catch { /* not json */ }
  }
  return stdout;
}

const DASH = '[\u2014\u2013-]';
const PREV_LINE_RE = new RegExp(`^\\s*(?:\\d+\\.|[-*])\\s*(.+?)\\s*${DASH}\\s*(DONE|NOT DONE|REMOVED INSTEAD)\\s*(?:${DASH}\\s*(.+))?$`, 'i');
const DONE_LINE_RE = new RegExp(`^\\s*(?:\\d+\\.|[-*])\\s*(.+?)\\s*${DASH}\\s*(GREEN|RED)\\s*(?:${DASH}\\s*(.+))?$`, 'i');
const SCORE_LINE_RE = new RegExp(`^\\s*(?:\\d+\\.|[-*]|line\\s*\\d+[.:)]?)\\s*(.+?)\\s*(?:${DASH}|:)\\s*(\\d{1,2})\\s*(?:/10)?\\s*(?:${DASH}\\s*(.+))?$`, 'i');
const CHANGE_LINE_RE = /^\s*\d+\.\s+(.+)$/;

function sectionBody(text, sectionNumber, keyword) {
  const re = new RegExp(`^##\\s*${sectionNumber}\\.[^\\n]*${keyword}[^\\n]*\\n`, 'im');
  const match = re.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^##\s*\d+\./m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function parseReview(markdown) {
  const text = String(markdown ?? '');
  const sections = { previous: [], done: [], scores: [], changes: [] };

  for (const line of sectionBody(text, 1, 'previous').split('\n')) {
    const match = PREV_LINE_RE.exec(line);
    if (!match) continue;
    const status = match[2].toUpperCase().replace(/\s+/g, ' ');
    const normalized = status === 'REMOVED INSTEAD' ? 'REMOVED INSTEAD' : status === 'NOT DONE' ? 'NOT DONE' : 'DONE';
    sections.previous.push({ item: match[1].trim(), status: normalized, evidence: (match[3] ?? '').trim() });
  }

  for (const line of sectionBody(text, 2, 'definition').split('\n')) {
    const match = DONE_LINE_RE.exec(line);
    if (!match) continue;
    sections.done.push({ n: match[1].trim(), status: match[2].toUpperCase() === 'GREEN' ? 'GREEN' : 'RED', evidence: (match[3] ?? '').trim() });
  }

  let lineNum = 0;
  for (const line of sectionBody(text, 3, 'rubric').split('\n')) {
    const match = SCORE_LINE_RE.exec(line);
    if (!match) continue;
    lineNum += 1;
    sections.scores.push({ line: match[1].trim(), score: Number(match[2]), evidence: (match[3] ?? '').trim() });
  }

  for (const line of sectionBody(text, 4, 'five').split('\n')) {
    const match = CHANGE_LINE_RE.exec(line);
    if (match) sections.changes.push(match[1].trim());
  }
  if (sections.changes.length > 5) sections.changes = sections.changes.slice(0, 5);
  return sections;
}

export function carryOver(parsed) {
  const notDone = (parsed?.previous ?? []).filter(row =>
    row.status === 'NOT DONE' || row.status === 'REMOVED INSTEAD',
  );
  const removed = notDone.filter(row => row.status === 'REMOVED INSTEAD');
  const plain = notDone.filter(row => row.status === 'NOT DONE');
  return [...removed, ...plain].map(row => row.item);
}

export function nextChangeList({ human = [], carry = [], reviewer = [] } = {}) {
  const capHuman = human.slice(0, 3);
  const seen = new Set();
  const out = [];
  for (const item of [...capHuman, ...carry, ...reviewer]) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function roundAverage(scores) {
  if (!scores?.length) return null;
  const nums = scores.map(s => s.score).filter(n => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stopDecision(history, cfg, { workerUnavailable = false, round } = {}) {
  if (workerUnavailable) return { stop: true, reason: 'required worker unavailable' };
  const max = cfg.rounds?.max ?? DEFAULT_MAX_ROUNDS;
  const currentRound = round ?? history?.at(-1)?.round ?? 0;
  if (currentRound > max) return { stop: true, reason: 'round cap reached' };

  const scored = (history ?? []).filter(h => h.allDoneGreen);
  if (scored.length >= 2) {
    const last = scored.at(-1);
    const prev = scored.at(-2);
    const lastOk = last.scores?.every(s => s.score >= 8);
    const prevOk = prev.scores?.every(s => s.score >= 8);
    if (last.allDoneGreen && prev.allDoneGreen && lastOk && prevOk) {
      return { stop: true, reason: 'definition of done green and rubric >= 8 for two consecutive rounds' };
    }
  }

  if ((history ?? []).length >= 3) {
    const a = history.at(-1)?.average;
    const b = history.at(-2)?.average;
    const c = history.at(-3)?.average;
    if (a != null && b != null && c != null && a < b && b < c) {
      return { stop: true, reason: 'average score dropped two rounds running' };
    }
  }

  return { stop: false, reason: null };
}

function normalizedCfg(cfg) {
  const max = cfg.rounds?.max ?? DEFAULT_MAX_ROUNDS;
  return {
    ...cfg,
    rounds: {
      max,
      checkpoints: cfg.rounds?.checkpoints ?? [1, 3, 6],
      primary_reviewer_at: cfg.rounds?.primary_reviewer_at ?? cfg.rounds?.checkpoints ?? [1, 3, 6],
    },
  };
}

export function dryRunPlan(cfg) {
  const c = normalizedCfg(cfg);
  const lines = ['Design loop dry run', `out: ${c.out}`, ''];
  lines.push('Rounds:');
  for (let round = 0; round <= c.rounds.max; round += 1) {
    if (round === 0) {
      lines.push(`  ${round}: capture baseline + vision test (no designer)`);
      continue;
    }
    const reviewer = reviewerFor(round, c, { visionTestPassed: true });
    const checkpoint = c.rounds.checkpoints.includes(round) ? ' yes' : '';
    lines.push(`  ${round}: designer ${c.designer}  reviewer ${reviewer}  checkpoint?${checkpoint}`);
  }
  lines.push('');
  lines.push('Files:');
  lines.push(`  ${path.join(c.out, 'LOG.md')}`);
  lines.push(`  ${path.join(c.out, 'state.json')}`);
  for (let round = 0; round <= c.rounds.max; round += 1) {
    lines.push(`  ${path.join(c.out, `round-${round}/`)}*.png`);
    lines.push(`  ${path.join(c.out, `round-${round}/axe.json`)}`);
    lines.push(`  ${path.join(c.out, `round-${round}/checks.json`)}`);
    if (c.rounds.checkpoints.includes(round) && round > 0) {
      lines.push(`  ${path.join(c.out, `round-${round}/CHECKPOINT.md`)}`);
      lines.push(`  ${path.join(c.out, `round-${round}/CHECKPOINT.reply.md`)} (human)`);
    }
  }
  return lines.join('\n');
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

function parseCheckpointReply(text) {
  const human = [];
  const lines = String(text).split('\n');
  for (const line of lines) {
    const humanMatch = /^\s*human\s*:\s*(.+)/i.exec(line);
    if (humanMatch) human.push(humanMatch[1].trim());
    const addMatch = /^\s*add\s*:\s*(.+)/i.exec(line);
    if (addMatch) human.push(addMatch[1].trim());
  }
  return { human: human.slice(0, 3) };
}

export function visionReplyPath(outDir) {
  return path.join(outDir, 'round-0', 'VISION.reply.md');
}

export function buildVisionHumanPauseContent({ replyPath, primaryReviewer, overlap }) {
  return [
    `Round-0 vision overlap ${overlap}/5 (need ≥3). Using primary reviewer (${primaryReviewer}) every round increases cost — confirm before continuing.`,
    '',
    '## Human decision',
    '',
    `Write exactly one of these lines (alone on a line) to \`${replyPath}\`:`,
    '',
    '- `continue with primary` — run round 1+ with the primary reviewer every round',
    '- `stop` — end the loop without further design rounds',
    '',
    'Then run the design loop again with `--resume`.',
  ].join('\n');
}

export function parseVisionReply(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim().toLowerCase();
    if (trimmed === 'continue with primary') return { action: 'continue' };
    if (trimmed === 'stop') return { action: 'stop' };
  }
  return { action: null };
}

async function appendLog(outDir, entry, { templatePath } = {}) {
  const logPath = path.join(outDir, 'LOG.md');
  let header = '';
  try {
    header = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const template = templatePath
      ? await fs.readFile(templatePath, 'utf8')
      : '# Design loop log\n';
    header = template.replace('<project>', 'project').replace('<target>', entry.target ?? '');
  }
  const block = typeof entry.block === 'string' ? entry.block : '';
  const next = header.endsWith('\n') ? `${header}${block}` : `${header}\n${block}`;
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(logPath, next);
}

export async function runDesignLoop(configPath, {
  dryRun = false,
  resume = false,
  workers,
  now = () => Date.now(),
  knownAdapters,
  skillDir = DESIGN_LOOP_SKILL,
} = {}) {
  const configText = await fs.readFile(configPath, 'utf8');
  const cfg = normalizedCfg(JSON.parse(configText));
  const adapters = knownAdapters ?? ['codex', 'claude', 'cursor', ...EXTRA_CLI_AGENTS];
  const validation = validateConfig(cfg, { knownAdapters: adapters });
  if (!validation.ok) {
    const error = new Error(`invalid design-loop config: ${validation.errors.join('; ')}`);
    error.code = 'design-loop-config';
    error.errors = validation.errors;
    throw error;
  }

  if (dryRun) {
    return { status: 'dry-run', plan: dryRunPlan(cfg) };
  }

  const outDir = path.resolve(path.dirname(configPath), cfg.out);
  const statePath = path.join(outDir, 'state.json');
  let state = await readJson(statePath, null);

  if (resume) {
    if (!state) {
      const error = new Error('resume refused: no saved run state');
      error.code = 'design-loop-resume';
      throw error;
    }
    if (state.status === 'awaiting-human') {
      const replyPath = visionReplyPath(outDir);
      try {
        await fs.access(replyPath);
      } catch {
        const error = new Error(`resume refused: missing ${replyPath}`);
        error.code = 'design-loop-resume';
        throw error;
      }
      const visionReply = parseVisionReply(await fs.readFile(replyPath, 'utf8'));
      if (visionReply.action === 'stop') {
        state.status = 'stopped';
        state.stopReason = 'human-stopped-after-vision-test';
        await appendLog(outDir, {
          block: `\n- Human vision reply: stop (no further rounds)\n`,
        });
        await writeJson(statePath, state);
        return { status: 'stopped', reason: state.stopReason, state };
      }
      if (visionReply.action !== 'continue') {
        const error = new Error(
          `resume refused: ${replyPath} must contain a line "continue with primary" or "stop"`,
        );
        error.code = 'design-loop-resume';
        throw error;
      }
      state.visionTestPassed = false;
      state.forcePrimaryReviewer = true;
      state.status = 'running';
      state.round = 1;
      await appendLog(outDir, {
        block: `\n- Human vision reply: continue with primary — reviewer every round: ${cfg.reviewer.primary}\n`,
      });
      await writeJson(statePath, state);
    } else if (state.status === 'awaiting-checkpoint') {
      const replyPath = path.join(outDir, `round-${state.checkpointRound}`, 'CHECKPOINT.reply.md');
      try {
        await fs.access(replyPath);
      } catch {
        const error = new Error(`resume refused: missing ${replyPath}`);
        error.code = 'design-loop-resume';
        throw error;
      }
      const reply = parseCheckpointReply(await fs.readFile(replyPath, 'utf8'));
      state.humanItems = reply.human;
      state.status = 'running';
      state.round = (state.checkpointRound ?? state.round) + 1;
    } else {
      const error = new Error(
        `resume refused: run is not awaiting human input (status: ${state.status ?? 'unknown'})`,
      );
      error.code = 'design-loop-resume';
      throw error;
    }
  } else if (!state) {
    state = {
      round: 0,
      status: 'running',
      visionTestPassed: true,
      history: [],
      changeList: [],
      reviewerInstance: 0,
      humanItems: [],
    };
  }

  const w = workers ?? {};
  const designer = w.designer ?? (async () => { throw workerUnavailableError(null, 'designer worker not configured'); });
  const reviewer = w.reviewer ?? (async () => { throw workerUnavailableError(null, 'reviewer worker not configured'); });
  const visionReviewer = w.visionReviewer ?? reviewer;
  const capture = w.capture ?? (async () => {});

  const maxRound = cfg.rounds.max;
  const checkpoints = new Set(cfg.rounds.checkpoints);

  try {
    while (state.status === 'running' && state.round <= maxRound) {
      const round = state.round;
      const roundDir = path.join(outDir, `round-${round}`);

      if (round === 0) {
        await capture(round);
        const images = await listCaptureImages(roundDir);
        const visionPrompt = buildVisionTestPrompt(images);
        let primaryList;
        let cheapList;
        try {
          const primaryMarkdown = await visionReviewer({
            instanceId: 'vision-primary-0',
            round: 0,
            worker: cfg.reviewer.primary,
            prompt: visionPrompt,
            imagePaths: images,
            visionTest: true,
          });
          const cheapMarkdown = await visionReviewer({
            instanceId: 'vision-cheap-0',
            round: 0,
            worker: cfg.reviewer.cheap,
            prompt: visionPrompt,
            imagePaths: images,
            visionTest: true,
          });
          primaryList = parseTopFiveList(primaryMarkdown);
          cheapList = parseTopFiveList(cheapMarkdown);
        } catch (error) {
          if (error.code === 'worker-unavailable') {
            state.status = 'stopped';
            state.stopReason = 'required worker unavailable';
            await writeJson(statePath, state);
            return { status: 'stopped', reason: state.stopReason };
          }
          throw error;
        }
        const overlap = visionOverlap(primaryList, cheapList);
        const passed = visionTestPassedFromLists(primaryList, cheapList);
        state.visionTest = { overlap, passed, primaryList, cheapList };
        state.visionTestPassed = passed;
        await appendLog(outDir, {
          target: cfg.target,
          block: `\n## Round 0\n- Captures: ${roundDir}\n- Started: ${new Date(now()).toISOString()}\n- Vision test: overlap ${overlap} (passed: ${passed})\n`,
        }, { templatePath: path.join(skillDir, 'LOG.template.md') });
        if (!passed) {
          state.status = 'awaiting-human';
          const replyPath = visionReplyPath(outDir);
          const pauseBody = buildVisionHumanPauseContent({
            replyPath,
            primaryReviewer: cfg.reviewer.primary,
            overlap,
          });
          await fs.mkdir(roundDir, { recursive: true });
          await fs.writeFile(path.join(roundDir, 'VISION.md'), `${pauseBody}\n`);
          await writeJson(statePath, state);
          return { status: 'awaiting-human', overlap, message: pauseBody };
        }
        await writeJson(statePath, state);
        state.round = 1;
        await writeJson(statePath, state);
        continue;
      }

      const changeList = nextChangeList({
        human: state.humanItems ?? [],
        carry: state.carryOver ?? [],
        reviewer: state.pendingReviewer ?? [],
      });
      state.humanItems = [];

      const designerPrompt = buildDesignerPrompt({
        target: cfg.target,
        changeList,
        rubric: cfg.rubric,
        done: cfg.done,
        round,
      });
      try {
        await designer({
          round,
          target: cfg.target,
          changeList,
          rubric: cfg.rubric,
          done: cfg.done,
          locks: cfg.locks ?? {},
          prompt: designerPrompt,
        });
      } catch (error) {
        if (error.code === 'worker-unavailable') {
          state.status = 'stopped';
          state.stopReason = 'required worker unavailable';
          await writeJson(statePath, state);
          return { status: 'stopped', reason: state.stopReason };
        }
        throw error;
      }

      await capture(round);

      const reviewerWorker = reviewerFor(round, cfg, { visionTestPassed: state.visionTestPassed !== false });
      state.reviewerInstance += 1;
      const instanceId = `reviewer-${state.reviewerInstance}`;
      const imagePaths = await listCaptureImages(roundDir);
      const reviewPrompt = await buildReviewPrompt(cfg, round, { outDir, history: state.history, skillDir });
      let reviewMarkdown;
      try {
        reviewMarkdown = await reviewer({
          instanceId,
          round,
          worker: reviewerWorker,
          prompt: reviewPrompt,
          imagePaths,
          roundDir,
        });
      } catch (error) {
        if (error.code === 'worker-unavailable') {
          state.status = 'stopped';
          state.stopReason = 'required worker unavailable';
          await writeJson(statePath, state);
          return { status: 'stopped', reason: state.stopReason };
        }
        throw error;
      }

      const parsed = parseReview(reviewMarkdown);
      const carry = carryOver(parsed);
      const allDoneGreen = parsed.done.length > 0 && parsed.done.every(d => d.status === 'GREEN');
      const average = roundAverage(parsed.scores);
      const historyEntry = {
        round,
        designer: cfg.designer,
        reviewer: reviewerWorker,
        instanceId,
        allDoneGreen,
        done: parsed.done,
        scores: parsed.scores,
        average,
        changes: parsed.changes,
      };
      state.history.push(historyEntry);
      state.carryOver = carry;
      state.pendingReviewer = parsed.changes;

      await appendLog(outDir, {
        block: `\n## Round ${round}\n- Designer: ${cfg.designer}  Reviewer: ${reviewerWorker}  (${instanceId})\n- DONE: ${parsed.done.filter(d => d.status === 'GREEN').length}/${parsed.done.length} green\n- Scores avg: ${average ?? 'n/a'}\n`,
      });

      const stop = stopDecision(state.history, cfg, { round });
      if (stop.stop) {
        state.status = 'stopped';
        state.stopReason = stop.reason;
        await writeJson(statePath, state);
        return { status: 'stopped', reason: stop.reason, state };
      }

      if (checkpoints.has(round)) {
        const checkpointPath = path.join(roundDir, 'CHECKPOINT.md');
        await fs.mkdir(roundDir, { recursive: true });
        await fs.writeFile(checkpointPath, [
          `# Checkpoint round ${round}`,
          '',
          '## Scores',
          ...(parsed.scores.map((s, i) => `${i + 1}. ${s.line}: ${s.score}`)),
          '',
          '## Done',
          ...parsed.done.map(d => `- ${d.n}: ${d.status}`),
          '',
          '## Ranked changes',
          ...parsed.changes.map((c, i) => `${i + 1}. ${c}`),
          '',
          `Reply in \`${path.join(roundDir, 'CHECKPOINT.reply.md')}\` with agree/disagree per item and up to 3 human items (lines starting with "human:").`,
        ].join('\n'));
        state.status = 'awaiting-checkpoint';
        state.checkpointRound = round;
        await writeJson(statePath, state);
        return {
          status: 'awaiting-checkpoint',
          round,
          message: `Checkpoint at round ${round}; write ${path.join(roundDir, 'CHECKPOINT.reply.md')} then run with --resume`,
        };
      }

      state.round = round + 1;
      await writeJson(statePath, state);
    }

    await writeJson(statePath, state);
    return { status: 'complete', state };
  } catch (error) {
    throw error;
  }
}

async function resolveTargetCwd(configPath, cfg) {
  const base = path.dirname(configPath);
  const target = path.resolve(base, cfg.target);
  try {
    const info = await fs.stat(target);
    return info.isDirectory() ? target : path.dirname(target);
  } catch {
    return base;
  }
}

async function runCodexWorker({ model, cwd, sandbox, prompt, imagePaths, spawnImpl, tmpDir }) {
  const lastMessageFile = path.join(tmpDir, `codex-${Date.now()}.txt`);
  const args = designLoopCodexArgv({ model, cwd, lastMessageFile, sandbox, imagePaths });
  try {
    await spawnWithStdin('codex', args, { cwd, env: process.env, stdin: prompt, spawnImpl });
    try {
      return await fs.readFile(lastMessageFile, 'utf8');
    } catch {
      return '';
    }
  } catch (error) {
    if (error.code === 'worker-unavailable') throw error;
    throw error;
  }
}

async function runClaudeWorker({ model, role, cwd, prompt, spawnImpl }) {
  const args = designLoopClaudeArgv({ model, role });
  try {
    const { stdout } = await spawnWithStdin('claude', args, { cwd, env: process.env, stdin: prompt, spawnImpl });
    return claudeResponseText(stdout);
  } catch (error) {
    if (error.code === 'worker-unavailable') throw error;
    throw error;
  }
}

async function runCursorDesigner({ model, cwd, prompt, spawnImpl, home = os.homedir() }) {
  if (process.platform !== 'darwin') throw workerUnavailableError(new Error('cursor designer requires macOS seatbelt'));
  const message = prompt;
  const { bin, installDir } = await resolveCursorBinary(process.env).catch(error => { throw workerUnavailableError(error); });
  const profilePath = path.join(cwd, `.design-loop-cursor-${Date.now()}.sb`);
  const profile = cursorProfile({ home, installDir, worktree: cwd, commonDir: cwd, metadataDir: path.join(cwd, '.git') });
  await fs.writeFile(profilePath, profile);
  const args = cursorLaunchArgs({ agent: 'cursor', model }, { profile: profilePath, bin, worktree: cwd, message, apiKey: process.env.CURSOR_API_KEY ?? null });
  assertFreshWorkerArgv(args);
  const env = await cursorEnvironment(process.env);
  try {
    const { stdout } = await spawnWithStdin('sandbox-exec', args, { cwd, env, stdin: '', spawnImpl });
    const parsed = parseCursorOutput(stdout);
    return parsed?.response ?? stdout;
  } catch (error) {
    if (error.code === 'worker-unavailable') throw error;
    throw error;
  } finally {
    await fs.unlink(profilePath).catch(() => {});
  }
}

export function createCliWorkers({ configPath, projectRoot, spawnImpl } = {}) {
  if (!configPath) throw new Error('createCliWorkers requires configPath');
  const configDir = path.dirname(configPath);
  let cfgCache = null;
  const loadCfg = async () => {
    if (!cfgCache) {
      cfgCache = normalizedCfg(JSON.parse(await fs.readFile(configPath, 'utf8')));
    }
    return cfgCache;
  };

  async function dispatchWorker(workerString, role, { prompt, imagePaths = [] }) {
    const parsed = parseWorkerString(workerString);
    if (!parsed) throw workerUnavailableError(new Error(`invalid worker ${workerString}`));
    const cfg = await loadCfg();
    const cwd = await resolveTargetCwd(configPath, cfg);
    const { spawn } = await import('node:child_process');
    const run = spawnImpl ?? spawn;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-loop-worker-'));
    try {
      if (parsed.adapter === 'codex') {
        const sandbox = role === 'designer' ? 'workspace-write' : 'read-only';
        return await runCodexWorker({
          model: parsed.model,
          cwd,
          sandbox,
          prompt,
          imagePaths: role === 'reviewer' ? imagePaths : [],
          spawnImpl: run,
          tmpDir,
        });
      }
      if (parsed.adapter === 'claude') {
        const claudeRole = role === 'designer' ? 'designer' : 'reviewer';
        let claudePrompt = prompt;
        if (claudeRole === 'reviewer' && imagePaths.length) {
          claudePrompt = `${prompt}\n\nAttached screenshot files (read-only):\n${imagePaths.join('\n')}`;
        }
        return await runClaudeWorker({ model: parsed.model, role: claudeRole, cwd, prompt: claudePrompt, spawnImpl: run });
      }
      if (parsed.adapter === 'cursor') {
        if (role !== 'designer') throw workerUnavailableError(new Error('cursor cannot be a reviewer'));
        if (!CURSOR_MODEL.test(parsed.model)) throw workerUnavailableError(new Error('invalid cursor model'));
        return await runCursorDesigner({ model: parsed.model, cwd, prompt, spawnImpl: run });
      }
      throw workerUnavailableError(new Error(`unsupported adapter ${parsed.adapter}`));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    designer: async job => dispatchWorker((await loadCfg()).designer, 'designer', { prompt: job.prompt }),
    reviewer: async job => dispatchWorker(job.worker, 'reviewer', { prompt: job.prompt, imagePaths: job.imagePaths ?? [] }),
    visionReviewer: async job => dispatchWorker(job.worker, 'reviewer', { prompt: job.prompt, imagePaths: job.imagePaths ?? [] }),
    capture: async round => {
      const { spawn } = await import('node:child_process');
      const run = spawnImpl ?? spawn;
      const spec = path.join(DESIGN_LOOP_SKILL, 'capture.spec.ts');
      return new Promise((resolve, reject) => {
        const child = run('npx', ['playwright', 'test', spec], {
          cwd: projectRoot ?? configDir,
          env: { ...process.env, LOOP_CONFIG: configPath, ROUND: String(round) },
          stdio: 'inherit',
        });
        child.on('error', error => reject(workerUnavailableError(error)));
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`capture failed with ${code}`))));
      });
    },
  };
}
