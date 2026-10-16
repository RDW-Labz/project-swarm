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
function parseDeps(files) {
  const out = [];
  for (const [file, text] of Object.entries(files || {})) {
    if (text == null) continue;
    if (file === 'package.json') {
      let j;
      try { j = JSON.parse(text); } catch { continue; }
      if (!j || typeof j !== 'object') continue;
      for (const [field, dev] of [['dependencies', false], ['optionalDependencies', false], ['devDependencies', true]]) {
        for (const [name, spec] of Object.entries(j[field] || {})) {
          const d = { ecosystem: 'npm', name, spec: String(spec), dev };
          if (!NPM_RE.test(name)) d.invalid = true;
          out.push(d);
        }
      }
    } else if (/^requirements.*\.txt$/.test(file)) {
      for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line[0] === '#' || line[0] === '-' || line.includes('://')) continue;
        const m = PY_RE.exec(line);
        if (!m) continue;
        out.push({ ecosystem: 'pypi', name: m[1].toLowerCase(), spec: m[3].replace(/\s+#.*$/, '').trim(), dev: false });
      }
    }
  }
  return out;
}
export function newDependencies({ before = {}, after = {} } = {}) {
  const key = d => d.ecosystem + ':' + d.name;
  const old = new Set(parseDeps(before).map(key));
  return parseDeps(after).filter(d => !old.has(key(d)));
}
function encodeName(name) {
  return encodeURIComponent(name).replace(/^%40/, '@').replace(/%2F/g, '%2f');
}
function daysSince(ms, now) {
  return Number.isFinite(ms) ? Math.floor((now() - ms) / 864e5) : null;
}
export async function checkPackage(dep, { fetchImpl, now = Date.now, policy = {} } = {}) {
  const { minAgeDays = 30, minWeeklyDownloads = 100 } = policy;
  const { name, ecosystem } = dep;
  const NOT_FOUND = 'not found on the registry (made-up name?)';
  try {
    const get = async u => {
      const r = await fetchImpl(u);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('bad status');
      return r.json();
    };
    let ageDays = null, weeklyDownloads = null, license = null;
    const reasons = [];
    if (ecosystem === 'npm') {
      const meta = await get('https://registry.npmjs.org/' + encodeName(name));
      if (!meta) return { name, ecosystem, ok: false, reasons: [NOT_FOUND], ageDays, weeklyDownloads, license };
      const created = meta.time?.created ? Date.parse(meta.time.created) : NaN;
      ageDays = daysSince(created, now);
      const latest = meta['dist-tags']?.latest;
      const lic = meta.versions?.[latest]?.license;
      license = typeof lic === 'string' ? lic : (lic?.type ?? null);
      const dl = await get('https://api.npmjs.org/downloads/point/last-week/' + encodeName(name));
      weeklyDownloads = dl?.downloads ?? 0;
    } else {
      const j = await get('https://pypi.org/pypi/' + name + '/json');
      if (!j) return { name, ecosystem, ok: false, reasons: [NOT_FOUND], ageDays, weeklyDownloads, license };
      const times = [];
      for (const files of Object.values(j.releases || {})) {
        for (const f of files || []) {
          if (!f.upload_time) continue;
          let s = f.upload_time;
          if (!/Z|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
          const t = Date.parse(s);
          if (Number.isFinite(t)) times.push(t);
        }
      }
      ageDays = times.length ? daysSince(Math.min(...times), now) : null;
      const cl = (j.info?.classifiers || []).find(c => c.startsWith('License ::'));
      license = j.info?.license || (cl ? cl.split('::').pop().trim() : null) || null;
    }
    if (dep.invalid) reasons.push('not a valid package name');
    if (ageDays !== null && ageDays < minAgeDays) reasons.push(`younger than ${minAgeDays} days`);
    if (ecosystem === 'npm' && weeklyDownloads < minWeeklyDownloads) reasons.push(`only ${weeklyDownloads} downloads last week`);
    if (ecosystem === 'npm' && !POPULAR_PACKAGES.includes(name)) {
      const p = POPULAR_PACKAGES.find(q => editDistance(name, q) === 1);
      if (p && (ageDays === null || ageDays < 365 || weeklyDownloads < 1000)) reasons.push(`looks like the popular package ${p}`);
    }
    return { name, ecosystem, ok: reasons.length === 0, reasons, ageDays, weeklyDownloads, license };
  } catch {
    return { name, ecosystem, ok: false, reasons: ['could not verify (registry unreachable)'], ageDays: null, weeklyDownloads: null, license: null };
  }
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
