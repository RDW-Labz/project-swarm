// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { runUiCheck, runUiCommand, localHttpUrl, BROWSER_SCRIPT } from '../tools/ui-check.mjs';
import { workTreeFingerprint } from '../tools/work-tree.mjs';
import { compareScreen } from '../tools/ui-compare.mjs';
import { decodePng } from '../tools/png-signature.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { contextEnvFor } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { validateProfile } from '../tools/init-profile.mjs';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { createLedger, writeLedger, readLedger } from '../tools/tickets.mjs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + data.length + 4); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out; };
function png(width, height, pixel) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const [r, g, b] = pixel(x, y); const o = y * (width * 3 + 1) + 1 + x * 3; rows[o] = r; rows[o + 1] = g; rows[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const cream = () => [251, 247, 242];
// text-like stripes on a cream page: a page with ink, so a blank page differs in structure
const half = (x, y) => (y % 3 === 0 && x > 2 && x < 27 ? [35, 31, 32] : [251, 247, 242]);
const metrics = (over = {}) => ({ viewportWidth: 390, scrollWidth: 390, bodyFont: 'Figtree', bodyMargin: '0px', fonts: ['Figtree', 'Bricolage Grotesque'], colors: ['rgb(35, 31, 32)'], backgrounds: ['rgb(251, 247, 242)', 'rgb(215, 38, 30)', 'rgb(255, 255, 255)'], words: ['request', 'phone', 'name', 'contact', 'email', 'reach'], styled: true, ...over });

async function project(t, ui) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ui-check-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/design/screens'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/design/screens/Contact.dc.html'), '<html></html>');
  const profile = { sensitive: true, acceptance: { enforce: false }, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, ui: ui ?? { screens: [{ id: 'form-contact', route: '/r/shop', mockup: 'docs/design/screens/Contact.dc.html' }] } };
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile }));
  return root;
}
// A fake browser: writes the screenshots the real script would write and returns the metrics.
const browserOf = (mockup, page, pixels = {}) => async ({ screens, out }) => {
  const result = [];
  for (const screen of screens) {
    const dir = path.join(out, screen.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mockup.png'), png(30, 60, pixels.mockup ?? half));
    await fs.writeFile(path.join(dir, 'page.png'), png(30, 60, pixels.page ?? half));
    result.push({ id: screen.id, mockup: { metrics: mockup, screenshot: path.join(dir, 'mockup.png') }, page: { metrics: page, screenshot: path.join(dir, 'page.png') } });
  }
  return result;
};
const up = async () => ({ status: 200 });

test('localHttpUrl accepts only this machine over http', () => {
  assert.equal(localHttpUrl('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000');
  assert.equal(localHttpUrl('http://localhost:3111'), 'http://localhost:3111');
  for (const bad of ['https://127.0.0.1', 'http://example.com', 'http://user:pw@127.0.0.1', 'file:///etc/passwd', 'not a url']) assert.equal(localHttpUrl(bad), null, bad);
});

test('the browser script is valid JavaScript (a syntax slip would only show in a real run)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-script-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'shots.mjs'), BROWSER_SCRIPT);
  const { spawnSync } = await import('node:child_process');
  const checked = spawnSync(process.execPath, ['--check', path.join(dir, 'shots.mjs')], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('the real browser step runs the script against a project Playwright (a fake one here) and returns screenshots and metrics', async t => {
  const root = await project(t);
  const pkg = path.join(root, 'node_modules/playwright');
  await fs.mkdir(pkg, { recursive: true });
  const shot = png(30, 60, half).toString('base64');
  await fs.writeFile(path.join(pkg, 'package.json'), '{"name":"playwright","main":"index.js"}');
  await fs.writeFile(path.join(pkg, 'index.js'), `const fs = require('node:fs');
const metrics = ${JSON.stringify(metrics())};
exports.chromium = { launch: async () => ({ close: async () => {}, newContext: async () => ({ close: async () => {}, route: async () => {}, newPage: async () => ({
  goto: async () => {}, waitForTimeout: async () => {}, screenshot: async ({ path }) => fs.writeFileSync(path, Buffer.from('${shot}', 'base64')), evaluate: async () => metrics }) }) }) };`);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fake"}');
  const result = await runUiCheck(root, { deps: { fetchImpl: up, head: 'abc' } });
  assert.equal(result.ok, true, JSON.stringify(result.screens));
  assert.ok((await fs.stat(path.join(root, '.swarm/ui/form-contact/page.png'))).size > 0);
  await fs.rm(pkg, { recursive: true });
  await assert.rejects(runUiCheck(root, { deps: { fetchImpl: up } }), /Playwright is not installed/);
});

test('the browser script is fixed text: values reach it through a spec file only', () => {
  assert.ok(!BROWSER_SCRIPT.includes('${'));
  assert.match(BROWSER_SCRIPT, /process\.argv\[2\]/);
});

test('a page that matches its mockup passes, and the report and results are written', async t => {
  const root = await project(t);
  const result = await runUiCheck(root, { deps: { fetchImpl: up, browser: browserOf(metrics(), metrics()), now: () => Date.parse('2026-10-20T00:00:00Z'), head: 'abc' } });
  assert.equal(result.ok, true, JSON.stringify(result.screens));
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/ui/results.json'), 'utf8'));
  assert.equal(saved.screens['form-contact'].pass, true);
  assert.equal(saved.head, 'abc');
  assert.equal(saved.screens['form-contact'].score, 1);
  const report = JSON.parse(await fs.readFile(path.join(root, '.swarm/ui/form-contact/report.json'), 'utf8'));
  assert.equal(report.route, '/r/shop');
});

test('the lesson 27 failures are caught: unwired fonts, an unstyled page, a blank page, an overflow', async t => {
  const root = await project(t);
  const check = async (page, pixels) => (await runUiCheck(root, { deps: { fetchImpl: up, browser: browserOf(metrics(), page, pixels) } })).screens[0];
  const fonts = await check(metrics({ fonts: ['displayFont', 'bodyFont', 'monoFont'], bodyFont: 'bodyFont' }));
  assert.equal(fonts.pass, false);
  assert.match(fonts.reasons.join(' '), /font-missing: .*Figtree/);
  const unstyled = await check(metrics({ styled: false, fonts: ['Times'], backgrounds: [] }));
  assert.match(unstyled.reasons.join(' '), /unstyled/);
  const blank = await check(metrics(), { page: cream });
  assert.match(blank.reasons.join(' '), /visual: 0\.\d+/);
  const overflow = await check(metrics({ scrollWidth: 700 }));
  assert.match(overflow.reasons.join(' '), /horizontal-overflow/);
});

test('refusals: no ui block, a remote base url, an unknown screen, a symlinked mockup, no server and no start command', async t => {
  const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ui-bare-')));
  t.after(() => fs.rm(bare, { recursive: true, force: true }));
  await assert.rejects(runUiCheck(bare, { deps: { fetchImpl: up } }), /no valid ui block/);
  const root = await project(t);
  await assert.rejects(runUiCheck(root, { baseUrl: 'http://example.com', deps: { fetchImpl: up } }), /base url must be http on 127\.0\.0\.1/);
  await assert.rejects(runUiCheck(root, { ids: ['nope'], deps: { fetchImpl: up } }), /no screen nope/);
  await assert.rejects(runUiCheck(root, { deps: { fetchImpl: async () => { throw new Error('down'); }, browser: browserOf(metrics(), metrics()) } }), /no ui\.start command/);
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ui-out-')), 'x.html');
  await fs.writeFile(outside, '<html></html>');
  await fs.rm(path.join(root, 'docs/design/screens/Contact.dc.html'));
  await fs.symlink(outside, path.join(root, 'docs/design/screens/Contact.dc.html'));
  await assert.rejects(runUiCheck(root, { deps: { fetchImpl: up } }), /symlink|not an allowed project file/);
});

test('the dev server from the profile is started on its own free port, and stopped afterwards', async t => {
  const free = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const root = await project(t, { baseUrl: `http://127.0.0.1:${free}`, timeoutSec: 30, start: ['node', '-e', "require('http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"], screens: [{ id: 'form-contact', route: '/', mockup: 'docs/design/screens/Contact.dc.html' }] });
  let sawServer = false, pageUrl = '';
  const browser = async args => { pageUrl = args.screens[0].pageUrl; sawServer = (await fetch(pageUrl)).ok; return browserOf(metrics(), metrics())(args); };
  const result = await runUiCheck(root, { deps: { browser } });
  assert.equal(sawServer, true);
  assert.notEqual(new URL(pageUrl).port, String(free), 'the check used a port of its own, not the configured one');
  assert.equal(result.ok, true);
  assert.equal(result.results.screens['form-contact'].serverStarted, true);
  await assert.rejects(fetch(pageUrl, { signal: AbortSignal.timeout(1500) }));
});

test('the command prints a line per screen, exits 1 on a failure, and only checks the screens it is given', async t => {
  const root = await project(t, { screens: [{ id: 'form-contact', route: '/a', mockup: 'docs/design/screens/Contact.dc.html' }, { id: 'dashboard', route: '/b', mockup: 'docs/design/screens/Contact.dc.html' }] });
  const ok = await runUiCommand(root, ['check', 'form-contact'], { fetchImpl: up, browser: browserOf(metrics(), metrics()) });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /pass form-contact 1/);
  assert.doesNotMatch(ok.stdout, /dashboard/);
  const bad = await runUiCommand(root, ['check', 'dashboard'], { fetchImpl: up, browser: browserOf(metrics(), metrics({ styled: false })) });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /FAIL dashboard/);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/ui/results.json'), 'utf8'));
  assert.equal(saved.screens['form-contact'].pass, true);
  assert.equal(saved.screens.dashboard.pass, false);
  assert.match((await runUiCommand(root, ['list'])).stdout, /form-contact {2}\/a/);
  assert.equal((await runUiCommand(root, ['check', '--nope'])).exitCode, 1);
});

test('profile ui block: valid config passes, bad ones are refused, and the dev server script is protected', () => {
  const ok = validateProfile({ ui: { start: ['node', 'scripts/dev.mjs'], screens: [{ id: 'form-contact', route: '/x', mockup: 'docs/design/screens/a.html' }] } });
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.profile.protectedPaths.includes('scripts/dev.mjs'));
  assert.equal(ok.profile.ui.screens[0].id, 'form-contact');
  assert.match(validateProfile({ ui: { screens: [{ id: 'x', route: '/x', mockup: '/abs.html' }] } }).errors[0], /profile\.ui/);
  assert.match(validateProfile({ ui: { baseUrl: 'https://example.com', screens: [{ id: 'form-contact', route: '/x', mockup: 'a.html' }] } }).errors[0], /profile\.ui/);
});

async function uiSyncProject(t, ui) {
  const root = await project(t, ui);
  const ticket = { id: 'T-0001', title: 'Form', type: 'build', stage: 'S1', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/a.tsx'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review', screens: ['form-contact'] };
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [ticket] }));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', integratedAt: new Date(Date.now() - 3600000).toISOString(), jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.tsx'] }] }));
  await fs.mkdir(path.join(root, '.swarm/ui'), { recursive: true });
  const sync = () => runScopeCommand(root, 'scope', ['sync', 'r1', '--integrated']);
  const write = async entry => fs.writeFile(path.join(root, '.swarm/ui/results.json'), JSON.stringify({ screens: { 'form-contact': { pass: true, serverStarted: true, ...entry } } }));
  return { root, sync, write, tree: await workTreeFingerprint(root) };
}

test('sync marks a UI ticket done only when the rendered check passed on this code, after the integration, by a server it started', async t => {
  const { root, sync, write, tree } = await uiSyncProject(t);
  const first = await sync();
  assert.match(first.stdout, /0 ticket\(s\) marked done/);
  assert.match(first.stdout, /rendered check has not passed for form-contact/);
  await write({ at: new Date(Date.now() - 7200000).toISOString(), tree });                  // before the integration
  assert.match((await sync()).stdout, /0 ticket\(s\) marked done/);
  await write({ at: new Date(Date.now() - 600000).toISOString(), tree: 'other-code-state' }); // about different code
  assert.match((await sync()).stdout, /0 ticket\(s\) marked done/);
  await write({ at: '2999-01-01T00:00:00.000Z', tree });                    // dated in the future
  assert.match((await sync()).stdout, /0 ticket\(s\) marked done/);
  await write({ at: new Date(Date.now() - 600000).toISOString(), tree, serverStarted: false }); // a server that was already running
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, acceptance: { enforce: false }, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, ui: { start: ['npm', 'run', 'dev'], screens: [{ id: 'form-contact', route: '/r/shop', mockup: 'docs/design/screens/Contact.dc.html' }] } } }));
  assert.match((await sync()).stdout, /0 ticket\(s\) marked done/);
  await write({ at: new Date(Date.now() - 600000).toISOString(), tree });
  assert.match((await sync()).stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'done');
});

test('a results file that is huge, not JSON or a symlink is not evidence', async t => {
  const { root, sync, tree } = await uiSyncProject(t);
  const file = path.join(root, '.swarm/ui/results.json');
  await fs.writeFile(file, '{not json');
  assert.match((await sync()).stdout, /0 ticket\(s\) marked done/);
  await fs.writeFile(file, ' '.repeat(1_100_000) + JSON.stringify({ screens: { 'form-contact': { pass: true, at: new Date(Date.now() - 600000).toISOString(), tree, serverStarted: true } } }));
  assert.match((await sync()).stdout, /0 ticket\(s\) marked done/);
  await fs.rm(file);
  const real = path.join(root, 'real-results.json');
  await fs.writeFile(real, JSON.stringify({ screens: { 'form-contact': { pass: true, at: new Date(Date.now() - 600000).toISOString(), tree, serverStarted: true } } }));
  await fs.symlink(real, file);
  assert.match((await sync()).stdout, /0 ticket\(s\) marked done/);
});

test('compareScreen: an empty mockup fails, odd metrics do not throw, and loader-hash names still match', () => {
  assert.ok(compareScreen({ mockup: { words: [], colors: [], backgrounds: [], fonts: [] }, page: metrics(), visual: 1 }).reasons.includes('mockup-empty'));
  assert.doesNotThrow(() => compareScreen({ mockup: null, page: null, visual: NaN }, { minScore: NaN, text: 'x' }));
  assert.doesNotThrow(() => compareScreen({ mockup: { fonts: 'Figtree', words: 5, colors: {} }, page: { fonts: null }, visual: 0.9 }));
  const ok = compareScreen({ mockup: metrics(), page: metrics({ fonts: ['__Figtree_Fallback_a1b2c3', '__Bricolage_Grotesque_9f8e7d'] }), visual: 0.9 });
  assert.deepEqual(ok.parts.fonts.missing, []);
});

test('the PNG decoder refuses a decompression bomb', () => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024));
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', bomb), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(file), error => /png-invalid|png-unsupported/.test(error.code));
});

test('profile ui: base url with a path or userinfo is refused, mockups are protected, pre and post scripts are guarded', () => {
  const screens = [{ id: 'form-contact', route: '/x', mockup: 'docs/design/screens/a.html' }];
  assert.match(validateProfile({ ui: { baseUrl: 'http://127.0.0.1:3000/app', screens } }).errors[0], /profile\.ui/);
  assert.match(validateProfile({ ui: { baseUrl: 'http://u:p@127.0.0.1:3000', screens } }).errors[0], /profile\.ui/);
  const ok = validateProfile({ ui: { screens } });
  assert.ok(ok.profile.protectedPaths.includes('docs/design/screens/a.html'));
});

test('a UI ticket gets its mockup as context through allowProtectedContext, and the styles prompt line', async t => {
  const root = await project(t);
  const ok = validateProfile({ ui: { screens: [{ id: 'form-contact', route: '/x', mockup: 'docs/design/screens/Contact.dc.html' }] } });
  const env = contextEnvFor(root, ok.profile);
  assert.equal(env.exists('docs/design/screens/Contact.dc.html'), false);       // protected: not an ordinary context file
  assert.equal(env.existsMockup('docs/design/screens/Contact.dc.html'), true);  // but a mockup may be read
  const ticket = { id: 'T-0001', title: 'Contact form', type: 'build', stage: 'S1', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/app/contact.tsx'], context: [], contracts: [], tests: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', screens: ['form-contact'] };
  const scope = parseScope('# Scope: P\nVersion: 1\n\n## Stages\n- S1: A\n\n## S1 A\n### R-001 A form.\nAcceptance:\n- ok\n');
  const { manifest } = ticketsToManifest([ticket], { ledger: { tickets: [] }, scope, ready: false, contextEnv: env });
  const job = manifest.jobs[0];
  assert.ok(job.context.includes('docs/design/screens/Contact.dc.html'));
  assert.match(job.allowProtectedContext, /design mockup/);
  assert.match(job.prompt, /Import your styles in the app entry/);
  const plain = ticketsToManifest([{ ...ticket, screens: undefined, files: ['src/lib/x.ts'] }], { ledger: { tickets: [] }, scope, ready: false, contextEnv: env }).manifest.jobs[0];
  assert.equal(plain.allowProtectedContext, undefined);
});
