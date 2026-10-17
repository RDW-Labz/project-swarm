import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatorSource } from '../src/safe-identifier.mjs';

const badName = (e) => e instanceof Error && e.code === 'bad-name';

async function load(names) {
  return import('data:text/javascript,' + encodeURIComponent(validatorSource(names)));
}

test('returns text with one declaration per valid name', () => {
  assert.equal(validatorSource(['Pet']).trim(), 'export const validatePet = () => true;');
  const src = validatorSource(['Pet', 'order_1']);
  assert.equal(typeof src, 'string');
  assert.ok(src.includes('export const validateorder_1 = () => true;'));
});

test('exported validators return true and nothing else is exported', async () => {
  const ns = await load(['Pet', 'order_1']);
  assert.equal(ns.validatePet(), true);
  assert.equal(ns.validateorder_1(), true);
  assert.equal(Object.keys(ns).length, 2);
});

test('empty list yields a module with no exports', async () => {
  const ns = await load([]);
  assert.equal(Object.keys(ns).length, 0);
});

test('leading underscore and digits after the first character are accepted', async () => {
  const ns = await load(['_private', 'a1_b2']);
  assert.equal(ns.validate_private(), true);
  assert.equal(ns.validatea1_b2(), true);
});

test('rejects a hyphen', () => {
  assert.throws(() => validatorSource(['a-b']), badName);
});

test('rejects a leading digit', () => {
  assert.throws(() => validatorSource(['1abc']), badName);
});

test('rejects an empty name and a non-string', () => {
  assert.throws(() => validatorSource(['']), badName);
  assert.throws(() => validatorSource([42]), badName);
});

test('rejects non-ASCII letters', () => {
  assert.throws(() => validatorSource(['café']), badName);
});

test('hostile name throws and its code never runs', () => {
  const hostile = 'x = 1; globalThis.pwned = true; //';
  assert.throws(() => validatorSource([hostile]), badName);
  assert.equal(globalThis.pwned, undefined);
});

test('one bad name rejects the whole batch with no partial output', () => {
  assert.throws(() => validatorSource(['Good', 'bad name']), badName);
});

test('non-array input is rejected', () => {
  assert.throws(() => validatorSource('Pet'), badName);
});
