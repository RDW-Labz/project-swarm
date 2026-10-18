import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const NL = String.fromCharCode(10);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const WS_RE = new RegExp('[ ' + String.fromCharCode(9, 10, 13) + ']+', 'g');
const DOWN_MARK = /^--[ ]*migrate:down/im;
const APPROVALS = '.swarm/project/migration-approvals.json';
const CMD_KEYS = ['up', 'down', 'seed'];
const CONFIG_KEYS = ['dir', 'down', 'downDir', 'commands', 'env'];
const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONFIG'];
// The environment a migration command gets: a short allow list (never provider keys), plus names the profile lists in migrations.env.
export function migrationEnv(extraNames = [], env = process.env) {
  const out = {};
  for (const name of [...ENV_KEEP, ...extraNames]) if (typeof env[name] === 'string') out[name] = env[name];
  return out;
}
export const MIGRATION_DEFAULTS = Object.freeze({ dir: 'supabase/migrations', down: 'sibling', commandTimeoutMs: 300000 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BS = String.fromCharCode(92);
const isWord = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
// One pass over the SQL. Returns a view of the same length (so line numbers and offsets stay valid) where comments and string literals are
// blanked, double-quoted identifiers become a placeholder word, and dollar-quoted bodies (DO blocks, function bodies) stay as code: what runs
// inside them is still a statement. keepLineComments keeps `--` comments, to find the down marker.
export function lexSql(sql, { keepLineComments = false } = {}) {
  const s = String(sql);
  let out = '';
  const dollars = [];
  let i = 0;
  const blankOf = (text) => text.replace(/[^\n]/g, ' ');
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '-' && next === '-') {
      let j = s.indexOf(NL, i);
      if (j < 0) j = s.length;
      out += keepLineComments ? s.slice(i, j) : blankOf(s.slice(i, j));
      i = j;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === '/' && s[j + 1] === '*') { depth += 1; j += 2; } else if (s[j] === '*' && s[j + 1] === '/') { depth -= 1; j += 2; } else j += 1;
      }
      out += blankOf(s.slice(i, j));
      i = j;
    } else if (c === SQ) {
      const escaped = /[eE]/.test(s[i - 1] ?? '') && !isWord(s[i - 2]);
      let j = i + 1;
      while (j < s.length) {
        if (escaped && s[j] === BS) { j += 2; continue; }
        if (s[j] === SQ) { if (s[j + 1] === SQ) { j += 2; continue; } break; }
        j += 1;
      }
      j = Math.min(j + 1, s.length);
      out += blankOf(s.slice(i, j));
      i = j;
    } else if (c === DQ) {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === DQ) { if (s[j + 1] === DQ) { j += 2; continue; } break; }
        j += 1;
      }
      j = Math.min(j + 1, s.length);
      out += 'q'.repeat(j - i);
      i = j;
    } else if (c === '$' && !isWord(s[i - 1])) {
      const m = /^[$][A-Za-z_]*[$]/.exec(s.slice(i, i + 70));
      if (m) {
        if (dollars.length && dollars[dollars.length - 1] === m[0]) dollars.pop();
        else dollars.push(m[0]);
        out += ' '.repeat(m[0].length);
        i += m[0].length;
      } else { out += c; i += 1; }
    } else { out += c; i += 1; }
  }
  return out;
}
const stripNonCode = (sql) => lexSql(sql);
const lineAt = (text, idx) => text.slice(0, idx).split(NL).length;
export function validateMigrationsConfig(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, config: null, errors: ['migrations config must be an object'] };
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.includes(k)) errors.push('unknown key: ' + k);
  const rawDir = raw.dir ?? MIGRATION_DEFAULTS.dir;
  const segments = typeof rawDir === 'string' ? rawDir.split('/').filter((part) => part !== '' && part !== '.') : [];
  if (typeof rawDir !== 'string' || rawDir.startsWith('/') || segments.length === 0 || segments.includes('..'))
    errors.push('dir must be a relative path without ..');
  const dir = segments.join('/');
  let envNames = [];
  if (raw.env !== undefined) {
    if (!Array.isArray(raw.env) || raw.env.length > 20 || !raw.env.every((n) => typeof n === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(n))) errors.push('env must be an array of at most 20 upper-case variable names');
    else envNames = [...raw.env];
  }
  const down = raw.down ?? MIGRATION_DEFAULTS.down;
  if (down !== 'sibling' && down !== 'section' && down !== 'dir') errors.push('down must be sibling, section or dir');
  // down "dir": down files live in a separate folder the migration tool never reads (Supabase reads every .sql in its migrations folder, so a
  // down file next to its migration is run as a second migration with the same version). Same file name, mirrored path.
  let downDir = null;
  if (raw.downDir !== undefined && down !== 'dir') errors.push('downDir needs down: "dir"');
  if (down === 'dir') {
    const rawDown = raw.downDir ?? (segments.length ? segments.join('/') + '_down' : '');
    const parts = typeof rawDown === 'string' ? rawDown.split('/').filter((part) => part !== '' && part !== '.') : [];
    if (typeof rawDown !== 'string' || rawDown.startsWith('/') || parts.length === 0 || parts.includes('..')) errors.push('downDir must be a relative path without ..');
    else {
      downDir = parts.join('/');
      const nested = (a, b) => a === b || a.startsWith(b + '/');
      if (nested(downDir, dir) || nested(dir, downDir)) errors.push('downDir must be a separate folder, not the migrations folder or inside it (the migration tool would read the down files)');
    }
  }
  const commands = {};
  if (raw.commands !== undefined) {
    if (raw.commands === null || typeof raw.commands !== 'object' || Array.isArray(raw.commands)) errors.push('commands must be an object');
    else
      for (const k of Object.keys(raw.commands)) {
        const argv = raw.commands[k];
        if (!CMD_KEYS.includes(k)) errors.push('unknown command: ' + k);
        else if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string'))
          errors.push('commands.' + k + ' must be a non-empty argv array of strings');
        else commands[k] = [...argv];
      }
  }
  if (errors.length > 0) return { ok: false, config: null, errors };
  return { ok: true, config: { dir, down, ...(downDir ? { downDir } : {}), commands, env: envNames, commandTimeoutMs: MIGRATION_DEFAULTS.commandTimeoutMs }, errors: [] };
}
export function isMigrationFile(file, config) {
  if (typeof file !== 'string' || !config) return false;
  const prefix = config.dir + '/';
  const lower = file.toLowerCase();
  return file.startsWith(prefix) && lower.endsWith('.sql') && !lower.endsWith('.down.sql') && !file.split('/').includes('..');
}
export function downFileFor(file, config) {
  if (config?.down === 'dir' && config.downDir && file.startsWith(config.dir + '/')) return config.downDir + '/' + file.slice(config.dir.length + 1);
  return file.replace(/[.]sql$/i, '.down.sql');
}
// The migration a down file belongs to, or null (a sibling X.down.sql, or a file in the down folder).
export function upFileFor(file, config) {
  if (config?.down === 'dir' && config.downDir && file.startsWith(config.downDir + '/') && /[.]sql$/i.test(file) && !file.split('/').includes('..')) return config.dir + '/' + file.slice(config.downDir.length + 1);
  if (config?.down !== 'dir' && /[.]down[.]sql$/i.test(file)) return file.replace(/[.]down[.]sql$/i, '.sql');
  return null;
}
// The marker only counts as a line comment in real code (not inside a block comment or a string).
function splitDown(sql) {
  const i = lexSql(sql, { keepLineComments: true }).search(DOWN_MARK);
  const clean = lexSql(sql);
  return i < 0 ? { up: clean, down: null } : { up: clean.slice(0, i), down: clean.slice(i) };
}
// True when the statement has a WHERE outside any parentheses (a WHERE inside a subquery does not limit the statement itself).
function hasTopLevelWhere(n) {
  let depth = 0;
  let flat = '';
  for (const c of n) {
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) flat += c;
  }
  return /(^| )where( |$)/.test(flat);
}
const DROP_KINDS = '(table|schema|database|view|materialized view|sequence|type|function|procedure|extension)';
function classify(n) {
  const drop = new RegExp('^drop ' + DROP_KINDS + '( |$)').exec(n);
  if (drop) return drop[1] === 'table' ? 'drop-table' : drop[1] === 'schema' ? 'drop-schema' : 'drop-other';
  if (/^truncate( |$)/.test(n)) return 'truncate';
  if (/^alter /.test(n)) {
    if (/^alter table /.test(n) && /(^| )drop (?!constraint( |$)|default( |$)|not null( |$)|identity( |$)|expression( |$))/.test(n)) return 'drop-column';
    if (/^alter table /.test(n) && /(^| )alter (column )?\S+ (set data )?type( |$)/.test(n)) return 'alter-type';
    if (/(^| )rename( |$)/.test(n)) return 'rename';
  }
  if (/(^|[ (])delete from( |$)/.test(n) && !hasTopLevelWhere(n)) return 'delete-all';
  if (/(^|[ (])update (only )?[\w.]+( (as )?\w+)? set( |$)/.test(n) && !/ do update set( |$)/.test(n) && !/ for update( |$)/.test(n) && !hasTopLevelWhere(n)) return 'update-all';
  if (/(^| )copy .*( |^)program( |$)/.test(n) || /^create extension( |$)/.test(n) || /(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export)\(/.test(n)) return 'privileged';
  return null;
}
export function destructiveStatements(sql) {
  const raw = String(sql);
  const clean = stripNonCode(raw);
  const out = [];
  let offset = 0;
  for (const piece of clean.split(';')) {
    const norm = piece.trim().replace(WS_RE, ' ').toLowerCase();
    if (norm !== '') {
      // Inside a DO block or a function body the first statement follows BEGIN, THEN, ELSE, LOOP or DO.
      const kind = classify(norm) ?? classify(norm.replace(/^.*(?:^| )(?:begin|then|else|loop|do) (?=\S)/, ''));
      if (kind) {
        const start = offset + (piece.length - piece.trimStart().length);
        out.push({
          kind,
          line: lineAt(clean, start),
          text: raw
            .slice(start, offset + piece.length)
            .replace(WS_RE, ' ')
            .trim()
            .slice(0, 120),
        });
      }
    }
    offset += piece.length + 1;
  }
  return out;
}
export function seedLooksReal(argv) {
  return argv.some((a) => /dump|prod|[.]sql[.]gz/i.test(a));
}
export async function checkMigrations({ files = [], config, read, exists, approvals = [] }) {
  const problems = [];
  const needsApproval = [];
  if (config.commands && config.commands.seed && seedLooksReal(config.commands.seed))
    problems.push({
      file: 'commands.seed',
      check: 'seed-looks-real',
      message: 'seed command mentions a real-looking data path (dump, prod or .sql.gz): use synthetic seed data',
    });
  // A change to a down file is a change to its migration: the pair is checked again.
  const wanted = new Set();
  for (const changed of files) {
    const up = typeof changed === 'string' ? upFileFor(changed, config) : null;
    if (up) { if (await exists(up)) wanted.add(up); }
    else wanted.add(changed);
  }
  for (const file of wanted) {
    if (!isMigrationFile(file, config)) continue;
    const bytes = await read(file);
    const sql = Buffer.from(bytes).toString('utf8');
    if (config.down === 'sibling' || config.down === 'dir') {
      const df = downFileFor(file, config);
      const has = (await exists(df)) && stripNonCode(Buffer.from(await read(df)).toString('utf8')).trim().length > 0;
      if (!has) problems.push({ file, check: 'no-down', message: 'migration ' + file + ' has no down step (add ' + df + ')' });
    } else {
      const split = splitDown(sql);
      const has = split.down !== null && split.down.trim().length > 0;
      if (!has)
        problems.push({
          file,
          check: 'no-down',
          message: 'migration ' + file + ' has no down step (add a -- migrate:down section with a statement)',
        });
    }
    const statements = destructiveStatements(config.down === 'section' ? splitDown(sql).up : sql);
    if (statements.length > 0) {
      const sha = sha256(bytes);
      const approved = approvals.some((a) => a && a.file === file && a.sha256 === sha);
      if (!approved) {
        needsApproval.push({ file, sha256: sha, statements });
        const first = statements[0];
        problems.push({
          file,
          check: 'needs-approval',
          message:
            'migration ' +
            file +
            ' drops or rewrites data (' +
            first.kind +
            ' line ' +
            first.line +
            '): the owner must run swarm migrations approve ' +
            file,
        });
      }
    }
  }
  return { ok: problems.length === 0, problems, needsApproval };
}
export async function runRoundTrip({ root, config, exec }) {
  const cmds = (config && config.commands) || {};
  if (!cmds.up || !cmds.down) return { ok: true, steps: [] };
  const plan = [['up', cmds.up]];
  if (cmds.seed) plan.push(['seed', cmds.seed]);
  plan.push(['down', cmds.down]);
  plan.push(['up', cmds.up]);
  const timeoutMs = config.commandTimeoutMs ?? MIGRATION_DEFAULTS.commandTimeoutMs;
  const steps = [];
  for (const [name, argv] of plan) {
    let res;
    try {
      res = await exec(argv, { cwd: root, timeoutMs, env: migrationEnv(config.env) });
    } catch (err) {
      res = { code: -1, stdout: '', stderr: String(err && err.message ? err.message : err) };
    }
    const out = String((res && res.stdout) ?? '') + String((res && res.stderr) ?? '');
    const ok = !!res && (res.exitCode ?? res.code) === 0;
    steps.push({ name, ok, tail: out.slice(-400) });
    if (!ok) return { ok: false, steps };
  }
  return { ok: true, steps };
}
export async function readApprovals(root) {
  try {
    const raw = JSON.parse(await readFile(join(root, APPROVALS), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
export async function addApproval(root, { file, sha256: hash, note = '', now = Date.now() } = {}) {
  if (typeof file !== 'string' || !/^[0-9a-f]{64}$/.test(String(hash))) throw new Error('invalid approval');
  const list = await readApprovals(root);
  const entry = { file, sha256: hash, at: new Date(now).toISOString(), note };
  list.push(entry);
  const target = join(root, APPROVALS);
  await mkdir(dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  await writeFile(tmp, JSON.stringify(list, null, 2) + NL);
  await rename(tmp, target);
  return entry;
}

// Where a project keeps SQL migrations, from the folders the common tools create (Supabase, Prisma, Drizzle, plain db/migrations).
// Returns the repo-relative folder, or null. Used by swarm init to turn the migration check on for a new project.
const MIGRATION_DIRS = ['supabase/migrations', 'prisma/migrations', 'drizzle', 'db/migrations'];
export async function detectMigrationsDir(root) {
  for (const dir of MIGRATION_DIRS) {
    try {
      if ((await stat(join(root, dir))).isDirectory()) return dir;
    } catch {
      // not there
    }
  }
  return null;
}
