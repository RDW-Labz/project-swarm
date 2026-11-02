import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitignoreBlock, ensureGitignore } from '../tools/gitignore-defaults.mjs';

const NODE_LINES = ['node_modules/', '.next/', 'out/', 'dist/', 'coverage/', '*.tsbuildinfo', 'next-env.d.ts', '.env*'];
const PYTHON_LINES = ['__pycache__/', '.venv/', '*.pyc'];

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gitignore-test-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function linesOf(text) {
  return text.split(/\r?\n/).map((l) => l.trim());
}

function blockText(stacks) {
  const block = gitignoreBlock(stacks);
  return Array.isArray(block) ? block.join('\n') : block;
}

test('node block contains the node defaults', () => {
  const lines = linesOf(blockText(['node']));
  for (const line of NODE_LINES) {
    assert.ok(lines.includes(line), `missing ${line}`);
  }
});

test('python block contains the python defaults', () => {
  const lines = linesOf(blockText(['python']));
  for (const line of PYTHON_LINES) {
    assert.ok(lines.includes(line), `missing ${line}`);
  }
});

test('missing .gitignore is created with the stack lines', () =>
  withRoot(async (root) => {
    const result = await ensureGitignore(root, ['node']);
    assert.equal(result.changed, true);
    assert.ok(existsSync(join(root, '.gitignore')));
    assert.ok(result.added.includes('node_modules/'));
    const lines = linesOf(readFileSync(join(root, '.gitignore'), 'utf8'));
    for (const line of NODE_LINES) {
      assert.ok(lines.includes(line), `missing ${line}`);
    }
  }));

test('python stack writes python lines', () =>
  withRoot(async (root) => {
    const result = await ensureGitignore(root, ['python']);
    assert.equal(result.changed, true);
    const lines = linesOf(readFileSync(join(root, '.gitignore'), 'utf8'));
    for (const line of PYTHON_LINES) {
      assert.ok(lines.includes(line), `missing ${line}`);
    }
  }));

test('existing .gitignore content is kept intact', () =>
  withRoot(async (root) => {
    const original = '# my own rules\nsecret-notes.txt\n';
    writeFileSync(join(root, '.gitignore'), original);
    await ensureGitignore(root, ['node']);
    const after = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.ok(after.startsWith(original), 'original content was changed');
    assert.ok(linesOf(after).includes('secret-notes.txt'));
  }));

test('partial overlap adds only the missing lines', () =>
  withRoot(async (root) => {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\ncoverage/\n');
    const result = await ensureGitignore(root, ['node']);
    assert.equal(result.changed, true);
    assert.ok(!result.added.includes('node_modules/'));
    assert.ok(!result.added.includes('coverage/'));
    assert.ok(result.added.includes('dist/'));
    const lines = linesOf(readFileSync(join(root, '.gitignore'), 'utf8'));
    assert.equal(lines.filter((l) => l === 'node_modules/').length, 1);
    assert.equal(lines.filter((l) => l === 'coverage/').length, 1);
    assert.equal(lines.filter((l) => l === 'dist/').length, 1);
  }));

test('second run is idempotent', () =>
  withRoot(async (root) => {
    await ensureGitignore(root, ['node', 'python']);
    const first = readFileSync(join(root, '.gitignore'), 'utf8');
    const result = await ensureGitignore(root, ['node', 'python']);
    assert.equal(result.changed, false);
    assert.deepEqual(result.added, []);
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), first);
  }));

test('a symlinked .gitignore is refused and its target is untouched', () =>
  withRoot(async (root) => {
    const target = join(root, 'real-ignore.txt');
    const original = 'keep\n';
    writeFileSync(target, original);
    symlinkSync(target, join(root, '.gitignore'));
    await assert.rejects(async () => ensureGitignore(root, ['node']));
    assert.equal(readFileSync(target, 'utf8'), original);
    assert.ok(lstatSync(join(root, '.gitignore')).isSymbolicLink());
  }));

test('a negation rule for .env keeps .env* out and reports it as skipped', () =>
  withRoot(async (root) => {
    writeFileSync(join(root, '.gitignore'), '!.env.example\n');
    const result = await ensureGitignore(root, ['node']);
    assert.ok(Array.isArray(result.skipped), 'skipped should be an array');
    assert.ok(result.skipped.includes('.env*'), '.env* should be reported as skipped');
    assert.ok(!result.added.includes('.env*'), '.env* should not be added');
    const lines = linesOf(readFileSync(join(root, '.gitignore'), 'utf8'));
    assert.equal(lines.filter((l) => l === '.env*').length, 0);
    assert.ok(lines.includes('!.env.example'), 'negation rule was removed');
  }));

test('skipped is empty when there is no negation rule', () =>
  withRoot(async (root) => {
    const result = await ensureGitignore(root, ['node']);
    assert.ok(Array.isArray(result.skipped), 'skipped should be an array');
    assert.deepEqual(result.skipped, []);
  }));
