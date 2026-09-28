// SPDX-License-Identifier: Apache-2.0
// Field lesson #176 as a tool check: a read-only `ask` scout given a fixed context list has no way
// to tell a genuine absence from a file it was never handed — "the allowlist omits it, the
// callback is never invoked" reads as fact either way, and a follow-up fix job can spend a large
// number of tokens proving there was no bug. `ask` now (a) tells the worker in its own prompt that
// any absence claim must carry `"basis":"context-only"` and name what it searched, (b) returns the
// exact `contextFiles` the worker was given, and (c) warns `absence-claim-limited-context` when the
// worker's own answer text reads as an absence claim.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { askRun, hasAbsenceClaim } from '../tools/swarm.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-lessons-i-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Only tests inject a provider; the production adapter spawns the literal claude command.
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const initEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });
const resultEvent = (answer, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer), ...extra });

describe('L176: ask names a claimed absence as context-only, reports contextFiles, and warns on an absence claim', () => {
  test('hasAbsenceClaim: hit — matches the words an absence claim is made of, case-insensitively, as whole words', () => {
    assert.equal(hasAbsenceClaim('the allowlist omits it, the callback is never invoked'), true);
    assert.equal(hasAbsenceClaim('X DROPS the event'), true);
    assert.equal(hasAbsenceClaim('the handler is not called anywhere'), true);
  });

  test('hasAbsenceClaim: non-hit — ordinary answer text with none of those words does not match', () => {
    assert.equal(hasAbsenceClaim('the event flows through the dispatcher and reaches the handler'), false);
    assert.equal(hasAbsenceClaim('the order uses dropshipping logistics'), false); // "drops" as a substring, not a whole word
    assert.equal(hasAbsenceClaim(''), false);
    assert.equal(hasAbsenceClaim(undefined), false);
  });

  test('ask prompt tells the worker any absence claim must carry basis:context-only and name what it searched', async t => {
    const root = await fixture(t);
    const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${JSON.stringify(resultEvent({ answer: 'fine' }, { total_cost_usd: 0.01 }))});`;
    const result = await askRun(root, { model: 'sonnet', context: ['a.txt'], question: 'Does X call Y?' }, { spawnImpl: fake(script) });
    const message = await fs.readFile(path.join(root, '.swarm/runs', result.id, result.id, 'message.txt'), 'utf8');
    assert.match(message, /"basis":"context-only"/);
    assert.match(message, /missing, never called, omitted, or absent/);
  });

  test('ask returns the exact contextFiles the worker was given', async t => {
    const root = await fixture(t);
    const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${JSON.stringify(resultEvent({ answer: 'fine' }, { total_cost_usd: 0.01 }))});`;
    const result = await askRun(root, { model: 'sonnet', context: ['a.txt'], question: 'Does X call Y?' }, { spawnImpl: fake(script) });
    assert.deepEqual(result.contextFiles, ['a.txt']);
  });

  test('ask warns absence-claim-limited-context when the worker answer reads as an absence claim (this is the behavior the unfixed code lacks)', async t => {
    const root = await fixture(t);
    const answer = { answer: 'X drops event E: the allowlist omits it, the callback is never invoked.' };
    const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${JSON.stringify(resultEvent(answer, { total_cost_usd: 0.02 }))});`;
    const result = await askRun(root, { model: 'sonnet', context: ['a.txt'], question: 'Does X drop event E?' }, { spawnImpl: fake(script) });
    assert.deepEqual(result.warnings, ['absence-claim-limited-context']);
  });

  test('ask reports no warning for an ordinary answer with no absence claim', async t => {
    const root = await fixture(t);
    const answer = { answer: 'The event flows from X through the dispatcher and reaches the handler.' };
    const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${JSON.stringify(resultEvent(answer, { total_cost_usd: 0.02 }))});`;
    const result = await askRun(root, { model: 'sonnet', context: ['a.txt'], question: 'Does X drop event E?' }, { spawnImpl: fake(script) });
    assert.deepEqual(result.warnings, []);
  });
});
