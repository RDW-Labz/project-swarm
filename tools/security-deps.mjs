// SPDX-License-Identifier: Apache-2.0
export const POPULAR_PACKAGES = ['react','lodash','express','axios','request','moment','chalk','commander','debug','webpack','typescript','jest','eslint','prettier','vue','next','tailwindcss','dotenv','uuid','cors','mongoose','jsonwebtoken','bcrypt','passport','socket.io','redux','rxjs','underscore','async','bluebird','yargs','inquirer','glob','rimraf','minimist','semver','colors','node-fetch','body-parser'];
export function editDistance(a, b) {
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[b.length];
}
const NPM_RE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const PY_RE = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/;
const PY_OPTIONS = ['--index-url', '--extra-index-url', '-i', '--find-links', '-f', '-e', '--trusted-host'];
const PY_IGNORED = ['-r', '--requirement', '-c', '--constraint'];
const NON_REGISTRY_PREFIXES = ['git+', 'git:', 'git@', 'github:', 'gitlab:', 'bitbucket:', 'file:', 'link:', 'http:', 'https:'];
const MAX_BYTES = 5 * 1024 * 1024;
const NOT_FOUND = 'not found on the registry (made-up name?)';
const UNREACHABLE = 'could not verify (registry unreachable)';
export function classifySpec(spec) {
  const s = String(spec ?? '').trim();
  const low = s.toLowerCase();
  if (low.startsWith('workspace:')) return { kind: 'workspace' };
  if (low.startsWith('npm:')) {
    const m = /^npm:(@[^/@]+\/[^@]+|[^@]+)/.exec(s);
    if (m) return { kind: 'alias', target: m[1] };
  }
  for (const p of NON_REGISTRY_PREFIXES) if (low.startsWith(p)) return { kind: 'nonRegistry', why: p };
  if (/\.(tgz|tar\.gz|tar)(#.*)?$/i.test(s) || /^(\.{1,2}\/|\/)/.test(s)) return { kind: 'nonRegistry', why: 'tarball' };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#.*)?$/.test(s)) return { kind: 'nonRegistry', why: 'user/repo' };
  return { kind: 'registry' };
}
function normalizePy(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}
function collectLeaves(obj, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === '.') continue;
    if (typeof v === 'string') out.push({ name: k, spec: v });
    else if (v && typeof v === 'object' && !Array.isArray(v)) collectLeaves(v, out);
  }
}
function parseNpm(text, file, out) {
  let j;
  try { j = JSON.parse(text); } catch { return; }
  if (!j || typeof j !== 'object') return;
  const fields = [['dependencies', false], ['optionalDependencies', false], ['devDependencies', true], ['peerDependencies', false], ['overrides', false], ['resolutions', false]];
  for (const [field, dev] of fields) {
    const leaves = [];
    collectLeaves(j[field], leaves);
    for (const { name, spec } of leaves) {
      const d = { ecosystem: 'npm', name, spec, dev, file };
      if (!NPM_RE.test(name)) d.invalid = true;
      const cls = classifySpec(spec);
      if (cls.kind === 'nonRegistry') d.nonRegistry = cls.why;
      out.push(d);
    }
  }
}
function parseRequirements(text, file, out) {
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('-')) {
      const om = /^(--[A-Za-z][A-Za-z-]*|-[A-Za-z])(?:=|\s+)?(.*)$/.exec(line);
      if (!om || PY_IGNORED.includes(om[1]) || !PY_OPTIONS.includes(om[1])) continue;
      out.push({ ecosystem: 'pypi', name: '(option) ' + om[1], spec: om[2].trim(), dev: false, file, nonRegistry: 'option ' + om[1] });
      continue;
    }
    if (line.includes('://') || /^[A-Za-z0-9._-]+(\[[^\]]*\])?\s*@/.test(line)) {
      const named = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*@/.exec(line);
      out.push({ ecosystem: 'pypi', name: named ? normalizePy(named[1]) : line, spec: named ? line.slice(named[0].length).trim() : line, dev: false, file, nonRegistry: 'direct URL' });
      continue;
    }
    const pm = PY_RE.exec(line);
    if (!pm) continue;
    const spec = pm[3].trim();
    const cls = classifySpec(spec);
    const d = { ecosystem: 'pypi', name: normalizePy(pm[1]), spec, dev: false, file };
    if (cls.kind === 'nonRegistry') d.nonRegistry = cls.why;
    out.push(d);
  }
}
function parseDeps(files) {
  const out = [];
  for (const [file, text] of Object.entries(files || {})) {
    if (text == null) continue;
    const base = String(file).split(/[\\/]/).pop();
    if (base === 'package.json') parseNpm(String(text), file, out);
    else if (/^requirements.*\.txt$/.test(base)) parseRequirements(String(text), file, out);
  }
  return out;
}
export function newDependencies({ before = {}, after = {} } = {}) {
  const key = d => JSON.stringify([d.file, d.ecosystem, d.name, d.spec]);
  const old = new Set(parseDeps(before).map(key));
  return parseDeps(after).filter(d => !old.has(key(d))).map(d => ({ ecosystem: d.ecosystem, name: d.name, spec: d.spec, dev: d.dev, file: d.file, ...(d.invalid ? { invalid: true } : {}), ...(d.nonRegistry ? { nonRegistry: d.nonRegistry } : {}) }));
}
function encodeName(name) {
  return encodeURIComponent(name).replace(/^%40/, '@').replace(/%2F/g, '%2f');
}
function daysSince(ms, now) {
  return Number.isFinite(ms) ? Math.floor((now() - ms) / 864e5) : null;
}
function sanitizeLicense(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[^A-Za-z0-9 .()+-]/g, '').slice(0, 80).trim();
  return s || null;
}
function licenseFromNpm(lic) {
  if (typeof lic === 'string') return lic;
  if (lic && typeof lic === 'object' && typeof lic.type === 'string') return lic.type;
  return null;
}
function pypiLicense(info) {
  const classifiers = Array.isArray(info?.classifiers) ? info.classifiers.filter(c => typeof c === 'string') : [];
  const has = re => classifiers.some(c => re.test(c) && !/Lesser/.test(c));
  if (has(/GNU Affero General Public License/)) return 'AGPL-3.0';
  if (has(/GNU General Public License/)) return 'GPL-3.0';
  if (typeof info?.license === 'string' && info.license.trim()) return sanitizeLicense(info.license);
  const cl = classifiers.find(c => c.startsWith('License ::'));
  return cl ? sanitizeLicense(cl.split('::').pop()) : null;
}
function earliestUpload(files) {
  const times = [];
  for (const f of files || []) {
    if (!f || !f.upload_time) continue;
    let s = String(f.upload_time);
    if (!/Z|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
    const t = Date.parse(s);
    if (Number.isFinite(t)) times.push(t);
  }
  return times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
}
export async function checkPackage(dep, { fetchImpl, now = Date.now, policy = {}, cache } = {}) {
  const { minAgeDays = 30, minWeeklyDownloads = 100 } = policy;
  const ecosystem = dep.ecosystem;
  const name0 = dep.name;
  const spec = String(dep.spec ?? '');
  const blocked = why => ({ name: name0, ecosystem, ok: false, reasons: [`installs from a non-registry source (${why}): needs the owner's approval`], ageDays: null, weeklyDownloads: null, license: null });
  if (dep.nonRegistry) return blocked(dep.nonRegistry);
  const cls = classifySpec(spec);
  if (cls.kind === 'nonRegistry') return blocked(cls.why);
  if (cls.kind === 'workspace') return { name: name0, ecosystem, ok: true, reasons: [], ageDays: null, weeklyDownloads: null, license: null };
  const target = cls.kind === 'alias' ? cls.target : name0;
  const extra = cls.kind === 'alias' ? { alias: name0 } : {};
  const aliasNote = cls.kind === 'alias' ? `alias ${name0} -> ${target}: ` : '';
  const key = ecosystem + ':' + name0 + ':' + spec;
  if (cache instanceof Map && cache.has(key)) {
    const hit = cache.get(key);
    return { ...hit, reasons: [...hit.reasons] };
  }
  const exact = /^=?v?\d+(?:\.\d+)*$/.test(spec);
  const ver = spec.replace(/^=?v?/, '');
  const get = async u => {
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(policy.fetchTimeoutMs ?? 10000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('bad status');
    const len = Number(r.headers?.get?.('content-length'));
    if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('response too large');
    return r.json();
  };
  const reasons = [];
  let ageDays = null, weeklyDownloads = null, license = null;
  let notFound = false, unreachable = false;
  if (dep.invalid) reasons.push('not a valid package name');
  try {
    if (ecosystem === 'npm') {
      const meta = await get('https://registry.npmjs.org/' + encodeName(target));
      if (!meta) notFound = true;
      else {
        const latest = meta['dist-tags']?.latest;
        let when = Date.parse(meta.time?.created);
        let lic = meta.versions?.[latest]?.license;
        if (exact) {
          if (meta.versions?.[ver]) {
            const t = Date.parse(meta.time?.[ver]);
            if (Number.isFinite(t)) when = t;
            lic = meta.versions[ver].license;
          } else reasons.push(`version ${ver} not found`);
        }
        ageDays = daysSince(when, now);
        license = sanitizeLicense(licenseFromNpm(lic));
        const dl = await get('https://api.npmjs.org/downloads/point/last-week/' + encodeName(target));
        weeklyDownloads = dl?.downloads ?? 0;
      }
    } else {
      const j = await get('https://pypi.org/pypi/' + encodeURIComponent(normalizePy(target)) + '/json');
      if (!j) notFound = true;
      else {
        let pool = Object.values(j.releases || {}).flat();
        if (exact) {
          if (Array.isArray(j.releases?.[ver])) pool = j.releases[ver];
          else reasons.push(`version ${ver} not found`);
        }
        const t = earliestUpload(pool);
        if (t === null) reasons.push('unknown age');
        else ageDays = daysSince(t, now);
        license = pypiLicense(j.info);
      }
    }
  } catch {
    unreachable = true;
  }
  if (unreachable) {
    return { name: target, ecosystem, ok: false, reasons: [UNREACHABLE], ageDays: null, weeklyDownloads: null, license: null, ...extra };
  }
  if (notFound) {
    const r = { name: target, ecosystem, ok: false, reasons: [aliasNote + NOT_FOUND], ageDays: null, weeklyDownloads: null, license: null, ...extra };
    if (cache instanceof Map) cache.set(key, r);
    return r;
  }
  if (ageDays !== null && ageDays < minAgeDays) reasons.push(`younger than ${minAgeDays} days`);
  if (ecosystem === 'npm' && weeklyDownloads < minWeeklyDownloads) reasons.push(`only ${weeklyDownloads} downloads last week`);
  if (ecosystem === 'npm' && !POPULAR_PACKAGES.includes(target)) {
    const p = POPULAR_PACKAGES.find(q => editDistance(target, q) === 1);
    if (p && (ageDays === null || ageDays < 365 || weeklyDownloads < 1000)) reasons.push(`looks like the popular package ${p}`);
  }
  const result = { name: target, ecosystem, ok: reasons.length === 0, reasons: reasons.map(r => aliasNote + r), ageDays, weeklyDownloads, license, ...extra };
  if (cache instanceof Map) cache.set(key, result);
  return result;
}
export async function checkPackages(deps, options) {
  const out = new Array(deps.length);
  let next = 0;
  const worker = async () => {
    while (next < deps.length) {
      const k = next++;
      out[k] = await checkPackage(deps[k], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, deps.length) }, worker));
  return out;
}
