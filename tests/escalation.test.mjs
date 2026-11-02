import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTruncation, MAX_LEVEL, nextStep, routingFor, sizeTicket } from '../tools/escalation.mjs';

function outputsTicket(files, extra) {
  const ticket = { id: 't1', files: files.slice(), outputs: files.slice() };
  return Object.assign(ticket, extra || {});
}

test('isTruncation matches the three markers in any case', () => {
  assert.equal(isTruncation('stop: max_tokens reached'), true);
  assert.equal(isTruncation('Output was TRUNCATED'), true);
  assert.equal(isTruncation('Output-Cap-Exceeded'), true);
});

test('isTruncation is false for other text and wrong types', () => {
  assert.equal(isTruncation('tests failed'), false);
  assert.equal(isTruncation(''), false);
  assert.equal(isTruncation(null), false);
  assert.equal(isTruncation(undefined), false);
  assert.equal(isTruncation(42), false);
});

test('MAX_LEVEL is 3', () => {
  assert.equal(MAX_LEVEL, 3);
});

test('first failure is level 1, kind failed, ready', () => {
  const step = nextStep({}, { error: 'assertion failed' });
  assert.equal(step.level, 1);
  assert.equal(step.kind, 'failed');
  assert.equal(step.status, 'ready');
  assert.equal(typeof step.reason, 'string');
  assert.ok(step.reason.length > 0);
});

test('missing error or options count as failed', () => {
  assert.equal(nextStep({}).kind, 'failed');
  assert.equal(nextStep({}, {}).kind, 'failed');
  assert.equal(nextStep({}).level, 1);
});

test('escalation counter adds one to the level', () => {
  const level2 = nextStep({ escalation: 1 }, { error: 'boom' });
  assert.equal(level2.level, 2);
  assert.equal(level2.status, 'ready');
  const level3 = nextStep({ escalation: 2 }, { error: 'boom' });
  assert.equal(level3.level, 3);
  assert.equal(level3.status, 'ready');
});

test('null escalation is treated as zero', () => {
  assert.equal(nextStep({ escalation: null }, { error: 'boom' }).level, 1);
});

test('level 4 after a plain failure is blocked with a reason', () => {
  const step = nextStep({ escalation: 3 }, { error: 'boom' });
  assert.equal(step.level, 4);
  assert.equal(step.status, 'blocked');
  assert.match(step.reason, /blocked/);
});

test('truncation skips to level 2 at least', () => {
  const step = nextStep({}, { error: 'stopped at max_tokens' });
  assert.equal(step.level, 2);
  assert.equal(step.kind, 'truncated');
  assert.equal(step.status, 'ready');
});

test('truncation at escalation 2 gives level 3, still ready', () => {
  const step = nextStep({ escalation: 2 }, { error: 'truncated output' });
  assert.equal(step.level, 3);
  assert.equal(step.kind, 'truncated');
  assert.equal(step.status, 'ready');
});

test('truncation at escalation 3 gives level 4, blocked', () => {
  const step = nextStep({ escalation: 3 }, { error: 'truncated output' });
  assert.equal(step.level, 4);
  assert.equal(step.status, 'blocked');
});

test('level is clamped to MAX_LEVEL + 1', () => {
  const step = nextStep({ escalation: 9 }, { error: 'output-cap-exceeded' });
  assert.equal(step.level, MAX_LEVEL + 1);
  assert.equal(step.status, 'blocked');
});

test('routingFor level 0 returns no extra fields', () => {
  assert.deepEqual(routingFor(0), {});
});

test('routingFor level 1 doubles the default 8192 to 16384', () => {
  assert.deepEqual(routingFor(1), { maxOutputTokens: 16384 });
});

test('routingFor level 1 doubles a given base', () => {
  assert.equal(routingFor(1, { maxOutputTokens: 4000 }).maxOutputTokens, 8000);
});

test('routingFor level 1 caps doubled tokens at 32768', () => {
  assert.equal(routingFor(1, { maxOutputTokens: 20000 }).maxOutputTokens, 32768);
});

test('routingFor level 2 sends hard tickets with 32768 tokens', () => {
  assert.deepEqual(routingFor(2), { maxOutputTokens: 32768, hard: true });
});

test('routingFor level 3 sets the expensive tier', () => {
  assert.deepEqual(routingFor(3), {
    maxOutputTokens: 32768,
    tier: 'expensive',
    tierReason: 'escalated after 3 failed attempts',
  });
});

test('routingFor never returns agent or model', () => {
  for (const level of [0, 1, 2, 3]) {
    const fields = routingFor(level);
    assert.equal('agent' in fields, false);
    assert.equal('model' in fields, false);
  }
});

test('sizeTicket accepts a small ticket', () => {
  const result = sizeTicket(outputsTicket(['a.js']), { sizes: { 'a.js': 100 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test('sizeTicket accepts a ticket with no files', () => {
  assert.equal(sizeTicket(outputsTicket([])).ok, true);
});

test('sizeTicket ignores folder entries', () => {
  const result = sizeTicket(outputsTicket(['a.js', 'b.js', 'c.js', 'd.js', 'e/']));
  assert.equal(result.ok, true);
});

test('sizeTicket rejects more than maxFiles output files', () => {
  const result = sizeTicket(outputsTicket(['a.js', 'b.js', 'c.js', 'd.js', 'e.js']));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.length > 0);
  for (const reason of result.reasons) assert.equal(typeof reason, 'string');
});

test('sizeTicket accepts exactly maxFiles output files', () => {
  assert.equal(sizeTicket(outputsTicket(['a.js', 'b.js', 'c.js', 'd.js'])).ok, true);
});

test('sizeTicket honours a custom maxFiles', () => {
  const files = ['a.js', 'b.js', 'c.js'];
  assert.equal(sizeTicket(outputsTicket(files), { maxFiles: 2 }).ok, false);
  assert.equal(sizeTicket(outputsTicket(files), { maxFiles: 3 }).ok, true);
});

test('sizeTicket rejects a sum above 60 percent of the cap', () => {
  const result = sizeTicket(outputsTicket(['a.js', 'b.js']), {
    sizes: { 'a.js': 5000, 'b.js': 4500 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.length > 0);
});

test('sizeTicket accepts a sum exactly at 60 percent of the cap', () => {
  const result = sizeTicket(outputsTicket(['a.js', 'b.js']), {
    sizes: { 'a.js': 4608, 'b.js': 4608 },
  });
  assert.equal(result.ok, true);
});

test('sizeTicket rejects one file above 80 percent of the cap', () => {
  const result = sizeTicket(outputsTicket(['a.js']), { sizes: { 'a.js': 12289 } });
  assert.equal(result.ok, false);
});

test('sizeTicket scales limits with a custom capBytes', () => {
  assert.equal(sizeTicket(outputsTicket(['a.js']), { capBytes: 100, sizes: { 'a.js': 61 } }).ok, false);
  assert.equal(sizeTicket(outputsTicket(['a.js']), { capBytes: 100, sizes: { 'a.js': 60 } }).ok, true);
});

test('sizeTicket treats missing sizes as zero', () => {
  const result = sizeTicket(outputsTicket(['a.js', 'b.js']), { sizes: { 'a.js': 9216 } });
  assert.equal(result.ok, true);
});
