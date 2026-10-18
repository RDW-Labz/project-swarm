// SPDX-License-Identifier: Apache-2.0
// `swarm lessons ...` and `swarm eval ...` (Phase 15, part 1). Glue over lesson-schema, lesson-store,
// lesson-backfill, lesson-notes and evals. No model is called here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { listLessons, readLessons, nextLessonId, writeLesson, filterLessons, lessonStats } from './lesson-store.mjs';
import { normalizeLesson, STAGES, CAUGHT_BY, GUARD_KINDS } from './lesson-schema.mjs';
import { backfill } from './lesson-backfill.mjs';
import { importLessons } from './lesson-import.mjs';
import { mine } from './lesson-mine.mjs';
import { queryFromTicket, selectNotes, renderNotes } from './lesson-notes.mjs';
import { listEvals, validateEval, evalManifest, scoreRun, compareBaseline } from './evals.mjs';
import { randomBytes } from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const LESSONS_USAGE = [
  'Usage: swarm lessons list [--stage S] [--tag T] [--caught-by C] [--text T] [--json]',
  '       swarm lessons show ID',
  '       swarm lessons add --stage S --what TEXT --rule TEXT [--fix TEXT] [--caught-by C] [--tag T]... [--lane-model M] [--ticket T-0001] [--requirement R-001] [--guard-kind K] [--guard-text TEXT] [--retries N] [--minutes N] [--usd N]',
  '       swarm lessons check | stats [--json] | backfill [--dry-run] | mine [--min N] [--include-guarded] [--write] [--json]',
  '       swarm lessons import PROJECT_PATH [--project NAME] [--dry-run]     (read the other project\'s coordination/swarm-lessons.jsonl, write lessons/NAME/; the other project is never changed)',
  '       swarm lessons notes "TEXT" [--file PATH]...',
  '       swarm eval list | validate [ID | --all] | manifest [ID... | --all] [--agent A] [--model M] [--out FILE] | score RUN [--record] | gate RUN [--update-baseline]',
  ''].join('\n');

const VALUE_FLAGS = new Set(['--stage', '--tag', '--min', '--caught-by', '--text', '--what', '--rule', '--fix', '--lane-model', '--ticket', '--requirement', '--guard-kind', '--guard-text', '--retries', '--minutes', '--usd', '--file', '--agent', '--model', '--out', '--project']);
const REPEATABLE = new Set(['--tag', '--file']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const out = (text, exitCode = 0) => ({ stdout: text.endsWith('\n') ? text : `${text}\n`, exitCode });
const bad = message => out(`${message}\n${LESSONS_USAGE}`, 1);

export function parseArgs(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    if (!VALUE_FLAGS.has(a)) { flags[a.slice(2)] = true; continue; }
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw fail('lessons-args', `${a} needs a value`);
    const key = a.slice(2);
    if (REPEATABLE.has(a)) (flags[key] ??= []).push(args[i + 1]); else flags[key] = args[i + 1];
    i += 1;
  }
  return { flags, rest };
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

// The swarm repo itself files its lessons under "swarm"; any other project uses its folder name.
async function projectName(root, flags) {
  if (flags.project) return flags.project;
  if (await exists(path.join(root, 'tools', 'swarm.mjs'))) return 'swarm';
  return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

const num = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw fail('lessons-args', `${name} must be a number of 0 or more`);
  return n;
};

const row = l => `${l.id} ${l.stage.padEnd(11)} ${l.caughtBy.padEnd(12)} ${l.rule.slice(0, 90)}  [${l.tags.join(',')}]`;

export async function loadLessonsForNotes(root, installRoot) {
  try {
    const { lessons } = await listLessons(root);
    const extra = installRoot && path.resolve(installRoot) !== path.resolve(root) ? await readLessons([installRoot]) : [];
    return [...lessons, ...(Array.isArray(extra) ? extra : extra.lessons ?? [])];
  } catch { return []; }
}

async function lessonsCommand(root, verb, args, { installRoot }) {
  const { flags, rest } = parseArgs(args);
  const project = await projectName(root, flags);
  if (verb === 'list' || verb === 'stats') {
    const { lessons } = await listLessons(root);
    if (verb === 'stats') {
      const s = lessonStats(lessons);
      return out(flags.json ? JSON.stringify(s) : [`${s.total} lessons, ${s.missed} missed or found in production`, `by stage: ${Object.entries(s.byStage).map(([k, v]) => `${k} ${v}`).join(', ')}`, `by caught by: ${Object.entries(s.byCaughtBy).map(([k, v]) => `${k} ${v}`).join(', ')}`, `top tags: ${s.byTag.slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', ')}`].join('\n'));
    }
    const list = filterLessons(lessons, { stage: flags.stage, tag: flags.tag?.[0], caughtBy: flags['caught-by'], text: flags.text });
    return out(flags.json ? JSON.stringify(list) : (list.length ? list.map(row).join('\n') : 'no lessons'));
  }
  if (verb === 'show') {
    if (rest.length !== 1) return bad('lessons show needs an id');
    const { lessons } = await listLessons(root);
    const found = lessons.find(l => l.id === rest[0]);
    return found ? out(JSON.stringify(found, null, 2)) : out(`no lesson ${rest[0]}`, 1);
  }
  if (verb === 'check') {
    const { lessons, invalid } = await listLessons(root);
    const lines = invalid.slice(0, 20).map(i => `  ${i.file}: ${i.errors.slice(0, 2).join('; ')}`);
    return out([`${lessons.length} valid, ${invalid.length} invalid`, ...lines, ...(invalid.length > 20 ? [`  ...and ${invalid.length - 20} more`] : [])].join('\n'), invalid.length ? 1 : 0);
  }
  if (verb === 'backfill') {
    const r = await backfill(root, { project, dryRun: flags['dry-run'] === true });
    return out([`${flags['dry-run'] ? 'would write' : 'wrote'} ${r.written.length}, skipped ${r.skipped.length} that already exist, failed ${r.failed.length} (of ${r.total})`, ...r.failed.slice(0, 10).map(f => `  ${f.ref}: ${f.reason}`)].join('\n'), r.failed.length ? 1 : 0);
  }
  if (verb === 'import') {
    if (rest.length !== 1) return bad('lessons import needs the project path');
    const r = await importLessons(root, rest[0], { project: flags.project, dryRun: flags['dry-run'] === true });
    const lines = [`${r.project}: ${flags['dry-run'] ? 'would write' : 'wrote'} ${r.written.length}${r.written.length ? ` (${r.written.join(', ')})` : ''}, skipped ${r.skipped.length} already imported, failed ${r.failed.length}`, ...r.duplicates.map(d => `  ${d.id} has the same rule as ${d.of}`), ...r.failed.slice(0, 10).map(f => `  failed ${f.ref}: ${f.reason}`)];
    return out(lines.join('\n'), r.failed.length ? 1 : 0);
  }
  if (verb === 'add') {
    for (const need of ['stage', 'what', 'rule']) if (!flags[need]) return bad(`lessons add needs --${need}`);
    if (!STAGES.includes(flags.stage)) return out(`stage must be one of: ${STAGES.join(', ')}`, 1);
    if (flags['caught-by'] && !CAUGHT_BY.includes(flags['caught-by'])) return out(`caught-by must be one of: ${CAUGHT_BY.join(', ')}`, 1);
    if (flags['guard-kind'] && !GUARD_KINDS.includes(flags['guard-kind'])) return out(`guard-kind must be one of: ${GUARD_KINDS.join(', ')}`, 1);
    const lesson = normalizeLesson({
      version: 1, id: await nextLessonId(root, { project }), project, date: new Date().toISOString().slice(0, 10),
      ...(flags.ticket ? { ticket: flags.ticket } : {}), ...(flags.requirement ? { requirement: flags.requirement } : {}),
      stage: flags.stage, what: flags.what, rule: flags.rule, caughtBy: flags['caught-by'] ?? 'unknown',
      cost: { retries: num(flags.retries, '--retries') ?? 0, minutes: num(flags.minutes, '--minutes') ?? 0, usd: num(flags.usd, '--usd') ?? 0 },
      laneModel: flags['lane-model'] ?? null, fix: flags.fix ?? '',
      guard: { kind: flags['guard-kind'] ?? 'none', text: flags['guard-text'] ?? '', status: 'proposed' },
      tags: flags.tag?.length ? flags.tag : [flags.stage], source: { kind: 'manual' },
    });
    const file = await writeLesson(root, lesson);
    import('./history-hooks.mjs').then(hooks => hooks.recordLessonHistory(root, lesson)).catch(() => {});
    return out(`wrote ${file}`);
  }
  if (verb === 'mine') {
    const min = flags.min === undefined ? 3 : Number(flags.min);
    if (!Number.isInteger(min) || min < 2 || min > 50) return out('--min must be a whole number from 2 to 50', 1);
    const r = await mine(root, { min, includeGuarded: flags['include-guarded'] === true, write: flags.write === true });
    if (flags.json) return out(JSON.stringify(r));
    const lines = [`${r.lessonCount} lessons, ${r.considered} without a built guard, ${r.clusters.length} cluster(s) of at least ${min}`, ...r.clusters.map(c => `  ${c.key}: ${c.size} lessons -> ${c.kind}`)];
    if (flags.write === true) lines.push(`${r.written.length} proposal(s) written${r.written.length ? `: ${r.written.join(', ')}` : ''}${r.skipped.length ? `; ${r.skipped.length} already existed` : ''}`, 'Review each one, build it with a test, and open a PR; nothing is merged automatically.');
    else if (r.clusters.length) lines.push('Nothing written. Add --write to create the proposal files.');
    return out(lines.join('\n'));
  }
  if (verb === 'notes') {
    if (rest.length !== 1) return bad('lessons notes needs the ticket text in quotes');
    const lessons = await loadLessonsForNotes(root, installRoot);
    const words = rest[0].toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const query = { ...queryFromTicket({ title: rest[0], type: 'build', files: flags.file ?? [], context: [], acceptance: [] }), tags: [...new Set(words)] };
    const text = renderNotes(selectNotes(query, lessons));
    return out(text || 'no relevant lessons');
  }
  return bad(verb ? `unknown lessons command: ${verb}` : 'lessons needs a command');
}

const SCORES = ['docs', 'state', 'eval-scores.ndjson'];

async function appendScore(root, record) {
  const dir = await safeWritableDir(root, SCORES.slice(0, -1));
  const file = path.join(dir, SCORES.at(-1));
  await assertRegularOrMissing(file);
  const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); } finally { await handle.close(); }
}

// A missing file is an empty baseline; a file that does not parse comes back as null, which the gate rejects.
async function readBaseline(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, 'evals', 'baseline.json'), 'utf8')); } catch (error) { return error.code === 'ENOENT' ? {} : null; }
}

// Temp file opened O_EXCL|O_NOFOLLOW, then rename: a symlink at the target is never followed.
async function writeFileSafe(root, segments, text) {
  const dir = await safeWritableDir(root, segments.slice(0, -1));
  const file = path.join(dir, segments.at(-1));
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.${segments.at(-1)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(text); await handle.close(); await fs.rename(tmp, file); }
  catch (error) { await handle.close().catch(() => {}); await fs.rm(tmp, { force: true }); throw error; }
}

// Fixture file names like job.mjs or lock.mjs coincide with words in this project's own tests; the manifest
// check would flag those tests as uncovered. They are unrelated to the fixture, so list them as ignored.
async function coverCoincidentalTests(root, manifest) {
  let files = [];
  try { files = (await fs.readdir(path.join(root, 'tests'))).filter(f => f.endsWith('.test.mjs')).sort(); } catch { return; }
  const texts = new Map();
  for (const f of files) texts.set(f, await fs.readFile(path.join(root, 'tests', f), 'utf8').catch(() => ''));
  for (const job of manifest.jobs) {
    const stems = [...new Set(job.outputs.map(o => path.basename(o).replace(/\.[^.]+$/, '')))];
    const hits = files.filter(f => stems.some(s => new RegExp(`\\b${s.replace(/[^A-Za-z0-9_-]/g, '')}\\b`).test(texts.get(f)))).slice(0, 100).map(f => `tests/${f}`);
    // The task's own hidden tests live in the repo too (never shown to the worker); the manifest check would flag them as uncovered.
    const own = `evals/${job.id.slice('eval-'.length)}/hidden`;
    const ownTests = [];
    const walk = async dir => { for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) { const rel = `${dir}/${entry.name}`; if (entry.isDirectory()) await walk(rel); else if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(entry.name)) ownTests.push(rel); } };
    await walk(own);
    hits.push(...ownTests);
    if (!hits.length) continue;
    job.ignoreTests = [...new Set(hits)].slice(0, 100);
    job.prompt += '\nignoreTests: the fixture file names coincide with words in unrelated project tests; the coordinator does not run them for this job.';
  }
}

async function evalCommand(root, verb, args) {
  const { flags, rest } = parseArgs(args);
  const { evals, invalid } = await listEvals(root);
  const pick = () => (flags.all === true || !rest.length ? evals : evals.filter(e => rest.includes(e.id)));
  if (verb === 'list') {
    return out([`${evals.length} evals, ${invalid.length} invalid`, ...evals.map(e => `${e.id}  ${e.spec.title}  [${e.spec.tags.join(',')}]${e.spec.lesson ? `  ${e.spec.lesson}` : ''}`), ...invalid.map(i => `INVALID ${i.id}: ${i.errors[0]}`)].join('\n'), invalid.length ? 1 : 0);
  }
  if (verb === 'validate') {
    const chosen = pick();
    if (!chosen.length) return out('no evals to validate', 1);
    let failed = 0;
    const lines = [];
    for (const e of chosen) {
      const r = await validateEval(e.dir);
      if (!r.ok) failed += 1;
      lines.push(`${r.ok ? 'ok  ' : 'FAIL'} ${e.id} (red ${r.red ? 'yes' : 'NO'}, green ${r.green ? 'yes' : 'NO'})${r.errors.length ? ` ${r.errors[0]}` : ''}`);
    }
    return out([...lines, `${chosen.length - failed} of ${chosen.length} fair (red on the start, green on the solution)`].join('\n'), failed ? 1 : 0);
  }
  if (verb === 'manifest') {
    const chosen = pick();
    if (!chosen.length) return out('no evals selected', 1);
    const manifest = evalManifest(chosen, { agent: flags.agent, model: flags.model });
    await coverCoincidentalTests(root, manifest);
    const file = flags.out ?? 'evals/.run/manifest.json';
    const segments = file.split('/');
    if (path.isAbsolute(file) || segments.includes('..')) return out('--out must be a relative path inside the project', 1);
    await writeFileSafe(root, segments, `${JSON.stringify(manifest, null, 2)}\n`);
    return out(`manifest with ${manifest.jobs.length} job(s) written to ${file}\nNext: swarm run ${file}, then swarm eval score RUN`);
  }
  if (verb === 'score' || verb === 'gate') {
    if (rest.length !== 1) return bad(`eval ${verb} needs a run id`);
    const score = await scoreRun(root, rest[0], { evals });
    const lines = [...score.results.map(r => `${r.pass ? 'pass' : 'FAIL'} ${r.id}${r.pass ? '' : ` (${r.status ?? `exit ${r.exitCode}`})`}`), `${score.passed} of ${score.total} passed (${score.agents.join(',') || '-'}/${score.models.join(',') || '-'}, $${score.costUsd.toFixed(4)})`];
    if (verb === 'score') {
      if (flags.record === true) await appendScore(root, { at: new Date().toISOString(), run: score.runId, agents: score.agents, models: score.models, passed: score.passed, total: score.total, costUsd: score.costUsd, failed: score.results.filter(r => !r.pass).map(r => r.id) });
      return out(lines.join('\n'));
    }
    const baseline = await readBaseline(root);
    const cmp = compareBaseline(score, baseline);
    const reasons = [...cmp.reasons];
    if (invalid.length) reasons.push('invalid-evals');
    lines.push(cmp.baseline ? `baseline for ${cmp.key}: ${cmp.baseline.passed} of ${cmp.baseline.total}` : `no baseline for ${cmp.key}`);
    const reset = flags['reset-baseline'] === true;
    // A baseline only ever moves up on the same eval count; a different count needs an explicit --reset-baseline.
    const mayUpdate = flags['update-baseline'] === true && !invalid.length && score.total > 0 && !cmp.reasons.some(r => ['baseline-invalid', 'mixed-key', 'unknown-key', 'no-evals'].includes(r)) &&
      (reset || !cmp.baseline || (cmp.baseline.total === score.total && score.passed >= cmp.baseline.passed));
    if (mayUpdate) {
      await writeFileSafe(root, ['evals', 'baseline.json'], `${JSON.stringify({ ...(baseline ?? {}), [cmp.key]: { passed: score.passed, total: score.total } }, null, 2)}\n`);
      return out([...lines, `baseline for ${cmp.key} set to ${score.passed} of ${score.total}`, 'gate passed'].join('\n'));
    }
    if (reasons.some(r => r !== 'total-changed') || (reasons.includes('total-changed') && flags['update-baseline'] !== true)) {
      return out([...lines, `GATE FAILED: ${reasons.join(', ')}`].join('\n'), 1);
    }
    if (reasons.includes('total-changed')) return out([...lines, 'GATE FAILED: the eval count changed; rerun with --update-baseline --reset-baseline to accept it'].join('\n'), 1);
    return out([...lines, 'gate passed'].join('\n'));
  }
  return bad(verb ? `unknown eval command: ${verb}` : 'eval needs a command');
}

export async function runLessonsCommand(root, command, args, { installRoot } = {}) {
  try {
    const [verb, ...more] = args;
    if (command === 'eval') return await evalCommand(root, verb, more);
    return await lessonsCommand(root, verb, more, { installRoot });
  } catch (error) {
    if (error.code && /^(lesson|lessons|eval|ticket)/.test(error.code)) return out(`${error.code}: ${error.message}`, 1);
    throw error;
  }
}

