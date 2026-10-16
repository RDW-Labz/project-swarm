// SPDX-License-Identifier: Apache-2.0
import "./_isolate-config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRentedConfig, rentedSensitiveOk, RENTED_DEFAULTS } from "../tools/rented.mjs";

const base = () => ({ name: 'h100-node', endpoint: 'https://203.0.113.9', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', hourlyUsd: 24.5, maxHoursPerRun: 3, concurrency: 64, dailyUsd: 80, trusted: false });
const ok = (over = {}) => validateRentedConfig({ ...base(), ...over });
const bad = (over, field) => {
  const r = validateRentedConfig({ ...base(), ...over });
  assert.equal(r.config, null, `expected refusal naming ${field}`);
  assert.ok(r.errors.some((e) => e.includes(field)), `no error naming ${field}: ${r.errors}`);
};

test('valid config is normalized', () => {
  const r = ok();
  assert.deepEqual(r.errors, []);
  const c = r.config;
  assert.equal(c.name, 'h100-node');
  assert.equal(c.endpoint, 'https://203.0.113.9');
  assert.equal(c.chatUrl, 'https://203.0.113.9/v1/chat/completions');
  assert.equal(c.modelsUrl, 'https://203.0.113.9/v1/models');
  assert.equal(c.model, 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8');
  assert.equal(c.hourlyUsd, 24.5);
  assert.equal(c.maxHoursPerRun, 3);
  assert.equal(c.concurrency, 64);
  assert.equal(c.dailyUsd, 80);
  assert.equal(c.trusted, false);
  assert.deepEqual(c.adaptive, { start: 4, min: 1 });
});

test('defaults are applied to omitted fields', () => {
  const r = validateRentedConfig({ endpoint: 'https://x.example/v1', model: 'm', hourlyUsd: 24.5 });
  assert.deepEqual(r.errors, []);
  const c = r.config;
  assert.equal(c.maxHoursPerRun, 4);
  assert.equal(c.concurrency, 32);
  assert.equal(c.dailyUsd, 98);
  assert.equal(c.trusted, false);
  assert.equal(c.name, 'rented');
  assert.deepEqual(c.keyItem, RENTED_DEFAULTS.keyItem);
  assert.equal(c.endpoint, 'https://x.example');
  assert.deepEqual(c.adaptive, { start: 4, min: 1 });
});

test('dailyUsd default is rounded to 2 decimals', () => {
  const r = validateRentedConfig({ endpoint: 'https://x.example', model: 'm', hourlyUsd: 3.333, maxHoursPerRun: 3 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.dailyUsd, 10);
});

test('adaptive start is min(4, concurrency)', () => {
  assert.deepEqual(ok({ concurrency: 2 }).config.adaptive, { start: 2, min: 1 });
  assert.deepEqual(ok({ concurrency: 1 }).config.adaptive, { start: 1, min: 1 });
});

test('allowed endpoint forms normalize to origin', () => {
  const cases = [
    ['https://x.example/v1', 'https://x.example'],
    ['https://x.example', 'https://x.example'],
    ['http://127.0.0.1:8000', 'http://127.0.0.1:8000'],
    ['http://localhost:8000', 'http://localhost:8000'],
    ['http://[::1]:8000', 'http://[::1]:8000'],
  ];
  for (const [input, origin] of cases) {
    const r = ok({ endpoint: input });
    assert.deepEqual(r.errors, [], input);
    assert.equal(r.config.endpoint, origin, input);
  }
});

test('bad endpoint forms are refused', () => {
  const cases = [
    'http://203.0.113.9',
    'http://example.com',
    'https://user:pw@x.example',
    'https://u@x.example',
    'https://x.example/?a=1',
    'https://x.example/#h',
    'https://x.example/api',
    'ftp://x.example',
    'x.example',
    42,
  ];
  for (const e of cases) bad({ endpoint: e }, 'endpoint');
});

test('endpoint errors never echo credentials', () => {
  const r = ok({ endpoint: 'https://user:s3cret@x.example' });
  assert.equal(r.config, null);
  assert.ok(!JSON.stringify(r.errors).includes('s3cret'));
});

test('model pattern', () => {
  for (const m of ['Qwen/Qwen3-Coder', 'a', 'a'.repeat(120), 'org/model:tag-1.0']) {
    assert.deepEqual(ok({ model: m }).errors, [], m);
  }
  for (const m of ['', '-x', ' x', 'a'.repeat(121), 'a b', undefined]) bad({ model: m }, 'model');
});

test('hourlyUsd range', () => {
  assert.deepEqual(ok({ hourlyUsd: 1000 }).errors, []);
  assert.deepEqual(ok({ hourlyUsd: 0.01 }).errors, []);
  for (const v of [0, -1, 1001, '24', NaN, Infinity, undefined]) bad({ hourlyUsd: v }, 'hourlyUsd');
});

test('maxHoursPerRun range', () => {
  assert.deepEqual(ok({ maxHoursPerRun: 168 }).errors, []);
  assert.deepEqual(ok({ maxHoursPerRun: 0.5 }).errors, []);
  for (const v of [0, -1, 169, '3', NaN]) bad({ maxHoursPerRun: v }, 'maxHoursPerRun');
});

test('concurrency range and integer rule', () => {
  assert.deepEqual(ok({ concurrency: 1 }).errors, []);
  assert.deepEqual(ok({ concurrency: 2048 }).errors, []);
  for (const v of [0, 2049, 1.5, '8', NaN]) bad({ concurrency: v }, 'concurrency');
});

test('dailyUsd must be above 0', () => {
  for (const v of [0, -5, '80']) bad({ dailyUsd: v }, 'dailyUsd');
});

test('trusted must be boolean', () => {
  assert.equal(ok({ trusted: true }).config.trusted, true);
  for (const v of ['yes', 1, null]) bad({ trusted: v }, 'trusted');
});

test('name rules', () => {
  assert.deepEqual(ok({ name: 'a'.repeat(40) }).errors, []);
  assert.deepEqual(ok({ name: 'my rig_1.0' }).errors, []);
  for (const v of ['a'.repeat(41), 'bad/name', 'x\u0007']) bad({ name: v }, 'name');
});

test('keyItem rules', () => {
  const cases = [
    { service: '', account: 'a' },
    { service: 's', account: 'a'.repeat(81) },
    { service: 's', account: 'a\u0001' },
    { service: 's' },
    'x',
  ];
  for (const v of cases) bad({ keyItem: v }, 'keyItem');
  assert.deepEqual(ok({ keyItem: { service: 's', account: 'a' } }).config.keyItem, { service: 's', account: 'a' });
});

test('unknown keys are errors', () => {
  bad({ extra: 1 }, 'extra');
});

test('non-object raw is refused', () => {
  for (const v of [null, [], 'x']) {
    const r = validateRentedConfig(v);
    assert.equal(r.config, null);
    assert.ok(r.errors.length > 0);
  }
});

test('all errors are collected', () => {
  const r = validateRentedConfig({ endpoint: 'http://example.com', model: '', hourlyUsd: 0 });
  assert.equal(r.config, null);
  assert.ok(r.errors.length >= 3);
});

test('rentedSensitiveOk', () => {
  const t = ok({ trusted: true }).config;
  const f = ok({ trusted: false }).config;
  assert.equal(rentedSensitiveOk(f, { sensitive: false }), true);
  assert.equal(rentedSensitiveOk(f, {}), false);
  assert.equal(rentedSensitiveOk(f, { sensitive: true }), false);
  assert.equal(rentedSensitiveOk(f, { sensitive: 'false' }), false);
  assert.equal(rentedSensitiveOk(t, { sensitive: true }), true);
  assert.equal(rentedSensitiveOk(t, {}), true);
  assert.equal(rentedSensitiveOk(null, { sensitive: false }), false);
});

test('RENTED_DEFAULTS values and frozen', () => {
  assert.ok(Object.isFrozen(RENTED_DEFAULTS));
  assert.deepEqual(RENTED_DEFAULTS, {
    maxHoursPerRun: 4, concurrency: 32, minBillableMinutes: 1, warnAt: 0.8, trusted: false,
    keyItem: { service: 'project-swarm', account: 'rented.api_key' },
  });
  assert.throws(() => { RENTED_DEFAULTS.warnAt = 1; }, TypeError);
});
