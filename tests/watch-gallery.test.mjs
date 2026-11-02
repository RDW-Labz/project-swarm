import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGallery, approveScreens, addComment, screenshotPath } from '../tools/watch-gallery.mjs';

const AT = '2024-01-01T00:00:00.000Z';
const NOW = '2024-03-03T00:00:00.000Z';

async function makeRoot() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'watch-gallery-'));
}

function uiDir(root) {
  const dir = path.join(root, '.swarm', 'ui');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeResults(root, screens) {
  writeJson(path.join(uiDir(root), 'results.json'), { at: AT, head: 'abc123', screens });
}

function result(pass, tree, score, at) {
  return { pass, score, reasons: [], at: at || AT, tree, serverStarted: true };
}

function makeScreenDir(root, id) {
  const d = path.join(uiDir(root), id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('readGallery returns a promise with schema 1 and no screens when files are missing', async () => {
  const root = await makeRoot();
  const p = readGallery(root);
  assert.equal(typeof p.then, 'function');
  const out = await p;
  assert.equal(out.schema, 1);
  assert.deepEqual(out.screens, []);
});

test('readGallery maps pass to verdict, tree to fingerprint, and keeps score and at', async () => {
  const root = await makeRoot();
  writeResults(root, {
    home: result(true, 'tree-a', 9, '2024-02-01T00:00:00.000Z'),
    cart: result(false, 'tree-b', 3),
  });
  const out = await readGallery(root);
  const byId = Object.fromEntries(out.screens.map((s) => [s.id, s]));
  assert.equal(byId.home.verdict, 'pass');
  assert.equal(byId.home.score, 9);
  assert.equal(byId.home.at, '2024-02-01T00:00:00.000Z');
  assert.equal(byId.cart.verdict, 'fail');
  assert.equal(byId.cart.score, 3);
});

test('readGallery skips ids that do not match the id pattern', async () => {
  const root = await makeRoot();
  writeResults(root, {
    'good-id': result(true, 'a', 5),
    'Bad_Id': result(true, 'b', 5),
    '-leading': result(true, 'c', 5),
    'a': result(true, 'd', 5),
    ['a'.repeat(64)]: result(true, 'e', 5),
    ['a'.repeat(65)]: result(true, 'f', 5),
  });
  const out = await readGallery(root);
  const ids = out.screens.map((s) => s.id).sort();
  assert.deepEqual(ids, ['a', 'a'.repeat(64), 'good-id'].sort());
});

test('readGallery reports hasMockup and hasPage from screenshot files', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp', 9) });
  const screenDir = makeScreenDir(root, 'home');
  fs.writeFileSync(path.join(screenDir, 'mockup.png'), 'x');
  const out = await readGallery(root);
  assert.equal(out.screens[0].hasMockup, true);
  assert.equal(out.screens[0].hasPage, false);
  fs.writeFileSync(path.join(screenDir, 'page.png'), 'y');
  const again = await readGallery(root);
  assert.equal(again.screens[0].hasPage, true);
});

test('readGallery marks approval approved when the stored fingerprint matches', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  writeJson(path.join(uiDir(root), 'gallery.json'), {
    version: 1,
    screens: { home: { approved: { at: AT, by: 'owner', fingerprint: 'fp1' }, comments: [] } },
  });
  const out = await readGallery(root);
  assert.equal(out.screens[0].approval, 'approved');
});

test('readGallery marks approval stale when the fingerprint differs', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp2', 9) });
  writeJson(path.join(uiDir(root), 'gallery.json'), {
    version: 1,
    screens: { home: { approved: { at: AT, by: 'owner', fingerprint: 'fp1' }, comments: [] } },
  });
  const out = await readGallery(root);
  assert.equal(out.screens[0].approval, 'stale');
});

test('readGallery marks approval none when nothing is approved', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  writeJson(path.join(uiDir(root), 'gallery.json'), {
    version: 1,
    screens: { home: { approved: null, comments: [] } },
  });
  const out = await readGallery(root);
  assert.equal(out.screens[0].approval, 'none');
});

test('approveScreens returns a promise and stores by, at and the current tree as fingerprint', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp7', 9) });
  const p = approveScreens(root, ['home'], { by: 'owner', now: NOW });
  assert.equal(typeof p.then, 'function');
  await p;
  const stored = readJson(path.join(uiDir(root), 'gallery.json'));
  assert.equal(stored.version, 1);
  assert.equal(stored.screens.home.approved.by, 'owner');
  assert.equal(stored.screens.home.approved.at, NOW);
  assert.equal(stored.screens.home.approved.fingerprint, 'fp7');
  const out = await readGallery(root);
  assert.equal(out.screens[0].approval, 'approved');
});

test('approveScreens approves several ids, each with its own tree', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fpA', 9), cart: result(false, 'fpB', 2) });
  await approveScreens(root, ['home', 'cart'], { by: 'owner', now: NOW });
  const stored = readJson(path.join(uiDir(root), 'gallery.json'));
  assert.equal(stored.screens.home.approved.fingerprint, 'fpA');
  assert.equal(stored.screens.cart.approved.fingerprint, 'fpB');
});

test('approveScreens keeps existing comments of other screens when gallery.json exists', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9), cart: result(true, 'fp2', 8) });
  writeJson(path.join(uiDir(root), 'gallery.json'), {
    version: 1,
    screens: { cart: { approved: null, comments: [{ at: AT, text: 'keep me', ticket: null }] } },
  });
  await approveScreens(root, ['home'], { by: 'owner', now: NOW });
  const stored = readJson(path.join(uiDir(root), 'gallery.json'));
  assert.equal(stored.screens.cart.comments.length, 1);
  assert.equal(stored.screens.cart.comments[0].text, 'keep me');
});

test('approveScreens rejects for unknown ids', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  await assert.rejects(approveScreens(root, ['nope'], { by: 'owner', now: NOW }));
});

test('addComment appends a comment with at from now and ticket null', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  const p = addComment(root, 'home', 'looks good', { now: NOW });
  assert.equal(typeof p.then, 'function');
  await p;
  const stored = readJson(path.join(uiDir(root), 'gallery.json'));
  const comments = stored.screens.home.comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].at, NOW);
  assert.equal(comments[0].text, 'looks good');
  assert.equal(comments[0].ticket, null);
});

test('addComment cuts comment text to 500 characters', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  await addComment(root, 'home', 'a'.repeat(700), { now: NOW });
  const stored = readJson(path.join(uiDir(root), 'gallery.json'));
  assert.equal(stored.screens.home.comments[0].text.length, 500);
});

test('addComment strips control characters from comment text', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  const bell = String.fromCharCode(7);
  await addComment(root, 'home', 'ding' + bell + 'dong', { now: NOW });
  const stored = readJson(path.join(uiDir(root), 'gallery.json'));
  const text = stored.screens.home.comments[0].text;
  assert.equal(text.includes(bell), false);
  assert.ok(text.includes('ding'));
});

test('addComment keeps earlier comments and appends new ones in order', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  await addComment(root, 'home', 'first note', { now: NOW });
  await addComment(root, 'home', 'second note', { now: '2024-03-04T00:00:00.000Z' });
  const stored = readJson(path.join(uiDir(root), 'gallery.json'));
  assert.deepEqual(stored.screens.home.comments.map((c) => c.text), ['first note', 'second note']);
});

test('addComment rejects for unknown ids', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  await assert.rejects(addComment(root, 'missing', 'hello', { now: NOW }));
});

test('approve and comment leave no temp files behind in .swarm/ui', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  await approveScreens(root, ['home'], { by: 'owner', now: NOW });
  await addComment(root, 'home', 'note', { now: NOW });
  const names = fs.readdirSync(uiDir(root));
  assert.ok(names.includes('gallery.json'));
  assert.deepEqual(names.filter((n) => n.toLowerCase().includes('tmp')), []);
});

test('screenshotPath returns an absolute path for a present mockup', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  const screenDir = makeScreenDir(root, 'home');
  fs.writeFileSync(path.join(screenDir, 'mockup.png'), 'x');
  const p = screenshotPath(root, 'home', 'mockup');
  assert.equal(typeof p.then, 'function');
  const out = await p;
  assert.equal(typeof out, 'string');
  assert.ok(path.isAbsolute(out));
  assert.equal(path.basename(out), 'mockup.png');
});

test('screenshotPath returns null when the file is missing', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  makeScreenDir(root, 'home');
  assert.equal(await screenshotPath(root, 'home', 'page'), null);
});

test('screenshotPath returns null when the path is a directory, not a regular file', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  const screenDir = makeScreenDir(root, 'home');
  fs.mkdirSync(path.join(screenDir, 'page.png'));
  assert.equal(await screenshotPath(root, 'home', 'page'), null);
});

test('screenshotPath returns null for an invalid id', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  const screenDir = makeScreenDir(root, 'home');
  fs.writeFileSync(path.join(screenDir, 'mockup.png'), 'x');
  assert.equal(await screenshotPath(root, '../home', 'mockup'), null);
  assert.equal(await screenshotPath(root, 'Bad_Id', 'mockup'), null);
});

test('screenshotPath returns null when the screenshot is a symlink', async () => {
  const root = await makeRoot();
  writeResults(root, { home: result(true, 'fp1', 9) });
  const screenDir = makeScreenDir(root, 'home');
  const target = path.join(root, 'outside.png');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, path.join(screenDir, 'page.png'));
  assert.equal(await screenshotPath(root, 'home', 'page'), null);
});
