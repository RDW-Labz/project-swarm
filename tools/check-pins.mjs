// SPDX-License-Identifier: Apache-2.0
// Field lesson #224/#225: the same stale internal pin (a library exact-pinning the shared core
// package, or an exact pin left behind after a vendored wheel moved on) showed up three times in
// one day before anyone noticed at a fresh install. This check reads what each repo actually ships
// (pyproject.toml + uv.lock + vendored wheel METADATA, or package.json + vendored tarballs) so the
// mismatch fails fast, in CI, instead of at `uv sync --offline` weeks later.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const normalizeName = name => String(name).toLowerCase().replace(/[_.]+/g, '-');
const isAppRepo = (name, appPrefix) => appPrefix != null && String(name ?? '').startsWith(appPrefix);

// --- version comparison (plain dotted versions; good enough for our internal packages) ---------

export function compareVersions(a, b) {
  const pa = String(a).split(/[.+]/), pb = String(b).split(/[.+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i] ?? '0', xb = pb[i] ?? '0';
    const na = Number(xa), nb = Number(xb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) { if (na !== nb) return na < nb ? -1 : 1; }
    else if (xa !== xb) return xa < xb ? -1 : 1;
  }
  return 0;
}

// --- requirement specs: "acme-core==0.4.0", "acme-lib-a>=0.5,<0.6", "acme-lib-c[extra]==1.2" -----

const SPEC_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/;
const CLAUSE_RE = /^(==|!=|>=|<=|>|<|~=)\s*([A-Za-z0-9_.+-]+)$/;

export function parseRequirement(spec) {
  const m = SPEC_RE.exec(String(spec).trim());
  if (!m) return null;
  const [, rawName, rest] = m;
  const clauses = rest.split(',').map(s => s.trim()).filter(Boolean);
  const exact = clauses.length === 1 && clauses[0].startsWith('==') ? clauses[0].slice(2).trim() : null;
  return { name: normalizeName(rawName), exact, clauses, raw: rest };
}

export function satisfiesRequirement(version, requirement) {
  for (const clause of requirement.clauses) {
    const m = CLAUSE_RE.exec(clause);
    if (!m) continue;
    const [, op, target] = m;
    const cmp = compareVersions(version, target);
    if (op === '==' && cmp !== 0) return false;
    if (op === '!=' && cmp === 0) return false;
    if (op === '>=' && cmp < 0) return false;
    if (op === '<=' && cmp > 0) return false;
    if (op === '>' && cmp <= 0) return false;
    if (op === '<' && cmp >= 0) return false;
    if (op === '~=' && cmp < 0) return false;
  }
  return true;
}

// --- pyproject.toml: name + the [project] dependencies array only, no general TOML parsing -----

export function parsePyprojectDependencies(text) {
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  const block = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
  const dependencies = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(block))) dependencies.push(m[1]);
  return { name, dependencies };
}

// --- uv.lock: repeated [[package]] blocks, name + version only ---------------------------------

export function parseUvLockVersions(text) {
  const versions = new Map();
  for (const block of String(text).split(/^\[\[package\]\]/m).slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) versions.set(normalizeName(name), version);
  }
  return versions;
}

// --- wheel/tarball filenames -> {name, version} -------------------------------------------------

export function parseWheelFilename(filename) {
  const m = /^([A-Za-z0-9_.]+)-([A-Za-z0-9_.!+]+)-[^-]+-[^-]+-[^-]+\.whl$/.exec(filename);
  return m ? { name: normalizeName(m[1]), version: m[2] } : null;
}

export function parseTarballFilename(filename) {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d[A-Za-z0-9._+-]*)\.(?:tgz|tar\.gz)$/i.exec(filename);
  return m ? { name: normalizeName(m[1]), version: m[2] } : null;
}

function groupVersions(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    const list = grouped.get(entry.name) ?? [];
    list.push(entry.version);
    grouped.set(entry.name, list);
  }
  return grouped;
}

// --- METADATA out of a wheel (a plain zip); node built-ins only, no new npm deps ---------------

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip file (no end of central directory record)');
}

function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, name) {
  const entry = readCentralDirectory(buffer).find(e => e.name === name);
  if (!entry) return null;
  const local = entry.localHeaderOffset;
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return data;
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${entry.compressionMethod}`);
}

export async function readWheelMetadata(wheelPath) {
  const buffer = await fs.readFile(wheelPath);
  const entries = readCentralDirectory(buffer);
  const metadataName = entries.find(e => e.name.endsWith('.dist-info/METADATA'))?.name;
  if (!metadataName) return '';
  return (readZipEntry(buffer, metadataName) ?? Buffer.alloc(0)).toString('utf8');
}

export function parseRequiresDist(metadataText) {
  const reqs = [];
  for (const line of String(metadataText).split(/\r?\n/)) {
    const m = /^Requires-Dist:\s*(.+)$/i.exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if (value.includes(';')) continue; // conditional/extra requirement, not checked here
    value = value.replace(/\s*\(([^)]*)\)\s*$/, '$1'); // "pkg (>=1,<2)" -> "pkg>=1,<2"
    const req = parseRequirement(value);
    if (req) reqs.push(req);
  }
  return reqs;
}

// --- npm: an exact pin is a plain version, no range operator -----------------------------------

export function exactNpmVersion(spec) {
  return /^\d+[\w.+-]*$/.test(String(spec).trim()) ? spec.trim() : null;
}

// --- [tool.uv.sources]: a name pinned from a local path or git needs no vendored wheel ---------
// Field lesson #204: an exact pin on a package vendored nowhere used to pass silently (R2 only
// ever compared a pin against a vendored copy, so "no vendored copy at all" fell through both of
// its findings). A `[tool.uv.sources]` entry (inline `name = {...}` or a `[tool.uv.sources.name]`
// sub-table) is the one legitimate way an exact pin is backed by something other than a vendored
// wheel; anything else with no vendored copy is now `pin-not-vendored`.
export function parseUvSourcesNames(text) {
  const names = new Set();
  const block = /^\[tool\.uv\.sources\]\r?\n([\s\S]*?)(?=^\[|$)/m.exec(text)?.[1] ?? '';
  for (const m of block.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) names.add(normalizeName(m[1]));
  for (const m of String(text).matchAll(/^\[tool\.uv\.sources\.([A-Za-z0-9][A-Za-z0-9._-]*)\]/gm)) names.add(normalizeName(m[1]));
  return names;
}

// --- shared vendored-version checks (rule names shared by pyproject.toml and package.json) -----

function checkVendored(findings, file, name, pin, vendoredVersions) {
  const versions = vendoredVersions.get(name);
  if (!versions?.length) return;
  if (!versions.includes(pin)) {
    const latest = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    findings.push({ rule: 'pin-not-vendored-version', file, package: name, message: `${name} is pinned to ${pin} but the vendored copy is ${latest}` });
  }
  const newer = versions.filter(v => compareVersions(v, pin) > 0);
  if (newer.length) {
    const newest = newer.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    findings.push({ rule: 'pin-older-than-vendored', file, package: name, message: `${name} is pinned to ${pin} but a newer vendored copy ${newest} exists` });
  }
}

async function readIfExists(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

async function listVendorFiles(dir) {
  try { return await fs.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

function printHuman(result) {
  if (!result.findings.length) { console.log('check-pins: ok, no stale internal pins found'); return; }
  for (const finding of result.findings) console.log(`${finding.rule}: ${finding.file}: ${finding.message}`);
}

export async function runCheckPins({ root, json = false, core, appPrefix }) {
  const findings = [];
  const normalizedCore = core != null ? normalizeName(core) : null;
  const skippedRules = normalizedCore ? [] : ['library-exact-core-pin', 'wheel-requirement-unsatisfied'];

  const vendorDir = path.join(root, 'vendor');
  const vendorFiles = await listVendorFiles(vendorDir);
  const wheelFiles = vendorFiles.filter(f => f.endsWith('.whl'));
  const tarballFiles = vendorFiles.filter(f => /\.(?:tgz|tar\.gz)$/i.test(f));
  const vendoredWheelVersions = groupVersions(wheelFiles.map(parseWheelFilename));
  const vendoredTarballVersions = groupVersions(tarballFiles.map(parseTarballFilename));

  const pyprojectText = await readIfExists(path.join(root, 'pyproject.toml'));
  if (pyprojectText != null) {
    const { name, dependencies } = parsePyprojectDependencies(pyprojectText);
    const uvSourceNames = parseUvSourcesNames(pyprojectText);
    for (const spec of dependencies) {
      const req = parseRequirement(spec);
      if (!req) continue;
      if (normalizedCore && req.exact && req.name === normalizedCore && !isAppRepo(name, appPrefix)) {
        findings.push({ rule: 'library-exact-core-pin', file: 'pyproject.toml', package: req.name, message: `${name ?? 'this library'} pins ${normalizedCore} with == (${req.exact}); libraries must use a range, not an exact pin` });
      }
      if (req.exact) checkVendored(findings, 'pyproject.toml', req.name, req.exact, vendoredWheelVersions);
      // Field lesson #204 (R2b): an exact pin backed by neither a vendored wheel nor a
      // [tool.uv.sources] entry is not backed by anything the tests ran against, agent repos
      // included (no isAppRepo exemption here — that exemption is about the core-pin rule only).
      if (req.exact && !vendoredWheelVersions.get(req.name)?.length && !uvSourceNames.has(req.name)) {
        findings.push({ rule: 'pin-not-vendored', file: 'pyproject.toml', package: req.name, message: `${req.name} is pinned to ${req.exact} but has no vendored wheel and no [tool.uv.sources] entry` });
      }
    }

    if (normalizedCore && normalizeName(name ?? '') === normalizedCore && wheelFiles.length) {
      const lockVersions = parseUvLockVersions(await readIfExists(path.join(root, 'uv.lock')) ?? '');
      for (const file of wheelFiles) {
        const metadataText = await readWheelMetadata(path.join(vendorDir, file));
        for (const req of parseRequiresDist(metadataText)) {
          const locked = lockVersions.get(req.name);
          if (locked == null || satisfiesRequirement(locked, req)) continue;
          findings.push({ rule: 'wheel-requirement-unsatisfied', file: `vendor/${file}`, package: req.name, message: `vendored wheel ${file} requires ${req.name}${req.raw} but uv.lock has ${req.name}==${locked}` });
        }
      }
    }
  }

  const packageJsonText = await readIfExists(path.join(root, 'package.json'));
  if (packageJsonText != null) {
    let pkg = null;
    try { pkg = JSON.parse(packageJsonText); } catch { pkg = null; }
    for (const [depName, depSpec] of Object.entries(pkg?.dependencies ?? {})) {
      const name = normalizeName(depName);
      const exact = exactNpmVersion(depSpec);
      if (exact) checkVendored(findings, 'package.json', name, exact, vendoredTarballVersions);
    }
  }

  const ok = findings.length === 0;
  const result = { ok, exitCode: ok ? 0 : 1, findings, ...(skippedRules.length ? { skippedRules } : {}) };
  if (json) console.log(JSON.stringify(result));
  else printHuman(result);
  return result;
}
