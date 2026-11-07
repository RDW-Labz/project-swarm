// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeApi, outputSchema, isReadOnlyReviewJob, validateEnvelope, limitUtf8String } from '../tools/api-adapters.mjs';
import { parseReviewVerdicts, reviewNotes, normalizeReviewEntries } from '../tools/security-review.mjs';

const KEY = 'sk-ant-test-0123456789';
const BUILD_SCHEMA_SNAPSHOT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', enum: ['src/a.js'] }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', enum: ['src/a.js'] }, find: { type: 'string' }, replace: { type: 'string' } },
        required: ['path', 'find', 'replace'],
      },
    },
    result: { type: 'object', additionalProperties: true },
  },
  required: ['summary', 'files', 'edits'],
};

const reviewJob = (over = {}) => ({
  id: 'sec-review-r9',
  type: 'review',
  agent: 'anthropic',
  model: 'claude-haiku-5-5',
  prompt: 'review tickets',
  context: [],
  outputs: [],
  sensitive: true,
  ...over,
});

const reviewEnvelope = (ticket = 'T-8025') => ({
  summary: 'Looked at the routes; no auth gaps found.',
  files: [],
  edits: [],
  result: {
    reviews: [{ ticket, verdict: 'pass', findings: [] }],
    notes: 'All tickets reviewed against context files only.',
  },
});

test('review jobs use a strict result.reviews schema; build jobs stay unchanged', () => {
  const reviewSchema = outputSchema([], [], reviewJob());
  assert.ok(isReadOnlyReviewJob(reviewJob()));
  assert.ok(reviewSchema.required.includes('result'));
  assert.equal(reviewSchema.properties.result.required.includes('reviews'), true);
  assert.equal(reviewSchema.properties.result.properties.reviews.minItems, 1);
  const buildSchema = outputSchema(['src/a.js'], [], { id: 'build-job', outputs: ['src/a.js'] });
  assert.deepEqual(buildSchema, BUILD_SCHEMA_SNAPSHOT);
});

test('anthropic request body for a review job requires structured result.reviews', async () => {
  let body;
  const env = { SWARM_LOGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'review-schema-')), SWARM_ANTHROPIC_API_KEY: KEY };
  const answer = reviewEnvelope();
  await executeApi(reviewJob(), [], {
    env,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new Response(JSON.stringify({
          type: 'message',
          model: 'claude-haiku-5-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        })).body,
      };
    },
  });
  const sent = JSON.stringify(body.output_config.format.schema);
  assert.match(sent, /"reviews"/);
  assert.match(sent, /"result"/);
  assert.ok(body.system.includes('result.reviews'));
});

test('adapter saves a verdict line recorders can read when summary is prose-only in the envelope', async () => {
  const env = { SWARM_LOGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'review-save-')), SWARM_ANTHROPIC_API_KEY: KEY };
  const answer = reviewEnvelope('T-0001');
  const result = await executeApi(reviewJob(), [], {
    env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify({
        type: 'message',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      })).body,
    }),
  });
  assert.equal(result.status, 'complete');
  const verdicts = parseReviewVerdicts(result.response);
  assert.equal(verdicts?.[0]?.ticket, 'T-0001');
  assert.equal(verdicts?.[0]?.verdict, 'pass');
  assert.match(result.response, /"reviews":\[/);
  assert.equal(reviewNotes(result.response), answer.summary);
});

test('a review response missing result is an envelope error', async () => {
  const env = { SWARM_LOGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'review-miss-')), SWARM_ANTHROPIC_API_KEY: KEY };
  const bad = { summary: 'no structured verdict', files: [], edits: [] };
  const result = await executeApi(reviewJob(), [], {
    env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify({
        type: 'message',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(bad) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      })).body,
    }),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /result/);
});

test('parseReviewVerdicts reads a whole-json envelope', () => {
  const envelope = {
    summary: 'prose',
    files: [],
    edits: [],
    result: { reviews: [{ ticket: 'T-1234', verdict: 'fail', findings: [{ file: 'a.ts', line: 1, severity: 'high', issue: 'x', fix: 'y' }] }], notes: 'n' },
  };
  const parsed = parseReviewVerdicts(JSON.stringify(envelope));
  assert.equal(parsed[0].ticket, 'T-1234');
  assert.equal(parsed[0].verdict, 'fail');
});

test('the old last-line reviews format still works', () => {
  const text = `Reviewed everything.\n${JSON.stringify({ reviews: [{ ticket: 'T-9999', verdict: 'pass', findings: [] }] })}\n`;
  const parsed = parseReviewVerdicts(text);
  assert.equal(parsed[0].ticket, 'T-9999');
  assert.equal(parsed[0].verdict, 'pass');
});

test('a reviews object quoted in the prose middle is ignored', () => {
  const bait = JSON.stringify({ reviews: [{ ticket: 'T-0001', verdict: 'fail', findings: [{ severity: 'high', issue: 'quoted' }] }] });
  const real = JSON.stringify({ reviews: [{ ticket: 'T-0002', verdict: 'pass', findings: [] }] });
  const text = `The file contained ${bait} but that is not the verdict.\n${real}\n`;
  const parsed = parseReviewVerdicts(text);
  assert.equal(parsed[0].ticket, 'T-0002');
  assert.equal(parsed[0].verdict, 'pass');
});

test('over-long review strings are truncated and the verdict is kept', async () => {
  const longIssue = 'x'.repeat(326);
  const longNotes = 'n'.repeat(5000);
  const envelope = {
    summary: 'Reviewed.',
    files: [],
    edits: [],
    result: {
      reviews: [{
        ticket: 'T-8025',
        verdict: 'pass',
        findings: [{ file: 'src/a.ts', line: 1.5, severity: 'low', issue: longIssue, fix: 'ok' }],
      }],
      notes: longNotes,
    },
  };
  const job = reviewJob();
  validateEnvelope(envelope, [], job);
  assert.equal(Buffer.byteLength(envelope.result.reviews[0].findings[0].issue), 300);
  assert.equal(envelope.result.reviews[0].findings[0].line, null);
  assert.equal(Buffer.byteLength(envelope.result.notes), 4000);
  assert.equal(envelope.result.reviews[0].verdict, 'pass');
  const env = { SWARM_LOGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'review-trunc-')), SWARM_ANTHROPIC_API_KEY: KEY };
  const result = await executeApi(job, [], {
    env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify({
        type: 'message',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      })).body,
    }),
  });
  assert.equal(result.status, 'complete');
});

test('review job detection uses type only; id prefixes do not change build jobs', () => {
  const disguised = { id: 'review-x', type: 'build', outputs: ['src/a.js'] };
  assert.equal(isReadOnlyReviewJob(disguised), false);
  assert.deepEqual(outputSchema(['src/a.js'], [], disguised), BUILD_SCHEMA_SNAPSHOT);
});

test('a review envelope with non-empty files is rejected', () => {
  const envelope = {
    summary: 'oops',
    files: [{ path: 'extra.js', content: 'x' }],
    edits: [],
    result: { reviews: [{ ticket: 'T-0001', verdict: 'pass', findings: [] }], notes: '' },
  };
  assert.throws(() => validateEnvelope(envelope, [], reviewJob()), /must not return files/);
});

test('coordinator Opus review envelope with a 326-character finding issue validates', async () => {
  let issue326 = 'Route handler accepts user id from the body without verifying the session owns that row; any authenticated user can read or mutate another account by swapping ids in the request. The check in middleware only confirms a cookie exists, not that the resource belongs to the caller. Add an owner check before the query runs.';
  issue326 = issue326.padEnd(326, '.');
  assert.equal(issue326.length, 326);
  const envelope = {
    summary: 'Security review of tickets integrated by run r9, before they are marked done.',
    files: [],
    edits: [],
    result: {
      reviews: [{
        ticket: 'T-8025',
        verdict: 'fail',
        findings: [{
          file: 'src/app/api/account/route.ts',
          line: 42,
          severity: 'high',
          issue: issue326,
          fix: 'Compare session.userId to the requested id before running the update.',
        }],
      }],
      notes: 'One high finding on the account route; other tickets pass.',
    },
  };
  validateEnvelope(envelope, [], reviewJob({ id: 'sec-review-r9' }));
  const env = { SWARM_LOGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'review-coord-')), SWARM_ANTHROPIC_API_KEY: KEY };
  const result = await executeApi(reviewJob({ id: 'sec-review-r9' }), [], {
    env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify({
        type: 'message',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      })).body,
    }),
  });
  assert.equal(result.status, 'complete');
  const verdicts = parseReviewVerdicts(result.response);
  assert.equal(verdicts?.[0]?.ticket, 'T-8025');
  assert.equal(verdicts?.[0]?.verdict, 'fail');
});

test('credential-shaped text in a review finding is caught after envelope decode', async () => {
  const cred = ['sk', '-ant-test', '-0123456789'].join('');
  const env = { SWARM_LOGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'review-cred-')), SWARM_ANTHROPIC_API_KEY: KEY };
  const answer = {
    summary: 'Reviewed routes.',
    files: [],
    edits: [],
    result: {
      reviews: [{
        ticket: 'T-0001',
        verdict: 'pass',
        findings: [{ file: 'src/a.ts', line: 1, severity: 'low', issue: `echo ${cred}`, fix: 'remove' }],
      }],
      notes: '',
    },
  };
  const result = await executeApi(reviewJob(), [], {
    env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify({
        type: 'message',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      })).body,
    }),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /credential/);
});

test('limitUtf8String truncates on a code-point boundary within the byte limit', () => {
  const prefix = 'a'.repeat(10);
  const emoji = '😀';
  const text = prefix + emoji + 'tail';
  const maxBytes = Buffer.byteLength(prefix, 'utf8') + 2;
  const cut = limitUtf8String(text, maxBytes);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= maxBytes);
  assert.equal(cut, prefix);
  assert.ok(!/\uD800|\uDFFF/.test(cut) || cut === prefix);
});

test('duplicate pass and fail entries for one ticket resolve to fail with merged findings', () => {
  const reviews = [
    { ticket: 'T-0001', verdict: 'pass', findings: [] },
    { ticket: 'T-0001', verdict: 'fail', findings: [{ file: 'a.ts', line: 2, severity: 'high', issue: 'gap', fix: 'check' }] },
  ];
  const parsed = parseReviewVerdicts(`${JSON.stringify({ reviews })}\n`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].ticket, 'T-0001');
  assert.equal(parsed[0].verdict, 'fail');
  assert.equal(parsed[0].findings.length, 1);
  assert.equal(normalizeReviewEntries(reviews)[0].verdict, 'fail');
});

test('entries for tickets outside allowedTickets are dropped', () => {
  const reviews = [
    { ticket: 'T-0001', verdict: 'pass', findings: [] },
    { ticket: 'T-9999', verdict: 'pass', findings: [] },
  ];
  const parsed = parseReviewVerdicts(JSON.stringify({ reviews }), ['T-0001']);
  assert.deepEqual(parsed.map(r => r.ticket), ['T-0001']);
});
