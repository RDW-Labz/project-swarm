// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { listLessons } from './lesson-store.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const GENERIC_TAGS = Object.freeze([
  'scope', 'split', 'build', 'test', 'review', 'merge', 'integration', 'deploy',
  'tool', 'process', 'documentation', 'release', 'operations', 'product', 'data', 'security',
]);

const TARGETS = {
  'scope-rule': 'tools/scope.mjs checkScope and tests/scope.test.mjs',
  'contract-test': 'tools/contracts-gen.mjs',
  'router-rule': 'tools/router.mjs',
  'prompt-rule': 'tools/lesson-notes.mjs or the lane prompt',
  'review-item': 'the review checklist in docs/lessons-loop.md',
  'test-template': 'the test templates of the starter kit',
  lint: 'a check in tools/security-rules or a project lint rule',
};

const ACTIONS = {
  'scope-rule': 'Make the scope check refuse work that matches',
  'contract-test': 'Add a contract test that catches',
  'router-rule': 'Add a routing rule for',
  'prompt-rule': 'Add a prompt rule for',
  'review-item': 'Add a review checklist item for',
  'test-template': 'Add a test template that catches',
  lint: 'Add a lint check for',
};

const LINE_MAX = 400;
const byCount = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const tagsOf = l => (Array.isArray(l.tags) ? l.tags : []);
const countOf = (map, k) => map[k] ?? 0;

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function fit(line) {
  return line.length > LINE_MAX ? line.slice(0, LINE_MAX - 1) + '…' : line;
}

function tally(items, pick) {
  const out = {};
  for (const item of items) {
    const v = pick(item);
    if (v !== undefined && v !== null) out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

function mostOf(map, name) {
  const v = countOf(map, name);
  const values = Object.values(map);
  return v > 0 && v === Math.max(...values);
}

export function clusterLessons(lessons, { min = 3, includeGuarded = false } = {}) {
  const pool = lessons.filter(l => includeGuarded || l.guard?.status === 'proposed');
  const generic = new Set(GENERIC_TAGS);
  const counts = new Map();
  for (const l of pool) {
    for (const t of new Set(tagsOf(l))) {
      if (!generic.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const order = [...counts].filter(([, n]) => n >= min).sort(byCount);
  const taken = new Set();
  const clusters = [];
  for (const [key] of order) {
    const members = pool
      .filter(l => !taken.has(l) && tagsOf(l).includes(key))
      .sort(byIdAsc);
    if (members.length < min) continue;
    for (const l of members) taken.add(l);
    const tagCount = new Map();
    for (const l of members) {
      for (const t of new Set(tagsOf(l))) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
    clusters.push({
      key,
      lessonIds: members.map(l => l.id),
      tags: [...tagCount].sort(byCount).slice(0, 5).map(([t]) => t),
      stages: tally(members, l => l.stage),
      caughtBy: tally(members, l => l.caughtBy),
      guardKinds: tally(members, l => l.guard?.kind),
    });
  }
  return clusters;
}

export function classifyCluster(cluster) {
  const tags = new Set([...(cluster.tags ?? []), cluster.key]);
  const has = list => list.some(t => tags.has(t));
  const stages = cluster.stages ?? {};
  const caughtBy = cluster.caughtBy ?? {};
  const size = cluster.lessonIds.length;
  const missed = countOf(caughtBy, 'missed') + countOf(caughtBy, 'production') + countOf(caughtBy, 'owner');
  if (has(['vague-scope', 'scope-check']) || mostOf(stages, 'scope')) {
    return { kind: 'scope-rule', why: 'scope problems dominate this cluster' };
  }
  if (has(['mock-drift', 'contract', 'openapi', 'schema'])) {
    return { kind: 'contract-test', why: 'the tags point at interface drift between parts' };
  }
  if (has(['lane-routing', 'router', 'rate-limit', 'routing'])) {
    return { kind: 'router-rule', why: 'the tags point at lane or routing choices' };
  }
  if (has(['prompt', 'small-model', 'worker-output'])) {
    return { kind: 'prompt-rule', why: 'the tags point at what workers were told or returned' };
  }
  if (mostOf(stages, 'review')) {
    return { kind: 'review-item', why: 'most lessons were in review' };
  }
  if (missed * 2 >= size || mostOf(stages, 'test')) {
    return { kind: 'test-template', why: 'the problems escaped tests or were caught late' };
  }
  return { kind: 'lint', why: 'no other rule matched; a mechanical check is the default' };
}

export function proposeGuard(cluster, lessons) {
  const ids = new Set(cluster.lessonIds);
  const members = lessons.filter(l => ids.has(l.id)).sort(byIdAsc);
  const { kind, why } = classifyCluster(cluster);
  const rules = members.map(l => ({ id: l.id, rule: String(l.rule ?? '') }));
  const quoted = rules.slice(0, 3).map(r => '"' + clip(r.rule, 160) + '"').join('; ');
  const key = String(cluster.key);
  const text = `${ACTIONS[kind]} "${key}". Lessons: ${quoted}.`;
  const first = members[0];
  const example = kind === 'scope-rule' && first
    ? { bad: clip(first.what, 200), good: String(first.rule ?? '') }
    : null;
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'cluster';
  return {
    slug,
    kind,
    why,
    title: `Guard for "${key}" (${members.length} lessons)`,
    lessons: rules.slice(0, 12),
    moreCount: Math.max(0, rules.length - 12),
    text,
    example,
    target: TARGETS[kind],
  };
}

export function renderProposal(proposal, { date } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const lines = [
    `# ${proposal.title}`,
    '',
    `Proposed guard: ${proposal.kind}`,
    `Why this kind: ${proposal.why}`,
    '',
    proposal.text,
    '',
  ];
  if (proposal.example) {
    lines.push('## Example', `Bad: ${proposal.example.bad}`, `Good: ${proposal.example.good}`, '');
  }
  lines.push('Comes from lessons:');
  for (const r of proposal.lessons) lines.push(`- ${r.id}: ${clip(r.rule, 300)}`);
  if (proposal.moreCount > 0) lines.push(`- and ${proposal.moreCount} more`);
  lines.push(
    '',
    `Where to build it: ${proposal.target}`,
    '',
    'Done when:',
    '- a test fails without the guard',
    '- the eval set still passes',
    "- the lessons' guard status is set to built",
    '',
    `Proposed by swarm lessons mine on ${day}. Not merged automatically.`,
  );
  return lines.map(fit).join('\n') + '\n';
}

function checkOutDir(outDir) {
  const parts = String(outDir).split('/').filter(Boolean);
  if (path.posix.isAbsolute(String(outDir)) || parts.includes('..') || String(outDir).includes('\\')) {
    throw Object.assign(new Error('proposal-dir: must be a relative folder'), { code: 'proposal-dir' });
  }
  return parts;
}

export async function mine(root, { dir = 'lessons', outDir = 'proposals', min = 3, includeGuarded = false, write = false, date } = {}) {
  const { lessons } = await listLessons(root, { dir });
  const considered = lessons.filter(l => includeGuarded || l.guard?.status === 'proposed').length;
  const clusters = clusterLessons(lessons, { min, includeGuarded });
  const proposals = clusters.map(c => proposeGuard(c, lessons));
  const written = [];
  const skipped = [];
  if (write && proposals.length > 0) {
    const parts = checkOutDir(outDir);
    const folder = await safeWritableDir(root, parts);
    for (const p of proposals) {
      const rel = path.posix.join(...parts, `${p.slug}.md`);
      const file = path.join(folder, `${p.slug}.md`);
      await assertRegularOrMissing(file);
      const tmp = path.join(folder, `.${p.slug}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(renderProposal(p, { date }));
      } finally {
        await handle.close();
      }
      try {
        await fs.link(tmp, file);
        written.push(rel);
      } catch (error) {
        if (error.code === 'EEXIST') skipped.push(rel);
        else throw error;
      } finally {
        await fs.rm(tmp, { force: true });
      }
    }
  }
  return {
    lessonCount: lessons.length,
    considered,
    clusters: proposals.map(p => ({ key: clusters[proposals.indexOf(p)].key, kind: p.kind, size: clusters[proposals.indexOf(p)].lessonIds.length })),
    proposals,
    written,
    skipped,
  };
}
