import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GENERIC_TAGS, clusterLessons, classifyCluster, proposeGuard, renderProposal, mine } from '../tools/lesson-mine.mjs';
import { writeLesson } from '../tools/lesson-store.mjs';

const DATE = '2026-10-16';

function lesson(id, over = {}) {
  return { version: 1, id, project: 'swarm', date: DATE, stage: 'build', what: 'Went wrong in ' + id, rule: 'Check the thing before merging.', caughtBy: 'test', cost: { retries: 0, minutes: 0, usd: 0 }, laneModel: null, fix: '', guard: { kind: 'none', text: '', status: 'proposed' }, tags: ['alpha-tag'], source: { kind: 'manual' }, ...over };
}

function cluster(over = {}) {
  return { key: 'alpha-tag', lessonIds: ['L-0001'], tags: ['alpha-tag'], stages: { build: 1 }, caughtBy: { test: 1 }, guardKinds: { lint: 1 }, ...over };
}

async function mkRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lesson-mine-'));
}

function ids(n) {
  return Array.from({ length: n }, (_, i) => 'L-' + String(i + 1).padStart(4, '0'));
}

test('GENERIC_TAGS is frozen and lists stage names and broad tags', () => {
  assert.equal(Object.isFrozen(GENERIC_TAGS), true);
  for (const t of ['scope', 'split', 'build', 'test', 'review', 'merge', 'integration', 'deploy', 'tool', 'process', 'documentation', 'release', 'operations', 'product', 'data', 'security']) {
    assert.ok(GENERIC_TAGS.includes(t), t);
  }
});

test('clusters need at least min lessons', () => {
  const ls = [lesson('L-0001'), lesson('L-0002')];
  assert.deepEqual(clusterLessons(ls, { min: 3 }), []);
  const out = clusterLessons(ls, { min: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'alpha-tag');
  assert.deepEqual(out[0].lessonIds, ['L-0001', 'L-0002']);
});

test('default min is 3', () => {
  const ls = [lesson('L-0001'), lesson('L-0002', { tags: ['alpha-tag'] })];
  assert.deepEqual(clusterLessons(ls), []);
  assert.equal(clusterLessons([...ls, lesson('L-0003')]).length, 1);
});

test('generic tags never form a cluster', () => {
  const ls = ids(4).map(id => lesson(id, { tags: ['review'] }));
  assert.deepEqual(clusterLessons(ls), []);
});

test('guarded lessons are ignored unless includeGuarded', () => {
  const ls = ids(3).map(id => lesson(id, { guard: { kind: 'lint', text: '', status: 'shipped' } }));
  assert.deepEqual(clusterLessons(ls), []);
  const out = clusterLessons(ls, { includeGuarded: true });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].lessonIds, ids(3));
});

test('greedy assignment: earlier cluster takes shared lessons and small leftovers are dropped', () => {
  const ls = [
    lesson('L-0001', { tags: ['alpha-tag'] }),
    lesson('L-0002', { tags: ['alpha-tag'] }),
    lesson('L-0003', { tags: ['alpha-tag', 'beta-tag'] }),
    lesson('L-0004', { tags: ['alpha-tag', 'beta-tag'] }),
    lesson('L-0005', { tags: ['beta-tag'] }),
  ];
  const out = clusterLessons(ls);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'alpha-tag');
  assert.deepEqual(out[0].lessonIds, ['L-0001', 'L-0002', 'L-0003', 'L-0004']);
});

test('clusters come in count order then name order, deterministically', () => {
  const ls = ids(3).map(id => lesson(id, { tags: ['zeta-tag', 'alpha-tag'] }));
  const out = clusterLessons(ls);
  assert.deepEqual(out.map(c => c.key), ['alpha-tag']);
  assert.deepEqual(clusterLessons([...ls].reverse()), out);
});

test('cluster output has counts for stages, caughtBy and guardKinds', () => {
  const ls = [
    lesson('L-0001', { tags: ['alpha-tag', 'beta-tag'], stage: 'build', caughtBy: 'test', guard: { kind: 'lint', text: '', status: 'proposed' } }),
    lesson('L-0002', { tags: ['alpha-tag', 'beta-tag'], stage: 'build', caughtBy: 'missed', guard: { kind: 'lint', text: '', status: 'proposed' } }),
    lesson('L-0003', { tags: ['alpha-tag', 'beta-tag'], stage: 'review', caughtBy: 'test', guard: { kind: 'review-item', text: '', status: 'proposed' } }),
  ];
  const [c] = clusterLessons(ls, { min: 3 });
  assert.deepEqual(c.lessonIds, ['L-0001', 'L-0002', 'L-0003']);
  assert.deepEqual(c.stages, { build: 2, review: 1 });
  assert.deepEqual(c.caughtBy, { test: 2, missed: 1 });
  assert.deepEqual(c.guardKinds, { lint: 2, 'review-item': 1 });
  assert.ok(c.tags.includes('alpha-tag'));
  assert.ok(c.tags.includes('beta-tag'));
});

test('classify: scope-check key wins first', () => {
  assert.equal(classifyCluster(cluster({ key: 'scope-check', stages: { build: 3 } })).kind, 'scope-rule');
});

test('classify: scope stage most lessons is scope-rule, before contract tags', () => {
  assert.equal(classifyCluster(cluster({ tags: ['mock-drift'], stages: { scope: 3, build: 1 } })).kind, 'scope-rule');
});

test('classify: contract tags give contract-test', () => {
  assert.equal(classifyCluster(cluster({ tags: ['openapi'], stages: { review: 3 } })).kind, 'contract-test');
});

test('classify: routing tags give router-rule before prompt tags', () => {
  assert.equal(classifyCluster(cluster({ tags: ['lane-routing', 'prompt'], stages: { build: 3 } })).kind, 'router-rule');
});

test('classify: prompt tags give prompt-rule before review stage', () => {
  assert.equal(classifyCluster(cluster({ tags: ['prompt'], stages: { review: 3 } })).kind, 'prompt-rule');
});

test('classify: review stage most gives review-item', () => {
  assert.equal(classifyCluster(cluster({ stages: { review: 3, build: 1 }, caughtBy: { test: 4 } })).kind, 'review-item');
});

test('classify: missed, production or owner majority gives test-template', () => {
  assert.equal(classifyCluster(cluster({ stages: { build: 3 }, caughtBy: { missed: 2, test: 1 } })).kind, 'test-template');
  assert.equal(classifyCluster(cluster({ stages: { build: 3 }, caughtBy: { owner: 2, test: 1 } })).kind, 'test-template');
});

test('classify: test stage most gives test-template', () => {
  assert.equal(classifyCluster(cluster({ stages: { test: 2, build: 1 }, caughtBy: { test: 3 } })).kind, 'test-template');
});

test('classify: otherwise lint, with a non-empty why', () => {
  const r = classifyCluster(cluster({ stages: { build: 3 }, caughtBy: { test: 3 } }));
  assert.equal(r.kind, 'lint');
  assert.equal(typeof r.why, 'string');
  assert.ok(r.why.length > 0);
});

test('proposeGuard for scope-rule gives an example from the first lesson', () => {
  const ls = [
    lesson('L-0002', { what: 'Short two.', rule: 'Ask before growing scope.', tags: ['vague-scope'], stage: 'scope' }),
    lesson('L-0001', { what: 'y'.repeat(250), rule: 'Name the scope first.', tags: ['vague-scope'], stage: 'scope' }),
  ];
  const c = cluster({ key: 'vague-scope', lessonIds: ['L-0001', 'L-0002'], tags: ['vague-scope'], stages: { scope: 2 }, caughtBy: { test: 2 } });
  const p = proposeGuard(c, ls);
  assert.equal(p.kind, 'scope-rule');
  assert.ok(p.example);
  assert.ok(p.example.bad.length <= 200);
  assert.ok(p.example.bad.startsWith('yyy'));
  assert.equal(p.example.good, 'Name the scope first.');
  assert.deepEqual(p.lessons.map(l => l.id), ['L-0001', 'L-0002']);
});

test('proposeGuard gives no example for non-scope kinds', () => {
  const ls = ids(3).map(id => lesson(id));
  const p = proposeGuard(cluster({ lessonIds: ids(3), stages: { build: 3 }, caughtBy: { test: 3 } }), ls);
  assert.equal(p.kind, 'lint');
  assert.equal(p.example, null);
});

test('proposeGuard lists at most 12 lessons and counts the rest', () => {
  const ls = ids(14).map(id => lesson(id));
  const p = proposeGuard(cluster({ lessonIds: ids(14), stages: { build: 14 }, caughtBy: { test: 14 } }), ls);
  assert.equal(p.lessons.length, 12);
  assert.ok(JSON.stringify(p).includes('"moreCount":2'));
});

test('proposeGuard slug is kebab and at most 50 characters', () => {
  const key = 'a-'.repeat(40);
  const p = proposeGuard(cluster({ key, lessonIds: ['L-0001'] }), [lesson('L-0001')]);
  assert.ok(p.slug.length <= 50);
  assert.match(p.slug, /^[a-z0-9][a-z0-9-]*$/);
});

test('proposeGuard target for scope-rule names the scope tool and its test', () => {
  const ls = ids(3).map(id => lesson(id, { stage: 'scope', tags: ['vague-scope'] }));
  const p = proposeGuard(cluster({ key: 'vague-scope', lessonIds: ids(3), tags: ['vague-scope'], stages: { scope: 3 } }), ls);
  assert.ok(p.target.includes('tools/scope.mjs'));
  assert.ok(p.target.includes('tests/scope.test.mjs'));
});

test('renderProposal has the required sections and short lines', () => {
  const ls = [
    lesson('L-0001', { what: 'Scope drifted once.', rule: 'Name the scope first.', tags: ['vague-scope'], stage: 'scope' }),
    lesson('L-0002', { what: 'Scope drifted twice.', rule: 'Ask before growing scope.', tags: ['vague-scope'], stage: 'scope' }),
  ];
  const c = cluster({ key: 'vague-scope', lessonIds: ['L-0001', 'L-0002'], tags: ['vague-scope'], stages: { scope: 2 }, caughtBy: { test: 2 } });
  const md = renderProposal(proposeGuard(c, ls), { date: DATE });
  assert.ok(md.includes('Proposed guard: scope-rule'));
  assert.ok(md.includes('Why this kind:'));
  assert.ok(md.includes('Comes from lessons:'));
  assert.ok(md.includes('- L-0001: Name the scope first.'));
  assert.ok(md.includes('Where to build it:'));
  assert.ok(md.includes('Done when:'));
  assert.ok(md.split('\n').some(l => l.replace(/^#+\s*/, '').startsWith('Example')));
  assert.ok(md.includes('Proposed by swarm lessons mine on ' + DATE + '. Not merged automatically.'));
  assert.ok(md.split('\n').every(l => l.length <= 400));
});

test('renderProposal has no Example section for non-scope kinds and no lesson what text', () => {
  const ls = ids(3).map(id => lesson(id, { what: 'SECRETWHAT-unique-marker' }));
  const md = renderProposal(proposeGuard(cluster({ lessonIds: ids(3), stages: { build: 3 }, caughtBy: { test: 3 } }), ls), { date: DATE });
  assert.equal(md.split('\n').some(l => l.replace(/^#+\s*/, '').startsWith('Example')), false);
  assert.equal(md.includes('SECRETWHAT-unique-marker'), false);
});

test('mine dry run writes nothing', async () => {
  const root = await mkRoot();
  try {
    for (const id of ids(3)) await writeLesson(root, lesson(id, { tags: ['vague-scope'], stage: 'scope' }));
    const result = await mine(root, { date: DATE });
    assert.equal(result.lessonCount, 3);
    assert.equal(result.clusters.length, 1);
    assert.equal(result.clusters[0].kind, 'scope-rule');
    assert.equal(result.clusters[0].size, 3);
    assert.deepEqual(result.written, []);
    await assert.rejects(fs.stat(path.join(root, 'proposals')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mine with write creates a proposal and never overwrites it', async () => {
  const root = await mkRoot();
  try {
    for (const id of ids(3)) await writeLesson(root, lesson(id, { tags: ['vague-scope'], stage: 'scope' }));
    const first = await mine(root, { write: true, date: DATE });
    assert.equal(first.written.length, 1);
    const file = path.join(root, 'proposals', path.basename(first.written[0]));
    const before = await fs.readFile(file, 'utf8');
    assert.ok(before.includes('Proposed guard: scope-rule'));
    const second = await mine(root, { write: true, date: DATE });
    assert.deepEqual(second.written, []);
    assert.equal(second.skipped.length, 1);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mine refuses a symlinked output folder', async () => {
  const root = await mkRoot();
  const outside = await mkRoot();
  try {
    for (const id of ids(3)) await writeLesson(root, lesson(id, { tags: ['vague-scope'], stage: 'scope' }));
    await fs.symlink(outside, path.join(root, 'proposals'), 'dir');
    await assert.rejects(mine(root, { write: true, date: DATE }));
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('mine does not write through a symlinked proposal file', async () => {
  const root = await mkRoot();
  const outside = await mkRoot();
  try {
    for (const id of ids(3)) await writeLesson(root, lesson(id, { tags: ['vague-scope'], stage: 'scope' }));
    const dry = await mine(root, { date: DATE });
    const slug = dry.proposals[0].slug;
    const target = path.join(outside, 'outside.md');
    await fs.writeFile(target, 'keep');
    await fs.mkdir(path.join(root, 'proposals'));
    await fs.symlink(target, path.join(root, 'proposals', slug + '.md'));
    let result = null;
    try {
      result = await mine(root, { write: true, date: DATE });
    } catch {
      result = null;
    }
    if (result) {
      assert.equal(result.written.some(p => path.basename(p) === slug + '.md'), false);
    }
    assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
