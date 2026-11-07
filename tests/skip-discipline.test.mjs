// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Relative paths under tests/ exempt from runtime skip discipline (prefer fixing the test). */
const SKIP_DISCIPLINE_ALLOWLIST = [];

function lineHasRuntimeSkip(line) {
  if (!/\b(?:t|ctx)\.skip\s*\(/.test(line)) return false;
  if (/\b(?:test|it)\.skip\s*\(/.test(line)) return false;
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
  if (trimmed.includes('"test.skip') || trimmed.includes("'test.skip")) return false;
  if (trimmed.includes('"it.skip') || trimmed.includes("'it.skip")) return false;
  return true;
}

function skipFollowedByReturn(line, nextLine) {
  if (/\breturn\b/.test(line) && /\.skip\s*\(/.test(line)) return true;
  if (/\.skip\s*\([^)]*\)\s*;\s*return\b/.test(line)) return true;
  const next = (nextLine ?? '').trim();
  return next.startsWith('return');
}

function findRuntimeSkipViolations(source) {
  const lines = source.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!lineHasRuntimeSkip(line)) continue;
    if (skipFollowedByReturn(line, lines[i + 1])) continue;
    violations.push({ line: i + 1, text: line.trim() });
  }
  return violations;
}

test('tests/*.test.mjs runtime t.skip and ctx.skip always return or use test skip option', () => {
  const files = fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  const allViolations = [];
  for (const name of files) {
    if (SKIP_DISCIPLINE_ALLOWLIST.includes(name)) continue;
    const rel = path.join('tests', name);
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    for (const v of findRuntimeSkipViolations(source)) {
      allViolations.push({ file: rel, ...v });
    }
  }
  if (allViolations.length > 0) {
    const detail = allViolations.map((v) => `${v.file}:${v.line} ${v.text}`).join('\n');
    const allowHint = SKIP_DISCIPLINE_ALLOWLIST.length
      ? `\nallow-list: ${SKIP_DISCIPLINE_ALLOWLIST.join(', ')}`
      : '';
    assert.fail(`runtime skip without immediate return:\n${detail}${allowHint}`);
  }
});
