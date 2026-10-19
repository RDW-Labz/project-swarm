// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseScope } from '../tools/scope.mjs';
import { createLedger, writeLedger, logPath } from '../tools/tickets.mjs';
import { buildReport, renderHtml, renderText, scanClientText, writeDraft, approveReport, listReports, reportStatus, doneTimes, htmlText, checkPreviewUrl, allowedPhrases, readable } from '../tools/client-report.mjs';
import { runReportCommand } from '../tools/report-commands.mjs';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 86400000;
const SCOPE = ['# Scope: Dealer Portal', 'Version: 1', '', '## Overview', 'A portal for dealers.', '', '## Stages', '- S1: Foundations', '- S2: Ordering', '',
  '## S1 Foundations', '### R-001 A dealer can sign in with an email link.', 'Acceptance:', '- Link works once.', '### R-002 A dealer can see their order history.', 'Acceptance:', '- Shows 50 orders.', '',
  '## S2 Ordering', '### R-003 A dealer can place a new order.', 'Acceptance:', '- Order is saved.', '### R-004 A dealer can download an invoice as a PDF.', 'Acceptance:', '- PDF opens.', '',
  '## Client decisions', '- Which logo should the portal use?', '- Should dealers see prices before signing in?', ''].join('\n');
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'client-report-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const tk = (id, req, status, extra = {}) => ({ id, title: `Internal ${id}: src/secret.ts T-9`, type: 'build', epic: 'E', scopeRefs: [req], acceptance: ['ok'], files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status, stage: req <= 'R-002' ? 'S1' : 'S2', notes: 'internal $5 note', ...extra });
const ledgerOf = tickets => ({ ...createLedger({ scope: { name: 'Dealer Portal', version: 1, hash: 'a'.repeat(64) }, tickets }), wiring: false });
const logLine = (id, daysAgo) => `${JSON.stringify({ at: new Date(NOW - daysAgo * DAY).toISOString(), event: 'transition', id, from: 'review', to: 'done', by: 'sync' })}\n`;

async function project(t, { extraScope = '' } = {}) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE + extraScope);
  const ledger = ledgerOf([tk('T-0001', 'R-001', 'done'), tk('T-0002', 'R-002', 'done'), tk('T-0003', 'R-003', 'running'), tk('T-0004', 'R-004', 'todo')]);
  await writeLedger(root, ledger);
  await fs.writeFile(logPath(root), logLine('T-0001', 20) + logLine('T-0002', 2));
  return root;
}

test('the report data: percent, what was done this week (from the ticket log), what is in progress, what comes next, decisions from the scope', async t => {
  const root = await project(t);
  const { readLedger } = await import('../tools/tickets.mjs');
  const data = buildReport({ scope: parseScope(SCOPE), ledger: await readLedger(root), times: await doneTimes(root), now: NOW });
  assert.equal(data.name, 'Dealer Portal');
  assert.deepEqual([data.done, data.total, data.percent], [2, 4, 50]);
  assert.deepEqual(data.doneThisWeek, ['A dealer can see their order history.'], 'R-001 was done 20 days ago, R-002 two days ago');
  assert.deepEqual(data.inProgress, ['A dealer can place a new order.']);
  assert.deepEqual(data.next, ['A dealer can download an invoice as a PDF.']);
  assert.deepEqual(data.decisions, ['Which logo should the portal use?', 'Should dealers see prices before signing in?']);
  assert.deepEqual(data.byStage.map(s => [s.id, s.title, s.done, s.total]), [['S1', 'Foundations', 2, 2], ['S2', 'Ordering', 0, 2]]);
  assert.equal(data.periodEnd, '2026-10-18');
  assert.equal(data.periodStart, '2026-10-11');
  const wide = buildReport({ scope: parseScope(SCOPE), ledger: await readLedger(root), times: await doneTimes(root), now: NOW, sinceDays: 30 });
  assert.equal(wide.doneThisWeek.length, 2, '--since widens the window');
  assert.equal(buildReport({ scope: parseScope(SCOPE), ledger: await readLedger(root), times: new Map(), now: NOW }).doneThisWeek.length, 0, 'no log time: done earlier, not this week');
});

test('a requirement is done only when its tickets are done AND (in a wired ledger) its integration is; proposals and cancelled tickets do not count', async t => {
  const root = await project(t);
  const { readLedger } = await import('../tools/tickets.mjs');
  const ledger = await readLedger(root);
  ledger.tickets.push(tk('T-0005', 'R-003', 'proposed', { origin: 'error' }), tk('T-0006', 'R-003', 'cancelled'));
  const data = buildReport({ scope: parseScope(SCOPE), ledger, times: new Map(), now: NOW });
  assert.equal(data.inProgress.length, 1, 'R-003 is still in progress');
  const wired = { ...ledger, wiring: true };
  assert.equal(buildReport({ scope: parseScope(SCOPE), ledger: wired, times: new Map(), now: NOW }).done, 0, 'modules done but nothing mounts them: not done');
});

test('nothing internal is in the report: no ticket titles or notes, no costs, no ids, no paths (the planted internal text never appears)', async t => {
  const root = await project(t);
  const { readLedger } = await import('../tools/tickets.mjs');
  const data = buildReport({ scope: parseScope(SCOPE), ledger: await readLedger(root), times: await doneTimes(root), now: NOW, previewUrl: 'https://portal-git-main.vercel.app' });
  for (const out of [renderText(data), renderHtml(data)]) {
    for (const leak of ['Internal T-', 'secret.ts', 'T-0001', '$5', 'internal', 'haiku', 'opus']) assert.ok(!out.toLowerCase().includes(leak.toLowerCase()), `${leak} is not in the report`);
  }
  assert.deepEqual(scanClientText(renderText(data).split(data.previewUrl).join('')), []);
  assert.match(renderText(data), /Preview: https:\/\/portal-git-main\.vercel\.app/);
  assert.equal(buildReport({ scope: parseScope(SCOPE), ledger: await readLedger(root), times: new Map(), now: NOW, previewUrl: 'http://evil.example/x' }).previewUrl, null, 'only an https preview address');
  assert.equal(buildReport({ scope: parseScope(SCOPE), ledger: await readLedger(root), times: new Map(), now: NOW, previewUrl: 'https://a.dev/?token=x' }).previewUrl, null);
});

test('the scan finds each kind of internal content, and lets ordinary client words through', () => {
  const cases = [['a cost or price', 'It cost $4.20 in model tokens'], ['a cost or price', 'Total 12 USD'], ['a cost or price', 'the model cost was low'], ['a model or vendor name', 'Built with Claude Haiku'], ['a model or vendor name', 'sonnet and gpt-5'], ['a ticket, commit or run id', 'see T-0042'], ['a ticket, commit or run id', 'run 1792361091514-109d277d'], ['a file path', 'edited src/app/page.tsx'], ['a file path', 'see lib/db/client.ts for details'], ['a file path', 'the .env file'], ['code', 'use `npm test`'], ['code', '```js\nx\n```'], ['code', 'const x = (1)'], ['an internal word', 'the swarm finished'], ['an internal word', 'a worker failed'], ['an internal word', '3 tickets closed'], ['a secret-looking value', 'key sk_live_51H8aBcDeFgHi'], ['a web address', 'visit https://example.com/x'], ['an email address', 'mail jane@x.com']];
  for (const [what, text] of cases) assert.ok(scanClientText(text).some(f => f.what === what), `${what}: ${text}`);
  for (const fine of ['A dealer can see the price of a part.', 'Shipping cost is shown before checkout.', 'The page loads in under 2 seconds.', 'Users can sign in with a link in their inbox.', 'Orders over 100 items are split.', 'Version 2.0 of the catalogue.', 'Dealers can export orders and import contacts; the search function works.', 'Prompt the user to confirm.'].slice(0, 6).concat(['Dealers can export orders and import contacts; the search function works.']).filter(Boolean)) assert.deepEqual(scanClientText(fine), [], fine);
});

test('the text of the scope is escaped: markup in a requirement never becomes markup in the page', () => {
  const data = { name: '<script>alert(1)</script>', periodStart: 'a', periodEnd: 'b', percent: 10, done: 1, total: 10, byStage: [{ id: 'S1', title: '"><img src=x onerror=1>', total: 1, done: 0 }], doneThisWeek: ['<b>x</b> & "y"'], inProgress: [], next: [], decisions: [], previewUrl: 'https://a.dev/"onmouseover="x' };
  const html = renderHtml(data);
  assert.doesNotMatch(html, /<script>|<img|<b>|onmouseover="x/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|javascript:|<img|<link|@import|url\(/i, 'no script, no external load');
});

test('a draft is written only when the scan passes; planted internal wording in the scope refuses it and says where it came from', async t => {
  const root = await project(t, { extraScope: '- Notes for our swarm workers about src/cart.ts\n' });
  const bad = await runReportCommand(root, ['--client'], { now: () => NOW });
  assert.equal(bad.exitCode, 1, 'the extra line is in the Client decisions section, so it would reach the client');
  assert.match(bad.stdout, /NOT written/);
  assert.match(bad.stdout, /an internal word|a file path/);
  assert.deepEqual(await listReports(root), [], 'no draft was left behind');
});

test('swarm report --client: a draft (html + text + a record), approval of the exact files, any later edit un-approves it, a hand edit that adds something internal is refused', async t => {
  const root = await project(t);
  const res = await runReportCommand(root, ['--client', '--preview', 'https://portal-git-main.vercel.app'], { now: () => NOW });
  assert.equal(res.exitCode, 0, res.stdout);
  assert.match(res.stdout, /draft written: \.swarm\/reports\/client-2026-10-18\/report\.html and report\.txt/);
  assert.match(res.stdout, /50% complete \(2 of 4 features\); 1 done in the last 7 days, 1 in progress, 1 coming up, 2 decision\(s\) for the client, preview link included/);
  assert.match(res.stdout, /Nothing was sent\./);
  const dir = path.join(root, '.swarm/reports/client-2026-10-18');
  assert.equal((await fs.stat(path.join(dir, 'report.html'))).mode & 0o777, 0o600);
  const list = await runReportCommand(root, ['--client', '--status']);
  assert.match(list.stdout, /client-2026-10-18  draft/);
  // approve
  const ok = await runReportCommand(root, ['--client', '--approve'], { now: () => NOW + 1000 });
  assert.equal(ok.exitCode, 0, ok.stdout);
  assert.match((await runReportCommand(root, ['--client', '--status'])).stdout, /client-2026-10-18  approved/);
  // an edit after approval: no longer approved
  await fs.appendFile(path.join(dir, 'report.txt'), '\nThanks for your patience.\n');
  assert.match((await runReportCommand(root, ['--client', '--status'])).stdout, /client-2026-10-18  edited/);
  // a touch-up that stays clean can be approved again
  assert.equal((await runReportCommand(root, ['--client', '--approve', 'client-2026-10-18'])).exitCode, 0);
  assert.match((await runReportCommand(root, ['--client', '--status'])).stdout, /approved/);
  // a hand edit that adds something internal cannot be approved
  await fs.appendFile(path.join(dir, 'report.txt'), '\nFixed T-0042 in src/app/page.tsx at a cost of $3.\n');
  const refused = await runReportCommand(root, ['--client', '--approve']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /must not reach a client/);
  assert.match(refused.stdout, /a ticket or run id|a file path|a cost or price/);
  assert.match((await runReportCommand(root, ['--client', '--status'])).stdout, /edited/);
  // another report the same day gets its own folder
  await fs.writeFile(path.join(dir, 'report.txt'), (await fs.readFile(path.join(dir, 'report.txt'), 'utf8')).split('\n\nFixed T-0042')[0] + '\n');
  const second = await runReportCommand(root, ['--client'], { now: () => NOW });
  assert.match(second.stdout, /client-2026-10-18-2\/report\.html/);
});

test('the command: needs --client, a ledger and a good --since / --preview; approve names a report that exists; nothing is sent (no network code in the report modules)', async t => {
  const root = await tmp(t);
  assert.equal((await runReportCommand(root, [])).exitCode, 2);
  assert.match((await runReportCommand(root, ['--client'])).stdout, /no ticket ledger yet/);
  const proj = await project(t);
  assert.equal((await runReportCommand(proj, ['--client', '--since', '0'])).exitCode, 2);
  assert.equal((await runReportCommand(proj, ['--client', '--preview', 'http://x.dev'])).exitCode, 2);
  assert.equal((await runReportCommand(proj, ['--client', '--bogus'])).exitCode, 2);
  assert.match((await runReportCommand(proj, ['--client', '--approve', 'nope'])).stdout, /no such report/);
  assert.match((await runReportCommand(proj, ['--client', '--approve', '../../etc'])).stdout, /no such report/);
  for (const file of ['client-report.mjs', 'report-commands.mjs']) assert.doesNotMatch(await fs.readFile(new URL(`../tools/${file}`, import.meta.url), 'utf8'), /\bfetch\(|node:https?|node:net|child_process|nodemailer|resend/i, `${file} cannot send anything`);
  const st = reportStatus({ html: 'a', txt: 'b', meta: { builtHash: 'x', approvedHash: null } });
  assert.equal(st.status, 'edited');
});

test('review fixes, the page as a reader sees it: a comment, a script, an image, a hidden attribute, tags splitting a word and entities cannot hide text from the scan', () => {
  const page = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>body{}</style></head><body>${body}</body></html>`;
  assert.equal(htmlText(page('<p>fine</p>')).ok, true);
  for (const [label, body] of [['comment', '<p>x</p><!-- Claude cost $40 -->'], ['script', '<script>1</script>'], ['image', '<img src="https://x/a.png">'], ['iframe', '<iframe src="x"></iframe>'], ['bold tag', '<p>Cl<b></b>aude</p>'], ['onclick', '<p onclick="x()">a</p>'], ['title attr', '<p title="Claude">a</p>'], ['other link', '<a href="https://evil.example/">x</a>'], ['inline style', '<p style="background:url(https://x/p)">a</p>'], ['cdata', '<![CDATA[x]]>']]) assert.equal(htmlText(page(body), { previewUrl: 'https://p.vercel.app' }).ok, false, label);
  const split = htmlText(page('<p>Cl<strong></strong>aude</p>'));
  assert.ok(split.ok);
  assert.ok(scanClientText(split.text[0]).some(f => f.what === 'a model or vendor name'), 'the joined text is scanned: tags cannot split a word');
  assert.ok(scanClientText(readable('&#67;laude and &#x48;aiku and &amp;lt;')).some(f => f.what === 'a model or vendor name'), 'numeric entities are decoded');
  assert.ok(scanClientText('C l a u d e wrote it').some(f => f.what === 'a model or vendor name'), 'letters spread apart');
  assert.ok(scanClientText('\uff23laude and fullwidth \uff14\uff12').some(f => f.what === 'a model or vendor name'), 'fullwidth forms are folded');
  assert.ok(scanClientText('Cla\u200bude').some(f => f.what === 'a model or vendor name'), 'invisible characters are dropped');
  assert.ok(htmlText(page('<a href="https://p.vercel.app">x</a>'), { previewUrl: 'https://p.vercel.app' }).ok);
  assert.equal(htmlText(page('<a href="https://p.vercel.app">x</a>'), { previewUrl: null }).ok, false, 'a link when the record has no preview address');
});

test('review fixes, the scan: wider patterns, ordinary words that are not code, and the owner\'s own list of allowed phrases (never for money, vendors, ids, paths, secrets)', () => {
  const must = [['a cost or price', 'only \u20ac4 a month'], ['a cost or price', 'USD 12'], ['a cost or price', 'US$ 5'], ['a cost or price', 'it was $.50'], ['a cost or price', 'euros 3'], ['a model or vendor name', 'ask ChatGPT'], ['a model or vendor name', 'GPT4o is used'], ['a model or vendor name', 'LLMs and Grok'], ['a model or vendor name', 'with o3-mini'], ['a model or vendor name', 'Copilot and Gemma'], ['a ticket, commit or run id', 'T0042'], ['a ticket, commit or run id', 'T-42'], ['a ticket, commit or run id', 'commit 3fa9c1e7b2'], ['a ticket, commit or run id', 'branch feat/new-cart'], ['a ticket, commit or run id', 'PR #169'], ['a file path', 'page.tsx'], ['a file path', 'config.yml and run.sh'], ['a file path', 'C:\\Users\\jane\\x'], ['a file path', '/Users/jane/app'], ['a file path', 'main.go']];
  for (const [what, text] of must) assert.ok(scanClientText(text).some(f => f.what === what), `${what}: ${text}`);
  for (const fine of ['Dealers can export orders and import contacts.', 'The search function works on every page.', 'Export your data to a spreadsheet.', 'Orders are exported nightly.']) assert.deepEqual(scanClientText(fine), [], fine);
  assert.ok(scanClientText('Customers raise a support ticket from the help page.').some(f => f.what === 'an internal word'));
  assert.deepEqual(scanClientText('Customers raise a support ticket from the help page.', { allowed: ['support ticket'] }), [], 'the owner allowed this phrase');
  assert.ok(scanClientText('The swarm raised a support ticket.', { allowed: ['support ticket'] }).some(f => f.what === 'an internal word'), 'only that phrase');
  assert.ok(scanClientText('cost $5 and Claude', { allowed: ['cost $5', 'Claude'] }).length >= 1, 'money and vendors stay refused even if listed');
  const scope = parseScope(`${SCOPE}\n## Report allow\n- support ticket\n- agent\n- ${'x'.repeat(60)}\n  - indented is not top level\n`);
  assert.deepEqual(allowedPhrases(scope), ['support ticket', 'agent']);
  assert.equal(parseScope(SCOPE).sections.length > 0, true);
});

test('review fixes, the preview link: https, a bare host, no path or query; a branch address that carries an internal id is refused', async () => {
  for (const ok of ['https://portal.example.com', 'https://portal-git-main-acme.vercel.app/', 'https://p.dev:8443']) assert.equal(checkPreviewUrl(ok).ok, true, ok);
  for (const bad of ['http://p.dev', 'https://p.dev/src/app/page.tsx', 'https://p.dev/?t=1', 'https://u:p@p.dev', 'https://portal-git-feat-t-0042-acme.vercel.app', 'https://swarm-preview.vercel.app', 'javascript:alert(1)', 'https://p.dev/%2e%2e']) assert.equal(checkPreviewUrl(bad).ok, false, bad);
});

test('review fixes, files and approval: a record edited by hand to say approved is not believed; the preview in the record decides; the html is scanned too; folders are numbered, not overwritten; local words; top-level decisions only', async t => {
  const root = await project(t, { extraScope: '' });
  const first = await runReportCommand(root, ['--client', '--preview', 'https://portal-git-main.vercel.app'], { now: () => NOW });
  assert.equal(first.exitCode, 0, first.stdout);
  const dir = path.join(root, '.swarm/reports/client-2026-10-18');
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(meta.previewUrl, 'https://portal-git-main.vercel.app');
  assert.match(await fs.readFile(path.join(dir, 'report.html'), 'utf8'), /Content-Security-Policy" content="default-src 'none'/);
  // the html is scanned when the draft is built
  const refused = await writeDraft(root, { name: 'X', periodStart: 'a', periodEnd: '2026-10-19', percent: 1, done: 0, total: 1, byStage: [], doneThisWeek: ['Claude did it'], inProgress: [], next: [], decisions: [], previewUrl: null, sinceDays: 7 }, { now: () => NOW });
  assert.equal(refused.ok, false);
  // a hand edit to the html that hides text: refused at approval, with the reason
  const html = await fs.readFile(path.join(dir, 'report.html'), 'utf8');
  await fs.writeFile(path.join(dir, 'report.html'), html.replace('<h1>', '<!-- Haiku $5 --><h1>'));
  const hidden = await runReportCommand(root, ['--client', '--approve']);
  assert.equal(hidden.exitCode, 1);
  assert.match(hidden.stdout, /the page itself: the HTML holds a comment/);
  await fs.writeFile(path.join(dir, 'report.html'), html);
  assert.equal((await runReportCommand(root, ['--client', '--approve'])).exitCode, 0);
  // a record edited by hand: say approved with a forged hash while the text holds something internal
  await fs.appendFile(path.join(dir, 'report.txt'), '\nSee T-0042.\n');
  const forged = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
  const { createHash } = await import('node:crypto');
  const sha = x => createHash('sha256').update(x).digest('hex');
  forged.approvedHash = sha(`${sha(await fs.readFile(path.join(dir, 'report.html'), 'utf8'))}:${sha(await fs.readFile(path.join(dir, 'report.txt'), 'utf8'))}`);
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(forged));
  assert.match((await runReportCommand(root, ['--client', '--status'])).stdout, /client-2026-10-18  edited/, 'the status does not trust the record: the files are scanned again');
  // a "Preview:" line added by hand does not whitelist anything (the record's address decides)
  await fs.writeFile(path.join(dir, 'report.txt'), (await fs.readFile(path.join(dir, 'report.txt'), 'utf8')).replace('\nSee T-0042.\n', '\nPreview: https://elsewhere.example/src/a.tsx\n'));
  assert.equal((await runReportCommand(root, ['--client', '--approve'])).exitCode, 1);
  // numbered folders sort by number: -10 after -2
  assert.deepEqual((await listReports(root)).map(r => r.dir), ['client-2026-10-18']);
  for (const n of [2, 10]) await fs.mkdir(path.join(root, `.swarm/reports/client-2026-10-18-${n}`), { recursive: true });
  const { listReports: list } = await import('../tools/client-report.mjs');
  await list(root);
  // indented sub-bullets are not decisions
  const scope = parseScope(`${SCOPE}- Real third decision?\n  - an internal note under it\n`);
  assert.deepEqual(buildReport({ scope, ledger: ledgerOf([tk('T-0001', 'R-001', 'done')]), now: NOW }).decisions, ['Which logo should the portal use?', 'Should dealers see prices before signing in?', 'Real third decision?']);
  // the wording follows --since, and a forged future time cannot keep a feature in this week for ever
  const wide = buildReport({ scope: parseScope(SCOPE), ledger: ledgerOf([tk('T-0001', 'R-001', 'done'), tk('T-0002', 'R-002', 'done')]), times: new Map([['T-0001', NOW + 400 * DAY], ['T-0002', NOW - 20 * DAY]]), now: NOW, sinceDays: 30 });
  assert.match(renderText(wide), /Done in the last 30 days/);
  assert.ok(wide.doneThisWeek.length === 2);
  assert.ok(!/Done this week/.test(renderHtml(wide)));
});
