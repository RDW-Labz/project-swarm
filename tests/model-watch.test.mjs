// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readState, weightBytes, fitsGpu, normalizeHf, watchModels, watchConfig, compareModels, isDue, fetchOpenCandidates, fetchApiModels, WATCH_DEFAULTS } from '../tools/model-watch.mjs';
import { runModelsCommand } from '../tools/models-commands.mjs';
import { readJournal } from '../tools/journal.mjs';
import { collectInbox } from '../tools/inbox.mjs';

const NOW = Date.UTC(2026, 9, 18);
const DAY = 86400000;
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'model-watch-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const hf = (id, extra = {}) => ({ id, downloads: 5000, createdAt: new Date(NOW - 10 * DAY).toISOString(), safetensors: { total: 30e9, parameters: { BF16: 30e9 } }, ...extra });
const config = watchConfig({});

test('fit: weights by dtype against the GPU memory, leaving room for the KV cache; unknown dtypes count as 16-bit; no size is unknown', () => {
  assert.deepEqual(weightBytes({ parameters: { BF16: 30e9 } }), { bytes: 60e9, estimated: false });
  assert.deepEqual(weightBytes({ parameters: { F8_E4M3: 30e9, BF16: 1e9 } }), { bytes: 32e9, estimated: false });
  assert.deepEqual(weightBytes({ total: 10e9 }), { bytes: 20e9, estimated: true });
  assert.equal(weightBytes(null), null);
  assert.equal(weightBytes({ parameters: { BF16: -1 } }), null);
  assert.equal(fitsGpu(60e9, config), true);
  assert.equal(fitsGpu(80e9, config), false, '96 GB x 0.8 = 76.8 GB of weights at most');
  assert.equal(fitsGpu(80e9, watchConfig({ modelWatch: { gpus: 2 } })), true);
});

test('listing rows: only public coding models with enough downloads, recent, with a well-formed id', () => {
  assert.equal(normalizeHf(hf('acme/Super-Coder-30B'), config, NOW).fits, true);
  assert.equal(normalizeHf(hf('acme/Huge-Coder-400B', { safetensors: { parameters: { BF16: 400e9 } } }), config, NOW).fits, false);
  for (const bad of [hf('acme/chat-model'), hf('acme/x-coder', { gated: 'manual' }), hf('acme/x-coder', { private: true }), hf('acme/x-coder', { downloads: 3 }), hf('acme/x-coder', { createdAt: new Date(NOW - 400 * DAY).toISOString() }), hf('../etc/coder'), hf('a b/coder'), null, 'x']) assert.equal(normalizeHf(bad, config, NOW), null);
  assert.equal(normalizeHf(hf('acme/x-coder', { safetensors: undefined }), config, NOW).fits, null, 'size unknown: not claimed to fit');
});

test('sources: Hugging Face and the Anthropic list are read defensively', async () => {
  const ok = body => async () => ({ ok: true, status: 200, json: async () => body });
  assert.equal((await fetchOpenCandidates({ fetchImpl: ok([hf('acme/a-coder'), { id: 'bad' }]), config, now: NOW })).length, 1);
  await assert.rejects(fetchOpenCandidates({ fetchImpl: async () => ({ ok: false, status: 503 }), config, now: NOW }), /answered 503/);
  await assert.rejects(fetchOpenCandidates({ fetchImpl: ok({ not: 'a list' }), config, now: NOW }), /no list/);
  assert.deepEqual((await fetchApiModels({ fetchImpl: ok({ data: [{ id: 'claude-x-1' }, { id: 'Bad Id' }, { nope: 1 }] }), key: 'k' })).ids, ['claude-x-1']);
  assert.equal((await fetchApiModels({ fetchImpl: ok({}), key: null })).skipped, 'no Anthropic key');
});

test('the first pass is a silent baseline; later passes put each NEW model that fits in the inbox as a decision, never rent anything, and honour the weekly interval', async t => {
  const root = await tmp(t), home = await tmp(t);
  const env = { SWARM_MODELS_DIR: path.join(home, 'models') };
  let open = [normalizeHf(hf('acme/a-coder'), config, NOW)], api = { ids: ['claude-haiku-5-5'], skipped: null };
  const sources = { open: async () => open, api: async () => api };
  const run = (extra = {}) => watchModels({ root, sources, env, home, now: () => NOW + (extra.at ?? 0), force: extra.force, local: extra.local });
  const first = await run();
  assert.equal(first.baseline, true);
  assert.deepEqual(first.decisions, []);
  assert.equal((await readJournal(root, { limit: Infinity })).filter(e => e.kind === 'decision').length, 0, 'the baseline never floods the inbox');
  // Not due yet.
  const early = await run({ at: 2 * DAY });
  assert.equal(early.ran, false);
  assert.match(early.nextAt, /^2026-10-25/);
  // A week later: one model fits, one is too big, one new API version.
  open = [...open, normalizeHf(hf('acme/b-coder'), config, NOW), normalizeHf(hf('acme/huge-coder', { safetensors: { parameters: { BF16: 400e9 } } }), config, NOW)];
  api = { ids: ['claude-haiku-5-5', 'claude-haiku-5-6'], skipped: null };
  const second = await run({ at: 8 * DAY, local: { modelWatch: { evalCapUsd: 3 } } });
  assert.equal(second.ran, true);
  assert.deepEqual(second.newOpen.map(c => c.id), ['acme/b-coder', 'acme/huge-coder']);
  assert.deepEqual(second.tooBig, ['acme/huge-coder']);
  assert.equal(second.decisions.length, 2);
  assert.match(second.decisions[0], /^model-hf-acme-b-coder-[0-9a-f]{8}$/);
  assert.match(second.decisions[1], /^model-api-claude-haiku-5-6-[0-9a-f]{8}$/);
  const events = (await readJournal(root, { limit: Infinity })).filter(e => e.kind === 'decision');
  const bcoder = events.find(e => e.id === second.decisions[0]);
  assert.match(bcoder.text, /acme\/b-coder.*fits 1 GPU/);
  assert.match(bcoder.text, /cap you pre-approved: \$3.*swarm gpu bakeoff --models acme\/b-coder --max-usd 3.*Nothing was rented/);
  assert.equal(bcoder.choice, 'skip', 'the default is to do nothing');
  assert.deepEqual(bcoder.options, ['evaluate', 'skip']);
  const items = await collectInbox([root], { listRuns: async () => [], readState: async () => null, readJournal, now: () => NOW });
  assert.ok(items.some(i => i.id === second.decisions[0]), 'it shows in swarm inbox');
  // The same models are never reported twice.
  const third = await run({ at: 20 * DAY });
  assert.deepEqual([third.newOpen, third.newApi, third.decisions], [[], [], []]);
});

test('without a pre-approved cap the advice says nothing was rented and how to set one; a failing source is a note, not a crash', async t => {
  const root = await tmp(t), home = await tmp(t);
  const env = { SWARM_MODELS_DIR: path.join(home, 'models') };
  const baseModel = normalizeHf(hf('acme/base-coder'), config, NOW);
  let rows = [baseModel];
  const sources = { open: async () => rows, api: async () => { throw new Error('offline'); } };
  await watchModels({ root, sources, env, home, now: () => NOW });
  rows = [baseModel, normalizeHf(hf('acme/c-coder'), config, NOW)];
  const r = await watchModels({ root, sources, env, home, now: () => NOW + 9 * DAY });
  assert.match(r.notes.join(), /API models not checked: offline/);
  const text = (await readJournal(root, { limit: Infinity })).find(e => /^model-hf-acme-c-coder-/.test(e.id)).text;
  assert.match(text, /no cap is pre-approved \(set modelWatch\.evalCapUsd.*nothing was rented/);
  assert.equal(watchConfig({ modelWatch: { evalCapUsd: -5, gpus: 'x' } }).evalCapUsd, null);
  assert.equal(watchConfig({}).gpuMemGb, WATCH_DEFAULTS.gpuMemGb);
  assert.equal(isDue({ lastRunAt: 'garbage' }, NOW, config), true);
});

test('compare: pass rate and cost from recorded eval runs, with thin evidence said out loud', () => {
  const row = (model, passed, total, costUsd) => ({ models: [model], passed, total, costUsd });
  const rows = [row('old', 8, 10, 0.01), row('old', 9, 10, 0.01), row('old', 7, 10, 0.01), row('new', 10, 10, 0.02), row('both', 1, 1, 0)];
  rows.push({ models: ['old', 'new'], passed: 1, total: 1, costUsd: 0 });
  const c = compareModels(rows, 'old', 'new');
  assert.equal(c.ok, true);
  assert.equal(c.points, 20, '100% vs 80%');
  assert.match(c.message, /new beats old by 20 points.*100\.0% vs 80\.0%.*\$0\.0200 per eval run \(old: \$0\.0100\)\. Thin evidence: 3 and 1 run\(s\).*Switching is your decision/);
  assert.equal(compareModels(rows, 'old', 'missing').ok, false);
  assert.match(compareModels(rows, 'old', 'missing').message, /no recorded eval runs for missing/);
  assert.match(compareModels(rows, 'new', 'old').message, /old is 20 points behind new/);
});

test('swarm models: watch (first run baseline), list, compare, usage', async t => {
  const root = await tmp(t), home = await tmp(t);
  const env = { SWARM_MODELS_DIR: path.join(home, 'models'), SWARM_CONFIG: path.join(home, 'none.json') };
  const fetchImpl = async url => ({ ok: true, status: 200, json: async () => (String(url).includes('huggingface') ? [hf('acme/a-coder', { createdAt: new Date().toISOString() })] : { data: [] }) });
  const first = await runModelsCommand(root, ['watch'], { fetchImpl, env, key: null });
  assert.match(first.stdout, /First check: recorded 1 model\(s\) as the baseline/);
  assert.match(first.stdout, /note: API models not checked: no Anthropic key/);
  assert.match((await runModelsCommand(root, ['watch'], { fetchImpl, env, key: null })).stdout, /Checked recently/);
  assert.equal((await runModelsCommand(root, ['watch', '--bogus'], { fetchImpl, env })).exitCode, 2);
  assert.match((await runModelsCommand(root, ['list'], { env })).stdout, /hf:acme\/a-coder/);
  await fs.mkdir(path.join(root, 'docs/state'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/state/eval-scores.ndjson'), `${JSON.stringify({ models: ['a'], passed: 5, total: 10, costUsd: 0.01 })}\n${JSON.stringify({ models: ['b'], passed: 9, total: 10, costUsd: 0.03 })}\n`);
  assert.match((await runModelsCommand(root, ['compare', 'a', 'b'], { env })).stdout, /b beats a by 40 points/);
  assert.equal((await runModelsCommand(root, ['compare', 'a'], { env })).exitCode, 2);
  assert.equal((await runModelsCommand(root, [], { env })).exitCode, 2);
});

test('review fixes: pagination to the age limit, packed dtypes, baseline only on a real answer, a decision cap, lastRunAt only after a real check, distinct ids, safe compare', async t => {
  // pages are followed until the models are older than maxAgeDays
  const page = (rows, next) => async url => ({ ok: true, status: 200, headers: { get: h => (h === 'link' && next ? `<${next}>; rel="next"` : null) }, json: async () => rows });
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (calls.length === 1) return page([hf('acme/new-coder', { downloads: 10 })], 'https://huggingface.co/api/models?cursor=2')(url);
    if (calls.length === 2) return page([hf('acme/popular-coder', { downloads: 9000, createdAt: new Date(NOW - 100 * DAY).toISOString() }), hf('acme/ancient-coder', { createdAt: new Date(NOW - 900 * DAY).toISOString() })], 'https://huggingface.co/api/models?cursor=3')(url);
    return page([], null)(url);
  };
  const found = await fetchOpenCandidates({ fetchImpl, config, now: NOW });
  assert.deepEqual(found.map(c => c.id), ['acme/popular-coder'], 'a model that gained downloads after its upload is found; the new low-download one is not');
  assert.equal(calls.length, 2, 'stops once a page reaches models older than maxAgeDays');
  assert.equal(weightBytes({ parameters: { I32: 25e9 } }).bytes, 100e9, 'packed 4-bit weights count at their stored width');
  assert.equal(fitsGpu(weightBytes({ parameters: { I32: 25e9 } }).bytes, config), false);
  assert.equal(weightBytes({ parameters: { WEIRD: 10e9 } }).bytes, 40e9, 'an unknown dtype is counted wide, not narrow');
  const root = await tmp(t), home = await tmp(t);
  const env = { SWARM_MODELS_DIR: path.join(home, 'models') };
  // an empty first answer baselines nothing; a total outage does not start the week
  let rows = [], fail = false;
  const sources = { open: async () => { if (fail) throw new Error('down'); return rows; }, api: async () => ({ ids: [], skipped: null }) };
  await watchModels({ root, sources, env, home, now: () => NOW });
  rows = [normalizeHf(hf('acme/a-coder'), config, NOW)];
  const second = await watchModels({ root, sources, env, home, now: () => NOW + 8 * DAY });
  assert.equal(second.baseline, true, 'the first non-empty answer is the baseline, not a flood of decisions');
  assert.deepEqual(second.decisions, []);
  fail = true;
  const outage = await watchModels({ root, sources: { open: sources.open, api: async () => { throw new Error('down too'); } }, env, home, now: () => NOW + 20 * DAY });
  assert.equal(outage.ran, true);
  const after = await readState(env, home);
  assert.equal(after.lastRunAt, new Date(NOW + 8 * DAY).toISOString(), 'a pass where nothing answered is not a check');
  // at most five decisions per run; ids that differ only by case or punctuation stay distinct
  fail = false;
  rows = [...rows, ...Array.from({ length: 8 }, (_, n) => normalizeHf(hf(`acme/m${n}-coder`), config, NOW)), normalizeHf(hf('acme/B_Coder'), config, NOW), normalizeHf(hf('acme/b-coder'), config, NOW)];
  const flood = await watchModels({ root, sources, env, home, now: () => NOW + 40 * DAY });
  assert.equal(flood.decisions.length, 5);
  assert.match(flood.notes.join(), /5 more new model\(s\) fit but only 5 were put in the inbox/);
  const { default: crypto } = await import('node:crypto');
  const slugOf = id => `${id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
  assert.notEqual(slugOf('acme/B_Coder'), slugOf('acme/b-coder'));
  // compare ignores malformed rows
  const rowsC = [{ models: ['x'], passed: 'many', total: 10, costUsd: 0 }, { models: ['x'], passed: 20, total: 10, costUsd: 0 }, { models: ['x'], passed: 5, total: 10, costUsd: 0.01 }, { models: ['y'], passed: 9, total: 10, costUsd: 0.01 }];
  assert.equal(compareModels(rowsC, 'x', 'y').points, 40, 'only the well-formed x row counts');
});
