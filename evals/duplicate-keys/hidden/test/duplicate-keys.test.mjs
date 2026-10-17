import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapKeys } from '../src/duplicate-keys.mjs';

test('assigns ids in item order from startAt', () => {
  const r = mapKeys([{ key: 'a' }, { key: 'b' }], 1);
  assert.deepEqual([...r.ids], [['a', 'T-0001'], ['b', 'T-0002']]);
  assert.deepEqual(r.errors, []);
});

test('pads ids to four digits and counts from startAt', () => {
  const r = mapKeys([{ key: 'x' }, { key: 'y' }, { key: 'z' }], 42);
  assert.equal(r.ids.get('x'), 'T-0042');
  assert.equal(r.ids.get('z'), 'T-0044');
});

test('empty input gives an empty Map and no errors', () => {
  const r = mapKeys([], 1);
  assert.ok(r.ids instanceof Map);
  assert.equal(r.ids.size, 0);
  assert.deepEqual(r.errors, []);
});

test('ids is a Map', () => {
  const r = mapKeys([{ key: 'a' }], 1);
  assert.equal(r.ids instanceof Map, true);
});

test('duplicate key: first use keeps id, later use is an error and takes no number', () => {
  const r = mapKeys([{ key: 'a' }, { key: 'b' }, { key: 'a' }, { key: 'c' }], 7);
  assert.equal(r.ids.get('a'), 'T-0007');
  assert.equal(r.ids.get('b'), 'T-0008');
  assert.equal(r.ids.get('c'), 'T-0009');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /duplicate/);
});

test('non-string or empty keys are rejected with errors and no ids', () => {
  const r = mapKeys([{ key: 1 }, { key: '' }, { key: null }, {}, { key: ['a'] }], 1);
  assert.equal(r.ids.size, 0);
  assert.equal(r.errors.length, 5);
});

test('rejected items do not use up a number', () => {
  const r = mapKeys([{ key: '' }, { key: 'x' }, { key: 7 }, { key: 'y' }], 1);
  assert.equal(r.ids.get('x'), 'T-0001');
  assert.equal(r.ids.get('y'), 'T-0002');
  assert.equal(r.errors.length, 2);
});

test('__proto__ and constructor are ordinary keys', () => {
  const r = mapKeys([{ key: '__proto__' }, { key: 'constructor' }, { key: 'toString' }], 1);
  assert.equal(r.ids.size, 3);
  assert.equal(r.ids.get('__proto__'), 'T-0001');
  assert.equal(r.ids.get('constructor'), 'T-0002');
  assert.deepEqual(r.errors, []);
});

test('duplicate __proto__ is still a duplicate', () => {
  const r = mapKeys([{ key: '__proto__' }, { key: '__proto__' }], 1);
  assert.equal(r.ids.get('__proto__'), 'T-0001');
  assert.equal(r.errors.length, 1);
});

test('a key named like a prototype property does not pollute Object.prototype', () => {
  mapKeys([{ key: 'polluted' }], 1);
  assert.equal(Object.prototype.polluted, undefined);
});
