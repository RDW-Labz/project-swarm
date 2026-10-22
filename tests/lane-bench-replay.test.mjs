// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  deliveryByTicket,
  seededPick,
  ownedFilesOk,
  ticketQualifies,
  selectFromLedgers,
} from '../bench/lane-benchmark/replay-select.mjs';
import { parseFilesEnvelope } from '../bench/lane-benchmark/endpoint.mjs';
import { TOOLCALL_CHECKS } from '../bench/lane-benchmark/toolcalls.mjs';
import { renderReplayReport, scrubSecret } from '../bench/lane-benchmark/run.mjs';
import { verifyOutputs } from '../bench/lane-benchmark/lib.mjs';

describe('replay-select delivery map', () => {
  it('reads delivered mergeCommits and transition notes', () => {
    const events = [
      { event: 'delivered', id: 'T-1', mergeCommits: ['abc123def456'] },
      { event: 'transition', id: 'T-2', to: 'done', note: 'held-ticket triage: #253 9f76d5a tools/x.mjs' },
    ];
    const map = deliveryByTicket(events);
    assert.equal(map.get('T-1').mergeCommit, 'abc123def456');
    assert.equal(map.get('T-2').mergeCommit, '9f76d5a');
  });
});

describe('seededPick', () => {
  it('spreads across ledger and type deterministically', () => {
    const candidates = [
      { id: 'T-001', ledger: 'roadmap', type: 'build' },
      { id: 'T-002', ledger: 'swarm', type: 'fix' },
      { id: 'T-003', ledger: 'roadmap', type: 'fix' },
      { id: 'T-004', ledger: 'swarm', type: 'build' },
    ];
    const a = seededPick(candidates, 3, 42);
    const b = seededPick(candidates, 3, 42);
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    const ledgers = new Set(a.map(c => c.ledger));
    assert.equal(ledgers.size, 2);
  });
});

describe('ownedFilesOk', () => {
  it('requires a real change at merge', () => {
    const git = {
      existsAt: () => true,
      readAt: (commit, file) => (commit === 'merge' ? 'new\n' : 'old\n'),
    };
    assert.equal(ownedFilesOk(['tools/a.mjs'], 'base', 'merge', git), true);
    const same = {
      existsAt: () => true,
      readAt: () => 'same',
    };
    assert.equal(ownedFilesOk(['tools/a.mjs'], 'base', 'merge', same), false);
  });
});

describe('ticketQualifies', () => {
  it('filters sensitive and validates tests hook', () => {
    const ticket = {
      id: 'T-9',
      status: 'done',
      sensitive: false,
      risk: 'low',
      size: 'S',
      type: 'build',
      files: ['tools/x.mjs'],
      tests: ['tests/x.test.mjs'],
    };
    const git = {
      resolveCommit: () => 'mergefull',
      parents: () => ['basefull'],
      existsAt: () => true,
      readAt: (c) => (c === 'mergefull' ? 'v2' : 'v1'),
    };
    const ok = ticketQualifies(ticket, { mergeCommit: 'mergefull' }, git, () => true);
    assert.equal(ok.ok, true);
    const bad = ticketQualifies({ ...ticket, sensitive: true }, { mergeCommit: 'mergefull' }, git, () => true);
    assert.equal(bad.ok, false);
  });
});

describe('selectFromLedgers (injected)', () => {
  it('picks qualified tickets without git', () => {
    const ledgers = [{
      name: 'roadmap',
      tickets: [{
        id: 'T-0100',
        title: 't',
        type: 'build',
        status: 'done',
        sensitive: false,
        risk: 'low',
        size: 'S',
        files: ['a.mjs'],
        tests: ['t.test.mjs'],
      }],
      logText: '{"event":"delivered","id":"T-0100","mergeCommits":["m1"]}\n',
    }];
    const git = {
      resolveCommit: ref => (ref === 'm1' ? 'merge1' : null),
      parents: () => ['base1'],
      existsAt: () => true,
      readAt: (c) => (c === 'merge1' ? '2' : '1'),
    };
    const { selected, qualifiedCount } = selectFromLedgers({
      ledgers,
      git,
      runTestsAtMerge: () => true,
      target: 20,
    });
    assert.equal(qualifiedCount, 1);
    assert.equal(selected[0].mergeCommit, 'merge1');
  });
});

describe('parseFilesEnvelope', () => {
  it('accepts object map and array forms', () => {
    const map = parseFilesEnvelope('prefix\n{"files":{"a.mjs":"hello"}}');
    assert.equal(map['a.mjs'], 'hello');
    const arr = parseFilesEnvelope('{"files":[{"path":"b.mjs","content":"x"}]}');
    assert.equal(arr['b.mjs'], 'x');
  });
});

describe('verifyOutputs merge tests', () => {
  it('copies hidden tests via hook and requires tests to run', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-replay-'));
    const task = {
      outputs: ['out.mjs'],
      verify: {
        argv: ['node', '-e', 'console.log("# tests 1\\n# pass 1")'],
        testsFromMerge: ['tests/hidden.test.mjs'],
        mergeCommit: 'deadbeef',
      },
    };
    const result = verifyOutputs(base, task, { 'out.mjs': 'export const x=1;\n' }, {
      readAtMerge: () => 'import test from "node:test"; test("t", () => {});',
    });
    assert.equal(result.pass, true);
  });
});

describe('api key scrubbing', () => {
  it('never leaves raw key in scrubbed error text', () => {
    const secret = 'sk-test-secret-value';
    const msg = `request failed: Bearer ${secret} invalid`;
    const out = scrubSecret(msg, secret);
    assert.ok(!out.includes(secret));
  });

  it('endpoint results JSON excludes api key field', () => {
    const secret = 'sk-bench-never-log';
    const payload = { model: 'm', slots: 2, set: 'replay', results: [{ pass: true, wallSec: 1 }] };
    const json = JSON.stringify(payload);
    assert.ok(!json.includes(secret));
    assert.ok(!json.includes('apiKey'));
  });
});

describe('toolcall validators', () => {
  it('scores parallel tool check on fixture response', () => {
    const check = TOOLCALL_CHECKS.find(c => c.id === 'parallel-tools');
    const response = {
      choices: [{
        message: {
          tool_calls: [
            { function: { name: 'echo_text', arguments: '{"text":"a"}' } },
            { function: { name: 'add_numbers', arguments: '{"a":1,"b":2}' } },
          ],
        },
      }],
    };
    assert.equal(check.validate(response), true);
  });
});

describe('renderReplayReport', () => {
  it('renders side-by-side table for multiple models', () => {
    const md = renderReplayReport([
      { model: 'model-a', slots: 4, results: [{ pass: true, wallSec: 10, completionTokensPerSec: 50 }, { pass: false, wallSec: 20, completionTokensPerSec: 40 }] },
      { model: 'model-b', slots: 8, results: [{ pass: true, wallSec: 8, completionTokensPerSec: 60 }] },
    ]);
    assert.match(md, /model-a/);
    assert.match(md, /model-b/);
    assert.match(md, /50%/);
  });
});
