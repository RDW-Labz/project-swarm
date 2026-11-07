// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketsToManifest, normalizeCacheContext } from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';
import { validateManifest } from '../tools/swarm/core-31.mjs';

const SCOPE_MD = `# Scope: Parts
Version: 1
## Overview
Cache context fixtures.
## Stages
- S1: Work
## S1 Work
### R-001 A feature exists.
Acceptance:
- It works.
`;

const scope = parseScope(SCOPE_MD);

function baseTicket(over = {}) {
  return {
    id: 'T-0457',
    title: 'Cache context ticket',
    type: 'build',
    stage: 'S1',
    scopeRefs: ['R-001'],
    acceptance: ['It works.'],
    files: ['src/widget.mjs'],
    context: ['src/widget.mjs'],
    contracts: [],
    dependsOn: [],
    size: 'S',
    risk: 'low',
    sensitive: false,
    status: 'ready',
    ...over,
  };
}

function minimalContextEnv(existsPaths = new Set()) {
  return {
    exists: p => existsPaths.has(p),
    sizes: {},
    profileContext: {},
    listFiles: () => [],
    limits: {},
    isApiTextFile: p => existsPaths.has(p),
  };
}

function assertValidManifest(manifest) {
  validateManifest(JSON.parse(JSON.stringify(manifest)));
}

test('a ticket with no shared context builds a job with no cacheContext and validates', () => {
  const exists = new Set(['src/widget.mjs']);
  const { manifest } = ticketsToManifest([baseTicket()], {
    scope,
    contextEnv: minimalContextEnv(exists),
  });
  const job = manifest.jobs[0];
  assert.equal('cacheContext' in job, false);
  assertValidManifest(manifest);
});

test('when the only shared context path is missing or non-text, cacheContext is omitted', () => {
  const binary = 'assets/logo.png';
  const exists = new Set(['src/widget.mjs', binary]);
  const { manifest, warnings } = ticketsToManifest([baseTicket({ context: ['src/widget.mjs', binary] })], {
    scope,
    contextEnv: {
      ...minimalContextEnv(exists),
      profileContext: { shared: [binary] },
      isApiTextFile: p => p !== binary,
    },
  });
  const job = manifest.jobs[0];
  assert.equal('cacheContext' in job, false);
  assert.ok(!job.context.includes(binary));
  assert.ok(warnings.some(w => w.includes('dropped non-text context')));
  assertValidManifest(manifest);
});

test('normalizeCacheContext caps twelve in-context paths at ten sorted', () => {
  const paths = Array.from({ length: 12 }, (_, i) => `shared/s${String(i).padStart(2, '0')}.md`);
  const job = {
    id: 'T-0999',
    agent: 'anthropic',
    model: 'claude-haiku-5-5',
    prompt: 'x',
    context: [...paths, 'src/out.mjs'],
    outputs: ['src/out.mjs'],
    cacheContext: [...paths],
  };
  normalizeCacheContext(job);
  assert.deepEqual(job.cacheContext, paths.slice().sort().slice(0, 10));
  assertValidManifest({ version: 1, jobs: [job] });
});

test('a CLI-lane job carries no cacheContext', () => {
  const shared = ['docs/scope/context/overview.md', 'package.json', 'src/widget.mjs'];
  const exists = new Set(shared);
  const { manifest } = ticketsToManifest([baseTicket({ lane: 'cursor' })], {
    scope,
    contextEnv: {
      ...minimalContextEnv(exists),
      profileContext: { shared: ['package.json'] },
    },
    laneModels: { cursor: { model: 'composer' } },
  });
  const job = manifest.jobs[0];
  assert.equal(job.agent, 'cursor');
  assert.equal('cacheContext' in job, false);
  assertValidManifest(manifest);
});
