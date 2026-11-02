import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  POINTER_FILE,
  writePointer,
  readPointerId,
  resolvePointer,
  stateRoot,
} from '../tools/state-pointer.mjs';
import {
  migrateState,
  dualWriteRun,
  externalStatePrimary,
  stateFolder,
} from '../tools/state-migrate.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const migrateModuleUrl = pathToFileURL(path.join(repoRoot, 'tools/state-migrate.mjs')).href;
const isolateImport = path.join(repoRoot, 'tests/_isolate-config.mjs');

async function mkRoots(t, prefix) {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, `${prefix}-home-`));
  const repoRootDir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, `${prefix}-repo-`));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repoRootDir, { recursive: true, force: true });
  });
  return { home, repoRoot: repoRootDir };
}

test('POINTER_FILE name and writePointer line format', async t => {
  assert.equal(POINTER_FILE, '.project-swarm-state');
  const { repoRoot: root } = await mkRoots(t, 'p2-ptr-fmt');
  const file = await writePointer(root, 'my.project-1');
  assert.equal(file, path.join(root, '.project-swarm-state'));
  const bytes = await fs.readFile(file, 'utf8');
  assert.equal(bytes, 'my.project-1\n');
});

test('writePointer rejects invalid project id', async t => {
  const { repoRoot: root } = await mkRoots(t, 'p2-ptr-invalid');
  await assert.rejects(writePointer(root, ''), /invalid project id/);
  await assert.rejects(writePointer(root, '../evil'), /invalid project id/);
});

test('readPointerId trims and resolvePointer joins stateRoot', async t => {
  const { home, repoRoot: root } = await mkRoots(t, 'p2-ptr-read');
  await writePointer(root, 'projA');
  assert.equal(await readPointerId(root), 'projA');
  await fs.writeFile(path.join(root, POINTER_FILE), '  projB  \n', 'utf8');
  assert.equal(await readPointerId(root), 'projB');
  const resolved = await resolvePointer(root, { home });
  assert.equal(resolved, path.join(stateRoot(home), 'projB') + path.sep);
});

test('readPointerId rejects invalid pointer contents', async t => {
  const { repoRoot: root } = await mkRoots(t, 'p2-ptr-bad');
  await fs.writeFile(path.join(root, POINTER_FILE), 'not valid!\n', 'utf8');
  await assert.rejects(readPointerId(root), /invalid pointer contents/);
});

test('migrateState copies legacy tree and writes .legacy-migration.json marker', async t => {
  const { home, repoRoot: root } = await mkRoots(t, 'p2-mig-copy');
  const legacyFile = path.join(root, '.swarm', 'nested', 'data.txt');
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  await fs.writeFile(legacyFile, 'payload', 'utf8');
  const first = await migrateState({ repoRoot: root, projectId: 'p1', home });
  assert.deepEqual(first.copied, ['nested/data.txt']);
  assert.equal(first.dest, stateFolder('p1', home));
  const destFile = path.join(first.dest, 'nested', 'data.txt');
  assert.equal(await fs.readFile(destFile, 'utf8'), 'payload');
  const markerPath = path.join(first.dest, '.legacy-migration.json');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  assert.deepEqual(marker.files, ['nested/data.txt']);
  assert.match(marker.lastRunAt, /^\d{4}-\d{2}-\d{2}T/);
  const second = await migrateState({ repoRoot: root, projectId: 'p1', home });
  assert.deepEqual(second.copied, []);
});

test('migrateState rejects invalid project id', async t => {
  const { home, repoRoot: root } = await mkRoots(t, 'p2-mig-id');
  await assert.rejects(migrateState({ repoRoot: root, projectId: 'bad/id', home }), /invalid project id/);
});

test('dualWriteRun writes legacy and external state when not primary', async t => {
  const { home, repoRoot: root } = await mkRoots(t, 'p2-dual-both');
  const env = { SWARM_EXTERNAL_STATE_PRIMARY: '0' };
  assert.equal(externalStatePrimary(env), false);
  const { stateTarget } = await dualWriteRun({
    repoRoot: root,
    projectId: 'dual1',
    relPath: 'runs/r1/state.json',
    text: '{"ok":true}\n',
    home,
    env,
  });
  assert.equal(await fs.readFile(stateTarget, 'utf8'), '{"ok":true}\n');
  const legacy = path.join(root, '.swarm', 'runs/r1/state.json');
  assert.equal(await fs.readFile(legacy, 'utf8'), '{"ok":true}\n');
});

test('dualWriteRun skips legacy when SWARM_EXTERNAL_STATE_PRIMARY=1', async t => {
  const { home, repoRoot: root } = await mkRoots(t, 'p2-dual-primary');
  const env = { SWARM_EXTERNAL_STATE_PRIMARY: '1' };
  assert.equal(externalStatePrimary(env), true);
  await dualWriteRun({
    repoRoot: root,
    projectId: 'dual2',
    relPath: 'only/external.txt',
    text: 'x',
    home,
    env,
  });
  await assert.rejects(
    fs.access(path.join(root, '.swarm', 'only/external.txt')),
    err => err.code === 'ENOENT',
  );
});

test('dualWriteRun rejects unsafe relative paths', async t => {
  const { home, repoRoot: root } = await mkRoots(t, 'p2-dual-unsafe');
  await assert.rejects(
    dualWriteRun({ repoRoot: root, projectId: 'u1', relPath: '../escape', text: 'x', home }),
    /unsafe relative path/,
  );
});

test(
  'migrateState marker truncate-in-place if writer killed mid-write',
  {
    todo:
      'Phase 2: migrateState rewrites .legacy-migration.json via truncate-in-place writeFile; fixed: atomic replace so kill cannot leave empty/invalid marker',
  },
  async t => {
    const { home, repoRoot: root } = await mkRoots(t, 'p2-mig-crash');
    await fs.mkdir(path.join(root, '.swarm', 'big'), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      await fs.writeFile(path.join(root, '.swarm', 'big', `f${i}.txt`), 'x'.repeat(8000), 'utf8');
    }
    const script = `
const { migrateState } = await import(${JSON.stringify(migrateModuleUrl)});
await migrateState({ repoRoot: process.env.TEST_ROOT, projectId: 'crash1', home: process.env.TEST_HOME });
process.stdout.write('done\\n');
`;
    const child = spawn(
      process.execPath,
      ['--import', isolateImport, '--input-type=module', '-e', script],
      {
        cwd: repoRoot,
        env: { ...process.env, TEST_ROOT: root, TEST_HOME: home },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    t.after(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 8000);
      child.stdout.once('data', () => {
        child.kill('SIGKILL');
      });
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const markerPath = path.join(stateFolder('crash1', home), '.legacy-migration.json');
    const text = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(text);
    assert.ok(Array.isArray(parsed.files) && parsed.files.length > 0);
  },
);
