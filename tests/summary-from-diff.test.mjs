import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REASK_SUMMARY_MESSAGE,
  diffSummary,
  settleMissingSummary,
} from '../tools/summary-from-diff.mjs';

function readers(baseMap, currentMap) {
  return {
    readBase: (file) => baseMap.get(file) ?? null,
    readCurrent: (file) => currentMap.get(file) ?? null,
  };
}

test('diffSummary counts +/- lines on modify', () => {
  const base = Buffer.from('a\nb\nc\n');
  const current = Buffer.from('a\nx\nc\nd\n');
  const r = diffSummary(['f.mjs'], readers(new Map([['f.mjs', base]]), new Map([['f.mjs', current]])));
  assert.equal(r.changed.length, 1);
  assert.match(r.text, /\+2\/-1 lines/);
  assert.equal(r.allWritten, true);
});

test('diffSummary created file', () => {
  const current = Buffer.from('new line\n');
  const r = diffSummary(['new.mjs'], readers(new Map(), new Map([['new.mjs', current]])));
  assert.deepEqual(r.changed, ['new.mjs']);
  assert.match(r.text, /Changed new\.mjs \(\+2\/-0 lines\)/);
  assert.equal(r.allWritten, true);
});

test('diffSummary unchanged file sets allWritten false', () => {
  const bytes = Buffer.from('same\n');
  const r = diffSummary(
    ['same.mjs'],
    readers(new Map([['same.mjs', bytes]]), new Map([['same.mjs', Buffer.from('same\n')]])),
  );
  assert.equal(r.text, 'No declared output changed');
  assert.equal(r.allWritten, false);
  assert.deepEqual(r.changed, []);
});

test('diffSummary missing output sets allWritten false', () => {
  const r = diffSummary(
    ['miss.mjs'],
    readers(new Map([['miss.mjs', Buffer.from('x\n')]]), new Map()),
  );
  assert.match(r.text, /Changed miss\.mjs \(\+0\/-2 lines\)/);
  assert.equal(r.allWritten, false);
});

test('diffSummary 300-char cap', () => {
  const outputs = [];
  const base = new Map();
  const current = new Map();
  for (let i = 0; i < 20; i++) {
    const file = `tools/long-file-${i}.mjs`;
    outputs.push(file);
    base.set(file, Buffer.from('a\n'));
    current.set(file, Buffer.from('a\nb\n'));
  }
  const r = diffSummary(outputs, readers(base, current));
  assert.equal(r.text.length, 300);
  assert.equal(r.allWritten, true);
});

test('REASK_SUMMARY_MESSAGE', () => {
  assert.match(REASK_SUMMARY_MESSAGE, /final report JSON line/);
});

test('settleMissingSummary keeps present summary and skips reask', async () => {
  let called = false;
  const out = await settleMissingSummary({
    status: 'complete',
    summary: 'did the thing',
    cancelled: false,
    alreadyReasked: false,
    reask: async () => {
      called = true;
      return { summary: 'nope' };
    },
    diff: async () => ({ text: 'x', allWritten: false, changed: [] }),
  });
  assert.equal(out.summary, 'did the thing');
  assert.equal(out.status, 'complete');
  assert.equal(called, false);
  assert.equal(out.summaryReasked, false);
});

test('settleMissingSummary reask gives summary', async () => {
  let calls = 0;
  const out = await settleMissingSummary({
    status: 'blocked',
    summary: '',
    cancelled: false,
    alreadyReasked: false,
    reask: async () => {
      calls += 1;
      return { summary: 'explained block' };
    },
    diff: async () => assert.fail('diff should not run'),
  });
  assert.equal(calls, 1);
  assert.equal(out.summary, 'explained block');
  assert.equal(out.status, 'blocked');
  assert.equal(out.summaryReasked, true);
});

test('settleMissingSummary reask empty and all written -> complete from diff', async () => {
  const diffResult = {
    text: 'Changed a.mjs (+2/-0 lines)',
    allWritten: true,
    changed: ['a.mjs'],
  };
  const out = await settleMissingSummary({
    status: 'blocked',
    summary: undefined,
    cancelled: false,
    alreadyReasked: false,
    reask: async () => ({ summary: '' }),
    diff: async () => diffResult,
  });
  assert.equal(out.status, 'complete');
  assert.equal(out.summary, diffResult.text);
  assert.equal(out.error, null);
  assert.equal(out.summaryFromDiff, true);
  assert.deepEqual(out.warnings, ['summary-from-diff: worker gave no summary']);
});

test('settleMissingSummary reask empty and output missing -> blocked with diff in error', async () => {
  const diffResult = {
    text: 'No declared output changed',
    allWritten: false,
    changed: [],
  };
  const out = await settleMissingSummary({
    status: 'complete',
    summary: '',
    cancelled: false,
    alreadyReasked: false,
    reask: async () => ({ summary: '' }),
    diff: async () => diffResult,
  });
  assert.equal(out.status, 'blocked');
  assert.equal(out.summary, diffResult.text);
  assert.equal(out.error, 'blocked: no summary given; No declared output changed');
});

test('settleMissingSummary reask throws uses diff rule', async () => {
  const diffResult = {
    text: 'Changed b.mjs (+1/-0 lines)',
    allWritten: true,
    changed: ['b.mjs'],
  };
  const out = await settleMissingSummary({
    status: 'blocked',
    summary: '',
    cancelled: false,
    alreadyReasked: false,
    reask: async () => {
      throw new Error('fail');
    },
    diff: async () => diffResult,
  });
  assert.equal(out.status, 'complete');
  assert.equal(out.summary, diffResult.text);
  assert.equal(out.summaryReasked, true);
});

test('settleMissingSummary cancelled skips reask', async () => {
  let reaskCalled = false;
  const diffResult = {
    text: 'Changed c.mjs (+3/-1 lines)',
    allWritten: true,
    changed: ['c.mjs'],
  };
  const out = await settleMissingSummary({
    status: 'blocked',
    summary: '',
    cancelled: true,
    alreadyReasked: false,
    reask: async () => {
      reaskCalled = true;
      return { summary: 'should not' };
    },
    diff: async () => diffResult,
  });
  assert.equal(reaskCalled, false);
  assert.equal(out.status, 'complete');
  assert.equal(out.summaryReasked, false);
});

test('settleMissingSummary alreadyReasked skips reask', async () => {
  let reaskCalled = false;
  const out = await settleMissingSummary({
    status: 'complete',
    summary: '   ',
    cancelled: false,
    alreadyReasked: true,
    reask: async () => {
      reaskCalled = true;
      return { summary: 'x' };
    },
    diff: async () => ({
      text: 'No declared output changed',
      allWritten: false,
      changed: [],
    }),
  });
  assert.equal(reaskCalled, false);
  assert.equal(out.status, 'blocked');
});
