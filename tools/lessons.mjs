// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { loadPrivateNames, findPrivateNameHitsInText } from './ship.mjs';

const STORE = 'coordination/swarm-lessons.jsonl';
const LEGACY = 'coordination/swarm-lessons.md';
const KEYS = ['id', 'date', 'area', 'evidence', 'rule', 'fix', 'public', 'status', 'test', 'version'];
const STATES = ['queued', 'built', 'shipped', 'dropped'];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const AREA = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_NAMES = [...KEYS, 'reopen', 'arguments', 'command', 'file', 'private-names', 'queued', 'shipped', 'older-than', 'agent', 'model', 'tier', 'stale-days', 'installed', 'from', 'dry-run', 'verbose', 'root', 'registry', 'manifest', 'help'];
const OPTION_FIELDS = { storeFile: 'file', publishFile: 'file', privateNamesFile: 'private-names', olderThan: 'older-than', staleDays: 'stale-days', dryRun: 'dry-run' };
const fieldName = key => FIELD_NAMES.includes(OPTION_FIELDS[key] ?? key) ? (OPTION_FIELDS[key] ?? key) : 'arguments';
const argsError = field => lessonError('lesson-args', { field });
const ioError = field => lessonError('lesson-io', { field });

export const LESSON_USAGE = `Usage: swarm [--root PROJECT] lesson COMMAND [options]
  add --area AREA --evidence TEXT --rule TEXT --fix TEXT [--public TEXT]
  list [--queued|--shipped] [--area AREA] [--older-than DAYS]
  set ID --status queued|built|shipped|dropped [--version V] [--test PATH]
  manifest ID --agent A --model M [--tier cheap|mid|expensive]
  check [--stale-days DAYS] [--installed DIR]
  publish --version V
  import [--from FILE] [--dry-run] [--verbose]
Common: --file PATH --private-names FILE --help -h
--file selects the JSONL store, except publish where it selects the public Markdown file.
`;

export function lessonError(code, details = {}) {
  let safe;
  const field = fieldName(details.field);
  switch (code) {
    case 'lesson-args': case 'private-name': safe = { status: 'error', code, field }; break;
    case 'lesson-io': safe = { status: 'error', code, field: ['root', 'file', 'from', 'installed', 'private-names', 'registry', 'area', 'command'].includes(field) ? field : 'command' }; break;
    case 'skill-too-long': safe = { status: 'error', code, tokens: Number.isSafeInteger(details.tokens) ? details.tokens : 801, cap: 800 }; break;
    case 'lesson-store-invalid': case 'lesson-import-invalid': safe = { status: 'error', code, line: Number.isSafeInteger(details.line) && details.line > 0 ? details.line : 1 }; break;
    case 'lesson-not-found': safe = { status: 'error', code, id: Number.isSafeInteger(details.id) && details.id > 0 ? details.id : 1 }; break;
    case 'lesson-area-invalid': case 'lesson-route-invalid': safe = { status: 'error', code, field: 'area' }; break;
    case 'lesson-id-overflow': safe = { status: 'error', code, field: 'id' }; break;
    case 'lesson-manifest-invalid': safe = { status: 'error', code, field: 'manifest' }; break;
    case 'lesson-public-file-invalid': safe = { status: 'error', code, field: 'file' }; break;
    case 'public-line-unsafe': safe = { status: 'error', code, field: ['public', 'rule', 'fix'].includes(field) ? field : 'public', pattern: ['private-name', 'run-id', 'repo', 'url', 'handle', 'home-path', 'ticket-id'].includes(details.pattern) ? details.pattern : 'private-name' }; break;
    default: safe = { status: 'error', code: 'lesson-io', field: 'command' };
  }
  return Object.assign(new Error(safe.code), { lessonError: safe });
}

function nonempty(value) { return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0'); }
function validTest(value) {
  return typeof value === 'string' && /^tests\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..');
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function rowProblem(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== KEYS.length + (Object.hasOwn(row, 'reopen') ? 1 : 0) || KEYS.some(key => !Object.hasOwn(row, key))) return 'arguments';
  if (Object.hasOwn(row, 'reopen') && (typeof row.reopen !== 'string' || !/^[a-z]+$/i.test(row.reopen))) return 'reopen';
  if (!Number.isSafeInteger(row.id) || row.id < 1) return 'id';
  if (!validDate(row.date)) return 'date';
  for (const key of ['area', 'evidence', 'rule', 'fix']) if (!nonempty(row[key])) return key;
  for (const key of ['public', 'test', 'version']) if (row[key] !== null && !nonempty(row[key])) return key;
  for (const key of ['rule', 'public']) if (row[key] !== null && (/[\r\n\0]/.test(row[key]) || row[key].trim() !== row[key])) return key;
  if (!STATES.includes(row.status)) return 'status';
  if (row.test !== null && !validTest(row.test)) return 'test';
  if (row.version !== null && !VERSION.test(row.version)) return 'version';
  return null;
}
function orderedRow(row) { return Object.fromEntries([...KEYS, ...(Object.hasOwn(row, 'reopen') ? ['reopen'] : [])].map(key => [key, row[key]])); }
function validateRows(rows) {
  const ids = new Set();
  if (!Array.isArray(rows)) throw lessonError('lesson-store-invalid', { line: 1 });
  rows.forEach((row, i) => {
    if (rowProblem(row) || ids.has(row.id)) throw lessonError('lesson-store-invalid', { line: i + 1 });
    ids.add(row.id);
  });
}

export function parseLessonArgs(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw argsError('arguments');
  const commands = {
    add: ['area', 'evidence', 'rule', 'fix', 'public'], list: ['queued', 'shipped', 'area', 'older-than'],
    set: ['status', 'version', 'test'], manifest: ['agent', 'model', 'tier'],
    check: ['stale-days', 'installed'], publish: ['version'], import: ['from', 'dry-run', 'verbose']
  };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const command = argv[0];
  if (!Object.hasOwn(commands, command)) throw argsError('command');
  if (argv.length === 2 && ['--help', '-h'].includes(argv[1])) return { command, help: true };
  const options = { command }, seen = new Set();
  let i = 1;
  if (['set', 'manifest'].includes(command)) {
    if (!/^[0-9]+$/.test(argv[i] ?? '') || !Number.isSafeInteger(Number(argv[i])) || Number(argv[i]) < 1) throw argsError('id');
    options.id = Number(argv[i++]);
  }
  const allowed = new Set([...commands[command], 'file', 'private-names']);
  for (; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw argsError('arguments');
    const key = flag.slice(2);
    if (seen.has(key)) throw argsError(key);
    seen.add(key);
    const mapped = key === 'file' ? (command === 'publish' ? 'publishFile' : 'storeFile')
      : ({ 'private-names': 'privateNamesFile', 'older-than': 'olderThan', 'stale-days': 'staleDays', 'dry-run': 'dryRun' }[key] ?? key);
    if (key === 'queued' || key === 'shipped' || key === 'dry-run' || key === 'verbose') { options[mapped] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--') || value === '-h') throw argsError(key);
    options[mapped] = value;
    if (key === 'older-than' || key === 'stale-days') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw argsError(key);
      options[mapped] = Number(value);
    }
  }
  if (options.queued && options.shipped) throw argsError('arguments');
  // Add's value checks follow its raw-field privacy scan in the handler.
  if (command !== 'add') {
    for (const [key, value] of Object.entries(options)) if (typeof value === 'string' && !nonempty(value)) throw argsError(fieldName(key));
    if (options.status !== undefined && !STATES.includes(options.status)) throw argsError('status');
    if (options.tier !== undefined && !['cheap', 'mid', 'expensive'].includes(options.tier)) throw argsError('tier');
    if (options.version !== undefined && !VERSION.test(options.version)) throw argsError('version');
    if (options.test !== undefined && !validTest(options.test)) throw argsError('test');
    for (const key of ({ set: ['status'], manifest: ['agent', 'model'], publish: ['version'] }[command] ?? [])) if (options[key] === undefined) throw argsError(key);
  }
  return options;
}

export async function assertLessonPrivateSafe(root, fields, options = {}) {
  let terms;
  try {
    if (options.privateNamesFile != null && !(await fs.stat(path.resolve(root, options.privateNamesFile))).isFile()) throw ioError('private-names');
    ({ terms } = await loadPrivateNames(root, options.privateNamesFile ?? null, { env: options.env ?? process.env, home: options.home ?? os.homedir() }));
  } catch { throw ioError('private-names'); }
  const keys = [...KEYS.filter(key => Object.hasOwn(fields, key)), ...Object.keys(fields).filter(key => !KEYS.includes(key)).sort()];
  for (const key of keys) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    let hit;
    try { hit = findPrivateNameHitsInText(fieldName(key), String(value), terms).length > 0; }
    catch { throw ioError('private-names'); }
    if (hit) throw lessonError('private-name', { field: fieldName(key) });
  }
}

function storePath(root, options) { return path.resolve(root, options.storeFile ?? STORE); }
async function readBytes(file, field = 'file') {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw ioError(field); }
}
function parseStore(bytes) {
  if (bytes === null) return [];
  const text = bytes.toString('utf8'), rows = [], ids = new Set();
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    let start = 0, line = 1;
    for (let end = 0; end <= bytes.length; end++) {
      if (end !== bytes.length && bytes[end] !== 10) continue;
      const physical = bytes.subarray(start, end);
      if (!Buffer.from(physical.toString('utf8'), 'utf8').equals(physical)) throw lessonError('lesson-store-invalid', { line });
      start = end + 1; line++;
    }
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const invalid = () => lessonError('lesson-store-invalid', { line: i + 1 });
    let row;
    try { row = JSON.parse(lines[i]); } catch { throw invalid(); }
    if (rowProblem(row) || ids.has(row.id) || (i === lines.length - 1 && !text.endsWith('\n'))) throw invalid();
    ids.add(row.id); rows.push(orderedRow(row));
  }
  return rows;
}
export async function readLessons(root, options = {}) {
  try { return parseStore(await readBytes(storePath(root, options))); }
  catch (error) { if (error.lessonError) throw error; throw ioError('file'); }
}

// Lock identity remains stable even before the store's parent directory exists.
async function canonicalTarget(file) {
  let parent = file, suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(parent), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw ioError('file');
      const next = path.dirname(parent);
      if (next === parent) throw ioError('file');
      suffix.unshift(path.basename(parent)); parent = next;
    }
  }
}
async function withStoreLock(file, action) {
  const identity = await canonicalTarget(file);
  const lock = path.join(os.tmpdir(), `swarm-lesson-${createHash('sha256').update(identity).digest('hex')}.lock`);
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); } catch { throw ioError('file'); }
  try { return await action(); }
  finally { await handle.close().catch(() => {}); await fs.unlink(lock).catch(() => {}); }
}

// Prepare every replacement and rollback copy before changing any destination.
async function replaceFiles(changes) {
  const staged = [], committed = [];
  let recoveryFailed = false;
  try {
    for (const change of changes) {
      let info;
      try { info = await fs.lstat(change.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info && (!info.isFile() || info.isSymbolicLink())) throw ioError(change.field ?? 'file');
      const next = `${change.file}.${randomUUID()}.tmp`, backup = `${change.file}.${randomUUID()}.bak`;
      staged.push({ ...change, next, backup, mode: info?.mode ?? 0o600 });
    }
    for (const entry of staged) {
      await fs.mkdir(path.dirname(entry.file), { recursive: true });
      await fs.writeFile(entry.next, entry.text, { flag: 'wx', mode: entry.mode });
      if (entry.before !== null) await fs.writeFile(entry.backup, entry.before, { flag: 'wx', mode: entry.mode });
    }
    for (const entry of staged) { await fs.rename(entry.next, entry.file); committed.push(entry); }
  } catch (error) {
    try {
      for (const entry of committed.reverse()) {
        if (entry.before === null) await fs.unlink(entry.file);
        else await fs.rename(entry.backup, entry.file);
      }
    } catch { recoveryFailed = true; throw ioError('file'); }
    if (error.lessonError) throw error;
    throw ioError('file');
  } finally {
    for (const entry of staged) {
      await fs.unlink(entry.next).catch(() => {});
      if (!recoveryFailed) await fs.unlink(entry.backup).catch(() => {});
    }
  }
}
const serialize = rows => rows.map(row => JSON.stringify(orderedRow(row)) + '\n').join('');

export async function writeLessons(root, rows, options = {}) {
  validateRows(rows);
  await assertLessonPrivateSafe(root, { storeFile: options.storeFile, privateNamesFile: options.privateNamesFile }, options);
  const file = storePath(root, options);
  await withStoreLock(file, async () => {
    const before = await readBytes(file), previous = parseStore(before);
    const byId = new Map(previous.map(row => [row.id, JSON.stringify(row)]));
    for (const row of rows) if (byId.get(row.id) !== JSON.stringify(orderedRow(row))) await assertLessonPrivateSafe(root, row, options);
    await replaceFiles([{ file, before, text: serialize(rows) }]);
  });
}

// A pipe is a separator only outside code spans and when it is not escaped.
function tableCells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  const cells = []; let cell = '', ticks = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (c === '`') {
      let n = 1; while (text[i + n] === '`') n++;
      if (!ticks) ticks = n; else if (ticks === n) ticks = 0;
      cell += '`'.repeat(n); i += n - 1; continue;
    }
    if (c === '|' && !ticks) { cells.push(cell.trim()); cell = ''; } else cell += c;
  }
  if (cell.trim() || !text.endsWith('|')) cells.push(cell.trim());
  return cells;
}
const markerRE = /\b(Swarm\s+fix|Rule|Fix|Status):(?:\*\*|__)?\s*/gi;
function markers(text) { return [...text.matchAll(markerRE)]; }
function beforeMarker(text, index) { return text.slice(0, index).replace(/(?:\*\*|__)$/, '').trim(); }

function parseLegacyRows(text, records, diagnostics) {
  const rows = [], seen = new Map();
  for (const [offset, line, parsedCells, reopen] of records ?? String(text).split(/\r?\n/).entries()) {
    if (!/^\s*\|?\s*[+-]?\d/.test(line) || !line.includes('|')) continue;
    const cells = parsedCells ?? tableCells(line);
    // Numeric narrative outside a table is not a data row.
    if (!/^[+-]?\d/.test(cells[0] ?? '')) continue;
    if (!line.trim().startsWith('|') && !/^[+-]?\d+(?:\.\d+)?$/.test(cells[0])) continue;
    const invalid = () => lessonError('lesson-import-invalid', { line: offset + 1 });
    if (cells.length < 4 || !/^\d+$/.test(cells[0])) throw invalid();
    const id = Number(cells[0]), date = cells[1], happened = cells[2];
    if (!Number.isSafeInteger(id) || id < 1 || !validDate(date)) throw invalid();
    let evidence = happened, rule, fix, status = 'queued', version = null;
    const unlabeled = [];
    let firstLabeled = Infinity;
    for (let i = 2; i < cells.length; i++) {
      const cell = cells[i], found = markers(cell);
      const contentMarkers = found.filter(m => m[1].toLowerCase() !== 'status');
      if (i > 2 && contentMarkers.length) firstLabeled = Math.min(firstLabeled, i);
      if (i === 2 && contentMarkers.length) evidence = beforeMarker(cell, contentMarkers[0].index);
      for (let m = 0; m < found.length; m++) {
        const match = found[m], label = match[1].toLowerCase();
        const end = found[m + 1]?.index ?? cell.length;
        const tail = cell.slice(match.index + match[0].length, end);
        const value = (found[m + 1] ? tail.replace(/(?:\*\*|__)$/, '') : tail).trim();
        if (label === 'status') {
          const parsed = /^([a-z]+)\b(?:\s+([^\s()]+))?/i.exec(value);
          if (!parsed || !STATES.includes(parsed[1].toLowerCase())) {
            if (!records) throw invalid();
            status = 'queued'; version = null; continue;
          }
          status = parsed[1].toLowerCase();
          version = ['built', 'shipped'].includes(status) && VERSION.test(parsed[2] ?? '') ? parsed[2] : null;
        } else if (label === 'rule') rule = value;
        else fix = value;
      }
      if (i > 2 && !contentMarkers.length) {
        const body = found.length ? beforeMarker(cell, found[0].index) : cell.trim();
        if (/^(queued|built|shipped|dropped)(?:\s|$)/i.test(body)) {
          const [state, ver] = body.split(/\s+/); status = state.toLowerCase();
          version = ['built', 'shipped'].includes(status) && VERSION.test(ver ?? '') ? ver : null;
        } else if (records && i === 5 && !found.length && body) {
          status = 'queued'; version = null;
        } else if (body) unlabeled.push({ body, index: i });
      }
    }
    const remaining = unlabeled.filter(cell => cell.index >= firstLabeled || firstLabeled === Infinity);
    const evidenceCells = unlabeled.filter(cell => cell.index < firstLabeled && firstLabeled !== Infinity);
    if (!fix && remaining.length) fix = remaining.pop().body;
    evidence = [evidence, ...evidenceCells.map(cell => cell.body), ...remaining.map(cell => cell.body)].filter(Boolean).join('\n');
    rule = (rule || happened || (records ? 'legacy lesson ' + id : '')).replace(/\s+/g, ' ').trim();
    fix = fix || rule;
    evidence = evidence || `legacy lesson ${id}`;
    const row = { id, date, area: 'tool', evidence, rule, fix, public: null, status, test: null, version };
    if (reopen) row.reopen = reopen;
    if (rowProblem(row)) {
      if (!records) throw invalid();
      diagnostics.skipped.push({ line: offset + 1, reason: 'invalid-row' }); continue;
    }
    const encoded = JSON.stringify(row);
    if (seen.has(id)) {
      if (records) diagnostics.skipped.push({ line: offset + 1, reason: 'duplicate-id' });
      else if (seen.get(id) !== encoded) throw invalid();
      continue;
    }
    seen.set(id, encoded); rows.push(row);
  }
  return rows;
}

// Keep the array return contract; import callers can also collect row diagnostics.
export function parseLegacyLessons(text, diagnostics = {}) {
  diagnostics.padded = []; diagnostics.overflow = []; diagnostics.skipped = [];
  const lines = String(text).split(/\r?\n/);
  const header = /^\s*\|?\s*#\s*\|\s*Date\s*\|\s*What happened\s*\|\s*Evidence\s*\|\s*Proposed swarm fix\s*\|\s*Status\s*\|?\s*$/i;
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const isHeader = offset => {
    const line = lines[offset], cells = tableCells(line);
    return header.test(line) || (line.includes('|') && cells.length > 1 && cells.some(Boolean)
      && !separator.test(line) && separator.test(lines[offset + 1] ?? ''));
  };
  const start = lines.findIndex((line, offset) => isHeader(offset));
  if (start < 0) throw lessonError('lesson-import-invalid', { line: 1 });
  const rowStart = /^\s*\|\s*(\d+)([a-z]*)\s*\|/i;
  const logical = [];
  let current;
  for (let offset = start + 1; offset < lines.length; offset++) {
    const line = lines[offset], match = rowStart.exec(line);
    if (match) {
      current = { offset, line, id: Number(match[1]), reopen: match[2] };
      logical.push(current);
    } else if (current) {
      if (isHeader(offset) || /^\s*#{1,6}\s/.test(line) || (!line.trim() && current.line.trimEnd().endsWith('|'))) break;
      current.line += '\n' + line;
    }
  }
  // Plain ids win even when their reopened counterpart appears earlier.
  const plain = new Set(logical.filter(row => !row.reopen).map(row => row.id));
  const records = [];
  for (const { offset, line, id, reopen } of logical) {
    const cells = tableCells(line);
    if (cells.length < 6) {
      diagnostics.padded.push(id);
      while (cells.length < 6) cells.push('');
    } else if (cells.length > 6) {
      diagnostics.overflow.push(id);
      cells.splice(5, cells.length - 5, cells.slice(5).join(' | '));
    }
    const reason = !Number.isSafeInteger(id) || id < 1 ? 'invalid-id'
      : reopen && plain.has(id) ? 'duplicate-id' : !validDate(cells[1]) ? 'invalid-date' : null;
    if (reason) { diagnostics.skipped.push({ line: offset + 1, reason }); continue; }
    cells[0] = String(id);
    records.push([offset, line, cells, reopen]);
  }
  const rows = parseLegacyRows('', records, diagnostics);
  diagnostics.skipped.sort((a, b) => a.line - b.line);
  return rows;
}

export function lessonAgeDays(date, now = Date.now) {
  const today = new Date(now()).toISOString().slice(0, 10);
  return Math.max(0, Math.floor((Date.parse(today) - Date.parse(date)) / 86400000));
}
export async function lessonQueueWarnings(root, options = {}) {
  const queued = (await readLessons(root)).filter(row => row.status === 'queued').sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  if (!queued.length) return [];
  const oldest = queued[0];
  await assertLessonPrivateSafe(root, { id: oldest.id, date: oldest.date, status: oldest.status }, options);
  return [`lesson-queue: ${queued.length} queued, oldest #${oldest.id} (${lessonAgeDays(oldest.date, options.now ?? Date.now)} days)`];
}

async function routeFor(root, row) {
  if (row.area === 'tool') return null;
  const invalid = () => lessonError('lesson-route-invalid');
  if (!AREA.test(row.area)) throw lessonError('lesson-area-invalid');
  const relative = row.area === 'gotchas' ? '.swarm/gotchas.md' : `coordination/skills/${row.area}/SKILL.md`;
  let realRoot;
  try { realRoot = await fs.realpath(root); } catch { throw ioError('root'); }
  const file = path.join(realRoot, relative), parts = relative.split('/');
  let cursor = realRoot;
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let info;
    try { info = await fs.lstat(cursor); }
    catch (error) {
      if (error.code === 'ENOENT') {
        if (row.area !== 'gotchas') throw lessonError('lesson-area-invalid');
        break;
      }
      throw ioError('area');
    }
    if (info.isSymbolicLink()) {
      if (i === parts.length - 1) throw invalid();
      let resolved;
      try { resolved = await fs.realpath(cursor); } catch { throw invalid(); }
      const rel = path.relative(realRoot, resolved);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw invalid();
    } else if (i === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw invalid();
  }
  const before = await readBytes(file, 'area'), text = before?.toString('utf8') ?? '';
  const bullet = `- ${row.rule} (lesson ${row.id})\n`;
  let next;
  if (row.area === 'gotchas') {
    next = text + (text && !text.endsWith('\n') ? '\n' : '') + bullet;
    if (Buffer.byteLength(next, 'utf8') > 16 * 1024) throw invalid();
  } else {
    const headings = [...text.matchAll(/^## Lessons\r?$/gm)];
    if (headings.length > 1) throw invalid();
    if (!headings.length) next = text + (text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n') + '## Lessons\n\n' + bullet;
    else {
      const start = headings[0].index + headings[0][0].length;
      const following = /^#{1,2} /m.exec(text.slice(start));
      const end = following ? start + following.index : text.length;
      const prefix = text.slice(0, end);
      next = prefix + (prefix.endsWith('\n') ? '' : '\n') + bullet + text.slice(end);
    }
    const tokens = Math.ceil(Buffer.byteLength(next, 'utf8') / 4);
    if (tokens > 800) throw lessonError('skill-too-long', { tokens, cap: 800 });
  }
  return { file, before, text: next, relative, field: 'area' };
}

async function addPlan(root, options, privacy, now) {
  await assertLessonPrivateSafe(root, options, privacy);
  for (const key of ['area', 'evidence', 'rule', 'fix']) if (!nonempty(options[key])) throw argsError(key);
  for (const key of ['public', 'storeFile', 'privateNamesFile']) if (options[key] !== undefined && !nonempty(options[key])) throw argsError(fieldName(key));
  for (const key of ['rule', 'public']) if (options[key] !== undefined && /[\r\n\0]/.test(options[key])) throw argsError(key);
  try { if (!(await fs.stat(root)).isDirectory()) throw ioError('root'); } catch { throw ioError('root'); }
  const file = storePath(root, options), before = await readBytes(file), rows = parseStore(before);
  const legacyBytes = await readBytes(path.join(root, LEGACY), 'from');
  const legacy = legacyBytes === null ? [] : parseLegacyRows(legacyBytes.toString('utf8'));
  let maximum = 0;
  for (const row of [...rows, ...legacy]) maximum = Math.max(maximum, row.id);
  if (maximum === Number.MAX_SAFE_INTEGER) throw lessonError('lesson-id-overflow');
  const row = { id: maximum + 1, date: new Date(now()).toISOString().slice(0, 10), area: options.area, evidence: options.evidence, rule: options.rule.trim(), fix: options.fix, public: options.public === undefined ? null : options.public.trim(), status: 'queued', test: null, version: null };
  await assertLessonPrivateSafe(root, row, privacy);
  const problem = rowProblem(row); if (problem) throw argsError(problem);
  const route = await routeFor(root, row);
  if (route) {
    await assertLessonPrivateSafe(root, { area: route.relative }, privacy);
    if (await canonicalTarget(file) === await canonicalTarget(route.file)) throw lessonError('lesson-route-invalid');
  }
  return { file, before, row, route };
}

export async function runLessonCore(root, options, deps = {}) {
  if (options.help || options.command === 'help') return { stdout: LESSON_USAGE, exitCode: 0 };
  const privacy = { ...deps, privateNamesFile: options.privateNamesFile };
  const now = deps.now ?? Date.now;
  try {
    if (options.command === 'add') {
      // Preflight before even acquiring the lock; repeat under it for fresh id allocation.
      await addPlan(root, options, privacy, now);
      return await withStoreLock(storePath(root, options), async () => {
        const { file, before, row, route } = await addPlan(root, options, privacy, now);
        const text = (before?.toString('utf8') ?? '') + JSON.stringify(row) + '\n';
        await replaceFiles([...(route ? [route] : []), { file, before, text }]);
        return { stdout: JSON.stringify({ status: 'ok', lesson: row, routedTo: route?.relative ?? null }) + '\n', exitCode: 0 };
      });
    }
    await assertLessonPrivateSafe(root, options, privacy);
    if (options.command === 'list') {
      const rows = (await readLessons(root, options)).filter(row => (!options.queued || row.status === 'queued') && (!options.shipped || row.status === 'shipped') && (options.area === undefined || row.area === options.area) && (options.olderThan === undefined || lessonAgeDays(row.date, now) > options.olderThan)).sort((a, b) => a.id - b.id);
      let stdout = '';
      for (const row of rows) {
        const fields = { id: row.id, date: row.date, area: row.area, status: row.status, rule: row.rule.slice(0, 100) };
        await assertLessonPrivateSafe(root, fields, privacy);
        stdout += `#${row.id} ${row.date} ${row.area} ${row.status} ${fields.rule}\n`;
      }
      return { stdout, exitCode: 0 };
    }
    if (options.command === 'set') return await withStoreLock(storePath(root, options), async () => {
      const file = storePath(root, options), before = await readBytes(file), rows = parseStore(before);
      const index = rows.findIndex(row => row.id === options.id);
      if (index < 0) throw lessonError('lesson-not-found', { id: options.id });
      const row = { ...rows[index], status: options.status, ...(options.version === undefined ? {} : { version: options.version }), ...(options.test === undefined ? {} : { test: options.test }) };
      await assertLessonPrivateSafe(root, row, privacy);
      const problem = rowProblem(row); if (problem) throw argsError(problem);
      rows[index] = row;
      await replaceFiles([{ file, before, text: serialize(rows) }]);
      return { stdout: JSON.stringify({ status: 'ok', lesson: row }) + '\n', exitCode: 0 };
    });
    throw argsError('command');
  } catch (error) { if (error.lessonError) throw error; throw ioError('command'); }
}
