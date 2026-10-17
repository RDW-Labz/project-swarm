export const UI_DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:3000',
  readyPath: '/',
  timeoutSec: 120,
  viewport: Object.freeze({ width: 390, height: 844 }),
  minScore: 0.7,
  text: 0.5
});

const TOP_KEYS = ['baseUrl', 'start', 'readyPath', 'timeoutSec', 'viewport', 'screens'];
const SCREEN_KEYS = ['id', 'route', 'mockup', 'viewport', 'minScore', 'text'];
const GENERIC_FONTS = new Set(['arial', 'helvetica', 'times', 'serif', 'sans-serif', 'monospace', 'system-ui', '-apple-system', 'segoe ui', 'roboto', 'ui-sans-serif', 'ui-serif', 'ui-monospace']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function unknownKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not a known key`);
  }
}

function inRange(v, min, max, integer) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
}

function validBase(s) {
  if (typeof s !== 'string') return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
}

function checkRoute(s) {
  return typeof s === 'string' && s.startsWith('/') && !s.startsWith('//') && s.length <= 200 &&
    !s.includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(s);
}

function checkMockup(s) {
  if (typeof s !== 'string' || s === '' || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false;
  if (s.includes(String.fromCharCode(92)) || s.includes(String.fromCharCode(0))) return false;
  return !s.split('/').some((p) => p === '' || p === '..');
}

function checkStart(a) {
  if (!Array.isArray(a) || a.length < 1 || a.length > 20) return 'ui.start must be an argv array of 1 to 20 strings';
  if (!a.every((x) => typeof x === 'string' && x !== '' && !x.includes('\0'))) return 'ui.start items must be non-empty strings without NUL';
  const p = a[0];
  if (p.startsWith('/') || p.startsWith(String.fromCharCode(92)) || /^[A-Za-z]:/.test(p)) return 'ui.start[0] must be a program name or relative path';
  return null;
}

function viewportOf(v, path, errors, fallback) {
  if (v === undefined) return { ...fallback };
  if (!isObj(v)) { errors.push(`${path} must be an object`); return { ...fallback }; }
  unknownKeys(v, ['width', 'height'], path, errors);
  if (!inRange(v.width, 200, 2000, true)) errors.push(`${path}.width must be an integer 200 to 2000`);
  if (!inRange(v.height, 200, 4000, true)) errors.push(`${path}.height must be an integer 200 to 4000`);
  return { width: v.width, height: v.height };
}

export function validateUiConfig(raw) {
  if (raw === undefined) return { config: null, errors: [] };
  if (!isObj(raw)) return { config: {}, errors: ['ui must be an object'] };
  const errors = [];
  unknownKeys(raw, TOP_KEYS, 'ui', errors);
  const config = {
    baseUrl: UI_DEFAULTS.baseUrl,
    readyPath: UI_DEFAULTS.readyPath,
    timeoutSec: UI_DEFAULTS.timeoutSec,
    viewport: { ...UI_DEFAULTS.viewport },
    screens: []
  };
  if (raw.baseUrl !== undefined) {
    if (validBase(raw.baseUrl)) config.baseUrl = raw.baseUrl;
    else errors.push('ui.baseUrl must be http on 127.0.0.1, localhost or [::1]');
  }
  if (raw.start !== undefined) {
    const e = checkStart(raw.start);
    if (e) errors.push(e);
    else config.start = [...raw.start];
  }
  if (raw.readyPath !== undefined) {
    if (checkRoute(raw.readyPath)) config.readyPath = raw.readyPath;
    else errors.push('ui.readyPath must be a path starting with /');
  }
  if (raw.timeoutSec !== undefined) {
    if (inRange(raw.timeoutSec, 30, 600, true)) config.timeoutSec = raw.timeoutSec;
    else errors.push('ui.timeoutSec must be an integer 30 to 600');
  }
  config.viewport = viewportOf(raw.viewport, 'ui.viewport', errors, UI_DEFAULTS.viewport);
  if (!Array.isArray(raw.screens) || raw.screens.length < 1 || raw.screens.length > 60) {
    errors.push('ui.screens must be an array of 1 to 60 screens');
  } else {
    const ids = new Set();
    raw.screens.forEach((s, i) => {
      const p = `ui.screens[${i}]`;
      if (!isObj(s)) { errors.push(`${p} must be an object`); return; }
      unknownKeys(s, SCREEN_KEYS, p, errors);
      const id = s.id;
      if (typeof id !== 'string' || id.length > 40 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
        errors.push(`${p}.id must be kebab-case, 2 to 40 characters`);
      } else if (ids.has(id)) {
        errors.push(`duplicate screen id ${id}`);
      } else {
        ids.add(id);
      }
      if (!checkRoute(s.route)) errors.push(`${p}.route must be a path starting with /, at most 200 characters, no .. and no scheme`);
      if (!checkMockup(s.mockup)) errors.push(`${p}.mockup must be a repo-relative path without .. or absolute prefix`);
      const viewport = viewportOf(s.viewport, `${p}.viewport`, errors, config.viewport);
      let minScore = UI_DEFAULTS.minScore;
      if (s.minScore !== undefined) {
        if (inRange(s.minScore, 0.3, 0.99, false)) minScore = s.minScore;
        else errors.push(`${p}.minScore must be 0.3 to 0.99`);
      }
      let text = UI_DEFAULTS.text;
      if (s.text !== undefined) {
        if (inRange(s.text, 0, 1, false)) text = s.text;
        else errors.push(`${p}.text must be 0 to 1`);
      }
      config.screens.push({ id, route: s.route, mockup: s.mockup, viewport, minScore, text });
    });
  }
  if (errors.length) return { config: {}, errors };
  return { config, errors };
}

function normFont(name) {
  let s = String(name).trim().toLowerCase().replace(/^['"]+|['"]+$/g, '');
  s = s.replace(/^_+/, '');
  s = s.replace(/_(?=[a-z0-9]*\d)[a-z0-9]{6,}$/, '');
  s = s.replace(/_/g, ' ').trim();
  return s.replace(/\s+fallback$/, '').trim();
}

function parseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = s.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if (m) return [m[1], m[2], m[3]].map(Number);
  return null;
}

const nearColor = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 12);

export function compareScreen(input, opts = {}) {
  const arr = v => (Array.isArray(v) ? v : []);
  const mockup = input?.mockup && typeof input.mockup === 'object' ? input.mockup : {};
  const page = input?.page && typeof input.page === 'object' ? input.page : {};
  const visual = input?.visual;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : UI_DEFAULTS.minScore;
  const text = Number.isFinite(opts.text) ? opts.text : UI_DEFAULTS.text;
  const reasons = [];
  const parts = { visual: null, text: null, colors: null, fonts: { missing: [] } };
  const score = Number.isFinite(visual) ? visual : 0;

  // A mockup with next to nothing in it would make every page pass the text, color and font rules.
  if (arr(mockup.words).length < 3 && arr(mockup.colors).length + arr(mockup.backgrounds).length < 2) reasons.push('mockup-empty');

  if (page.styled === false && mockup.styled === true) reasons.push('unstyled');

  const pageFonts = new Set(arr(page.fonts).map(normFont));
  const missing = [];
  for (const f of arr(mockup.fonts)) {
    const n = normFont(f);
    if (!n || GENERIC_FONTS.has(n) || pageFonts.has(n)) continue;
    if (!missing.includes(f)) missing.push(f);
  }
  parts.fonts.missing = missing;
  if (missing.length) reasons.push(`font-missing: ${missing.join(', ')}`);

  if (typeof page.scrollWidth === 'number' && typeof page.viewportWidth === 'number' &&
      page.scrollWidth > page.viewportWidth + 2) {
    reasons.push('horizontal-overflow');
  }

  const mockupWords = [...new Set(arr(mockup.words))];
  if (mockupWords.length >= 5) {
    const pageWords = new Set(arr(page.words));
    const share = mockupWords.filter((w) => pageWords.has(w)).length / mockupWords.length;
    parts.text = share;
    if (share < text) reasons.push(`text-mismatch: ${share.toFixed(2)}`);
  }

  const mockupColors = [...new Set([...arr(mockup.colors), ...arr(mockup.backgrounds)])]
    .map(parseColor).filter(Boolean);
  if (mockupColors.length >= 3) {
    const pageColors = [...arr(page.colors), ...arr(page.backgrounds)].map(parseColor).filter(Boolean);
    const hits = mockupColors.filter((c) => pageColors.some((p) => nearColor(c, p))).length;
    const share = hits / mockupColors.length;
    parts.colors = share;
    if (share < 0.4) reasons.push(`colors-missing: ${share.toFixed(2)}`);
  }

  parts.visual = score;
  if (score < minScore) reasons.push(`visual: ${score.toFixed(2)}`);

  return { pass: reasons.length === 0, score, reasons, parts };
}
