// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  LESSON_USAGE, lessonError, readLessons, writeLessons, parseLegacyLessons,
  assertLessonPrivateSafe, lessonAgeDays,
} from './lessons.mjs';

const json = value => ({ stdout: JSON.stringify(value) + '\n', exitCode: 0 });
const io = field => lessonError('lesson-io', { field });
const manifestInvalid = () => lessonError('lesson-manifest-invalid');
const publicInvalid = () => lessonError('lesson-public-file-invalid');
const normalize = text => text.replace(/\s+/g, ' ').trim();
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Resolve existing aliases and missing descendants without trusting lexical ancestry.
async function identity(file) {
  const suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(file), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink is not an absent file that we can safely initialize.
      try { if ((await fs.lstat(file)).isSymbolicLink()) throw publicInvalid(); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(file);
      if (parent === file) throw error;
      suffix.unshift(path.basename(file)); file = parent;
    }
  }
}

async function manifestFile(root, file, { required = false } = {}) {
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) throw manifestInvalid();
  const target = path.resolve(root, file);
  try {
    if (!inside(root, await identity(target))) throw manifestInvalid();
    const info = await fs.stat(target);
    if (!info.isFile()) throw manifestInvalid();
    if (required && !(await fs.readFile(target, 'utf8')).trim()) throw manifestInvalid();
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return false;
    throw manifestInvalid();
  }
}

async function manifest(root, options, deps, privacy) {
  const rows = await readLessons(root, options);
  const row = rows.find(item => item.id === options.id);
  if (!row) throw lessonError('lesson-not-found', { id: options.id });
  await assertLessonPrivateSafe(root, { id: row.id, fix: row.fix, evidence: row.evidence }, privacy);
  let realRoot;
  try { realRoot = await fs.realpath(root); } catch { throw io('root'); }
  const files = new Set();
  // Markdown delimiters surround tokens; a path prefix is never silently stripped.
  const tokens = row.fix.match(/[^\s`"'()[\]{}<>,;!?]+/g) ?? [];
  for (const token of tokens) {
    const file = token.replace(/^[*_]+|[*_.:]+$/g, '');
    if (!/(?:^|[/\\])(?:tools|tests)[/\\].*\.mjs$/.test(file)) continue;
    if (!/^(?:tools|tests)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(file)) throw manifestInvalid();
    if (await manifestFile(realRoot, file)) files.add(file);
  }
  const test = `tests/field-lesson-${row.id}.test.mjs`;
  if (await manifestFile(realRoot, test)) files.add(test);
  await manifestFile(realRoot, 'package.json', { required: true });
  const context = [...files].sort();
  context.push('package.json');
  const job = {
    id: `lesson-${row.id}`, agent: options.agent, model: options.model,
    prompt: `${row.fix}\nEvidence: ${row.evidence}\nAdd a node:test case in ${test} that fails without the fix; fixtures use fake ids, no names, repos, URLs or prompt text.`,
    context, outputs: [...files].filter(file => file.startsWith('tools/')).sort().concat(test),
  };
  if (options.tier !== undefined) job.tier = options.tier;
  if (options.tier === 'expensive') job.tierReason = 'Explicit lesson manifest --tier expensive selection.';
  const result = { version: 1, jobs: [job] };
  await assertLessonPrivateSafe(root, { id: job.id, fix: job.prompt, test, file: context.join('\n') }, privacy);
  try {
    if (typeof deps.validateManifest !== 'function' || typeof deps.validateProject !== 'function') throw manifestInvalid();
    // Existing validators can expand model presets; preserve the explicit requested model.
    await deps.validateManifest(structuredClone(result));
    await deps.validateProject(root, structuredClone(result), { env: deps.env, home: deps.home });
  } catch { throw manifestInvalid(); }
  return json(result);
}

async function check(root, options, deps, privacy) {
  const rows = await readLessons(root, options), findings = [];
  const limit = options.staleDays ?? 7;
  const installed = path.resolve(root, options.installed ?? path.join(deps.home ?? os.homedir(), '.project-swarm/current'));
  const nowValue = (deps.now ?? Date.now)();
  for (const row of rows) {
    if (row.status === 'queued') {
      const days = lessonAgeDays(row.date, () => nowValue);
      if (days > limit) findings.push({ code: 'lesson-stale', id: row.id, days, limit });
    } else if (row.status === 'shipped') {
      let exists = false;
      if (row.test !== null) {
        try {
          const base = await identity(installed), target = path.join(installed, row.test);
          if (!inside(base, await identity(target))) throw io('installed');
          exists = (await fs.stat(target)).isFile();
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw io('installed'); }
      }
      if (!exists) findings.push({ code: 'lesson-test-missing', id: row.id, test: row.test });
    }
  }
  findings.sort((a, b) => a.id - b.id || a.code.localeCompare(b.code));
  for (const finding of findings) await assertLessonPrivateSafe(root, { id: finding.id, test: finding.test }, privacy);
  return json({ status: 'ok', checked: rows.length, findings });
}

async function registryLabels(root) {
  let source;
  try { source = await fs.readFile(path.join(root, '.swarm-projects.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw io('registry'); }
  const labels = new Set();
  const add = text => {
    const label = text.replace(/\.git$/i, '').toLowerCase();
    if (label) labels.add(label);
  };
  const walk = (value, key = '') => {
    if (typeof value === 'string') {
      if (['owner', 'repo', 'name'].includes(key.toLowerCase())) add(value.trim());
      // Strip URL authorities so only repository path segments become bare labels.
      const text = value.replace(/[a-z][a-z0-9+.-]*:\/\/[^/\s]+/gi, '');
      for (const match of text.matchAll(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) { add(match[1]); add(match[2]); }
    } else if (Array.isArray(value)) value.forEach(item => walk(item));
    else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  };
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object') throw io('registry');
    walk(parsed);
  } catch { throw io('registry'); }
  return [...labels];
}

async function publicSafe(root, field, text, labels, privacy) {
  const refuse = pattern => { throw lessonError('public-line-unsafe', { field, pattern }); };
  try { await assertLessonPrivateSafe(root, { [field]: text }, privacy); }
  catch (error) { if (error.lessonError?.code === 'private-name') refuse('private-name'); throw error; }
  if (/\b(?:[a-z][a-z0-9]*-)?\d+-[a-f0-9]+\b/gi.test(text) || /\brun-\d+\b/gi.test(text)) refuse('run-id');
  const pair = /(?:^|[^A-Za-z0-9_./\\-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?=$|[^A-Za-z0-9_.\\-])/g;
  for (const match of text.matchAll(pair)) if (!match[1].toLowerCase().startsWith('www.')) refuse('repo');
  const lower = text.toLowerCase();
  for (const label of labels) {
    let start = lower.indexOf(label);
    while (start >= 0) {
      if (!/[a-z0-9_-]/i.test(lower[start - 1] ?? '') && !/[a-z0-9_-]/i.test(lower[start + label.length] ?? '')) refuse('repo');
      start = lower.indexOf(label, start + 1);
    }
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|\]\s*\([^)]*\)|<[^>\s]+[.:/@][^>]*>|(?:^|\s)\[[^\]]+\]:\s*\S+/i.test(text)) refuse('url');
  if (/@[a-z0-9_][a-z0-9_.-]*/i.test(text)) refuse('handle');
  if (/(?:\/(?:Users|home|root)(?:\/|\b)|[a-z]:[\\/](?:Users|home|Documents and Settings)[\\/]|\\\\[^\s\\]+\\[^\s]+|~(?:[^\s/\\]+)?[/\\])/i.test(text)) refuse('home-path');
  if (/\bT\d+\b/i.test(text)) refuse('ticket-id');
}

const markdown = text => text.replace(/([\\`*_{}\[\]()<>#!|~])/g, '\\$1');

async function publicTarget(root, selected) {
  const file = path.resolve(root, selected);
  try {
    const target = await identity(file);
    let before = null, info = null;
    try {
      info = await fs.stat(target);
      if (!info.isFile()) throw publicInvalid();
      before = await fs.readFile(target);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { file, target, before, info };
  } catch (error) { if (error.lessonError) throw error; throw io('file'); }
}

// Append through the verified inode, preserving both symlink and hard-link aliases.
// On ordinary write failure, truncate back to the preflight byte length.
async function appendPublic(destination, suffix) {
  const { file, target, before, info } = destination;
  let handle, created = false;
  try {
    if (await identity(file) !== target) throw io('file');
    if (before === null) await fs.mkdir(path.dirname(target), { recursive: true });
    handle = await fs.open(target, before === null ? 'wx+' : 'r+', info?.mode ?? 0o600);
    created = before === null;
    const current = await handle.stat();
    if (info && (current.dev !== info.dev || current.ino !== info.ino)) throw io('file');
    const bytes = await handle.readFile();
    if (!bytes.equals(before ?? Buffer.alloc(0))) throw io('file');
    const addition = Buffer.from(suffix);
    let written = 0;
    try {
      while (written < addition.length) {
        const result = await handle.write(addition, written, addition.length - written, bytes.length + written);
        if (!result.bytesWritten) throw io('file');
        written += result.bytesWritten;
      }
    } catch { await handle.truncate(bytes.length); throw io('file'); }
  } catch {
    if (created) await fs.unlink(target).catch(() => {});
    throw io('file');
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function publish(root, options, privacy) {
  const selected = options.publishFile ?? 'docs/lessons.md';
  await assertLessonPrivateSafe(root, { file: selected, version: options.version }, privacy);
  const rows = (await readLessons(root)).filter(row => row.status === 'shipped' && row.version === options.version).sort((a, b) => a.id - b.id);
  const result = { status: 'ok', version: options.version, file: selected, published: [], skipped: [] };
  if (!rows.length) return json(result);
  const labels = await registryLabels(root);
  const destination = await publicTarget(root, selected);
  const before = destination.before?.toString('utf8') ?? '# Field lessons\n';
  const entries = [...before.matchAll(/^(\d+)\.\s+\S/gm)];
  if (destination.before !== null && (!Buffer.from(before).equals(destination.before) || !/^# Field lessons\r?$/m.test(before) || !entries.length)) throw publicInvalid();
  let maximum = 0;
  for (const entry of entries) {
    const number = Number(entry[1]);
    if (!Number.isSafeInteger(number) || number < 1) throw publicInvalid();
    maximum = Math.max(maximum, number);
  }
  const pending = [];
  for (const row of rows) {
    await assertLessonPrivateSafe(root, { id: row.id, version: row.version, test: row.test }, privacy);
    const fields = row.public !== null ? [['public', normalize(row.public)]] : [['rule', normalize(row.rule)], ['fix', normalize(row.fix)]];
    for (const [field, text] of fields) await publicSafe(root, field, text, labels, privacy);
    const candidate = fields.map(([, text]) => text).join(' — ');
    const marker = `<!-- swarm-lesson:${row.id}:${row.version} -->`;
    if (before.split(/\r?\n/).some(line => line.trim() === marker)) { result.skipped.push(row.id); continue; }
    pending.push({ row, fields, candidate, marker });
  }
  if (!Number.isSafeInteger(maximum + pending.length)) throw publicInvalid();
  let suffix = '';
  for (const { row, candidate, marker } of pending) {
    suffix += `${++maximum}. **${markdown(candidate)}**\n    Enforcement: lesson ${row.id}, shipped in ${row.version}.\n    Regression coverage: ${row.test === null ? 'not recorded' : '`' + row.test + '`'}.\n    ${marker}\n`;
    result.published.push(row.id);
  }
  if (pending.length) {
    // Recheck normalized source fields immediately before append; never emit a safe prefix.
    for (const { fields } of pending) for (const [field, text] of fields) await publicSafe(root, field, text, labels, privacy);
    const boundary = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    await appendPublic(destination, (destination.before === null ? before : '') + boundary + suffix);
  }
  return json(result);
}

async function importLessons(root, options, privacy) {
  const from = path.resolve(root, options.from ?? 'coordination/swarm-lessons.md');
  let source;
  try { source = await fs.readFile(from, 'utf8'); } catch { throw io('from'); }
  const diagnostics = {};
  const incoming = parseLegacyLessons(source, diagnostics).sort((a, b) => a.id - b.id);
  const rows = await readLessons(root, options), present = new Set(rows.map(row => row.id));
  const imported = [], skipped = [...diagnostics.skipped];
  const lines = source.split(/\r?\n/), sourceLines = new Map();
  const rejectedLines = new Set(diagnostics.skipped.map(item => item.line));
  const start = lines.findIndex(line => /^\s*\|\s*#\s*\|\s*Date\s*\|\s*What happened\s*\|\s*Evidence\s*\|\s*Proposed swarm fix\s*\|\s*Status\s*\|\s*$/i.test(line));
  // Parser diagnostics exclude invalid and duplicate occurrences of an id.
  for (let offset = start + 1; offset < lines.length; offset++) {
    const match = /^\s*\|\s*(\d+)([a-z]*)\s*\|/i.exec(lines[offset]);
    if (match && !rejectedLines.has(offset + 1) && !sourceLines.has(Number(match[1]))) sourceLines.set(Number(match[1]), offset + 1);
  }
  for (const row of incoming) {
    if (present.has(row.id)) {
      await assertLessonPrivateSafe(root, { id: row.id }, privacy);
      skipped.push(row.id); continue;
    }
    try { await assertLessonPrivateSafe(root, row, privacy); }
    catch (error) {
      if (error.lessonError?.code !== 'private-name') throw error;
      skipped.push({ id: row.id, line: sourceLines.get(row.id), reason: 'private-name', field: error.lessonError.field });
      continue;
    }
    rows.push(row); imported.push(row.id);
  }
  if (options.dryRun) {
    const skippedPrivate = skipped.filter(item => item?.reason === 'private-name');
    const summary = {
      status: 'ok', dryRun: true, imported: imported.length,
      padded: diagnostics.padded.length, overflow: diagnostics.overflow.length,
      skippedPrivate: skippedPrivate.length,
    };
    if (options.verbose) {
      const accepted = new Set(imported), privateIds = new Set(skippedPrivate.map(item => item.id));
      const padded = new Set(diagnostics.padded), overflow = new Set(diagnostics.overflow);
      summary.rows = incoming.filter(row => accepted.has(row.id) || privateIds.has(row.id)).map(row => ({
        id: row.id,
        verdict: privateIds.has(row.id) ? 'skipped-private' : overflow.has(row.id) ? 'overflow' : padded.has(row.id) ? 'padded' : 'import',
      }));
    }
    return json(summary);
  }
  // Coordinator-approved provisional interface: writeLessons owns the writer lock;
  // this read/merge/write sequence has no shared read lock. Repeated ids are skipped.
  if (imported.length) await writeLessons(root, rows, { ...privacy, storeFile: options.storeFile });
  return json({ status: 'ok', imported, skipped, padded: diagnostics.padded, overflow: diagnostics.overflow });
}

export async function runLessonShip(root, options, deps = {}) {
  if (options.help || options.command === 'help') return { stdout: LESSON_USAGE, exitCode: 0 };
  const privacy = { ...deps, privateNamesFile: options.privateNamesFile };
  try {
    await assertLessonPrivateSafe(root, options, privacy);
    if (options.command === 'manifest') return await manifest(root, options, deps, privacy);
    if (options.command === 'check') return await check(root, options, deps, privacy);
    if (options.command === 'publish') return await publish(root, options, privacy);
    if (options.command === 'import') return await importLessons(root, options, privacy);
    throw lessonError('lesson-args', { field: 'command' });
  } catch (error) { if (error.lessonError) throw error; throw io('command'); }
}
