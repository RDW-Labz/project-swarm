import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const assetDir = path.join(repo, 'tools', 'watch-assets');
const TABS = ['run', 'plan', 'commands', 'gallery'];
const files = fs.readdirSync(assetDir, { withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => d.name)
  .sort();
const read = (name) => fs.readFileSync(path.join(assetDir, name), 'utf8');
const URL_RE = /https?:\/\//i;
const FORBIDDEN = [
  [/innerHTML/, 'innerHTML'],
  [/outerHTML/, 'outerHTML'],
  [/insertAdjacentHTML/, 'insertAdjacentHTML'],
  [/document\.write/, 'document.write'],
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\b/, 'new Function'],
];

function isCommentLine(line) {
  const t = line.trim();
  return /^(\/\/|\/\*|\*|<!--)/.test(t) || /SPDX-License-Identifier/.test(line);
}

const html = read('index.html');

test('design doc defines the client assets contract', () => {
  const doc = fs.readFileSync(path.join(repo, 'docs', 'plans', 'watch-design.md'), 'utf8');
  assert.match(doc, /## Client assets contract/);
});

test('assets directory has index.html and watch.css', () => {
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('watch.css'));
});

test('index.html references only existing relative assets/ paths', () => {
  const refRe = /\b(?:src|href)\s*=\s*["']([^"']*)["']/gi;
  const refs = [];
  let m;
  while ((m = refRe.exec(html)) !== null) refs.push(m[1]);
  assert.ok(refs.length > 0, 'no asset references found');
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^(?:[a-z]+:|\/)/i, 'absolute or external reference: ' + ref);
    assert.ok(ref.startsWith('assets/'), 'reference outside assets/: ' + ref);
    const rel = ref.slice('assets/'.length).split(/[?#]/)[0];
    assert.match(rel, /^[A-Za-z0-9._-]+$/, 'unsafe name: ' + ref);
    assert.ok(files.includes(rel), 'missing file for ' + ref);
  }
});

test('index.html has no inline script and no external URL', () => {
  const scriptRe = /<script\b([^>]*)>/gi;
  let m;
  let count = 0;
  while ((m = scriptRe.exec(html)) !== null) {
    count++;
    assert.match(m[1], /\bsrc\s*=/i, 'inline script tag found');
  }
  assert.ok(count > 0, 'no script tags found');
  assert.doesNotMatch(html, URL_RE, 'external URL in index.html');
});

test('index.html loads app.js first', () => {
  const first = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
  assert.ok(first, 'no script with src');
  assert.equal(first[1], 'assets/app.js');
});

test('no asset file uses DOM-string sinks or eval', () => {
  for (const name of files) {
    const text = read(name);
    for (const [re, label] of FORBIDDEN) {
      assert.doesNotMatch(text, re, name + ' uses ' + label);
    }
  }
});

test('no http(s) URL outside comment or SPDX lines in css and js files', () => {
  for (const name of files.filter((f) => /\.(?:js|css)$/.test(f))) {
    read(name).split(/\r?\n/).forEach((line, i) => {
      if (URL_RE.test(line.split('http://www.w3.org/2000/svg').join('')) && !isCommentLine(line)) {
        assert.fail(name + ':' + (i + 1) + ' has a URL outside a comment');
      }
    });
  }
});

test('every js file parses as a classic script (syntax only)', () => {
  for (const name of files.filter((f) => f.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(read(name), { filename: name }), name);
  }
});

test('tab scripts register under one of the four tab names', () => {
  const tabFiles = files.filter((f) => f.endsWith('.js') && f !== 'app.js' && f !== 'run-drawer.js' && f !== 'board.js' && f !== 'project.js' && f !== 'nav.js');
  assert.ok(tabFiles.length > 0, 'no tab scripts found');
  const re = /register\(\s*['"](run|plan|commands|gallery)['"]/;
  for (const name of tabFiles) {
    assert.match(read(name), re, name + ' does not register a tab');
  }
});

test('each tab name has a pane in index.html', () => {
  for (const tab of TABS) {
    assert.match(html, new RegExp('id\\s*=\\s*["\']pane-' + tab + '["\']'), 'missing pane-' + tab);
  }
});
