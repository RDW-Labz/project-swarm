// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const acornInstalled = await import('acorn').then(() => true, () => false);
if (!acornInstalled) {
  test('split-module tests', { skip: 'acorn not installed: run npm ci' }, () => {});
} else {
  const {
    planSplit,
    moveItems,
    verifyMove,
    checkUnresolvedImportsForMove,
    possiblyUnresolvedNames,
    smokeImportModules,
  } = await import('../tools/split-module.mjs');
  const { scanModule } = await import('../tools/split-scan.mjs');

const root = path.dirname(fileURLToPath(import.meta.url));
const tmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();
const swarmPath = path.join(root, '..', 'tools', 'swarm.mjs');
const swarmSplitDir = path.join(root, '..', 'tools', 'swarm');

function swarmMonolithPreSplit() {
  if (fs.existsSync(swarmSplitDir)) return false;
  if (!fs.existsSync(swarmPath)) return false;
  const lineCount = fs.readFileSync(swarmPath, 'utf8').split('\n').length;
  return lineCount >= 5000;
}

function skipIfSwarmAlreadySplit(t, reason) {
  if (!swarmMonolithPreSplit()) {
    t.skip(reason || 'tools/swarm.mjs already split or not monolithic');
  }
}

function mkFixture(name, files) {
  const dir = fs.mkdtempSync(path.join(tmpBase, `split-mod-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('leaf move splits a function with no internal deps', () => {
  const dir = mkFixture('leaf', {
    'main.mjs': [
      'import fs from "node:fs";',
      '',
      'function helper() { return 1; }',
      'function main() { return helper() + fs.readFileSync; }',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'helper.mjs');
  const originalPath = path.join(dir, 'main.original.mjs');
  fs.writeFileSync(originalPath, fs.readFileSync(main, 'utf8'));
  const original = fs.readFileSync(originalPath, 'utf8');
  const result = moveItems(main, mod, ['helper']);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.ok(fs.existsSync(mod));
  assert.ok(fs.readFileSync(mod, 'utf8').includes('function helper()'));
  const verify = verifyMove(main, mod, originalPath);
  assert.equal(verify.ok, true, verify.issues?.join('; '));
  const afterMain = fs.readFileSync(main, 'utf8');
  assert.ok(afterMain.includes('import { helper }'));
  assert.ok(afterMain.includes('function main()'));
  assert.notEqual(afterMain, original);
});

test('move copies import used by moved item', () => {
  const dir = mkFixture('import-use', {
    'main.mjs': [
      'import path from "node:path";',
      'function usesPath() { return path.join("a", "b"); }',
      'const x = 1;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'uses.mjs');
  const result = moveItems(main, mod, ['usesPath']);
  assert.equal(result.ok, true);
  const modText = fs.readFileSync(mod, 'utf8');
  assert.ok(modText.includes('node:path'));
  assert.ok(modText.includes('function usesPath'));
});

test('move refused for back reference', () => {
  const dir = mkFixture('backref', {
    'main.mjs': 'const base = 1;\nfunction dep() { return base; }\n',
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'dep.mjs');
  const result = moveItems(main, mod, ['dep']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('back-references')));
});

test('move refused for reassigned let', () => {
  const dir = mkFixture('reassign', {
    'main.mjs': 'let counter = 0;\ncounter = 1;\nfunction f() { return counter; }\n',
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'f.mjs');
  const result = moveItems(main, mod, ['counter']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('reassigned')));
});

test('move refused for import.meta in item', () => {
  const dir = mkFixture('meta', {
    'main.mjs': 'function metaFn() { return import.meta.url; }\nconst x = 1;\n',
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'meta.mjs');
  const result = moveItems(main, mod, ['metaFn']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('forbidden runtime')));
});

test('re-export keeps importing file working', () => {
  const dir = mkFixture('reexport', {
    'lib.mjs': 'export function greet() { return "hi"; }\nexport const n = 1;\n',
    'consumer.mjs': 'import { greet } from "./lib.mjs";\nif (greet() !== "hi") throw new Error("fail");\n',
  });
  const lib = path.join(dir, 'lib.mjs');
  const mod = path.join(dir, 'greet.mjs');
  const result = moveItems(lib, mod, ['greet']);
  assert.equal(result.ok, true);
  assert.ok(fs.readFileSync(lib, 'utf8').includes('export { greet }'));
  const run = spawnSync(process.execPath, [path.join(dir, 'consumer.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test('dry-run writes nothing', () => {
  const dir = mkFixture('dry', {
    'main.mjs': 'function solo() {}\nconst a = 1;\n',
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'solo.mjs');
  const before = fs.readFileSync(main, 'utf8');
  const result = moveItems(main, mod, ['solo'], { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(main, 'utf8'), before);
  assert.ok(!fs.existsSync(mod));
});

test('verify catches hand-altered copy', () => {
  const dir = mkFixture('verify-bad', {
    'main.mjs': 'function solo() { return 1; }\n',
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'solo.mjs');
  moveItems(main, mod, ['solo']);
  fs.writeFileSync(mod, fs.readFileSync(mod, 'utf8').replace('return 1', 'return 2'), 'utf8');
  const orig = mkFixture('verify-orig', { 'main.mjs': 'function solo() { return 1; }\n' });
  const verify = verifyMove(main, mod, path.join(orig, 'main.mjs'));
  assert.equal(verify.ok, false);
  assert.ok(verify.issues.length > 0);
});

test('plan layers a small cycle as one group', () => {
  const dir = mkFixture('cycle', {
    'main.mjs': [
      'function a() { return b(); }',
      'function b() { return a(); }',
      'function leaf() { return 1; }',
      '',
    ].join('\n'),
  });
  const plan = planSplit(path.join(dir, 'main.mjs'));
  const layer0 = plan.layers[0] || [];
  const layer0Names = layer0.flatMap((g) => g.items.flatMap((it) => it.names));
  assert.ok(layer0Names.includes('leaf'));
  const cycleGroup = plan.layers.flat().find((g) => g.cycle && g.items.length >= 2);
  assert.ok(cycleGroup, 'expected cycle group');
  const cycleNames = cycleGroup.items.flatMap((it) => it.names).sort();
  assert.deepEqual(cycleNames, ['a', 'b']);
});

test('moved function rewrites literal dynamic import into subfolder', async () => {
  const dir = mkFixture('dyn-import', {
    'other.mjs': 'export const VALUE = 42;\n',
    'main.mjs': [
      'async function loadOther() {',
      '  const m = await import("./other.mjs");',
      '  return m.VALUE;',
      '}',
      'const stay = 0;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'sub', 'loader.mjs');
  const result = moveItems(main, mod, ['loadOther']);
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.ok(result.rewrittenSpecifiers?.some((r) => r.from === './other.mjs' && r.to === '../other.mjs'));
  const modText = fs.readFileSync(mod, 'utf8');
  assert.ok(modText.includes('../other.mjs'));
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { loadOther } from ${JSON.stringify(mod)}; const v = await loadOther(); if (v !== 42) process.exit(1);`],
    { encoding: 'utf8', cwd: dir },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test('dynamic import of moved sibling in swarm folder uses ./ basename', () => {
  const dir = mkFixture('dyn-sibling', {
    'sibling.mjs': 'export const ok = 1;\n',
    'main.mjs': [
      'async function loadSibling() {',
      '  const m = await import("./sibling.mjs");',
      '  return m.ok;',
      '}',
      'const stay = 0;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  fs.mkdirSync(path.join(dir, 'pack'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'sibling.mjs'), path.join(dir, 'pack', 'sibling.mjs'));
  const mod = path.join(dir, 'pack', 'loader.mjs');
  const result = moveItems(main, mod, ['loadSibling']);
  assert.equal(result.ok, true, result.errors?.join('; '));
  const modText = fs.readFileSync(mod, 'utf8');
  assert.ok(modText.includes('./sibling.mjs'));
  assert.ok(!modText.includes('../sibling.mjs'));
});

test('non-literal relative dynamic import is refused', () => {
  const dir = mkFixture('dyn-bad', {
    'main.mjs': 'async function bad() { const n = "a"; return import(`./x-${n}.mjs`); }\nconst stay = 0;\n',
  });
  const result = moveItems(path.join(dir, 'main.mjs'), path.join(dir, 'bad.mjs'), ['bad']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('non-literal relative dynamic import')));
});

test('new URL with import.meta.url is refused', () => {
  const dir = mkFixture('dyn-url', {
    'main.mjs': 'function u() { return new URL("./data.json", import.meta.url); }\nconst x = 1;\n',
  });
  const result = moveItems(path.join(dir, 'main.mjs'), path.join(dir, 'u.mjs'), ['u']);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('forbidden runtime') || e.includes('relative new URL')),
  );
});

test('node: and bare dynamic import specifiers stay untouched', () => {
  const dir = mkFixture('dyn-bare', {
    'main.mjs': [
      'async function loadNode() { return import("node:fs"); }',
      'async function loadBare() { return import("zod"); }',
      'const stay = 0;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'sub', 'loads.mjs');
  const result = moveItems(main, mod, ['loadNode', 'loadBare']);
  assert.equal(result.ok, true, result.errors?.join('; '));
  const modText = fs.readFileSync(mod, 'utf8');
  assert.ok(modText.includes('node:fs'));
  assert.ok(modText.includes('"zod"'));
  assert.equal(result.rewrittenSpecifiers?.length ?? 0, 0);
});

test('plan on tools/swarm.mjs finishes quickly with layer-0 items', () => {
  const started = Date.now();
  const plan = planSplit(swarmPath);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `plan took ${elapsed}ms`);
  const layer0 = plan.layers[0] || [];
  assert.ok(layer0.length > 0);
  const hasLayer0Item = layer0.some((g) => g.items.length > 0);
  assert.ok(hasLayer0Item);
});

test('move spread array includes import for spread binding', () => {
  const dir = mkFixture('spread-import', {
    'dep.mjs': 'export const EXTRA_CLI_AGENTS = ["hermes"];\n',
    'main.mjs': [
      'import { EXTRA_CLI_AGENTS } from "./dep.mjs";',
      "const CLI_AGENTS = ['claude', 'codex', ...EXTRA_CLI_AGENTS];",
      'const keep = 1;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'cli-agents.mjs');
  const result = moveItems(main, mod, ['CLI_AGENTS']);
  assert.equal(result.ok, true, result.errors?.join('; '));
  const modText = fs.readFileSync(mod, 'utf8');
  assert.ok(modText.includes('EXTRA_CLI_AGENTS'));
  assert.ok(modText.includes('./dep.mjs'));
});

test('move with rest parameter and object rest pattern', () => {
  const dir = mkFixture('rest-move', {
    'main.mjs': [
      'function withRest(...args) { return args; }',
      'function pick({ a, ...rest }) { return rest; }',
      'const stay = 0;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'rest.mjs');
  const r1 = moveItems(main, path.join(dir, 'a.mjs'), ['withRest']);
  assert.equal(r1.ok, true, r1.errors?.join('; '));
  const r2 = moveItems(main, mod, ['pick']);
  assert.equal(r2.ok, true, r2.errors?.join('; '));
});

test('verify catches module missing import after deliberate drop', () => {
  const originalText = [
    'import { EXTRA } from "./dep.mjs";',
    'const V = EXTRA + 1;',
    '',
  ].join('\n');
  const dir = mkFixture('drop-import', {
    'dep.mjs': 'export const EXTRA = 1;\n',
    'main.mjs': originalText,
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'v.mjs');
  moveItems(main, mod, ['V']);
  const bad = fs.readFileSync(mod, 'utf8').replace(/import[^\n]+\n/, '');
  fs.writeFileSync(mod, bad, 'utf8');
  const { items } = scanModule(originalText);
  const movedItem = items.find((it) => it.names.includes('V'));
  const issues = checkUnresolvedImportsForMove(originalText, bad, [movedItem]);
  assert.ok(issues.length > 0, issues.join('; '));
});

function stage1PatternNames(plan, copy) {
  const layer0 = plan.layers[0] || [];
  const names = [];
  for (const g of layer0) {
    for (const it of g.items) {
      if (it.cannotMoveAlone.length > 0) continue;
      if (it.kind !== 'declaration') continue;
      const text = fs.readFileSync(copy, 'utf8');
      const { items } = scanModule(text);
      const full = items.find((x) => x.names[0] === it.names[0]);
      if (!full) continue;
      const onlyImports = [...full.uses].every((u) => {
        const imp = items.find((ii) => ii.kind === 'import' && ii.names.includes(u));
        return imp || u === 'undefined';
      });
      if (onlyImports && it.names.length === 1) names.push(it.names[0]);
    }
  }
  return names;
}

function layer0MovableNames(plan, copy, filter) {
  const layer0 = plan.layers[0] || [];
  const names = [];
  const text = fs.readFileSync(copy, 'utf8');
  const { items } = scanModule(text);
  for (const g of layer0) {
    for (const it of g.items) {
      if (it.cannotMoveAlone.length > 0) continue;
      if (it.kind !== 'function') continue;
      if (!it.names.every((n) => filter(n))) continue;
      const full = items.find((x) => x.names[0] === it.names[0]);
      if (!full || full.names.length !== it.names.length) continue;
      names.push(...it.names);
    }
  }
  return names;
}

function copyToolsDir(name) {
  const toolsDir = path.join(root, '..', 'tools');
  const dir = mkFixture(name, {});
  for (const file of fs.readdirSync(toolsDir)) {
    if (!file.endsWith('.mjs')) continue;
    fs.copyFileSync(path.join(toolsDir, file), path.join(dir, file));
  }
  return { dir, copy: path.join(dir, 'swarm.mjs') };
}

function nextMovableLayerGroupNames(plan) {
  for (const layer of plan.layers) {
    for (const g of layer) {
      const names = [];
      for (const it of g.items) {
        if (it.cannotMoveAlone.length > 0) continue;
        names.push(...it.names);
      }
      if (names.length > 0) return names;
    }
  }
  return null;
}

function runPatternsStage(copy, dir) {
  const plan = planSplit(copy);
  const names = stage1PatternNames(plan, copy);
  assert.ok(names.length > 0, 'no pattern-stage names');
  const batch = names.slice(0, Math.min(8, names.length));
  const mod = path.join(dir, 'swarm-patterns.mjs');
  const result = moveItems(copy, mod, batch);
  assert.equal(result.ok, true, `patterns: ${result.errors?.join('; ')}`);
  return mod;
}

function runWarningsStage(copy, dir) {
  const plan = planSplit(copy);
  const names = layer0MovableNames(plan, copy, (n) => /Warnings$/.test(n));
  assert.ok(names.length > 0, 'no warnings-stage names');
  const batch = names.slice(0, Math.min(6, names.length));
  const mod = path.join(dir, 'swarm-warnings.mjs');
  const result = moveItems(copy, mod, batch, { allowBackReferences: true });
  assert.equal(result.ok, true, `warnings: ${result.errors?.join('; ')}`);
  return mod;
}

function runMutantsStage(copy, dir) {
  const mod = path.join(dir, 'swarm-mutants-core.mjs');
  const result = moveItems(copy, mod, ['reviewSourcePath', 'parseContractEventRows'], {
    allowBackReferences: true,
  });
  assert.equal(result.ok, true, `mutants: ${result.errors?.join('; ')}`);
  return mod;
}

function runCoreStage(copy, dir, stageNum) {
  const plan = planSplit(copy);
  const names = nextMovableLayerGroupNames(plan);
  assert.ok(names, `no movable group for core-${stageNum}`);
  const mod = path.join(dir, `swarm-core-${stageNum}.mjs`);
  const result = moveItems(copy, mod, names, { allowBackReferences: true });
  assert.equal(result.ok, true, `core-${stageNum}: ${result.errors?.join('; ')}`);
  return mod;
}

test('possiblyUnresolvedNames ignores go in comment string template and regex', () => {
  const body = [
    '// 8 of 11 reader lines go unmeasured',
    '/* block go here */',
    'const s = "go";',
    'const t = `prefix go suffix`;',
    'const re = /\\.(?:rs|go|java)$/i;',
    'const obj = { go: 1 };',
    'function usesProp() { return obj.go; }',
    '',
  ].join('\n');
  const original = `import go from "go-pkg";\n${body}`;
  const moduleMissingImport = body;
  assert.ok(!possiblyUnresolvedNames(moduleMissingImport).has('go'));
  const { items } = scanModule(original);
  const movedItem = items.find((it) => it.names.includes('usesProp'));
  const issues = checkUnresolvedImportsForMove(original, moduleMissingImport, [movedItem]);
  assert.ok(!issues.some((i) => i.includes(' go')));
});

test('move with duplicate import name uses alias binding only in new module', () => {
  const dir = mkFixture('import-alias-dup', {
    'exec.mjs': 'export function isSecretPath() { return 1; }\n',
    'prof.mjs': 'export function isSecretPath() { return 2; }\n',
    'main.mjs': [
      'import { isSecretPath } from "./exec.mjs";',
      'import { isSecretPath as isProfileSecretPath } from "./prof.mjs";',
      'function usesProfileSecret() { return isProfileSecretPath(); }',
      'const stay = 0;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'uses-profile.mjs');
  const result = moveItems(main, mod, ['usesProfileSecret']);
  assert.equal(result.ok, true, result.errors?.join('; '));
  const modText = fs.readFileSync(mod, 'utf8');
  assert.ok(modText.includes('isProfileSecretPath'));
  assert.ok(modText.includes('as isProfileSecretPath'));
  assert.ok(!modText.includes('from "./exec.mjs"'));
  assert.ok(!modText.match(/import\s*\{[^}]*\bisSecretPath\b[^}]*\}\s*from\s*['"]\.\/exec/));
});

test('unaliased import name still flagged when its import line is dropped from module', () => {
  const originalText = [
    'import { isSecretPath } from "./exec.mjs";',
    'import { isSecretPath as isProfileSecretPath } from "./prof.mjs";',
    'function usesExec() { return isSecretPath(); }',
    '',
  ].join('\n');
  const dir = mkFixture('import-alias-miss', {
    'exec.mjs': 'export function isSecretPath() { return 1; }\n',
    'prof.mjs': 'export function isSecretPath() { return 2; }\n',
    'main.mjs': originalText,
  });
  const main = path.join(dir, 'main.mjs');
  const mod = path.join(dir, 'uses-exec.mjs');
  moveItems(main, mod, ['usesExec']);
  const bad = fs.readFileSync(mod, 'utf8').replace(/import[^\n]+\.\/exec\.mjs[^\n]*\n/, '');
  const { items } = scanModule(originalText);
  const movedItem = items.find((it) => it.names.includes('usesExec'));
  const issues = checkUnresolvedImportsForMove(originalText, bad, [movedItem]);
  assert.ok(issues.some((i) => i.includes('isSecretPath')));
});

test('possiblyUnresolvedNames ignores export-from specifier names', () => {
  const mod = "export { isSecretPath as isProfileSecretPath } from './prof.mjs';\n";
  assert.ok(!possiblyUnresolvedNames(mod).has('isSecretPath'));
});

test('move may place export-from line in new module without false unresolved import', () => {
  const dir = mkFixture('export-from-move', {
    'dep.mjs': 'export const bridge = 1;\n',
    'main.mjs': [
      'export { bridge } from "./dep.mjs";',
      'const stay = 0;',
      '',
    ].join('\n'),
  });
  const main = path.join(dir, 'main.mjs');
  const { items } = scanModule(fs.readFileSync(main, 'utf8'));
  const exportItem = items.find((it) => it.kind === 'export');
  assert.ok(exportItem, 'expected export-from item');
  const mod = path.join(dir, 'bridge.mjs');
  const result = moveItems(main, mod, exportItem.names);
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.ok(fs.readFileSync(mod, 'utf8').includes('from "./dep.mjs"'));
});

test('possiblyUnresolvedNames flags real go() when import missing from module', () => {
  const original = [
    'import go from "go-pkg";',
    'function callsGo() { return go(); }',
    '',
  ].join('\n');
  const moduleText = 'function callsGo() { return go(); }\n';
  assert.ok(possiblyUnresolvedNames(moduleText).has('go'));
  const { items } = scanModule(original);
  const movedItem = items.find((it) => it.names.includes('callsGo'));
  const issues = checkUnresolvedImportsForMove(original, moduleText, [movedItem]);
  assert.ok(issues.some((i) => i.includes('go')));
});

test('tools/swarm.mjs generic scan invariants (any layout)', () => {
  if (!fs.existsSync(swarmPath)) return;
  const text = fs.readFileSync(swarmPath, 'utf8');
  const started = Date.now();
  const { items, exports } = scanModule(text);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `scan took ${elapsed}ms`);
  let rebuilt = '';
  let pos = 0;
  for (const it of items) {
    rebuilt += text.slice(pos, it.start) + it.text;
    pos = it.end;
  }
  rebuilt += text.slice(pos);
  assert.equal(rebuilt, text);
  const declared = new Set();
  for (const it of items) {
    for (const n of it.names) declared.add(n);
    if (it.exported) for (const n of it.names) declared.add(n);
  }
  for (const name of exports) assert.ok(declared.has(name), `missing export ${name}`);
});

test('stage-1 pattern constants move on swarm copy smoke-imports', (t) => {
  skipIfSwarmAlreadySplit(t, 'monolithic swarm copy stages require unsplit tools/swarm.mjs');
  const { dir, copy } = copyToolsDir('swarm-stage1');
  const plan = planSplit(copy);
  const names = stage1PatternNames(plan, copy);
  assert.ok(names.length > 0, 'no stage-1 names');
  const batch = names.slice(0, Math.min(8, names.length));
  const mod = path.join(dir, 'swarm-patterns.mjs');
  const result = moveItems(copy, mod, batch);
  assert.equal(result.ok, true, result.errors?.join('; '));
  const smoke = smokeImportModules([mod, copy], { timeoutMs: 20_000 });
  assert.equal(smoke.length, 0, smoke.join('; '));
});

test('swarm copy stages patterns warnings and mutants succeed', (t) => {
  skipIfSwarmAlreadySplit(t, 'monolithic swarm copy stages require unsplit tools/swarm.mjs');
  const { dir, copy } = copyToolsDir('swarm-stages-3');
  const patternsMod = runPatternsStage(copy, dir);
  const warningsMod = runWarningsStage(copy, dir);
  const mutantsMod = runMutantsStage(copy, dir);

  const smoke = smokeImportModules([patternsMod, warningsMod, mutantsMod, copy], { timeoutMs: 30_000 });
  assert.equal(smoke.length, 0, smoke.join('; '));
});

test('swarm copy split stages patterns through core-12 succeed', (t) => {
  skipIfSwarmAlreadySplit(t, 'monolithic swarm copy stages require unsplit tools/swarm.mjs');
  const started = Date.now();
  const { dir, copy } = copyToolsDir('swarm-through-core-12');
  const modules = [
    runPatternsStage(copy, dir),
    runWarningsStage(copy, dir),
    runMutantsStage(copy, dir),
  ];
  for (let n = 1; n <= 12; n++) {
    modules.push(runCoreStage(copy, dir, n));
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 60_000, `stages took ${elapsed}ms`);
  const smoke = smokeImportModules([...modules, copy], { timeoutMs: 30_000 });
  assert.equal(smoke.length, 0, smoke.join('; '));
});

test('dry-run move of layer-0 function on swarm.mjs does not touch file', (t) => {
  skipIfSwarmAlreadySplit(t, 'dry-run on live swarm requires monolithic tools/swarm.mjs');
  const plan = planSplit(swarmPath);
  let pick = null;
  for (const g of plan.layers[0] || []) {
    for (const it of g.items) {
      if (it.cannotMoveAlone.length === 0 && it.names.length === 1 && it.kind === 'function') {
        pick = it.names[0];
        break;
      }
    }
    if (pick) break;
  }
  assert.ok(pick, 'no movable layer-0 function found');
  const before = fs.readFileSync(swarmPath, 'utf8');
  const mod = path.join(tmpBase, `swarm-split-dry-${Date.now()}.mjs`);
  const result = moveItems(swarmPath, mod, [pick], { dryRun: true });
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(fs.readFileSync(swarmPath, 'utf8'), before);
  try {
    if (fs.existsSync(mod)) fs.unlinkSync(mod);
  } catch {
    // ignore
  }
});

}
