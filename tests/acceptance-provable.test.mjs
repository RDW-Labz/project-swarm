import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pathsInAcceptanceText,
  allowedPathsForAcceptance,
  provabilityOfAcceptanceLine,
  filterProvableAcceptance,
} from '../tools/acceptance-provable.mjs';

function fsOf(paths) {
  const have = new Set(paths);
  return (p) => have.has(p);
}

const scope = { context: [], sections: [] };

test('pathsInAcceptanceText: backticks and bare paths, not URLs', () => {
  const found = pathsInAcceptanceText('Check `src/a.ts` and tools/foo.mjs; skip https://x.test/y');
  assert.deepEqual(found, ['src/a.ts', 'tools/foo.mjs']);
});

test('pathsInAcceptanceText: dot-prefixed paths in plain text and backticks', () => {
  const plain = pathsInAcceptanceText('CI runs from .github/workflows/ci.yml on push');
  const ticked = pathsInAcceptanceText('CI runs from `.github/workflows/ci.yml` on push');
  assert.deepEqual(plain, ['.github/workflows/ci.yml']);
  assert.deepEqual(ticked, ['.github/workflows/ci.yml']);
  assert.deepEqual(plain, ticked);
});

test('pathsInAcceptanceText: other dot-dir paths keep leading dot', () => {
  const found = pathsInAcceptanceText('Use .eslintrc/base.json and .husky/pre-commit.sh hooks');
  assert.deepEqual(found, ['.eslintrc/base.json', '.husky/pre-commit.sh']);
});

test('pathsInAcceptanceText: ./ prefix normalizes like backtick paths', () => {
  const found = pathsInAcceptanceText('See ./docs/x.md for details');
  assert.deepEqual(found, ['docs/x.md']);
});

test('pathsInAcceptanceText: does not match path embedded in a word', () => {
  const found = pathsInAcceptanceText('pretools/foo.mjs');
  assert.deepEqual(found, ['pretools/foo.mjs']);
  assert.equal(found.includes('tools/foo.mjs'), false);
});

test('pathsInAcceptanceText: ../ is not treated as a dot-prefixed repo path', () => {
  const found = pathsInAcceptanceText('copy from ../secret/leak.txt never');
  assert.deepEqual(found, []);
});

test('AC1: keeps a line with no file references', () => {
  const ticket = {
    id: 'T-0001',
    type: 'build',
    files: ['tools/x.mjs'],
    tests: ['tests/x.test.mjs'],
    acceptance: ['Returns the filtered list in stable order'],
    context: [],
  };
  const { acceptance, dropped } = filterProvableAcceptance({
    ticket,
    allTickets: [ticket],
    scope,
    exists: fsOf(['docs/scope/context/overview.md', 'package.json', 'tools/x.mjs', 'tests/x.test.mjs']),
  });
  assert.deepEqual(acceptance, ['Returns the filtered list in stable order']);
  assert.deepEqual(dropped, []);
});

test('AC1: drops a line that names a path outside ticket files and auto context', () => {
  const ticket = {
    id: 'T-0001',
    type: 'build',
    files: ['tools/x.mjs'],
    tests: [],
    acceptance: ['`src/other.ts` exports the helper'],
    context: [],
  };
  const { acceptance, dropped } = filterProvableAcceptance({
    ticket,
    allTickets: [ticket],
    scope,
    exists: fsOf(['docs/scope/context/overview.md', 'package.json', 'tools/x.mjs']),
  });
  assert.deepEqual(acceptance, []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].code, 'outside-context');
  assert.match(dropped[0].reason, /src\/other\.ts/);
});

test('AC1: keeps a line that names a path in the ticket own files', () => {
  const ticket = {
    id: 'T-0001',
    type: 'build',
    files: ['tools/x.mjs'],
    tests: [],
    acceptance: ['`tools/x.mjs` exports filterProvableAcceptance'],
    context: [],
  };
  const allowed = allowedPathsForAcceptance({
    ticket,
    allTickets: [ticket],
    scope,
    exists: fsOf(['docs/scope/context/overview.md', 'package.json', 'tools/x.mjs']),
  });
  const verdict = provabilityOfAcceptanceLine({
    line: ticket.acceptance[0],
    ticket,
    allowed,
    allTickets: [ticket],
  });
  assert.equal(verdict.provable, true);
});

test('AC2: drops a line that references a file a later ticket owns', () => {
  const early = {
    id: 'T-0001',
    type: 'build',
    files: ['tools/x.mjs'],
    tests: [],
    dependsOn: [],
    acceptance: ['`tests/y.test.mjs` covers the behavior'],
  };
  const later = {
    id: 'T-0002',
    type: 'test',
    files: [],
    tests: ['tests/y.test.mjs'],
    dependsOn: ['T-0001'],
    acceptance: ['Tests pass'],
  };
  const exists = fsOf(['docs/scope/context/overview.md', 'package.json', 'tools/x.mjs']);
  const { acceptance, dropped } = filterProvableAcceptance({
    ticket: early,
    allTickets: [early, later],
    scope,
    exists,
  });
  assert.deepEqual(acceptance, []);
  assert.equal(dropped[0].code, 'later-ticket-file');
  assert.match(dropped[0].reason, /T-0002/);
});

test('AC2: keeps a line that references a dependency ticket output', () => {
  const dep = {
    id: 'T-0001',
    type: 'build',
    files: ['src/core.ts'],
    tests: [],
    dependsOn: [],
    acceptance: [],
  };
  const ticket = {
    id: 'T-0002',
    type: 'build',
    files: ['src/use.ts'],
    tests: [],
    dependsOn: ['T-0001'],
    acceptance: ['Uses `src/core.ts` from the dependency'],
  };
  const { acceptance, dropped } = filterProvableAcceptance({
    ticket,
    allTickets: [dep, ticket],
    scope,
    exists: fsOf(['docs/scope/context/overview.md', 'package.json', 'src/core.ts', 'src/use.ts']),
  });
  assert.deepEqual(acceptance, ticket.acceptance);
  assert.deepEqual(dropped, []);
});
