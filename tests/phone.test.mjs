// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupPhone, syncPhone, phoneItems, readPhoneState, readPhoneConfig, writePhoneConfig, phoneStatus, phoneOff, issueBody, EXPIRY_MS, MAX_NEW_PER_SYNC, PHONE_ACTIONS } from '../tools/phone.mjs';
import { runPhoneCommand } from '../tools/phone-commands.mjs';

const REPO = 'RDW-Labz/swarm-inbox';
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'phone-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

// A small fake of GitHub: issues, comments, and the few gh api calls the tool makes.
function fakeGithub({ login = 'owner-login', repoExists = true, isPrivate = true } = {}) {
  const gh = { issues: new Map(), nextId: 1000, nextNumber: 1, calls: [], repo: repoExists ? { isPrivate, nameWithOwner: REPO } : null, loggedIn: true };
  gh.say = (number, body, { user = login, type = 'User', created, edited = false } = {}) => {
    const issue = gh.issues.get(number);
    const at = created ?? new Date(gh.clock()).toISOString();
    issue.comments.push({ id: gh.nextId++, user: { login: user, type }, body, created_at: at, updated_at: edited ? new Date(Date.parse(at) + 1000).toISOString() : at });
  };
  gh.clock = () => Date.now();
  gh.run = async (args, { input } = {}) => {
    gh.calls.push({ args, body: input ? JSON.parse(input) : undefined });
    const [cmd, ...rest] = args;
    if (cmd === 'api' && rest[0] === 'user') { if (!gh.loggedIn) throw new Error('not logged in'); return `${login}\n`; }
    if (cmd === 'repo' && rest[0] === 'view') { if (!gh.repo) throw new Error('not found'); return JSON.stringify(gh.repo); }
    if (cmd === 'repo' && rest[0] === 'create') { gh.repo = { isPrivate: rest.includes('--private'), nameWithOwner: REPO }; return ''; }
    if (cmd === 'api') {
      const method = rest[0] === '-X' ? rest[1] : 'GET';
      const url = rest[0] === '-X' ? rest[2] : rest[0];
      const body = input ? JSON.parse(input) : {};
      let m;
      if (method === 'POST' && /\/labels$/.test(url)) return '{}';
      if (method === 'POST' && /\/issues$/.test(url)) { const number = gh.nextNumber++; gh.issues.set(number, { number, title: body.title, body: body.body, labels: body.labels, state: 'open', comments: [] }); return JSON.stringify({ number }); }
      if ((m = /\/issues\/(\d+)\/comments/.exec(url)) && method === 'GET') return JSON.stringify(gh.issues.get(Number(m[1])).comments);
      if ((m = /\/issues\/(\d+)\/comments$/.exec(url)) && method === 'POST') { gh.say(Number(m[1]), body.body, { user: 'swarm-bot-is-owner' }); return '{}'; }
      if ((m = /\/issues\/(\d+)$/.exec(url)) && method === 'PATCH') { gh.issues.get(Number(m[1])).state = body.state; return '{}'; }
    }
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return gh;
}

const decision = (id = 'd-1', over = {}) => ({ key: `/p|decision|${id}`, root: '/p', projectName: 'shop', kind: 'decision', itemId: id, title: 'Which logo?', options: ['blue', 'green'], default: 'green', secondStep: false, ...over });
const ticket = (id = 'T-0007', over = {}) => ({ key: `/p|ticket|${id}`, root: '/p', projectName: 'shop', kind: 'ticket', itemId: id, title: 'Fix the footer', options: [], files: ['src/footer.tsx'], secondStep: false, ...over });

async function rig(t, { items = [decision()], github = fakeGithub(), swarm } = {}) {
  const dir = await tmp(t);
  await writePhoneConfig(dir, { repo: REPO, owner: 'owner-login', enabled: true });
  const ran = [];
  const world = { items, now: Date.now(), github, ran };
  const deps = { gh: github.run, items: async () => world.items, now: () => world.now, random: n => 3 % n, runSwarm: swarm ?? (async (root, args) => { ran.push({ root, args }); return { ok: true, text: 'ok' }; }) };
  github.clock = () => world.now;
  const sync = (opts = {}) => syncPhone({ dir, deps, ...opts });
  return { dir, world, deps, sync, github, ran };
}
const numberOf = (github, kind) => [...github.issues.values()].find(i => (kind === 'panic' ? /panic/ : new RegExp(kind)).test(i.title));

test('setup: uses the owner\'s gh login, creates the private repo when it is missing, refuses a public one, and needs gh logged in', async t => {
  const dir = await tmp(t);
  const gh = fakeGithub({ repoExists: false });
  const r = await setupPhone({ repo: REPO, dir, deps: { gh: gh.run } });
  assert.deepEqual([r.ok, r.created, r.owner], [true, true, 'owner-login']);
  assert.ok(gh.calls.some(c => c.args[0] === 'repo' && c.args[1] === 'create' && c.args.includes('--private')));
  assert.deepEqual(await readPhoneConfig(dir), { repo: REPO, owner: 'owner-login', enabled: true });
  const pub = await setupPhone({ repo: REPO, dir: await tmp(t), deps: { gh: fakeGithub({ isPrivate: false }).run } });
  assert.equal(pub.ok, false);
  assert.match(pub.error, /PUBLIC/);
  const out = fakeGithub(); out.loggedIn = false;
  assert.match((await setupPhone({ repo: REPO, dir: await tmp(t), deps: { gh: out.run } })).error, /not logged in/);
  for (const bad of ['nope', 'a/b/c', 'a b/c', '../x/y', '']) assert.equal((await setupPhone({ repo: bad, dir, deps: { gh: gh.run } })).ok, false, bad);
});

test('sync opens one issue per waiting decision plus one panic button; the text is fixed words and sanitised data; a second sync adds nothing', async t => {
  const r = await rig(t, { items: [decision('d-1', { title: 'Which `logo` <b>now</b> [x](http://evil) sk_live_' + 'a'.repeat(24) + '?' })] });
  const first = await r.sync();
  assert.equal(first.created.length, 2);
  const issue = numberOf(r.github, 'decision d-1');
  assert.deepEqual(issue.labels, ['swarm-phone']);
  assert.match(issue.body, /Reply with ONE word/);
  assert.match(issue.body, /`1` = blue/);
  assert.doesNotMatch(issue.body, /<b>|\]\(http|sk_live_a/, 'markup, links and secrets do not pass');
  assert.match(issue.body, /Merging, deploying, spend caps and overrides are never done from here/);
  assert.equal((await r.sync()).created.length, 0);
  assert.equal(r.github.issues.size, 2);
});

test('the owner\'s answer runs once: the chosen option is passed to swarm decide, the issue is closed, a repeat or a later comment does nothing', async t => {
  const r = await rig(t);
  await r.sync();
  const n = numberOf(r.github, 'decision d-1').number;
  r.github.say(n, '2');
  const res = await r.sync();
  assert.equal(res.answered.length, 1);
  assert.deepEqual(r.ran, [{ root: '/p', args: ['decide', 'd-1', 'green'] }]);
  assert.equal(r.github.issues.get(n).state, 'closed');
  r.github.say(n, '1');
  await r.sync();
  await r.sync();
  assert.equal(r.ran.length, 1, 'once only');
  assert.equal((await readPhoneState(r.dir)).issues[n].status, 'answered');
});

test('only the owner counts: other logins, bots, edited comments, comments before the issue or after expiry, many words, and actions that were not offered are ignored and logged', async t => {
  const r = await rig(t);
  await r.sync();
  const n = numberOf(r.github, 'decision d-1').number;
  r.github.say(n, '1', { user: 'someone-else' });
  r.github.say(n, '1', { user: 'OWNER-LOGIN-2' });
  r.github.say(n, '1', { type: 'Bot' });
  r.github.say(n, '1', { edited: true });
  r.github.say(n, '1', { created: new Date(r.world.now - 5000).toISOString() });
  r.github.say(n, 'please pick 1');
  r.github.say(n, 'merge');
  r.github.say(n, 'approve');
  r.github.say(n, '3');
  r.github.say(n, '0');
  r.github.say(n, 'stop');
  const res = await r.sync();
  assert.equal(res.answered.length, 0);
  assert.equal(res.ignored, 11);
  assert.equal(r.ran.length, 0);
  const log = (await fs.readFile(path.join(r.dir, 'ignored.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 11);
  assert.ok(log.some(e => e.reason === 'not the owner') && log.some(e => e.reason === 'edited') && log.some(e => e.reason === 'not an offered action'));
  assert.ok(log.every(e => !('body' in e) && !('text' in e)), 'what was written is not kept');
  assert.equal((await readPhoneState(r.dir)).issues[n].status, 'open');
});

test('24 hours: an answer after expiry does nothing and the issue is closed with a note', async t => {
  const r = await rig(t);
  await r.sync();
  const n = numberOf(r.github, 'decision d-1').number;
  r.world.now += EXPIRY_MS + 1000;
  r.github.say(n, '1');
  const res = await r.sync();
  assert.deepEqual([res.expired.length, res.answered.length], [2, 0], 'the question and the panic button');
  assert.equal(r.ran.length, 0);
  assert.equal(r.github.issues.get(n).state, 'closed');
  assert.match(r.github.issues.get(n).comments.at(-1).body, /Expired. Nothing was done/);
});

test('decline closes the question and changes nothing', async t => {
  const r = await rig(t, { items: [ticket()] });
  await r.sync();
  const n = numberOf(r.github, 'ticket T-0007').number;
  r.github.say(n, 'decline');
  await r.sync();
  assert.equal(r.ran.length, 0);
  assert.equal((await readPhoneState(r.dir)).issues[n].status, 'declined');
});

test('a proposed ticket is approved with the same command the owner would type, and only when it already names its files', async t => {
  const r = await rig(t, { items: [ticket()] });
  await r.sync();
  const n = numberOf(r.github, 'ticket T-0007').number;
  r.github.say(n, 'approve');
  await r.sync();
  assert.deepEqual(r.ran, [{ root: '/p', args: ['tickets', 'T-0007', '--approve', '--yes'] }]);
  const items = phoneItems({ projectName: 'shop', root: '/p', inbox: [], proposed: [{ id: 'T-0001', status: 'proposed', title: 'x', files: [] }, { id: 'T-0002', status: 'todo', title: 'y', files: ['a.ts'] }, { id: 'T-0003', status: 'proposed', title: 'z', files: ['a.ts'] }] });
  assert.deepEqual(items.map(i => i.itemId), ['T-0003']);
});

test('what a phone can see: decisions with choices only; human tasks, blockers and decisions without choices are not offered', () => {
  const inbox = [{ kind: 'decision', id: 'a', title: 't', choices: ['x', 'y'] }, { kind: 'decision', id: 'b', title: 't' }, { kind: 'human', id: 'c', title: 't' }, { kind: 'blocker', id: 'd', title: 't' }];
  assert.deepEqual(phoneItems({ projectName: 'p', root: '/p', inbox, proposed: [] }).map(i => i.itemId), ['a']);
  assert.deepEqual([...PHONE_ACTIONS], ['choose', 'approve-ticket', 'decline', 'stop-all']);
});

test('a borderline item (money, sign-in, secrets, deletion, production, a sensitive or high-risk ticket) needs a second step: a one-time word, three wrong tries lock it, the word expires in an hour', async t => {
  const money = phoneItems({ projectName: 'p', root: '/p', inbox: [{ kind: 'decision', id: 'a', title: 'Charge dealers at sign-up?', choices: ['yes', 'no'] }], proposed: [{ id: 'T-0009', status: 'proposed', title: 'tweak', files: ['src/auth/session.ts'] }, { id: 'T-0008', status: 'proposed', title: 'tweak', files: ['src/a.ts'], risk: 'high' }, { id: 'T-0007', status: 'proposed', title: 'tweak', files: ['src/a.ts'], sensitive: true }, { id: 'T-0006', status: 'proposed', title: 'tweak', files: ['src/a.ts'] }] });
  assert.deepEqual(money.map(i => i.secondStep), [true, true, true, true, false]);
  const r = await rig(t, { items: [decision('d-2', { title: 'Delete old orders?', options: ['yes', 'no'], secondStep: true })] });
  await r.sync();
  const n = numberOf(r.github, 'decision d-2').number;
  r.github.say(n, '1');
  assert.equal((await r.sync()).confirming.length, 1);
  assert.equal(r.ran.length, 0, 'nothing runs on the first answer');
  const wordComment = r.github.issues.get(n).comments.at(-1).body;
  const w = /`([a-z]+-[a-z]+-\d\d)`/.exec(wordComment)[1];
  r.github.say(n, 'wrong-word-11');
  r.github.say(n, 'yes');
  assert.equal(r.ran.length, 0);
  r.github.say(n, w);
  await r.sync();
  assert.deepEqual(r.ran, [{ root: '/p', args: ['decide', 'd-2', 'yes'] }], 'the word confirms the choice made first');
  const r2 = await rig(t, { items: [decision('d-3', { secondStep: true })] });
  await r2.sync();
  const n2 = numberOf(r2.github, 'decision d-3').number;
  r2.github.say(n2, '1'); await r2.sync();
  for (const bad of ['aaa', 'bbb', 'ccc']) r2.github.say(n2, bad);
  await r2.sync();
  assert.equal((await readPhoneState(r2.dir)).issues[n2].status, 'locked');
  r2.github.say(n2, /`([a-z]+-[a-z]+-\d\d)`/.exec(r2.github.issues.get(n2).comments.find(c => /one-time word/.test(c.body)).body)[1]);
  await r2.sync();
  assert.equal(r2.ran.length, 0, 'locked stays locked');
  const r3 = await rig(t, { items: [decision('d-4', { secondStep: true })] });
  await r3.sync();
  const n3 = numberOf(r3.github, 'decision d-4').number;
  r3.github.say(n3, '2'); await r3.sync();
  const w3 = /`([a-z]+-[a-z]+-\d\d)`/.exec(r3.github.issues.get(n3).comments.find(c => /one-time word/.test(c.body)).body)[1];
  r3.world.now += 3600000 + 1000;
  r3.github.say(n3, w3);
  await r3.sync();
  assert.equal(r3.ran.length, 0, 'the word expired');
});

test('the panic button: stop, then the one-time word, runs swarm stop --all once; the next sync opens a fresh button', async t => {
  const r = await rig(t, { items: [] });
  await r.sync();
  const panic = numberOf(r.github, 'panic');
  assert.equal(panic.title, 'swarm: panic button (stop all runs)');
  r.github.say(panic.number, 'stop');
  await r.sync();
  assert.equal(r.ran.length, 0);
  r.github.say(panic.number, /`([a-z]+-[a-z]+-\d\d)`/.exec(panic.comments.find(c => /one-time word/.test(c.body)).body)[1]);
  const res = await r.sync();
  assert.deepEqual(r.ran, [{ root: null, args: ['stop', '--all'] }]);
  assert.equal(res.created.length, 1, 'a new button');
  await r.sync();
  assert.equal(r.ran.length, 1);
});

test('an item handled at the computer closes its issue; a failing command is reported on the issue and is not retried; dry run changes nothing', async t => {
  const r = await rig(t);
  await r.sync();
  const n = numberOf(r.github, 'decision d-1').number;
  r.world.items = [];
  const res = await r.sync();
  assert.equal(res.closed.length, 1);
  assert.equal(r.github.issues.get(n).state, 'closed');
  const failing = await rig(t, { swarm: async () => { throw new Error('boom'); } });
  await failing.sync();
  const f = numberOf(failing.github, 'decision d-1').number;
  failing.github.say(f, '2');
  await failing.sync();
  await failing.sync();
  assert.match(failing.github.issues.get(f).comments.at(-1).body, /That did not work/);
  assert.equal((await readPhoneState(failing.dir)).issues[f].result, 'failed');
  const dry = await rig(t);
  const before = dry.github.calls.length;
  const dr = await dry.sync({ dryRun: true });
  assert.equal(dr.dryRun, true);
  assert.equal(dry.github.calls.length, before, 'no gh call at all');
  assert.deepEqual((await readPhoneState(dry.dir)).issues, {});
});

test('caps: at most 10 new issues per sync', async t => {
  const items = Array.from({ length: 25 }, (_, i) => decision(`d-${i}`));
  const r = await rig(t, { items });
  assert.equal((await r.sync()).created.length, MAX_NEW_PER_SYNC);
  assert.equal((await r.sync()).created.length, MAX_NEW_PER_SYNC);
});

test('off and status; sync before setup or when off refuses', async t => {
  const dir = await tmp(t);
  assert.match((await syncPhone({ dir, deps: {} })).error, /not set up/);
  await writePhoneConfig(dir, { repo: REPO, owner: 'o', enabled: true });
  assert.match((await runPhoneCommand(['status'], { dir })).stdout, /repo: RDW-Labz\/swarm-inbox.*on/);
  assert.equal((await phoneOff(dir)).ok, true);
  assert.match((await syncPhone({ dir, deps: {} })).error, /switched off/);
  assert.match((await runPhoneCommand(['status'], { dir })).stdout, /OFF/);
  assert.equal((await runPhoneCommand(['nope'], { dir })).exitCode, 2);
  assert.equal((await runPhoneCommand(['sync', '--force'], { dir })).exitCode, 2);
  assert.equal((await phoneStatus(dir)).config.enabled, false);
});

test('the phone code cannot reach merge, deploy, spend caps or overrides: it only ever runs decide, tickets --approve and stop --all (a test reads the source)', async () => {
  const src = (await fs.readFile(new URL('../tools/phone.mjs', import.meta.url), 'utf8')) + (await fs.readFile(new URL('../tools/phone-commands.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /pr['", ]+merge|swarm merge|vercel|--max-usd|--override|--accept|maxUsd|projectMaxUsd|--force|funnel/i);
  const runs = [...src.matchAll(/runSwarm\([^)]*\[([^\]]*)\]/g)].map(m => m[1].replace(/\s+/g, ' '));
  assert.deepEqual(runs, ["'decide', rec.itemId, action.choice", "'tickets', rec.itemId, '--approve', '--yes'", "'stop', '--all'"]);
  assert.match(issueBody(decision(), { expiresAt: Date.now() }), /Only your own GitHub login is listened to/);
});

test('review fixes: a declined, locked or answered question is never reopened; an expired one is not reopened in the same sync', async t => {
  const r = await rig(t);
  await r.sync();
  const n = numberOf(r.github, 'decision d-1').number;
  r.github.say(n, 'decline');
  const again = await r.sync();
  assert.equal(again.created.length, 0, 'declined: not asked again');
  assert.equal(r.github.issues.size, 2);
  const e = await rig(t);
  await e.sync();
  e.world.now += EXPIRY_MS + 1000;
  const res = await e.sync();
  assert.equal(res.expired.length, 2);
  assert.equal(res.created.length, 1, 'only the panic button is new in that sync; the expired decision waits for the next one');
  assert.equal((await e.sync()).created.length, 1, 'then the still-waiting decision is asked again');
});

test('review fixes: picking anything but the default needs the confirmation word (it queues a change goal); the default does not', async t => {
  const r = await rig(t);
  await r.sync();
  const n = numberOf(r.github, 'decision d-1').number;
  assert.match(r.github.issues.get(n).body, /other than the current default adds a change to the backlog/);
  r.github.say(n, '1');
  assert.equal((await r.sync()).confirming.length, 1);
  assert.equal(r.ran.length, 0);
  const r2 = await rig(t);
  await r2.sync();
  r2.github.say(numberOf(r2.github, 'decision d-1').number, '2');
  await r2.sync();
  assert.equal(r2.ran.length, 1, 'the default runs at once');
});

test('review fixes: a changed set of choices closes the question; a ticket that became borderline gets the second step; state for another repo is not applied', async t => {
  const r = await rig(t);
  await r.sync();
  const n = numberOf(r.github, 'decision d-1').number;
  r.world.items = [decision('d-1', { options: ['blue', 'green', 'red'] })];
  const res = await r.sync();
  assert.equal(res.closed.length, 1);
  assert.equal((await readPhoneState(r.dir, REPO)).issues[n].status, 'superseded');
  const t2 = await rig(t, { items: [ticket()] });
  await t2.sync();
  const m = numberOf(t2.github, 'ticket T-0007').number;
  t2.world.items = [ticket('T-0007', { secondStep: true })];
  t2.github.say(m, 'approve');
  assert.equal((await t2.sync()).confirming.length, 1);
  assert.equal(t2.ran.length, 0);
  const state = await readPhoneState(t2.dir, 'someone/else');
  assert.deepEqual(state.issues, {}, 'issue numbers of another repo are not used');
});

test('review fixes: choices that cleaning would change, or that start with a dash, and odd decision or ticket ids are not offered', () => {
  const mk = (choices, id = 'd-1') => phoneItems({ projectName: 'p', root: '/p', inbox: [{ kind: 'decision', id, title: 't', choices }], proposed: [] }).length;
  assert.equal(mk(['blue', 'green']), 1);
  assert.equal(mk(['--json', 'x']), 0);
  assert.equal(mk(['-x', 'y']), 0);
  assert.equal(mk(['a `b`', 'c']), 0);
  assert.equal(mk(['a'.repeat(41), 'c']), 0);
  assert.equal(mk(['a', 'b'], '--flag'), 0);
  assert.equal(mk(['a', 'b'], 'ok.id_1'), 1);
  assert.equal(phoneItems({ projectName: 'p', root: '/p', inbox: [], proposed: [{ id: 'T-0001', status: 'proposed', title: 'x', files: ['a.ts'] }, { id: '--yes', status: 'proposed', title: 'x', files: ['a.ts'] }, { id: 'T-1', status: 'proposed', title: 'x', files: ['a.ts'] }] }).length, 1);
});

test('review fixes: two syncs at once do not both act (a lock); a stale lock is taken over', async t => {
  const r = await rig(t);
  await fs.writeFile(path.join(r.dir, 'sync.lock'), `1 ${Date.now()}\n`);
  const busy = await r.sync();
  assert.match(busy.error, /another swarm phone sync is running/);
  const old = new Date(Date.now() - 11 * 60000);
  await fs.utimes(path.join(r.dir, 'sync.lock'), old, old);
  assert.equal((await r.sync()).ok, true);
  await assert.rejects(fs.access(path.join(r.dir, 'sync.lock')), 'the lock is released');
});
