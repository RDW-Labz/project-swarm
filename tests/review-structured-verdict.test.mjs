// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeApi, outputSchema, isReadOnlyReviewJob } from '../tools/api-adapters.mjs';
import { parseReviewVerdicts, reviewNotes } from '../tools/security-review.mjs';

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
