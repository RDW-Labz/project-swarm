// Structural/static assertions against tools/watch-assets/cc-phone.css source text only.
// No DOM, viewport, or layout engine — true overflow and hit-target behavior need a
// browser-based follow-up once this project has that tooling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cssPath = path.join(repo, 'tools', 'watch-assets', 'cc-phone.css');
const css = fs.readFileSync(cssPath, 'utf8');

/** @param {string} text @param {RegExp} mediaRe */
function extractMediaBlock(text, mediaRe) {
  const idx = text.search(mediaRe);
  if (idx === -1) return null;
  const open = text.indexOf('{', idx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const PHONE_MEDIA_RE = /@media\s*\(\s*max-width\s*:\s*(?:390|400)px\s*\)/;
const phoneBlock = extractMediaBlock(css, PHONE_MEDIA_RE);

test('cc-phone.css defines a max-width phone viewport media query (390px or narrower)', () => {
  assert.match(css, PHONE_MEDIA_RE, 'expected @media (max-width: 390px) or similar');
  assert.ok(phoneBlock, 'could not extract phone media block body');
});

test('interactive targets in the phone block meet 44px minimum touch size', () => {
  assert.ok(phoneBlock);

  const ccTabRule = phoneBlock.match(
    /\.cc-nav\s+\.cc-tab[\s\S]*?\.hive-nav\s+\.cc-btn\s*\{[^}]+\}/,
  );
  assert.ok(ccTabRule, 'cc-tab / cc-btn rule block');
  assert.match(ccTabRule[0], /min-height\s*:\s*44px/);
  assert.match(ccTabRule[0], /min-width\s*:\s*44px/);

  const hiveNodeRule = phoneBlock.match(/\.hive-stage\.hive-phone\s+\.hive-node[\s\S]*?\{[^}]+\}/);
  assert.ok(hiveNodeRule, '.hive-node rule in hive-phone stage');
  assert.match(hiveNodeRule[0], /min-height\s*:\s*44px/);

  const viewTabRule = phoneBlock.match(/\.view-tabs\s+\[role="tab"\]\s*\{[^}]+\}/);
  assert.ok(viewTabRule, '.view-tabs [role="tab"] rule');
  assert.match(viewTabRule[0], /min-height\s*:\s*44px/);
  assert.match(viewTabRule[0], /min-width\s*:\s*44px/);

  const btnPillRule = phoneBlock.match(/\.btn-pill\s*,[\s\S]*?\.ticket-search\s+input\s*\{[^}]+\}/);
  assert.ok(btnPillRule, '.btn-pill rule group');
  assert.match(btnPillRule[0], /min-height\s*:\s*44px/);
  assert.match(btnPillRule[0], /min-width\s*:\s*44px/);
});

test('phone block sets min-width: 0 on grid/flex children to allow shrinking', () => {
  assert.ok(phoneBlock);
  assert.match(phoneBlock, /min-width\s*:\s*0/);
  assert.match(
    phoneBlock,
    /\.hive-shell,\s*\n\s*\.shell,\s*\n\s*\.cc-app\s*\{[\s\S]*?min-width\s*:\s*0/,
    'shell containers use min-width: 0',
  );
  assert.match(
    phoneBlock,
    /\.hive-stage\.hive-phone\s+#hive-nodes[\s\S]*?min-width\s*:\s*0/,
    'hive node grid allows min-width: 0',
  );
});

test('hive ring/core visualization is capped at 60% of viewport width in phone layout', () => {
  assert.ok(phoneBlock);
  const coreRule = phoneBlock.match(/\.hive-stage\.hive-phone\s+\.hive-core-ui\s*\{[^}]+\}/);
  assert.ok(coreRule, '.hive-core-ui rule under hive-phone');
  const body = coreRule[0];
  assert.ok(
    /60vw/.test(body) || /max-width\s*:\s*[^;]*60%/.test(body),
    'expected 60vw or max-width 60% on hive core',
  );
  assert.match(body, /width\s*:\s*min\(\s*60vw/);
  assert.match(body, /max-width\s*:\s*min\(\s*60vw/);
});

test('card/node list uses single-column layout at phone breakpoint', () => {
  assert.ok(phoneBlock);

  const hiveNodesRule = phoneBlock.match(
    /\.hive-stage\.hive-phone\s+#hive-nodes[\s\S]*?\.hive-nodes\s*\{[^}]+\}/,
  );
  assert.ok(hiveNodesRule, '#hive-nodes / .hive-nodes grid rule');
  assert.match(
    hiveNodesRule[0],
    /grid-template-columns\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
  );

  const panelsRule = phoneBlock.match(
    /\.hive-panels\s*,\s*\n\s*\.cc-panels\s*,\s*\n\s*\.cc-panels--hive\s*\{[^}]+\}/,
  );
  assert.ok(panelsRule, '.hive-panels / .cc-panels single column');
  assert.match(
    panelsRule[0],
    /grid-template-columns\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
  );
});
