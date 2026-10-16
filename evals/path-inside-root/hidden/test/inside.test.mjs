import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveInside } from '../src/inside.mjs';

const root = path.resolve('/work/proj');
const outside = { code: 'outside' };

test('resolves a plain child path', () => {
  assert.equal(resolveInside(root, 'src/a.js'), path.join(root, 'src', 'a.js'));
});

test('root itself is inside', () => {
  assert.equal(resolveInside(root, '.'), root);
});

test('child named with leading dots is inside', () => {
  assert.equal(resolveInside(root, '..cache/x'), path.join(root, '..cache', 'x'));
});

test('segments that stay inside are normalized', () => {
  assert.equal(resolveInside(root, 'a/../b'), path.join(root, 'b'));
});

test('parent segment escapes', () => {
  assert.throws(() => resolveInside(root, '../x'), outside);
});

test('sibling sharing the name prefix escapes', () => {
  assert.throws(() => resolveInside(root, '../proj-evil/x'), outside);
});

test('deep parent escape escapes', () => {
  assert.throws(() => resolveInside(root, 'a/../../proj-evil'), outside);
});

test('absolute path elsewhere escapes', () => {
  assert.throws(() => resolveInside(root, path.resolve('/etc/passwd')), outside);
});

test('trailing separator on root still resolves children', () => {
  assert.equal(resolveInside(root + path.sep, 'x'), path.join(root, 'x'));
});
