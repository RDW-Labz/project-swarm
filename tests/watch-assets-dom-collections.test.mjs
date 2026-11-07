// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutSummaryTileElement } from '../tools/watch-assets/cockpit-lists.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_ASSETS_DIR = path.join(__dirname, '..', 'tools', 'watch-assets');

const ARRAY_METHODS =
  'find|filter|map|some|every|reduce|findIndex|includes|flatMap|forEach';

const LINE_CHECKS = [
  {
    label: '.children',
    re: new RegExp(`\\.children\\.(${ARRAY_METHODS})\\s*\\(`, 'g'),
  },
  {
    label: '.childNodes',
    re: new RegExp(`\\.childNodes\\.(${ARRAY_METHODS})\\s*\\(`, 'g'),
  },
  {
    label: 'getElementsBy…()',
    re: new RegExp(
      `getElementsBy\\w+\\s*\\([^)]*\\)\\s*\\.\\s*(${ARRAY_METHODS})\\s*\\(`,
      'g',
    ),
  },
  {
    label: 'querySelectorAll()',
    re: new RegExp(
      `querySelectorAll\\s*\\([^)]*\\)\\s*\\.\\s*(${ARRAY_METHODS})\\s*\\(`,
      'g',
    ),
    allowForEach: true,
  },
];

function violationsInLine(line) {
  const out = [];
  for (const check of LINE_CHECKS) {
    for (const match of line.matchAll(check.re)) {
      const method = match[1];
      if (check.allowForEach && method === 'forEach') continue;
      out.push({ kind: check.label, method });
    }
  }
  return out;
}

async function listWatchAssetJsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'vendor') continue;
      files.push(...(await listWatchAssetJsFiles(full)));
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

test('watch-assets JS does not call array methods on live DOM collections', async () => {
  const files = await listWatchAssetJsFiles(WATCH_ASSETS_DIR);
  assert.ok(files.length > 0, 'expected watch-assets .js files to scan');
  const failures = [];
  for (const file of files.sort()) {
    const rel = path.relative(path.join(__dirname, '..'), file);
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const v of violationsInLine(lines[i])) {
        failures.push(
          `${rel}:${i + 1}: ${v.kind}.${v.method}() on a DOM collection`,
        );
      }
    }
  }
  assert.equal(
    failures.length,
    0,
    failures.length ? failures.join('\n') : undefined,
  );
});

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
  };
}

function makeHtmlCollection(items) {
  const col = { length: items.length };
  for (let i = 0; i < items.length; i++) col[i] = items[i];
  return col;
}

test('layoutSummaryTileElement finds tile parts when children is HTMLCollection-like', () => {
  const label = { classList: makeClassList(), textContent: 'Engines' };
  label.classList.add('m-label');
  const val = { classList: makeClassList(), textContent: '3' };
  val.classList.add('m-val');
  const foot = { classList: makeClassList(), textContent: 'peak workers' };
  foot.classList.add('m-foot');
  assert.equal(typeof label.children?.find, 'undefined');

  const tileRoot = {
    children: makeHtmlCollection([label, val, foot]),
  };
  assert.equal(tileRoot.children.length, 3);
  assert.equal(typeof tileRoot.children.find, 'undefined');

  layoutSummaryTileElement(tileRoot, { width: 390, height: 720 });

  assert.ok(label._layout, 'label layout assigned');
  assert.ok(val._layout, 'numeral layout assigned');
  assert.ok(foot._layout, 'footnote layout assigned');
  assert.ok(tileRoot._layout, 'tile root layout assigned');
});
