import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTicket, buildTicketContext } from '../tools/ticket-context.mjs';

function fsOf(paths) {
  const have = new Set(paths);
  return (p) => have.has(p);
}

const scopeOf = (context = []) => ({ context, sections: [] });

function ticketOf(over = {}) {
  return {
    id: 'T1',
    type: 'build',
    title: 'Login form',
    epic: 'Auth',
    files: ['src/lib/x.ts'],
    context: [],
    contracts: [],
    tests: [],
    requirements: '',
    ...over,
  };
}

test('classifyTicket: db by type, .sql file, or migrations/supabase path', () => {
  assert.equal(classifyTicket(ticketOf({ type: 'migration', files: ['x.ts'] })), 'db');
  assert.equal(classifyTicket(ticketOf({ files: ['db/a.sql'] })), 'db');
  assert.equal(classifyTicket(ticketOf({ files: ['supabase/config.ts'] })), 'db');
});

test('classifyTicket: ui by extension or folder', () => {
  assert.equal(classifyTicket(ticketOf({ files: ['src/page.tsx'] })), 'ui');
  assert.equal(classifyTicket(ticketOf({ files: ['src/components/a.ts'] })), 'ui');
});

test('classifyTicket: api by /api/ or routes/ path', () => {
  assert.equal(classifyTicket(ticketOf({ files: ['src/app/api/items/route.ts'] })), 'api');
  assert.equal(classifyTicket(ticketOf({ files: ['server/routes/items.ts'] })), 'api');
});

test('classifyTicket: test by type or when all files are tests', () => {
  assert.equal(classifyTicket(ticketOf({ type: 'test', files: ['src/lib/x.ts'] })), 'test');
  assert.equal(classifyTicket(ticketOf({ files: ['tests/a.test.mjs'] })), 'test');
});

test('classifyTicket: config for root files, other otherwise', () => {
  assert.equal(classifyTicket(ticketOf({ files: ['package.json', 'tsconfig.json'] })), 'config');
  assert.equal(classifyTicket(ticketOf({ files: ['src/lib/util.ts'] })), 'other');
});

test('classifyTicket: first matching class wins in order db, api, ui, test', () => {
  assert.equal(classifyTicket(ticketOf({ type: 'test', files: ['src/page.tsx'] })), 'ui');
  assert.equal(classifyTicket(ticketOf({ type: 'test', files: ['src/app/api/a.ts'] })), 'api');
  assert.equal(classifyTicket(ticketOf({ type: 'test', files: ['db/a.sql'] })), 'db');
});

test('buildTicketContext: shared list has overview, all entries, profile shared, package.json', () => {
  const exists = fsOf(['docs/scope/context/overview.md', 'package.json', 'docs/all.md', 'docs/profile.md']);
  const r = buildTicketContext({
    ticket: ticketOf(),
    scope: scopeOf([{ path: 'docs/all.md', kinds: ['all'] }]),
    exists,
    profileContext: { shared: ['docs/profile.md'] },
  });
  assert.equal(r.kind, 'other');
  for (const p of ['docs/scope/context/overview.md', 'docs/all.md', 'docs/profile.md', 'package.json']) {
    assert.ok(r.shared.includes(p), p);
  }
  assert.deepEqual(r.warnings, []);
});

test('buildTicketContext: docs tickets do not get package.json', () => {
  const exists = fsOf(['docs/scope/context/overview.md', 'package.json']);
  const r = buildTicketContext({
    ticket: ticketOf({ type: 'docs', files: ['docs/a.md'] }),
    scope: scopeOf(),
    exists,
  });
  assert.equal(r.kind, 'docs');
  assert.ok(!r.shared.includes('package.json'));
});

test('buildTicketContext: db kind adds data model, db entries and profile db, not ui entries', () => {
  const exists = fsOf([
    'docs/scope/context/overview.md',
    'docs/scope/context/data-model.md',
    'docs/db.md',
    'docs/ui.md',
    'docs/profile-db.md',
  ]);
  const r = buildTicketContext({
    ticket: ticketOf({ type: 'migration', files: ['supabase/migrations/0001_init.sql'] }),
    scope: scopeOf([
      { path: 'docs/db.md', kinds: ['db'] },
      { path: 'docs/ui.md', kinds: ['ui'] },
    ]),
    exists,
    profileContext: { db: ['docs/profile-db.md'] },
  });
  assert.equal(r.kind, 'db');
  assert.ok(r.context.includes('docs/scope/context/data-model.md'));
  assert.ok(r.context.includes('docs/db.md'));
  assert.ok(r.context.includes('docs/profile-db.md'));
  assert.ok(!r.context.includes('docs/ui.md'));
});

test('buildTicketContext: ui kind adds design files and at most 2 overlapping screens', () => {
  const design = [
    'docs/design/tokens.json',
    'docs/design/README.md',
    'docs/design/components.css',
    'docs/design/screens/login-a.html',
    'docs/design/screens/login-b.html',
    'docs/design/screens/login-c.html',
    'docs/design/screens/settings-page.html',
  ];
  const exists = fsOf(['docs/scope/context/overview.md', ...design]);
  const sizes = Object.fromEntries(design.map((p) => [p, 100]));
  const r = buildTicketContext({
    ticket: ticketOf({ files: ['src/page.tsx'] }),
    scope: scopeOf(),
    exists,
    sizes,
    listFiles: (prefix) => design.filter((p) => p.startsWith(prefix)),
  });
  assert.equal(r.kind, 'ui');
  for (const p of ['docs/design/tokens.json', 'docs/design/README.md', 'docs/design/components.css']) {
    assert.ok(r.context.includes(p), p);
  }
  const screens = r.context.filter((p) => p.startsWith('docs/design/screens/'));
  assert.ok(screens.length <= 2);
  assert.ok(!r.context.includes('docs/design/screens/settings-page.html'));
});

test('buildTicketContext: missing files are dropped', () => {
  const exists = fsOf(['docs/scope/context/overview.md', 'docs/have.md']);
  const r = buildTicketContext({
    ticket: ticketOf({ context: ['docs/missing.md', 'docs/have.md'] }),
    scope: scopeOf(),
    exists,
  });
  assert.ok(!r.context.includes('docs/missing.md'));
  assert.ok(r.context.includes('docs/have.md'));
});

test('buildTicketContext: files over 60000 bytes are skipped with a warning', () => {
  const exists = fsOf(['docs/scope/context/overview.md', 'docs/big.md', 'docs/small.md']);
  const r = buildTicketContext({
    ticket: ticketOf({ context: ['docs/big.md', 'docs/small.md'] }),
    scope: scopeOf(),
    exists,
    sizes: { 'docs/big.md': 60001, 'docs/small.md': 60000 },
  });
  assert.ok(!r.context.includes('docs/big.md'));
  assert.ok(r.context.includes('docs/small.md'));
  assert.ok(r.warnings.some((w) => w.includes('docs/big.md')));
});

test('buildTicketContext: default limit is 14 paths, custom limit respected', () => {
  const paths = Array.from({ length: 20 }, (_, i) => `docs/c${String(i).padStart(2, '0')}.md`);
  const exists = fsOf(['docs/scope/context/overview.md', ...paths]);
  const ticket = ticketOf({ context: paths });
  const def = buildTicketContext({ ticket, scope: scopeOf(), exists });
  assert.equal(def.shared.length + def.context.length, 14);
  const small = buildTicketContext({ ticket, scope: scopeOf(), exists, limits: { maxFiles: 5 } });
  assert.equal(small.shared.length + small.context.length, 5);
});

test('buildTicketContext: cacheContext is sorted and at most 10 shared paths', () => {
  const all = Array.from({ length: 12 }, (_, i) => `docs/all-${String(i).padStart(2, '0')}.md`);
  const exists = fsOf(['docs/scope/context/overview.md', ...all]);
  const r = buildTicketContext({
    ticket: ticketOf(),
    scope: scopeOf(all.map((path) => ({ path, kinds: ['all'] }))),
    exists,
  });
  assert.equal(r.cacheContext.length, 10);
  assert.deepEqual(r.cacheContext, [...r.shared].sort().slice(0, 10));
  assert.deepEqual(r.cacheContext, [...r.cacheContext].sort());
});

test('buildTicketContext: paths are de-duplicated', () => {
  const exists = fsOf(['docs/scope/context/overview.md', 'docs/dup.md']);
  const r = buildTicketContext({
    ticket: ticketOf({ context: ['docs/dup.md'], tests: ['docs/dup.md'] }),
    scope: scopeOf([{ path: 'docs/dup.md', kinds: ['all'] }]),
    exists,
  });
  assert.equal([...r.shared, ...r.context].filter((p) => p === 'docs/dup.md').length, 1);
});

test('buildTicketContext: backticked existing paths in requirements are added', () => {
  const exists = fsOf(['docs/scope/context/overview.md', 'src/lib/util.ts', 'docs/notes.md']);
  const r = buildTicketContext({
    ticket: ticketOf({
      requirements: 'Edit `src/lib/util.ts` and read `docs/notes.md`, not `missing.ts`.',
    }),
    scope: scopeOf(),
    exists,
  });
  assert.ok(r.context.includes('src/lib/util.ts'));
  assert.ok(r.context.includes('docs/notes.md'));
  assert.ok(!r.context.includes('missing.ts'));
});

test('buildTicketContext: scope context entries are filtered by kind', () => {
  const exists = fsOf(['docs/scope/context/overview.md', 'docs/t.md']);
  const entry = [{ path: 'docs/t.md', kinds: ['test'] }];
  const other = buildTicketContext({ ticket: ticketOf(), scope: scopeOf(entry), exists });
  assert.ok(!other.context.includes('docs/t.md'));
  const testing = buildTicketContext({
    ticket: ticketOf({ type: 'test', files: ['tests/a.test.mjs'] }),
    scope: scopeOf(entry),
    exists: fsOf(['docs/scope/context/overview.md', 'docs/t.md', 'tests/a.test.mjs']),
  });
  assert.equal(testing.kind, 'test');
  assert.ok(testing.context.includes('docs/t.md'));
});

test('buildTicketContext: own context, contracts and tests are appended', () => {
  const exists = fsOf([
    'docs/scope/context/overview.md',
    'docs/own.md',
    'contracts/api.json',
    'tests/a.test.mjs',
  ]);
  const r = buildTicketContext({
    ticket: ticketOf({
      context: ['docs/own.md'],
      contracts: ['contracts/api.json'],
      tests: ['tests/a.test.mjs'],
    }),
    scope: scopeOf(),
    exists,
  });
  assert.ok(r.context.includes('docs/own.md'));
  assert.ok(r.context.includes('contracts/api.json'));
  assert.ok(r.context.includes('tests/a.test.mjs'));
});
