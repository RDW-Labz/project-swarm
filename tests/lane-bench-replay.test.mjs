// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  deliveryByTicket,
  seededPick,
  ownedFilesOk,
  ticketQualifies,
  selectFromLedgers,
} from '../bench/lane-benchmark/replay-select.mjs';
import {
  parseFilesEnvelope,
  buildPromptWithBudget,
  estimateTokens,
  chatCompletion,
  runEndpointTask,
} from '../bench/lane-benchmark/endpoint.mjs';
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

  it('accepts markdown fenced JSON and ignores reasoning-only paths', () => {
    const fenced = parseFilesEnvelope('Here is the answer:\n```json\n{"files":{"c.mjs":"ok"}}\n```');
    assert.equal(fenced['c.mjs'], 'ok');
  });
});

describe('buildPromptWithBudget', () => {
  it('excludes context that exceeds budget and excerpts huge files', () => {
    const task = {
      prompt: 'Fix the bug',
      outputs: ['owned.mjs'],
      context: ['owned.mjs', 'small.mjs', 'tests/big.test.mjs', 'huge.mjs'],
    };
    const files = [
      { path: 'owned.mjs', content: 'export const owned = 1;\n' },
      { path: 'small.mjs', content: 'small\n' },
      { path: 'tests/big.test.mjs', content: 'test file\n' },
      { path: 'huge.mjs', content: `${'x'.repeat(20000)}\n` },
    ];
    const { prompt, excluded, excerpted } = buildPromptWithBudget(task, files, { promptTokenBudget: 500 });
    assert.match(prompt, /owned\.mjs/);
    assert.match(prompt, /Fix the bug/);
    assert.ok(excerpted.some(e => e.path === 'huge.mjs'));
    assert.ok(excluded.length >= 0);
    assert.ok(estimateTokens(prompt) <= 600);
  });
});

describe('chatCompletion thinking mode', () => {
  it('sends enable_thinking false and system message when thinking is off', async () => {
    let captured;
    const fetchImpl = async (_url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    };
    await chatCompletion({
      baseUrl: 'http://localhost/v1',
      model: 'm',
      apiKey: 'k',
      prompt: 'hi',
      thinking: 'off',
      fetchImpl,
    });
    assert.equal(captured.chat_template_kwargs.enable_thinking, false);
    assert.equal(captured.messages[0].role, 'system');
    assert.match(captured.messages[0].content, /step-by-step/i);
    assert.equal(captured.messages[1].role, 'user');
  });
});

describe('runEndpointTask recording', () => {
  it('records empty content when reasoning consumed the completion budget', async () => {
    const srcRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { spawnSync } = await import('node:child_process');
    const baseCommit = spawnSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const task = {
      id: 'T-rec',
      type: 'fix',
      baseCommit,
      prompt: 'do thing',
      context: [],
      outputs: ['out.mjs'],
      verify: { argv: ['node', '-e', 'process.exit(0)'] },
    };
    const result = await runEndpointTask(task, {
      srcRepo,
      verifyOutputs: () => ({ pass: true, detail: 'tests pass' }),
      readContextAtBase: () => '',
      api: async () => ({
        content: '',
        finishReason: 'length',
        reasoningChars: 12000,
        completionChars: 0,
        promptChars: 10,
        completionTokens: 8000,
        promptTokens: 100,
        usage: { completion_tokens: 8000 },
      }),
    });
    assert.equal(result.reason, 'empty content (finish=length, reasoning 12000 chars)');
    assert.equal(result.finishReason, 'length');
    assert.equal(result.reasoningChars, 12000);
    assert.equal(result.completionChars, 0);
    assert.ok(Number.isFinite(result.completionTokensPerSec));
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
      {
        model: 'model-a',
        slots: 4,
        results: [
          { taskId: 'T-1', pass: true, wallSec: 10, completionTokensPerSec: 50, reason: 'passed' },
          { taskId: 'T-2', pass: false, wallSec: 20, completionTokensPerSec: 40, reason: 'empty content (finish=length, reasoning 9000 chars)' },
        ],
      },
      { model: 'model-b', slots: 8, results: [{ taskId: 'T-1', pass: true, wallSec: 8, completionTokensPerSec: 60, reason: 'passed' }] },
    ]);
    assert.match(md, /model-a/);
    assert.match(md, /model-b/);
    assert.match(md, /50%/);
    assert.match(md, /Failure reasons:/);
    assert.match(md, /empty content/);
  });
});
