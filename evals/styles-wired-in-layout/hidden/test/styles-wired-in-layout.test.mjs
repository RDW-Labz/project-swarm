import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/app/styles-wired-in-layout.tsx', 'utf8');

test('imports the global stylesheet', () => {
  assert.match(src, /import\s+["'](\.\/globals\.css|@\/app\/globals\.css)["']/);
});

test('loads both design fonts from next/font/google', () => {
  assert.match(src, /import\s*\{[^}]*\bBricolage_Grotesque\b[^}]*\}\s*from\s*["']next\/font\/google["']/);
  assert.match(src, /import\s*\{[^}]*\bFigtree\b[^}]*\}\s*from\s*["']next\/font\/google["']/);
});

test('uses the CSS variable option names', () => {
  assert.ok(src.includes('--font-bricolage'));
  assert.ok(src.includes('--font-figtree'));
});

test('puts both font variable classes on the html element', () => {
  assert.match(src, /<html\b/);
  assert.ok((src.match(/\.variable\b/g) || []).length >= 2);
});

test('sets lang en on html', () => {
  assert.match(src, /<html[^>]*lang=["']en["']/);
});

test('default export function RootLayout', () => {
  assert.match(src, /export\s+default\s+function\s+RootLayout\b/);
});
