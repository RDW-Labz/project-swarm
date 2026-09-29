// SPDX-License-Identifier: Apache-2.0
// Worker skills: a coordinator-owned directory of SKILL.md files (frontmatter + body) a manifest
// or local config may point at. Absent, every function here is a no-op and every prompt is
// unchanged (feature off, byte-identical to the release before this file existed).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SKILLS_DIR_NAME = '.swarm/skills';
const SKILLS_INDEX_LABEL = 'Skills in .swarm/skills/: ';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fail = (message, code) => { throw Object.assign(new Error(message), code ? { code } : {}); };

// Manifest `skillsDir` (absolute, or relative to root) wins over local config `skills.dir`;
// neither present means the feature is off (null).
export function resolveSkillsDir(manifest, config, root) {
  const raw = typeof manifest?.skillsDir === 'string' && manifest.skillsDir ? manifest.skillsDir
    : typeof config?.skills?.dir === 'string' && config.skills.dir ? config.skills.dir : null;
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
}

// --- a small YAML subset: scalars, lists, and one level of nested map. No anchors, no flow
// style, no multi-line scalars: enough for SKILL.md frontmatter and nothing more.
const indentOf = line => line.match(/^ */)[0].length;
function parseScalar(value) {
  value = value.trim();
  if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}
// Field lesson #224: `key: [a, b]` (flow-style, one line) is the other shape SKILL.md frontmatter
// actually uses; a reader that only understood block lists (`- a`) read it as an empty string.
// No nesting, no quoted commas: split on `,` and parse each item the same way a block list item is.
function parseInlineList(value) {
  const inner = value.slice(1, -1).trim();
  return inner === '' ? [] : inner.split(',').map(parseScalar);
}
export function parseYamlSubset(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '' && !line.trim().startsWith('#'));
  let i = 0;
  function parseList(indent) {
    const items = [];
    while (i < lines.length && indentOf(lines[i]) === indent) {
      const match = /^-\s?(.*)$/.exec(lines[i].slice(indent));
      if (!match) break;
      items.push(parseScalar(match[1]));
      i++;
    }
    return items;
  }
  function parseBlock(indent) {
    const object = {};
    while (i < lines.length) {
      const line = lines[i];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`unexpected indent: ${line}`);
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.slice(indent));
      if (!match) throw new Error(`invalid line: ${line}`);
      const [, key, rest] = match;
      i++;
      const trimmedRest = rest.trim();
      if (trimmedRest.startsWith('[') && trimmedRest.endsWith(']')) { object[key] = parseInlineList(trimmedRest); continue; }
      if (trimmedRest) { object[key] = parseScalar(trimmedRest); continue; }
      if (i < lines.length && indentOf(lines[i]) > indent) {
        const childIndent = indentOf(lines[i]);
        object[key] = /^-\s?/.test(lines[i].slice(childIndent)) ? parseList(childIndent) : parseBlock(childIndent);
      } else object[key] = '';
    }
    return object;
  }
  const result = parseBlock(0);
  if (i !== lines.length) throw new Error('unparsed trailing content');
  return result;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
export function parseSkillFrontmatter(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error('missing frontmatter delimiters');
  return { frontmatter: parseYamlSubset(match[1]), body: match[2] };
}

export function validateSkillFrontmatter(frontmatter, file) {
  const invalid = what => fail(`invalid-skill-frontmatter: ${file}: ${what}`, 'invalid-skill-frontmatter');
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return invalid('not a mapping');
  for (const key of Object.keys(frontmatter)) if (!['name', 'description', 'paths', 'checks'].includes(key)) invalid(`unknown field ${key}`);
  if (typeof frontmatter.name !== 'string' || !SKILL_NAME.test(frontmatter.name)) invalid('invalid name');
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) invalid('invalid description');
  if (frontmatter.paths !== undefined && (!Array.isArray(frontmatter.paths) || frontmatter.paths.some(value => typeof value !== 'string' || !value))) invalid('invalid paths');
  if (frontmatter.checks !== undefined) {
    const checks = frontmatter.checks;
    if (!checks || typeof checks !== 'object' || Array.isArray(checks)) invalid('invalid checks');
    for (const key of Object.keys(checks)) if (!['filesMustChange', 'resultKeys'].includes(key)) invalid(`unknown checks field ${key}`);
    // Field lesson #224: an explicit empty list (`filesMustChange: []`) means "none" — valid, no
    // check ever runs for it — never the same as the field being invalid or absent.
    for (const key of ['filesMustChange', 'resultKeys']) if (checks[key] !== undefined && (!Array.isArray(checks[key]) || checks[key].some(value => typeof value !== 'string' || !value))) invalid(`invalid checks.${key}`);
  }
  return frontmatter;
}

// Token estimate = ceil(chars/4), of the whole SKILL.md file (frontmatter and body alike); a
// skill is never trimmed or edited to fit, only warned or refused about.
export const tokenEstimate = chars => Math.ceil(chars / 4);
export function skillSizeWarnings(skills) {
  return skills.filter(skill => tokenEstimate(skill.chars) > 800).map(skill => `skill-over-800: ${skill.file}`);
}
export function refuseOversizeSkills(skills) {
  const over = skills.filter(skill => tokenEstimate(skill.chars) > 1200);
  if (over.length) fail(`skill-over-1200: ${over.map(skill => skill.file).join(', ')}`, 'skill-over-1200');
}

// A path glob supports `*` (within one path segment) and `**` (across segments); the same
// restricted shape backs both frontmatter `paths:` auto-attach and `checks.filesMustChange`.
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { out += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') out += '[^/]*';
    else if ('.+^${}()|[]\\'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}
export const pathMatchesGlob = (glob, file) => globToRegExp(glob).test(file);
export const anyPathMatchesGlobs = (globs, files) => (globs ?? []).some(glob => (files ?? []).some(file => pathMatchesGlob(glob, file)));

// Refused anywhere in the tree, not just at the top: a source dir is either copied whole or not
// copied at all.
export async function assertNoSkillSymlinks(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail(`symlink refused: ${full}`, 'skill-symlink');
    if (entry.isDirectory()) await assertNoSkillSymlinks(full);
  }
}
// Field lesson #244: swarm itself seeds these copies into a job's workspace (the job wrote none
// of them), so the dropped-write scan needs to tell an untouched seeded file apart from one a
// worker actually edited; returning each copied file's own path (relative to destDir) and content
// hash lets that scan compare against what was actually seeded instead of guessing by path alone.
export async function copySkillsInto(sourceDir, destDir) {
  await assertNoSkillSymlinks(sourceDir);
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.cp(sourceDir, destDir, { recursive: true });
  return await seededSkillFileHashes(destDir);
}
async function seededSkillFileHashes(destDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(full);
        out.push({ file: path.relative(destDir, full).split(path.sep).join('/'), hash: crypto.createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await walk(destDir);
  return out;
}

// gitHash matches `git hash-object`'s own blob id, computed without shelling out to git: sha1 of
// "blob <byte length>\0" followed by the file's exact bytes.
export function gitBlobHash(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, Buffer.from(bytes)])).digest('hex');
}

// One skill = `<sourceDir>/<any-name>/SKILL.md`; a directory with no SKILL.md is not a skill and
// is silently skipped (never a reason to refuse the whole source dir).
export async function loadSkillFile(file) {
  let info;
  try { info = await fs.lstat(file); } catch { return null; }
  if (info.isSymbolicLink()) fail(`symlink refused: ${file}`, 'skill-symlink');
  const text = await fs.readFile(file, 'utf8');
  let parsed;
  try { parsed = parseSkillFrontmatter(text); }
  catch (error) { fail(`invalid-skill-frontmatter: ${file}: ${error.message}`, 'invalid-skill-frontmatter'); }
  const chars = text.length, gitHash = gitBlobHash(Buffer.from(text, 'utf8'));
  try {
    const frontmatter = validateSkillFrontmatter(parsed.frontmatter, file);
    return { name: frontmatter.name, description: frontmatter.description, paths: frontmatter.paths ?? [], checks: frontmatter.checks ?? null, body: parsed.body, file, chars, gitHash };
  } catch (error) {
    // Field lesson #224: an invalid field (never a structurally unparsable file — that stays a
    // hard error above) only ever needs to block the jobs that would actually attach this skill.
    // Its own raw, still-recoverable name/paths (whether or not they themselves are individually
    // valid) decide that attachment; a job that never names or path-matches it is unaffected.
    const raw = parsed.frontmatter;
    const name = typeof raw?.name === 'string' && SKILL_NAME.test(raw.name) ? raw.name : null;
    const paths = Array.isArray(raw?.paths) ? raw.paths.filter(value => typeof value === 'string' && value) : [];
    return { broken: true, error: error.message, name, description: '(invalid skill)', paths, checks: null, body: '', file, chars, gitHash };
  }
}
export async function listSkills(sourceDir) {
  let entries;
  try { entries = await fs.readdir(sourceDir, { withFileTypes: true }); } catch { return []; }
  const skills = [], names = new Set();
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const skill = await loadSkillFile(path.join(sourceDir, entry.name, 'SKILL.md'));
    if (!skill) continue;
    if (skill.name != null) {
      if (names.has(skill.name)) fail(`invalid-skill-frontmatter: ${skill.file}: duplicate skill name ${skill.name}`, 'invalid-skill-frontmatter');
      names.add(skill.name);
    }
    skills.push(skill);
  }
  return skills;
}

// A manifest job `skills: [...]` (even `[]`) overrides frontmatter `paths:` auto-attach entirely;
// every known skill still gets a record entry, "index-only" when it is neither named nor matched.
export function attachSkillsForJob(skills, job) {
  const named = Array.isArray(job.skills) ? job.skills : null;
  if (named) for (const name of named) if (!skills.some(skill => skill.name === name)) fail(`unknown-skill: ${name}`, 'unknown-skill');
  const files = [...(job.context ?? []), ...(job.outputs ?? [])];
  return skills.map(skill => ({ ...skill, attached: named ? (named.includes(skill.name) ? 'named' : 'index-only') : (anyPathMatchesGlobs(skill.paths, files) ? 'paths' : 'index-only') }));
}

// An index-only skill (neither named nor paths-matched) points at its own copied file, since its
// body was never prepended; a named/paths-attached skill keeps the plain name/description line.
export function skillIndexBlock(skills) {
  if (!skills.length) return '';
  return `${skills.map(skill => `${SKILLS_INDEX_LABEL}${skill.name} — ${skill.description}${skill.attached === 'index-only' ? ` — ${SKILLS_DIR_NAME}/${skill.name}/SKILL.md — read it if your job touches this` : ''}`).join('\n')}\n`;
}
export function skillPrependBlock(attachedSkills) {
  const bodies = attachedSkills.filter(skill => skill.attached !== 'index-only');
  if (!bodies.length) return '';
  return `${bodies.map(skill => `--- skill ${skill.name} ---\n${skill.body.replace(/\s+$/, '')}\n---\n`).join('\n')}\n`;
}
// The whole preamble a job prompt gets: the index (every known skill), then the full body of
// each named/paths-attached one. Empty when there are no skills, so concatenating it onto an
// existing prompt template changes nothing (the off-by-default byte-identical guarantee).
export function skillsPromptBlock(attachedSkills) {
  return `${skillIndexBlock(attachedSkills)}${skillPrependBlock(attachedSkills)}`;
}
export const skillRecordEntries = attachedSkills => attachedSkills.map(({ name, gitHash, attached }) => ({ name, gitHash, attached }));

// Frontmatter `checks` for each attached (named or paths) skill, evaluated at integrate time
// against that job's own changed files and its result object; index-only skills are never checked.
export function skillCheckFailures({ attachedSkills, changedFiles, resultData }) {
  const failures = [];
  for (const skill of attachedSkills) {
    if (skill.attached === 'index-only' || !skill.checks) continue;
    for (const glob of skill.checks.filesMustChange ?? []) {
      if (!anyPathMatchesGlobs([glob], changedFiles)) failures.push(`${skill.name}: filesMustChange ${glob} matched no changed file`);
    }
    for (const key of skill.checks.resultKeys ?? []) {
      if (!resultData || typeof resultData !== 'object' || !Object.hasOwn(resultData, key)) failures.push(`${skill.name}: resultKeys missing ${key}`);
    }
  }
  return failures;
}
