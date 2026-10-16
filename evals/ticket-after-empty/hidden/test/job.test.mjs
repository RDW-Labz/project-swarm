import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJob } from '../src/job.mjs';

test('keeps dependencies that are in the set', () => {
  const ticket = { id: 'T1', title: 'Build', dependsOn: ['T0'] };
  assert.deepStrictEqual(toJob(ticket, new Set(['T0'])), { id: 'T1', title: 'Build', after: ['T0'] });
});

test('drops dependencies that are not in the set', () => {
  const ticket = { id: 'T1', title: 'Build', dependsOn: ['A', 'B', 'C'] };
  assert.deepStrictEqual(toJob(ticket, new Set(['B'])), { id: 'T1', title: 'Build', after: ['B'] });
});

test('keeps the original order of dependencies', () => {
  const ticket = { id: 'T2', title: 'Test', dependsOn: ['C', 'A', 'B'] };
  assert.deepStrictEqual(toJob(ticket, new Set(['A', 'C'])).after, ['C', 'A']);
});

test('omits after when no dependency is in the set', () => {
  const result = toJob({ id: 'T1', title: 'Build', dependsOn: ['A'] }, new Set(['B']));
  assert.equal(Object.hasOwn(result, 'after'), false);
  assert.deepStrictEqual(result, { id: 'T1', title: 'Build' });
});

test('omits after when dependsOn is empty', () => {
  const result = toJob({ id: 'T3', title: 'Docs', dependsOn: [] }, new Set(['A']));
  assert.equal(Object.hasOwn(result, 'after'), false);
  assert.deepStrictEqual(result, { id: 'T3', title: 'Docs' });
});

test('omits after when the set is empty', () => {
  const result = toJob({ id: 'T4', title: 'Ship', dependsOn: ['A', 'B'] }, new Set());
  assert.equal(Object.hasOwn(result, 'after'), false);
  assert.deepStrictEqual(Object.keys(result).sort(), ['id', 'title']);
});

test('returns only id and title keys when after is omitted', () => {
  const result = toJob({ id: 'T5', title: 'Review', dependsOn: ['X'] }, new Set(['Y']));
  assert.deepStrictEqual(Object.keys(result).sort(), ['id', 'title']);
});

test('keeps every dependency when all are in the set', () => {
  const ticket = { id: 'T6', title: 'All', dependsOn: ['A', 'B'] };
  assert.deepStrictEqual(toJob(ticket, new Set(['A', 'B', 'Z'])), { id: 'T6', title: 'All', after: ['A', 'B'] });
});

test('does not modify the ticket or its dependsOn array', () => {
  const ticket = { id: 'T7', title: 'Keep', dependsOn: ['A', 'B'] };
  const before = JSON.stringify(ticket);
  toJob(ticket, new Set(['A']));
  assert.equal(JSON.stringify(ticket), before);
  assert.deepStrictEqual(ticket.dependsOn, ['A', 'B']);
});

test('after is a new array, not the ticket array', () => {
  const ticket = { id: 'T8', title: 'Copy', dependsOn: ['A'] };
  const result = toJob(ticket, new Set(['A']));
  assert.notEqual(result.after, ticket.dependsOn);
  assert.deepStrictEqual(result.after, ['A']);
});
