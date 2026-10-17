// Ticket context selection for the dogfood-fixes design, section 2.
// Pure functions: file existence and sizes are passed in; nothing is read from disk.

const CTX_OVERVIEW = 'docs/scope/context/overview.md';
const CTX_DATA_MODEL = 'docs/scope/context/data-model.md';
const CONTRACT_FILES = ['contracts/api.json', 'contracts/types.d.ts'];
const CONTRACT_KINDS = ['db', 'api', 'ui', 'test'];
const UI_EXT = ['.tsx', '.jsx', '.css', '.html', '.vue', '.svelte'];
const MAX_BYTES = 60000;
const CACHE_MAX = 10;
const DEFAULT_MAX_FILES = 14;

function norm(p) {
  return String(p).split('\\').join('/').replace(/^\.\//, '');
}

function hasSeg(p, seg) {
  return ('/' + norm(p)).includes('/' + seg);
}

function isTestPath(p) {
  const n = norm(p);
  const parts = n.split('/');
  const base = parts[parts.length - 1];
  return parts.some((s) => s === 'tests' || s === 'test' || s === '__tests__') || /\.(test|spec)\./.test(base);
}

function filesOf(ticket) {
  return Array.isArray(ticket && ticket.files) ? ticket.files.map(norm) : [];
}

function isDbFile(p) {
  const n = norm(p);
  return n.endsWith('.sql') || hasSeg(n, 'migrations') || hasSeg(n, 'supabase');
}

function isApiFile(p) {
  const n = '/' + norm(p);
  return n.includes('/api/') || n.includes('/routes/');
}

function isUiFile(p) {
  const n = norm(p);
  const dot = n.lastIndexOf('.');
  const ext = dot >= 0 ? n.slice(dot).toLowerCase() : '';
  return UI_EXT.includes(ext) || hasSeg(n, 'components') || hasSeg(n, 'app') || hasSeg(n, 'pages');
}

export function classifyTicket(ticket = {}) {
  const files = filesOf(ticket);
  if (ticket.type === 'migration' || files.some(isDbFile)) return 'db';
  if (files.some(isApiFile)) return 'api';
  if (files.some(isUiFile)) return 'ui';
  if (ticket.type === 'test' || (files.length > 0 && files.every(isTestPath))) return 'test';
  if (files.length > 0 && files.every((f) => !norm(f).includes('/'))) return 'config';
  if (files.length > 0 && files.every((f) => norm(f).startsWith('docs/') || norm(f).endsWith('.md'))) return 'docs';
  return 'other';
}

function wordSet(s) {
  return new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
}

export function buildTicketContext({
  ticket = {},
  scope = {},
  exists = () => false,
  sizes = {},
  profileContext = {},
  limits = {},
  listFiles,
} = {}) {
  const kind = classifyTicket(ticket);
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const warnings = [];
  const scopeCtx = Array.isArray(scope.context) ? scope.context : [];
  const scopeFor = (k) => scopeCtx.filter((e) => e && Array.isArray(e.kinds) && e.kinds.includes(k)).map((e) => e.path);
  const profFor = (k) => (Array.isArray(profileContext[k]) ? profileContext[k] : []);
  const items = [];
  const add = (group, p) => {
    if (typeof p === 'string' && p.length > 0) items.push({ group, path: norm(p) });
  };

  // Shared group: every ticket, plus contract files for the kinds that use them.
  add('shared', CTX_OVERVIEW);
  for (const p of scopeFor('all')) add('shared', p);
  for (const p of profFor('shared')) add('shared', p);
  if (exists('package.json') && kind !== 'docs') add('shared', 'package.json');
  if (CONTRACT_KINDS.includes(kind)) {
    for (const p of CONTRACT_FILES) add('shared', p);
  }

  // Kind-specific group.
  if (kind === 'db') {
    add('context', CTX_DATA_MODEL);
    for (const p of scopeFor('db')) add('context', p);
    for (const p of profFor('db')) add('context', p);
  } else if (kind === 'ui') {
    for (const p of scopeFor('ui')) add('context', p);
    for (const p of profFor('ui')) add('context', p);
    if (typeof listFiles === 'function') {
      const dfiles = (listFiles('docs/design') || []).map(norm);
      if (dfiles.length > 0) {
        add('context', 'docs/design/tokens.json');
        for (const f of dfiles) {
          const parts = f.split('/');
          if (parts.length === 3 && parts[0] === 'docs' && parts[1] === 'design' && /README/i.test(parts[2])) add('context', f);
        }
        add('context', 'docs/design/components.css');
        const tw = wordSet(`${ticket.title ?? ''} ${ticket.epic ?? ''}`);
        const screens = dfiles
          .filter((f) => f.startsWith('docs/design/screens/'))
          .map((f) => {
            const base = f.split('/').pop().replace(/\.[^.]*$/, '');
            const bw = wordSet(base.replace(/[^a-zA-Z]+/g, ' '));
            let score = 0;
            for (const w of bw) if (tw.has(w)) score++;
            return { f, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || (a.f < b.f ? -1 : 1))
          .slice(0, 2);
        for (const s of screens) add('context', s.f);
      }
    }
  } else if (kind === 'api' || kind === 'test') {
    for (const p of scopeFor(kind)) add('context', p);
    for (const p of profFor(kind)) add('context', p);
  }

  // Paths named in backticks in the requirements text.
  const req = String(ticket.requirements ?? '');
  for (const m of req.matchAll(/`([^`\s]+)`/g)) {
    const p = norm(m[1]);
    if (p.includes('://')) continue;
    if (p.includes('/') || /\.[a-z0-9]+$/i.test(p)) add('context', p);
  }

  // The ticket's own context, contracts and tests.
  for (const p of Array.isArray(ticket.context) ? ticket.context : []) add('context', p);
  for (const p of Array.isArray(ticket.contracts) ? ticket.contracts : []) add('context', p);
  for (const p of Array.isArray(ticket.tests) ? ticket.tests : []) add('context', p);

  // De-duplicate, keep existing files, skip oversized files.
  const seen = new Set();
  let kept = [];
  for (const it of items) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    if (!exists(it.path)) continue;
    const size = sizes[it.path];
    if (typeof size === 'number' && size > MAX_BYTES) {
      warnings.push(`skipped ${it.path}: over ${MAX_BYTES} bytes`);
      continue;
    }
    kept.push(it);
  }
  if (kept.length > maxFiles) {
    warnings.push(`limit of ${maxFiles} files reached; ${kept.length - maxFiles} path(s) dropped`);
    kept = kept.slice(0, maxFiles);
  }

  const shared = kept.filter((x) => x.group === 'shared').map((x) => x.path);
  const context = kept.filter((x) => x.group === 'context').map((x) => x.path);
  const cacheContext = [...shared].sort().slice(0, CACHE_MAX);
  return { kind, shared, context, cacheContext, warnings };
}
