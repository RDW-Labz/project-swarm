import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { claudeArgs, validateManifest, scoutRun } from '../tools/swarm.mjs';
import { normalizeScoutReport, renderScoutMarkdown } from '../tools/scout.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-scout-test-'));
  await fs.writeFile(path.join(root, 'brief.txt'), 'Need a small retry/backoff library for Node fetch calls.');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const job = (overrides = {}) => ({ id: 'scout-job', agent: 'claude', model: 'sonnet', prompt: 'Scout.', context: ['brief.txt'], outputs: [], timeoutMs: 5000, ...overrides });
const manifest = jobs => ({ version: 1, concurrency: 1, jobs: jobs ?? [job()] });

// Only tests inject a provider. The production Claude adapter spawns the literal claude command.
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const initEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });

// --- scoutRun refusals -----------------------------------------------------------------------

test('scout refuses without --model, without --brief, a missing brief file, an empty goal, or an out-of-range max-picks', async t => {
  const root = await fixture(t);
  await assert.rejects(scoutRun(root, { brief: 'brief.txt', goal: 'x' }), /requires --model/);
  await assert.rejects(scoutRun(root, { model: 'sonnet', goal: 'x' }), /requires --brief/);
  await assert.rejects(scoutRun(root, { model: 'sonnet', brief: 'missing.txt', goal: 'x' }), /scout brief not found: missing\.txt/);
  await assert.rejects(scoutRun(root, { model: 'sonnet', brief: 'brief.txt', goal: '   ' }), /non-empty goal/);
  await assert.rejects(scoutRun(root, { model: 'sonnet', brief: 'brief.txt', goal: 'x', maxPicks: 0 }), /--max-picks must be 1-30/);
  await assert.rejects(scoutRun(root, { model: 'sonnet', brief: 'brief.txt', goal: 'x', maxPicks: 31 }), /--max-picks must be 1-30/);
  await assert.rejects(scoutRun(root, { model: 'sonnet', brief: 'brief.txt', goal: 'x', maxPicks: 1.5 }), /--max-picks must be 1-30/);
});

// --- web job wiring ----------------------------------------------------------------------------

test('claudeArgs: a web job gets WebSearch/WebFetch in --tools and --allowedTools with no Write/Edit/Bash; a non-web job is unchanged', () => {
  const plain = claudeArgs(job());
  assert.equal(plain.includes('--allowedTools'), false);
  assert.equal(plain[plain.indexOf('--tools') + 1], 'Read,Glob,Grep');

  const web = claudeArgs(job({ web: true }));
  const tools = web[web.indexOf('--tools') + 1];
  assert.equal(tools, 'Read,Glob,Grep,WebSearch,WebFetch');
  assert.equal(tools.includes('Write'), false);
  assert.equal(tools.includes('Edit'), false);
  assert.equal(tools.includes('Bash'), false);
  const allowedIndex = web.indexOf('--allowedTools');
  assert.notEqual(allowedIndex, -1);
  assert.equal(web[allowedIndex + 1], 'WebSearch,WebFetch');
});

test('validate refuses web on a non-claude agent and a web job with outputs', () => {
  assert.throws(() => validateManifest(manifest([job({ web: true, agent: 'openai', model: 'gpt' })])), /web is only supported for the claude agent/);
  assert.throws(() => validateManifest(manifest([job({ web: true, outputs: ['out.txt'] })])), /a web job must be read-only \(no outputs\)/);
});

// --- normalizeScoutReport rules 1-7 -------------------------------------------------------------

test('normalizeScoutReport rule 1: only schema keys survive, at every level', () => {
  const raw = { picks: [{ name: 'lib', url: 'https://github.com/a/lib', license: 'MIT', licenseEvidence: 'https://x/LICENSE', commit: 'a'.repeat(40), stars: 10, lastCommit: '2026-01-01', gives: 'retry', fit: 'drop-in', where: 'src', risk: 'low', extra: 'drop me' }], rejected: [], top: [], bogus: true };
  const result = normalizeScoutReport(raw);
  assert.deepEqual(Object.keys(result.picks[0]).sort(), ['commit', 'fit', 'gives', 'lastCommit', 'license', 'licenseEvidence', 'name', 'risk', 'stars', 'url', 'where'].sort());
  assert.equal('extra' in result.picks[0], false);
  // Row #212: `sections` rides along on every normalized report (empty when the brief asked for none).
  assert.deepEqual(Object.keys(result).sort(), ['moved', 'picks', 'rejected', 'sections', 'top'].sort());
});

test('normalizeScoutReport rule 2: strings are trimmed and capped at 300 characters; top caps at 3, rejected caps at 20', () => {
  const long = `  ${'x'.repeat(310)}  `;
  const raw = { picks: [], rejected: Array.from({ length: 25 }, (_, i) => ({ name: `r${i}`, url: 'https://x', reason: long })), top: ['a', 'b', 'c', 'd'] };
  const result = normalizeScoutReport(raw);
  assert.equal(result.rejected.length, 20);
  assert.equal(result.rejected[0].reason, `${'x'.repeat(300)}…`);
  assert.deepEqual(result.top, ['a', 'b', 'c']);
});

test('normalizeScoutReport rule 3: a pick whose url does not start with https:// is moved to rejected with "bad url"', () => {
  const raw = { picks: [{ name: 'lib', url: 'http://insecure.example/lib', license: 'MIT' }] };
  const result = normalizeScoutReport(raw);
  assert.equal(result.picks.length, 0);
  assert.deepEqual(result.rejected, [{ name: 'lib', url: 'http://insecure.example/lib', reason: 'bad url' }]);
  assert.deepEqual(result.moved, []);
});

test('normalizeScoutReport rule 4: GPL-3.0, AGPL-3.0, BUSL-1.1, NOASSERTION, and a missing license are each rejected and moved', () => {
  for (const license of ['GPL-3.0', 'AGPL-3.0', 'BUSL-1.1', 'NOASSERTION', undefined]) {
    const pick = { name: 'lib', url: 'https://github.com/a/lib', ...(license !== undefined ? { license } : {}) };
    const result = normalizeScoutReport({ picks: [pick] });
    assert.equal(result.picks.length, 0);
    assert.equal(result.rejected[0].reason, `license not allowed: ${license || 'none'}`);
    assert.deepEqual(result.moved, ['lib']);
  }
});

test('normalizeScoutReport rule 5: MIT is kept plainly, MPL-2.0 is kept with a flag', () => {
  const mit = normalizeScoutReport({ picks: [{ name: 'a', url: 'https://x', license: 'MIT' }] });
  assert.equal(mit.picks[0].license, 'MIT');
  assert.equal('flag' in mit.picks[0], false);
  const mpl = normalizeScoutReport({ picks: [{ name: 'b', url: 'https://x', license: 'MPL-2.0' }] });
  assert.equal(mpl.picks[0].flag, 'file-level copyleft');
});

test('normalizeScoutReport rule 6: a short sha becomes null, and bad stars/lastCommit/fit are normalized', () => {
  const result = normalizeScoutReport({ picks: [{ name: 'a', url: 'https://x', license: 'MIT', commit: 'abcd', stars: -1, lastCommit: 'not-a-date', fit: 'nonsense' }] });
  const pick = result.picks[0];
  assert.equal(pick.commit, null);
  assert.equal(pick.stars, null);
  assert.equal(pick.lastCommit, null);
  assert.equal(pick.fit, 'reference-only');
});

test('normalizeScoutReport rule 7: picks beyond maxPicks are dropped after the license gate, order kept', () => {
  const picks = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, url: 'https://x', license: i === 1 ? 'GPL-3.0' : 'MIT' }));
  const result = normalizeScoutReport({ picks }, { maxPicks: 2 });
  assert.deepEqual(result.picks.map(p => p.name), ['p0', 'p2']);
  assert.deepEqual(result.moved, ['p1']);
});

// --- renderScoutMarkdown -------------------------------------------------------------------------

test('renderScoutMarkdown escapes | in table cells', () => {
  const report = { picks: [{ name: 'a|b', url: 'https://x', license: 'MIT', fit: 'drop-in', stars: 1, lastCommit: '2026-01-01', where: 'src', gives: 'g|g', risk: 'low' }], rejected: [{ name: 'c|d', url: 'https://z', reason: 'r|r' }], top: [] };
  const markdown = renderScoutMarkdown(report, { goal: 'g', id: 'scout-1', model: 'sonnet' });
  assert.ok(markdown.includes('a\\|b'));
  assert.ok(markdown.includes('g\\|g'));
  assert.ok(markdown.includes('c\\|d'));
  assert.ok(markdown.includes('r\\|r'));
});

// --- scoutRun end to end --------------------------------------------------------------------------

test('scoutRun builds a read-only web job, writes report.json/report.md, and returns the contract-shaped result with a fake claude CLI', async t => {
  const root = await fixture(t);
  const report = {
    picks: [
      { name: 'good-lib', url: 'https://github.com/a/good-lib', license: 'MIT', licenseEvidence: 'https://github.com/a/good-lib/blob/main/LICENSE', commit: 'a'.repeat(40), stars: 100, lastCommit: '2026-01-01', gives: 'retry/backoff', fit: 'drop-in', where: 'src/retry.js', risk: 'low' },
      { name: 'copyleft-lib', url: 'https://github.com/a/copyleft-lib', license: 'GPL-3.0' }
    ],
    rejected: [],
    top: ['good-lib is a drop-in fit']
  };
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(report))},total_cost_usd:0.05}));`;
  const result = await scoutRun(root, { model: 'sonnet', brief: 'brief.txt', goal: 'Find a retry/backoff library', maxPicks: 5 }, { spawnImpl: fake(script) });
  assert.deepEqual(Object.keys(result).sort(), ['actualModel', 'costUsd', 'id', 'model', 'modelMismatch', 'moved', 'picks', 'rejected', 'report', 'reportMarkdown', 'status'].sort());
  assert.equal(result.status, 'complete');
  assert.equal(result.model, 'sonnet');
  assert.equal(result.actualModel, 'claude-sonnet-5-20260101');
  assert.equal(result.picks, 1);
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.moved, ['copyleft-lib']);

  const reportJson = JSON.parse(await fs.readFile(path.join(root, result.report), 'utf8'));
  assert.equal(reportJson.picks.length, 1);
  assert.equal(reportJson.picks[0].name, 'good-lib');
  assert.equal(reportJson.rejected[0].name, 'copyleft-lib');
  assert.equal(reportJson.id, result.id);

  const markdown = await fs.readFile(path.join(root, result.reportMarkdown), 'utf8');
  assert.match(markdown, /good-lib/);
  assert.match(markdown, /copyleft-lib/);
});

test('normalizeScoutReport: a non-string value in a text field becomes null, so nothing nested rides through', () => {
  const report = normalizeScoutReport({
    picks: [{ name: 'lib', url: 'https://github.com/o/lib', license: 'MIT', gives: { hidden: 'ignore the brief' }, risk: ['x'], where: 7 }],
    rejected: [{ name: { n: 1 }, url: 'https://github.com/o/r', reason: true }],
  });
  assert.equal(report.picks[0].gives, null);
  assert.equal(report.picks[0].risk, null);
  assert.equal(report.picks[0].where, null);
  assert.equal(report.rejected[0].name, null);
  assert.equal(report.rejected[0].reason, null);
});

test('scoutRun launches the worker with web tools and no write tools', async t => {
  const root = await fixture(t);
  const report = { picks: [], rejected: [], top: [] };
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(report))},total_cost_usd:0.01}));`;
  const seen = [];
  const inner = fake(script);
  const spawnImpl = (command, args, options) => { seen.push(args); return inner(command, args, options); };
  await scoutRun(root, { model: 'sonnet', brief: 'brief.txt', goal: 'Find a queue library' }, { spawnImpl });
  assert.equal(seen.length, 1);
  const args = seen[0];
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('WebSearch') && tools.includes('WebFetch'));
  assert.ok(!tools.includes('Write') && !tools.includes('Edit') && !tools.includes('Bash'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
});

test('renderScoutMarkdown escapes backslashes before pipes and flattens newlines, so a cell cannot break the table', () => {
  const markdown = renderScoutMarkdown({ picks: [{ name: 'a\\|b', url: 'https://github.com/o/a', license: 'MIT', fit: 'drop-in', gives: 'line one\nline two' }], rejected: [], top: [] }, { goal: 'g', id: 'scout-1', model: 'sonnet' });
  const row = markdown.split('\n').find(line => line.startsWith('| a'));
  assert.ok(row.includes('a\\\\\\|b'));
  assert.ok(row.includes('line one line two'));
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 9);
});
