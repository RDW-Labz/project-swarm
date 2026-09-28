// Field lessons #193 (run ids, cancelled cost) and #194 (brief-driven license allowlist), plus
// wiring `check-pins` into swarm.mjs's command dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scoutRun } from '../tools/swarm.mjs';
import { parseAllowedLicenses, licenseAllowed, normalizeScoutReport } from '../tools/scout.mjs';

const execFileAsync = promisify(execFile);
const CLI = path.resolve('tools/swarm.mjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-scout125-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function briefFile(root, text) {
  await fs.writeFile(path.join(root, 'brief.txt'), text);
  return 'brief.txt';
}

// Only tests inject a provider. The production Claude adapter spawns the literal claude command.
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const initEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });
// Double-stringified: the inner JSON.stringify is the actual stdout line the fake worker prints;
// the outer one embeds that line as a valid JS string literal inside the generated `-e` script.
const resultEvent = (report, extra = {}) => JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report), total_cost_usd: 0.05, ...extra }));

// --- run id uniqueness (field lesson #193) --------------------------------------------------

test('scout ids carry a random suffix: <prefix>-<ms>-<8 hex>, unlike the old scout-<ms> that two runs could share', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Need a small retry library.');
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${resultEvent({ picks: [], rejected: [], top: [] })});`;
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find a library' }, { spawnImpl: fake(script) });
  assert.match(result.id, /^scout-\d+-[0-9a-f]{8}$/);
});

test('a claim collision on the first id is retried once with a fresh id, and the run still completes', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Need a small retry library.');
  const collidingId = 'scout-collision-fixture';
  await fs.mkdir(path.join(root, '.swarm/runs', collidingId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', collidingId, 'claim'), '');
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${resultEvent({ picks: [], rejected: [], top: [] })});`;
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find a library' }, { spawnImpl: fake(script), id: collidingId });
  assert.notEqual(result.id, collidingId);
  assert.match(result.id, /^scout-\d+-[0-9a-f]{8}$/);
  assert.equal(result.status, 'complete');
  // The report the retried run wrote lives under its own (new) id, not the id that collided.
  const reportJson = JSON.parse(await fs.readFile(path.join(root, result.report), 'utf8'));
  assert.equal(reportJson.id, result.id);
});

// --- cancelled cost reporting (field lesson #193) -------------------------------------------

test('#193: a cancelled scout reports costUsd from the last cost-carrying event seen before it was killed', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Need a small retry library.');
  const controller = new AbortController();
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'progress',total_cost_usd:0.02}));setInterval(()=>{},1000);`;
  const spawnImpl = (...args) => { const child = fake(script)(...args); setTimeout(() => controller.abort(), 80); return child; };
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find a library' }, { spawnImpl, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.costUsd, 0.02);
  assert.equal('costUnknown' in result, false);
});

test('#193: a cancelled scout with no cost ever streamed reports costUsd:null and costUnknown:true', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Need a small retry library.');
  const controller = new AbortController();
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});setInterval(()=>{},1000);`;
  const spawnImpl = (...args) => { const child = fake(script)(...args); setTimeout(() => controller.abort(), 80); return child; };
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find a library' }, { spawnImpl, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.costUsd, null);
  assert.equal(result.costUnknown, true);
});

// --- brief-driven license allowlist (field lesson #194) -------------------------------------

test('parseAllowedLicenses reads a case-insensitive "Allowed licenses: ..." line and splits on commas', () => {
  assert.deepEqual(parseAllowedLicenses('Some brief text.\nallowed licenses: CC0-1.0, CC-BY-4.0 \nMore text.'), ['CC0-1.0', 'CC-BY-4.0']);
  assert.equal(parseAllowedLicenses('No such line here.'), null);
  assert.equal(parseAllowedLicenses('Allowed licenses:    '), null);
  assert.equal(parseAllowedLicenses(42), null);
});

test('licenseAllowed matches an SPDX id against its full name either direction, case-insensitively', () => {
  assert.equal(licenseAllowed('CC0 1.0 Universal', ['CC0-1.0']), true);
  assert.equal(licenseAllowed('CC0-1.0', ['CC0 1.0 Universal']), true);
  assert.equal(licenseAllowed('MIT', ['mit']), true);
  assert.equal(licenseAllowed('GPL-3.0', ['CC0-1.0', 'CC-BY-4.0']), false);
  assert.equal(licenseAllowed('MIT', null), true, 'falls back to the fixed code-license list');
  assert.equal(licenseAllowed('CC0-1.0', null), false, 'CC0 is not in the fixed code-license list');
});

test('normalizeScoutReport keeps a brief-allowed asset license that the fixed code list would have rejected', () => {
  const raw = { picks: [{ name: 'texture-pack', url: 'https://example.com/a/texture-pack', license: 'CC0 1.0 Universal' }] };
  const rejectedByDefault = normalizeScoutReport(raw);
  assert.equal(rejectedByDefault.picks.length, 0);
  const keptWithAllowlist = normalizeScoutReport(raw, { allowlist: ['CC0-1.0', 'CC-BY-4.0'] });
  assert.equal(keptWithAllowlist.picks.length, 1);
  assert.equal(keptWithAllowlist.picks[0].name, 'texture-pack');
});

test('#194: scoutRun reads "Allowed licenses" from the brief and keeps a worker pick the fixed code list alone would reject', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Find CC0 or CC-BY assets for the game.\nAllowed licenses: CC0-1.0, CC-BY-4.0\n');
  const report = { picks: [{ name: 'poly-model', url: 'https://example.com/a/poly-model', license: 'CC0 1.0 Universal' }], rejected: [], top: [] };
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${resultEvent(report)});`;
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find game assets' }, { spawnImpl: fake(script) });
  assert.equal(result.picks, 1);
  assert.equal(result.rejected, 0);
  const reportJson = JSON.parse(await fs.readFile(path.join(root, result.report), 'utf8'));
  assert.equal(reportJson.picks[0].name, 'poly-model');
});

test('#194: a brief naming no allowlist still falls back to the fixed code-license list', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Need a small retry library, no license constraints named.');
  const report = { picks: [{ name: 'cc0-lib', url: 'https://example.com/a/cc0-lib', license: 'CC0 1.0 Universal' }], rejected: [], top: [] };
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(${resultEvent(report)});`;
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find a library' }, { spawnImpl: fake(script) });
  assert.equal(result.picks, 0);
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.moved, ['cc0-lib']);
});

// --- check-pins wired into swarm.mjs's command dispatch -------------------------------------

test('CLI check-pins parses its own flags before touching the (parallel-job-owned, lazily-imported) check-pins module', async t => {
  const root = await fixture(t);
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, '--root', root, 'check-pins', '--bogus']),
    /Invalid arguments/,
  );
});

test('CLI check-pins --json on a repo with no manifests exits 0 with ok:true', async t => {
  const root = await fixture(t);
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'check-pins', '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test('check-pins is listed in --help usage', async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--help']);
  assert.match(stdout, /check-pins \[--root DIR\] \[--json\]/);
});
