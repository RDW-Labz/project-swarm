// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planSplit, moveItems, verifyMove } from '../tools/split-module.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const tmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();

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

test('plan on tools/swarm.mjs finishes quickly with layer-0 items', () => {
  const swarmPath = path.join(root, '..', 'tools', 'swarm.mjs');
  const started = Date.now();
  const plan = planSplit(swarmPath);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `plan took ${elapsed}ms`);
  const layer0 = plan.layers[0] || [];
  assert.ok(layer0.length > 0);
  const hasLayer0Item = layer0.some((g) => g.items.length > 0);
  assert.ok(hasLayer0Item);
});

test('dry-run move of layer-0 function on swarm.mjs does not touch file', () => {
  const swarmPath = path.join(root, '..', 'tools', 'swarm.mjs');
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
