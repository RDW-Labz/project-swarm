// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HANDOFF_TRANSCRIPT_BYTES,
  HANDOFF_TRANSCRIPT_BYTES_ENV,
  validateOrchestratorConfig,
  handoffTranscriptBytes,
  transcriptBytes,
  contextHandoffOf,
} from '../tools/orchestrator-context.mjs';

const MIN_BYTES = 256 * 1024;
const PROFILE_BYTES = 512 * 1024;
const ENV_BYTES = 768 * 1024;
const EXPLICIT_BYTES = 1024 * 1024;

test('handoffTranscriptBytes: explicit beats orchestrator config, env, and default', () => {
  const env = { [HANDOFF_TRANSCRIPT_BYTES_ENV]: String(ENV_BYTES) };
  const got = handoffTranscriptBytes({
    threshold: EXPLICIT_BYTES,
    orchestrator: { handoffTranscriptBytes: PROFILE_BYTES },
    env,
  });
  assert.equal(got, EXPLICIT_BYTES);
});

test('handoffTranscriptBytes: orchestrator config beats env and default', () => {
  const env = { [HANDOFF_TRANSCRIPT_BYTES_ENV]: String(ENV_BYTES) };
  assert.equal(
    handoffTranscriptBytes({ orchestrator: { handoffTranscriptBytes: PROFILE_BYTES }, env }),
    PROFILE_BYTES,
  );
  assert.equal(
    handoffTranscriptBytes({ config: { orchestrator: { handoffTranscriptBytes: PROFILE_BYTES } }, env }),
    PROFILE_BYTES,
  );
});

test('handoffTranscriptBytes: env beats default', () => {
  const env = { [HANDOFF_TRANSCRIPT_BYTES_ENV]: String(ENV_BYTES) };
  assert.equal(handoffTranscriptBytes({ env }), ENV_BYTES);
});

test('handoffTranscriptBytes: falls back to default', () => {
  assert.equal(handoffTranscriptBytes({ env: {} }), DEFAULT_HANDOFF_TRANSCRIPT_BYTES);
});

test('validateOrchestratorConfig refuses invalid orchestrator blocks', () => {
  assert.deepEqual(validateOrchestratorConfig(undefined), { ok: true, config: null, errors: [] });
  const badType = validateOrchestratorConfig('nope');
  assert.equal(badType.ok, false);
  assert.match(badType.errors[0], /object/);

  const tooSmall = validateOrchestratorConfig({ handoffTranscriptBytes: MIN_BYTES - 1 });
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.errors.join(' '), /handoffTranscriptBytes/);

  const unknown = validateOrchestratorConfig({ handoffTranscriptBytes: PROFILE_BYTES, extra: 1 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(' '), /unknown key/);

  const good = validateOrchestratorConfig({ handoffTranscriptBytes: PROFILE_BYTES });
  assert.deepEqual(good, { ok: true, config: { handoffTranscriptBytes: PROFILE_BYTES }, errors: [] });
});

test('transcriptBytes reads size under an allowed transcript root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-orch-ctx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = process.env.SWARM_TRANSCRIPT_ROOTS;
  process.env.SWARM_TRANSCRIPT_ROOTS = root;
  t.after(() => { process.env.SWARM_TRANSCRIPT_ROOTS = saved; });

  const name = 'sess-handoff-test.jsonl';
  const file = path.join(root, name);
  const body = '{"type":"user"}\n';
  fs.writeFileSync(file, body, 'utf8');

  assert.equal(transcriptBytes(name), Buffer.byteLength(body, 'utf8'));
  assert.equal(transcriptBytes('missing-file.jsonl'), null);
});

test('contextHandoffOf reports over and under with bytes and threshold', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-orch-ctx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = process.env.SWARM_TRANSCRIPT_ROOTS;
  process.env.SWARM_TRANSCRIPT_ROOTS = root;
  t.after(() => { process.env.SWARM_TRANSCRIPT_ROOTS = saved; });

  const threshold = MIN_BYTES;
  const name = 'ctx-size.jsonl';
  const file = path.join(root, name);
  const small = 'x'.repeat(threshold - 1);
  fs.writeFileSync(file, small, 'utf8');

  const under = await contextHandoffOf(name, { threshold, measureOnly: true, env: {} });
  assert.equal(under.over, false);
  assert.equal(under.handoff, false);
  assert.equal(under.bytes, threshold - 1);
  assert.equal(under.threshold, threshold);

  fs.writeFileSync(file, 'x'.repeat(threshold), 'utf8');
  const over = await contextHandoffOf(name, { threshold, measureOnly: true, env: {} });
  assert.equal(over.over, true);
  assert.equal(over.handoff, true);
  assert.equal(over.bytes, threshold);
  assert.equal(over.threshold, threshold);
  assert.equal(over.saved, false);
});

test('contextHandoffOf handles missing transcript', async () => {
  const threshold = PROFILE_BYTES;
  const out = await contextHandoffOf('no-such-transcript.jsonl', { threshold, measureOnly: true, env: {} });
  assert.equal(out.transcript, 'no-such-transcript.jsonl');
  assert.equal(out.bytes, null);
  assert.equal(out.threshold, threshold);
  assert.equal(out.over, false);
  assert.equal(out.handoff, false);
});

test('contextHandoffOf treats empty transcript as missing', async () => {
  const out = await contextHandoffOf('', { threshold: PROFILE_BYTES, measureOnly: true, env: {} });
  assert.equal(out.transcript, null);
  assert.equal(out.bytes, null);
  assert.equal(out.over, false);
});
