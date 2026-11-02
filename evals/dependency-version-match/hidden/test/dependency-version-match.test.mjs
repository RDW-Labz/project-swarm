import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readCss() {
  return readFileSync(join(process.cwd(), 'src/app/dependency-version-match.css'), 'utf8');
}

test('has the three tailwind v3 directives', () => {
  const css = readCss();
  for (const name of ['base', 'components', 'utilities']) assert.match(css, new RegExp(`@tailwind\\s+${name}\\s*;`));
});

test('does not use the v4 import', () => {
  assert.doesNotMatch(readCss(), /@import\s+["']tailwindcss["']/);
});

test('sets --brand on :root', () => {
  assert.match(readCss(), /:root\s*\{[^}]*--brand:\s*#0a7\s*;?[^}]*\}/);
});
