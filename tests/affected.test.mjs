import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAffectedTests, expandAffectedArgv } from '../tools/affected.mjs';

function makeMap({ tests = [], sources = [], unmapped = [], testLinks = [], importedBy = {} } = {}) {
  const files = {};
  for (const t of tests) files[t] = { lang: 'js', isTest: true };
  for (const s of sources) files[s] = { lang: 'js', isTest: false };
  for (const u of unmapped) files[u] = { isTest: false };
  return { files, testLinks, importedBy };
}

const TESTS = Array.from({ length: 10 }, (_, i) => `tests/t${i + 1}.test.mjs`);

const CHAIN = makeMap({
  tests: TESTS,
  sources: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'],
  importedBy: {
    'src/c.mjs': ['src/b.mjs'],
    'src/b.mjs': ['src/a.mjs'],
    'src/a.mjs': ['tests/t1.test.mjs'],
  },
});

const CTRL = 'src/a' + String.fromCharCode(1) + 'b.mjs';

test('a missing or unsound map is a full run', () => {
  for (const map of [null, undefined, {}, { files: null }]) {
    const s = selectAffectedTests(map, ['src/a.mjs']);
    assert.equal(s.mode, 'full');
    assert.deepEqual(s.tests, []);
    assert.ok(s.reasons.includes('no-map'));
  }
});

test('no changed files is a full run', () => {
  const s = selectAffectedTests(CHAIN, []);
  assert.equal(s.mode, 'full');
  assert.deepEqual(s.tests, []);
  assert.ok(s.reasons.includes('no-changes'));
});

test('global files force a full run', () => {
  const globals = [
    'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.project-swarm.json', 'coordination/checks.json', '.github/workflows/ci.yml',
    'vitest.config.mjs', 'tests/_helpers.mjs', 'tsconfig.json', 'tsconfig.build.json', '.npmrc',
  ];
  for (const g of globals) {
    const s = selectAffectedTests(CHAIN, [g]);
    assert.equal(s.mode, 'full', g);
    assert.deepEqual(s.tests, [], g);
    assert.ok(s.reasons.length > 0, g);
  }
  const mixed = selectAffectedTests(CHAIN, ['src/a.mjs', 'package.json']);
  assert.equal(mixed.mode, 'full');
});

test('more global patterns force a full run', () => {
  const globals = [
    'conftest.py', 'src/setup.mjs', 'src/fixture.js', 'fixtures/data.json',
    'test/_x.mjs', '__tests__/_x.js', 'jest.config.js', 'jest.setup.ts',
    'vitest.workspace.ts', 'pytest.ini', 'setup.cfg', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  ];
  for (const g of globals) {
    const s = selectAffectedTests(CHAIN, [g]);
    assert.equal(s.mode, 'full', g);
    assert.deepEqual(s.tests, [], g);
    assert.ok(s.reasons.some((r) => r.startsWith('global:')), g);
  }
});

test('a changed file that is not in the map is a full run', () => {
  const s = selectAffectedTests(CHAIN, ['src/nope.mjs']);
  assert.equal(s.mode, 'full');
  assert.deepEqual(s.tests, []);
  assert.ok(s.reasons.includes('unknown-file: src/nope.mjs'));
});

test('paths with traversal, absolute paths or backslashes are unknown files', () => {
  for (const p of ['../x.mjs', '/etc/passwd', 'src\\a.mjs']) {
    const s = selectAffectedTests(CHAIN, [p]);
    assert.equal(s.mode, 'full', p);
    assert.ok(s.reasons.some((r) => r.startsWith('unknown-file')), p);
  }
});

test('unsafe path segments, whitespace, control characters, braces and absolute paths are unknown files', () => {
  const bad = [
    'src//a.mjs', 'src/./a.mjs', 'src/../a.mjs', '-rf/a.mjs', 'src/-a.mjs', 'tests/-x.test.mjs',
    'src/a b.mjs', CTRL, 'src/{a}.mjs', 'src/a}.mjs', '/abs/a.mjs', 'src\\a.mjs',
  ];
  for (const p of bad) {
    const s = selectAffectedTests(CHAIN, [p]);
    assert.equal(s.mode, 'full', JSON.stringify(p));
    assert.ok(s.reasons.some((r) => r.startsWith('unknown-file')), JSON.stringify(p));
  }
});

test('a mapped file with no language that is not a test is a full run', () => {
  const map = makeMap({ tests: TESTS, sources: ['src/a.mjs'], unmapped: ['docs/guide.md'] });
  const s = selectAffectedTests(map, ['docs/guide.md']);
  assert.equal(s.mode, 'full');
  assert.ok(s.reasons.includes('unmapped-file: docs/guide.md'));
});

test('a changed file under a test folder whose name does not match is a test-helper full run', () => {
  const map = makeMap({ tests: TESTS, sources: ['src/a.mjs'], importedBy: CHAIN.importedBy });
  map.files['tests/support/util.mjs'] = { lang: 'js', isTest: true };
  const notInMap = selectAffectedTests(map, ['tests/helpers.mjs']);
  assert.equal(notInMap.mode, 'full');
  assert.deepEqual(notInMap.tests, []);
  assert.ok(notInMap.reasons.includes('test-helper: tests/helpers.mjs'));

  const inMap = selectAffectedTests(map, ['tests/support/util.mjs']);
  assert.equal(inMap.mode, 'full');
  assert.ok(inMap.reasons.some((r) => r.startsWith('test-helper')));
});

test('only base names matching test patterns count as tests', () => {
  const widget = selectAffectedTests(CHAIN, ['tests/widget.spec.ts']);
  assert.equal(widget.mode, 'affected');
  assert.deepEqual(widget.tests, ['tests/widget.spec.ts']);

  const underscore = selectAffectedTests(CHAIN, ['tests/handler_test.py']);
  assert.equal(underscore.mode, 'affected');
  assert.deepEqual(underscore.tests, ['tests/handler_test.py']);

  const pyPrefix = selectAffectedTests(CHAIN, ['tests/test_api.py']);
  assert.equal(pyPrefix.mode, 'affected');
  assert.deepEqual(pyPrefix.tests, ['tests/test_api.py']);

  const map = makeMap({ tests: TESTS, sources: ['src/a.mjs'] });
  map.files['tests/notes.mjs'] = { lang: 'js', isTest: true };
  const flagged = selectAffectedTests(map, ['tests/notes.mjs']);
  assert.equal(flagged.mode, 'full');
  assert.ok(flagged.reasons.some((r) => r.startsWith('test-helper')));
});

test('new test files run themselves and do not force a full run', () => {
  const s = selectAffectedTests(CHAIN, ['tests/new.test.mjs', 'src/a.mjs']);
  assert.equal(s.mode, 'affected');
  assert.deepEqual(s.tests, ['tests/new.test.mjs', 'tests/t1.test.mjs']);
});

test('a change that would run more than maxShare of the tests is a full run', () => {
  const hub7 = makeMap({
    tests: TESTS,
    sources: ['src/hub.mjs'],
    importedBy: { 'src/hub.mjs': TESTS.slice(0, 7) },
  });
  const wide = selectAffectedTests(hub7, ['src/hub.mjs']);
  assert.equal(wide.mode, 'full');
  assert.deepEqual(wide.tests, []);
  assert.ok(wide.reasons.some(r => r.startsWith('too-wide')));

  const allowed = selectAffectedTests(hub7, ['src/hub.mjs'], { maxShare: 0.8 });
  assert.equal(allowed.mode, 'affected');
  assert.equal(allowed.tests.length, 7);
});

test('exactly maxShare of the tests is still affected', () => {
  const hub6 = makeMap({
    tests: TESTS,
    sources: ['src/hub.mjs'],
    importedBy: { 'src/hub.mjs': TESTS.slice(0, 6) },
  });
  const s = selectAffectedTests(hub6, ['src/hub.mjs']);
  assert.equal(s.mode, 'affected');
  assert.equal(s.tests.length, 6);
});

test('a direct importer test is selected at depth 1', () => {
  const s = selectAffectedTests(CHAIN, ['src/a.mjs'], { depth: 1 });
  assert.equal(s.mode, 'affected');
  assert.deepEqual(s.tests, ['tests/t1.test.mjs']);
});

test('importer chains are followed up to depth, and the default has no limit', () => {
  const d1 = selectAffectedTests(CHAIN, ['src/c.mjs'], { depth: 1 });
  assert.equal(d1.mode, 'full');
  assert.ok(d1.reasons.some((r) => r.startsWith('depth-limit')));

  const d2 = selectAffectedTests(CHAIN, ['src/c.mjs'], { depth: 2 });
  assert.equal(d2.mode, 'full');
  assert.ok(d2.reasons.some((r) => r.startsWith('depth-limit')));

  assert.deepEqual(selectAffectedTests(CHAIN, ['src/c.mjs'], { depth: 3 }).tests, ['tests/t1.test.mjs']);
  assert.deepEqual(selectAffectedTests(CHAIN, ['src/c.mjs']).tests, ['tests/t1.test.mjs']);
});

test('no depth limit: a deep importer chain is walked to the end', () => {
  const deep = makeMap({
    tests: ['tests/deep.test.mjs', 'tests/o1.test.mjs', 'tests/o2.test.mjs'],
    sources: ['src/d0.mjs', 'src/d1.mjs', 'src/d2.mjs', 'src/d3.mjs'],
    importedBy: {
      'src/d0.mjs': ['src/d1.mjs'],
      'src/d1.mjs': ['src/d2.mjs'],
      'src/d2.mjs': ['src/d3.mjs'],
      'src/d3.mjs': ['tests/deep.test.mjs'],
    },
  });
  assert.deepEqual(selectAffectedTests(deep, ['src/d0.mjs']).tests, ['tests/deep.test.mjs']);
  assert.deepEqual(selectAffectedTests(deep, ['src/d0.mjs'], { depth: 4 }).tests, ['tests/deep.test.mjs']);
  const limited = selectAffectedTests(deep, ['src/d0.mjs'], { depth: 3 });
  assert.equal(limited.mode, 'full');
  assert.ok(limited.reasons.some((r) => r.startsWith('depth-limit')));
});

test('cycles in importedBy terminate and still find the test', () => {
  const cycle = makeMap({
    tests: TESTS,
    sources: ['src/a.mjs', 'src/b.mjs'],
    importedBy: {
      'src/a.mjs': ['src/b.mjs', 'tests/t1.test.mjs'],
      'src/b.mjs': ['src/a.mjs'],
    },
  });
  assert.deepEqual(selectAffectedTests(cycle, ['src/b.mjs']).tests, ['tests/t1.test.mjs']);
  assert.deepEqual(selectAffectedTests(cycle, ['src/a.mjs']).tests, ['tests/t1.test.mjs']);
});

test('testLinks select tests linked to the changed file or to a reached file', () => {
  const linked = makeMap({
    tests: TESTS,
    sources: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'],
    testLinks: [
      { test: 'tests/t2.test.mjs', source: 'src/c.mjs', by: 'name' },
      { test: 'tests/t9.test.mjs', source: 'src/a.mjs', by: 'import' },
    ],
    importedBy: CHAIN.importedBy,
  });
  const cDepth1 = selectAffectedTests(linked, ['src/c.mjs'], { depth: 1 });
  assert.equal(cDepth1.mode, 'full');
  assert.ok(cDepth1.reasons.some((r) => r.startsWith('depth-limit')));
  assert.deepEqual(
    selectAffectedTests(linked, ['src/c.mjs']).tests,
    ['tests/t1.test.mjs', 'tests/t2.test.mjs', 'tests/t9.test.mjs'],
  );
  assert.deepEqual(
    selectAffectedTests(linked, ['src/a.mjs'], { depth: 1 }).tests,
    ['tests/t1.test.mjs', 'tests/t9.test.mjs'],
  );
});

test('a file with 199 importers is still walked; 200 or more is a truncated graph', () => {
  const many199 = Array.from({ length: 198 }, (_, i) => `src/m${i}.mjs`);
  const ok = makeMap({
    tests: TESTS,
    sources: ['src/a.mjs'],
    importedBy: { 'src/a.mjs': ['tests/t1.test.mjs', ...many199] },
  });
  assert.deepEqual(selectAffectedTests(ok, ['src/a.mjs']).tests, ['tests/t1.test.mjs']);

  const many200 = Array.from({ length: 199 }, (_, i) => `src/m${i}.mjs`);
  const capped = makeMap({
    tests: TESTS,
    sources: ['src/a.mjs'],
    importedBy: { 'src/a.mjs': ['tests/t1.test.mjs', ...many200] },
  });
  const s = selectAffectedTests(capped, ['src/a.mjs']);
  assert.equal(s.mode, 'full');
  assert.deepEqual(s.tests, []);
  assert.ok(s.reasons.some((r) => r.startsWith('truncated-graph')));
});

test('a changed or reached file over 262144 bytes is a truncated graph', () => {
  const sized = makeMap({
    tests: TESTS,
    sources: ['src/a.mjs', 'src/big.mjs'],
    importedBy: { 'src/a.mjs': ['src/big.mjs'], 'src/big.mjs': ['tests/t1.test.mjs'] },
  });
  sized.files['src/big.mjs'].bytes = 262145;

  const reached = selectAffectedTests(sized, ['src/a.mjs']);
  assert.equal(reached.mode, 'full');
  assert.ok(reached.reasons.some((r) => r.startsWith('truncated-graph')));

  const changed = selectAffectedTests(sized, ['src/big.mjs']);
  assert.equal(changed.mode, 'full');
  assert.ok(changed.reasons.some((r) => r.startsWith('truncated-graph')));

  sized.files['src/big.mjs'].bytes = 262144;
  assert.deepEqual(selectAffectedTests(sized, ['src/a.mjs']).tests, ['tests/t1.test.mjs']);
});

test('languages without an import graph are a full run; js, python and rust are walked', () => {
  const polyglot = makeMap({ tests: TESTS, sources: ['src/a.mjs'] });
  polyglot.files['lib/x.go'] = { lang: 'go', isTest: false };
  polyglot.files['pkg/mod.py'] = { lang: 'python', isTest: false };
  polyglot.files['crate/lib.rs'] = { lang: 'rust', isTest: false };
  polyglot.importedBy['pkg/mod.py'] = ['tests/t2.test.mjs'];
  polyglot.importedBy['crate/lib.rs'] = ['tests/t3.test.mjs'];

  const go = selectAffectedTests(polyglot, ['lib/x.go']);
  assert.equal(go.mode, 'full');
  assert.deepEqual(go.tests, []);
  assert.ok(go.reasons.some((r) => r.startsWith('no-import-graph')));

  assert.deepEqual(selectAffectedTests(polyglot, ['pkg/mod.py']).tests, ['tests/t2.test.mjs']);
  assert.deepEqual(selectAffectedTests(polyglot, ['crate/lib.rs']).tests, ['tests/t3.test.mjs']);
});

test('a map with no tests is a full run', () => {
  const map = makeMap({ sources: ['src/a.mjs'], importedBy: { 'src/a.mjs': ['src/b.mjs'] } });
  const s = selectAffectedTests(map, ['src/a.mjs']);
  assert.equal(s.mode, 'full');
  assert.deepEqual(s.tests, []);
  assert.ok(s.reasons.some((r) => r.startsWith('no-tests')));
});

test('a changed source file that reaches no test is a full run', () => {
  const map = makeMap({ tests: TESTS, sources: ['src/lonely.mjs'] });
  const s = selectAffectedTests(map, ['src/lonely.mjs']);
  assert.equal(s.mode, 'full');
  assert.deepEqual(s.tests, []);
  assert.ok(s.reasons.some((r) => r.startsWith('no-test-reach')));
});

test('a deleted file is a full run, and deleted tests are never selected', () => {
  const gone = selectAffectedTests(CHAIN, ['src/a.mjs'], { deleted: ['src/old.mjs'] });
  assert.equal(gone.mode, 'full');
  assert.deepEqual(gone.tests, []);
  assert.ok(gone.reasons.some((r) => r.startsWith('deleted-file')));

  const goneTest = selectAffectedTests(CHAIN, ['tests/t2.test.mjs'], { deleted: ['tests/t9.test.mjs'] });
  assert.equal(goneTest.mode, 'full');
  assert.deepEqual(goneTest.tests, []);

  const none = selectAffectedTests(CHAIN, ['src/a.mjs'], { deleted: [] });
  assert.equal(none.mode, 'affected');
});

test('a changed test file selects itself', () => {
  const s = selectAffectedTests(CHAIN, ['tests/t3.test.mjs']);
  assert.equal(s.mode, 'affected');
  assert.deepEqual(s.tests, ['tests/t3.test.mjs']);
});

test('a new test file that is not in the map selects itself', () => {
  const s = selectAffectedTests(CHAIN, ['tests/new.test.mjs']);
  assert.equal(s.mode, 'affected');
  assert.deepEqual(s.tests, ['tests/new.test.mjs']);
});

test('selected tests are sorted and de-duplicated', () => {
  const s = selectAffectedTests(CHAIN, ['src/a.mjs', 'tests/new.test.mjs', 'tests/t5.test.mjs']);
  assert.equal(s.mode, 'affected');
  assert.deepEqual(s.tests, ['tests/new.test.mjs', 'tests/t1.test.mjs', 'tests/t5.test.mjs']);

  const dup = selectAffectedTests(CHAIN, ['src/a.mjs', 'tests/t1.test.mjs']);
  assert.deepEqual(dup.tests, ['tests/t1.test.mjs']);
});

test('expandAffectedArgv puts ./ before each selected test and in place of the affected item', () => {
  const sel = { mode: 'affected', tests: ['tests/a.test.mjs', 'tests/b.test.mjs'], reasons: [] };
  const r = expandAffectedArgv(['node', '--test', '{affected}'], sel);
  assert.deepEqual(r.argv, ['node', '--test', './tests/a.test.mjs', './tests/b.test.mjs']);
  assert.equal(r.empty, false);
});

test('expandAffectedArgv refuses an affected item at index 0', () => {
  const sel = { mode: 'affected', tests: ['tests/a.test.mjs'], reasons: [] };
  assert.throws(() => expandAffectedArgv(['{affected}', '--test'], sel), (e) => e.code === 'affected-argv');
});

test('expandAffectedArgv with an empty affected selection is marked empty', () => {
  const sel = { mode: 'affected', tests: [], reasons: [] };
  const r = expandAffectedArgv(['node', '--test', '{affected}'], sel);
  assert.deepEqual(r.argv, ['node', '--test']);
  assert.equal(r.empty, true);
});

test('expandAffectedArgv in full mode leaves the item alone and flags full', () => {
  const original = ['node', '--test', '{affected}'];
  const sel = { mode: 'full', tests: [], reasons: ['no-changes'] };
  const r = expandAffectedArgv(original, sel);
  assert.deepEqual(r.argv, ['node', '--test', '{affected}']);
  assert.equal(r.empty, false);
  assert.equal(r.full, true);
});

test('expandAffectedArgv copies other items unchanged and does not mutate its input', () => {
  const original = ['node', '--test', '--test-reporter=spec', '{affected}', 'tests/x.test.mjs'];
  const snapshot = original.slice();
  const sel = { mode: 'affected', tests: ['tests/a.test.mjs'], reasons: [] };
  const r = expandAffectedArgv(original, sel);
  assert.deepEqual(r.argv, ['node', '--test', '--test-reporter=spec', './tests/a.test.mjs', 'tests/x.test.mjs']);
  assert.deepEqual(original, snapshot);
});
