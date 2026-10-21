// SPDX-License-Identifier: Apache-2.0
// swarm init --kit NAME --kit-source PATH_OR_GIT_URL: start a new project from a starter kit (its own repo, never part of project-swarm).
// The kit's kit.json says which files the kit owns, which services need setting up on day 0, and where the swarm builds. Nothing is run from the kit: files are copied.
// The copy is all or nothing: the kit is read and checked first, then written, and a failure puts everything back.
import fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendEvent } from './journal.mjs';
import { normalizeProtectedPath, isSecretPath, isExampleFile } from './init-profile.mjs';

const exec = promisify(execFile);
const KIT_NAME = /^[a-z][a-z0-9-]{1,40}$/;
const SERVICE_ID = /^[a-z][a-z0-9-]{0,30}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,60}$/;
const SKIP_NAMES = new Set(['.git', 'node_modules', '.next', 'coverage', 'test-results', 'playwright-report', '.swarm', '.DS_Store', 'next-env.d.ts', '.vercel']);
// Files only the project owner writes: a kit that ships one is refused (it would supply the profile or the checks that run with the owner's rights).
const RESERVED = ['.project-swarm.json', 'coordination/checks.json'];
const LIMITS = { files: 2000, totalBytes: 20 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, readOnlyPaths: 80 };
// Existing entries that do not stop a kit from being copied in: a new repo with its git folder and swarm's own files.
const ALLOWED_EXISTING = new Set(['.git', '.swarm', '.project-swarm', '.project-swarm.json', '.gitignore', 'README.md']);
const BARE_README_BYTES = 2048;

export const KIT_USAGE = 'Usage: swarm init --kit NAME --kit-source PATH_OR_GIT_URL [--name "Project name"] [--no-protect-kit]   (the folder must be new: a git repo with nothing but a README)';

const bad = message => Object.assign(new Error(message), { code: 'kit-invalid' });
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const relOk = p => typeof p === 'string' && p.length > 0 && p.length <= 200 && p === p.trim() && !p.startsWith('/') && !p.includes('\\') && !/[*?[\]{}\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(p) && !p.split('/').some(x => x === '' || x === '.' || x === '..');

export function validateKit(raw, expectedName) {
  if (!isObj(raw)) throw bad('kit.json is not an object');
  if (typeof raw.kit !== 'string' || !KIT_NAME.test(raw.kit)) throw bad('kit.json: "kit" must be a lowercase name');
  if (expectedName && raw.kit !== expectedName) throw bad(`this source is the kit "${raw.kit}", not "${expectedName}"`);
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw bad('kit.json: "version" must look like 1.2.3');
  const services = Array.isArray(raw.services) ? raw.services : [];
  if (services.length > 20) throw bad('kit.json: at most 20 services');
  for (const s of services) {
    if (!isObj(s) || !SERVICE_ID.test(s.id ?? '') || typeof s.why !== 'string' || typeof s.day0 !== 'string' || s.why.length > 200 || s.day0.length > 800) throw bad('kit.json: each service needs an id, a short why and a day0 text');
  }
  const slots = Array.isArray(raw.slots) ? raw.slots : [];
  if (slots.length > 40) throw bad('kit.json: at most 40 slots');
  for (const s of slots) {
    if (!isObj(s) || typeof s.id !== 'string' || !['kit', 'swarm'].includes(s.owner) || !Array.isArray(s.paths) || s.paths.length > 40 || !s.paths.every(relOk)) throw bad(`kit.json: slot "${s?.id}" needs an id, an owner (kit or swarm) and plain relative paths (no spaces at the ends, no control characters)`);
  }
  const owned = new Set(slots.filter(s => s.owner === 'kit').flatMap(s => s.paths));
  if (owned.size > LIMITS.readOnlyPaths) throw bad(`kit.json: the kit owns ${owned.size} paths; a profile holds at most ${LIMITS.readOnlyPaths} for a kit (list folders, not every file)`);
  const env = Array.isArray(raw.env) ? raw.env : [];
  if (!env.every(n => typeof n === 'string' && ENV_NAME.test(n))) throw bad('kit.json: env must list upper-case variable names');
  const placeholders = isObj(raw.placeholders) ? raw.placeholders : {};
  for (const [file, list] of Object.entries(placeholders)) if (!relOk(file) || !Array.isArray(list) || !list.every(x => typeof x === 'string' && x.length > 0 && x.length <= 60)) throw bad('kit.json: placeholders must map a file to a list of words');
  return { kit: raw.kit, version: raw.version, description: String(raw.description ?? '').slice(0, 300), services: services.map(s => ({ id: s.id, required: s.required === true, why: s.why, day0: s.day0 })), slots, env, placeholders, swarmBuildsOnlyIn: (Array.isArray(raw.swarmBuildsOnlyIn) ? raw.swarmBuildsOnlyIn : []).filter(relOk) };
}

// A path is either a folder or a file on disk: a folder is listed with a trailing slash.
async function readOnlyEntries(root, kit) {
  const out = [];
  for (const slot of kit.slots.filter(s => s.owner === 'kit')) {
    for (const p of slot.paths) {
      const stat = await fs.lstat(path.join(root, p)).catch(() => null);
      if (!stat) continue;
      out.push(normalizeProtectedPath(stat.isDirectory() ? `${p}/` : p));
    }
  }
  return [...new Set(out)];
}

// Secrets and local state never come from a kit: any case, any depth. A names-only template (.env.example) is kept.
const skip = (name, rel) => SKIP_NAMES.has(name) || name.endsWith('.tsbuildinfo') || (isSecretPath(rel.toLowerCase()) && !isExampleFile(rel.toLowerCase())) || /^\.env(\..*)?$/i.test(name) && name.toLowerCase() !== '.env.example';

// Reads the whole kit first and writes nothing: the files to copy, the links left out, and a refusal for anything over the limits or reserved.
async function planCopy(src) {
  const plan = { files: [], skippedLinks: [], bytes: 0 };
  const walk = async (dir, rel) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(entry.name, r)) continue;
      if (RESERVED.includes(r)) throw bad(`the kit contains ${r}, which only the project owner writes; it was not copied`);
      if (entry.isSymbolicLink()) { plan.skippedLinks.push(r); continue; }   // a link in a kit is never followed
      if (entry.isDirectory()) { await walk(path.join(dir, entry.name), r); continue; }
      if (!entry.isFile()) continue;
      if (!relOk(r)) throw bad(`the kit has a file name that is not plain: ${JSON.stringify(r)}`);
      const stat = await fs.lstat(path.join(dir, entry.name));
      if (stat.size > LIMITS.fileBytes) throw bad(`${r} is larger than ${LIMITS.fileBytes / 1024 / 1024} MB`);
      plan.bytes += stat.size;
      plan.files.push({ rel: r, from: path.join(dir, entry.name), size: stat.size });
      if (plan.files.length > LIMITS.files || plan.bytes > LIMITS.totalBytes) throw bad('the kit is larger than the limits (2000 files, 20 MB)');
    }
  };
  await walk(src, '');
  return plan;
}

// The .gitignore of a new repo gets the kit's lines added: never a line that un-ignores something ("!.env"), and never through a link.
async function mergeGitignore(root, kitText) {
  const dest = path.join(root, '.gitignore');
  const stat = await fs.lstat(dest).catch(() => null);
  if (stat && !stat.isFile()) throw bad('.gitignore in the project is a link or not a file; the kit was not copied');
  const existing = stat ? await fs.readFile(dest, 'utf8') : '';
  const have = new Set(existing.split('\n').map(l => l.trim()));
  const add = kitText.split('\n').filter(l => l.trim() && !l.trim().startsWith('!') && !have.has(l.trim()));
  const handle = await fs.open(dest, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(`${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${add.join('\n')}${add.length ? '\n' : ''}`); } finally { await handle.close(); }
}

export const slug = name => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project';
// A name that is safe inside source text: letters, digits, space, dot, dash (no quotes or ampersands that would break a string or a page).
export const displayName = name => String(name).replace(/[^A-Za-z0-9 .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Project';

const redact = text => String(text).replace(/(:\/\/)[^@/\s]+@/g, '$1[redacted]@');

// A git address or a folder. A git address is cloned shallowly into a temp folder first; nothing from it is run.
export async function resolveSource(source, { cloner = defaultClone } = {}) {
  if (typeof source !== 'string' || !source || source.startsWith('-')) throw bad('give the kit with --kit-source PATH_OR_GIT_URL');
  if (/^(https:\/\/|git@[\w.-]+:)/.test(source)) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-kit-'));
    try { await cloner(source, dir); } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw bad(`could not fetch the kit: ${redact(String(error.message).split('\n')[0]).slice(0, 160)}`); }
    return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) throw bad('a kit source is a folder, an https address or a git@ address');
  const dir = await fs.realpath(path.resolve(source)).catch(() => null);
  if (!dir || !(await fs.stat(dir)).isDirectory()) throw bad(`no kit folder at ${redact(source)}`);
  return { dir, cleanup: async () => {} };
}
export const CLONE_ARGS = (url, dir) => ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'clone', '--depth', '1', '--quiet', '--no-recurse-submodules', '--', url, dir];
async function defaultClone(url, dir) { await exec('git', CLONE_ARGS(url, dir), { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, timeout: 120000 }); }

/** Copies the kit into `root`, names the project, lists the kit's files as read-only for tickets, and records the Day 0 services as human tasks. Returns what was done. */
export async function installKit({ root, kitName, source, name, protectKit = true, now = Date.now, cloner }) {
  if (!KIT_NAME.test(String(kitName ?? ''))) throw bad(KIT_USAGE);
  const src = await resolveSource(source, { cloner });
  try {
    let raw;
    try { raw = JSON.parse(await fs.readFile(path.join(src.dir, 'kit.json'), 'utf8')); } catch { throw bad(`${redact(source)} has no readable kit.json`); }
    const kit = validateKit(raw, kitName);
    const existing = (await fs.readdir(root)).filter(n => !ALLOWED_EXISTING.has(n));
    if (existing.length) throw bad(`the project folder is not new (${existing.slice(0, 5).join(', ')}${existing.length > 5 ? ', ...' : ''}): a kit is copied into an empty repo`);
    const plan = await planCopy(src.dir);   // reads and checks everything first
    // Only a bare README is replaced (by the kit's own); a README with real content stays and the kit's is added as KIT-README.md.
    const readmeStat = await fs.lstat(path.join(root, 'README.md')).catch(() => null);
    const keepReadme = Boolean(readmeStat) && (!readmeStat.isFile() || readmeStat.size > BARE_README_BYTES);
    const backups = new Map();
    for (const f of ['README.md', '.gitignore']) { const s = await fs.lstat(path.join(root, f)).catch(() => null); if (s?.isFile()) backups.set(f, await fs.readFile(path.join(root, f))); }
    const written = [], createdDirs = [];
    try {
      for (const f of plan.files) {
        let rel = f.rel;
        if (rel === '.gitignore') { await mergeGitignore(root, await fs.readFile(f.from, 'utf8')); continue; }
        if (rel === 'README.md' && keepReadme) rel = 'KIT-README.md';
        const to = path.join(root, rel);
        const made = await fs.mkdir(path.dirname(to), { recursive: true });
        if (made) createdDirs.push(made);
        // The source is opened without following a link (a file swapped for a link mid-copy is refused), and the target is created, never overwritten (a bare README is the one exception).
        const handle = await fs.open(f.from, C.O_RDONLY | C.O_NOFOLLOW);
        let data;
        try { const st = await handle.stat(); if (!st.isFile() || st.size > LIMITS.fileBytes) throw bad(`${f.rel} changed while it was being copied`); data = await handle.readFile(); } finally { await handle.close(); }
        if (rel === 'README.md') { await fs.rm(to, { force: true }); }
        await fs.writeFile(to, data, { flag: 'wx', mode: 0o644 });
        written.push(rel);
      }
      const project = displayName(name ?? path.basename(root));
      const targets = new Set(written);
      const pkgFile = path.join(root, 'package.json');
      if (targets.has('package.json')) { try { const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8')); pkg.name = slug(name ?? path.basename(root)); pkg.version = '0.1.0'; await fs.writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`); } catch { /* a kit with no readable package.json has nothing to rename */ } }
      // Placeholders are replaced only in files the kit itself just wrote.
      for (const [file, words] of Object.entries(kit.placeholders)) {
        if (file === 'package.json' || !targets.has(file)) continue;
        const target = path.join(root, file);
        let text = await fs.readFile(target, 'utf8');
        for (const w of words) text = text.split(w).join(project);
        await fs.writeFile(target, text);
      }
      const readOnly = protectKit ? await readOnlyEntries(root, kit) : [];
      const day0 = [];
      for (const s of kit.services.slice().sort((a, b) => Number(b.required) - Number(a.required))) {
        const id = `day0-${s.id}`;
        const steps = s.day0.split(/;\s+|\.\s+(?=[A-Z])/).map(x => x.trim().replace(/\.$/, '')).filter(Boolean).slice(0, 8);
        await appendEvent(root, { kind: 'human', id, title: `Day 0${s.required ? '' : ' (optional)'}: ${s.id}, ${s.why}`.slice(0, 160), steps, unblocks: 0 }, { now });
        day0.push(id);
      }
      return { kit: kit.kit, version: kit.version, files: written.length, skippedLinks: plan.skippedLinks, project, readOnly, day0, env: kit.env, swarmBuildsOnlyIn: kit.swarmBuildsOnlyIn };
    } catch (error) {
      // Put the folder back as it was: remove what was written (and the folders made for it), restore the README and .gitignore.
      for (const rel of written.reverse()) await fs.rm(path.join(root, rel), { force: true }).catch(() => {});
      for (const dir of [...new Set(createdDirs)].reverse()) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      for (const f of ['README.md', '.gitignore']) { if (backups.has(f)) await fs.writeFile(path.join(root, f), backups.get(f)).catch(() => {}); else await fs.rm(path.join(root, f), { force: true }).catch(() => {}); }
      throw error;
    }
  } finally { await src.cleanup(); }
}
