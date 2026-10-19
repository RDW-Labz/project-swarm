// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installKit, validateKit, resolveSource, slug, displayName } from '../tools/kit.mjs';
import { validateAnswers, buildScope, scopeFromAnswers, runInterview, appTypes, QUESTIONS } from '../tools/scope-interview.mjs';
import { parseScope, checkScope } from '../tools/scope.mjs';
import { protectedPathHit, protectedViolations, validateProfile } from '../tools/init-profile.mjs';
import { CLONE_ARGS } from '../tools/kit.mjs';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readJournal } from '../tools/journal.mjs';

const SWARM = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kit-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

const KIT = {
  kit: 'web-portal', version: '0.1.0', description: 'test kit',
  placeholders: { 'src/title.txt': ['Web portal'] },
  services: [{ id: 'resend', required: false, why: 'email', day0: 'Create a key; set RESEND_API_KEY' }, { id: 'supabase', required: true, why: 'sign-in and the database', day0: 'Create a project; copy its URL and keys. Run the migrations' }],
  slots: [{ id: 'auth', owner: 'kit', paths: ['src/lib', 'src/proxy.ts', 'missing/file.ts'] }, { id: 'project', owner: 'swarm', paths: ['src/features'] }],
  env: ['NEXT_PUBLIC_SUPABASE_URL', 'RESEND_API_KEY'], swarmBuildsOnlyIn: ['src/features'],
};
async function makeKit(t, over = {}) {
  const dir = await tmp(t);
  await fs.mkdir(path.join(dir, 'src/lib'), { recursive: true }); await fs.mkdir(path.join(dir, 'src/features'), { recursive: true }); await fs.mkdir(path.join(dir, 'node_modules/x'), { recursive: true }); await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, 'kit.json'), JSON.stringify({ ...KIT, ...over }));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'web-portal-kit', version: '9.9.9', private: true }));
  await fs.writeFile(path.join(dir, 'src/lib/auth.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(dir, 'src/proxy.ts'), 'export const p = 1;\n');
  await fs.writeFile(path.join(dir, 'src/title.txt'), 'Welcome to Web portal\n');
  await fs.writeFile(path.join(dir, 'src/features/.keep'), '');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1\n'); await fs.writeFile(path.join(dir, '.env.local'), 'SECRET=2\n'); await fs.writeFile(path.join(dir, '.env.example'), 'KEY=\n');
  await fs.writeFile(path.join(dir, 'node_modules/x/i.js'), 'x'); await fs.writeFile(path.join(dir, '.git/HEAD'), 'ref');
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
  await fs.writeFile(path.join(dir, 'README.md'), '# kit readme\n');
  return dir;
}

test('kit.json is validated: names, versions, services, slots with an owner, plain relative paths', () => {
  assert.equal(validateKit(KIT, 'web-portal').kit, 'web-portal');
  for (const bad of [null, [], { ...KIT, kit: 'Bad Name' }, { ...KIT, version: '1' }, { ...KIT, services: [{ id: 'x' }] }, { ...KIT, slots: [{ id: 'a', owner: 'someone', paths: ['a'] }] }, { ...KIT, slots: [{ id: 'a', owner: 'kit', paths: ['../etc'] }] }, { ...KIT, slots: [{ id: 'a', owner: 'kit', paths: ['/abs'] }] }, { ...KIT, slots: [{ id: 'a', owner: 'kit', paths: ['a/*'] }] }, { ...KIT, env: ['lower'] }, { ...KIT, placeholders: { '../x': ['a'] } }]) assert.throws(() => validateKit(bad), /kit\.json|object/, JSON.stringify(bad)?.slice(0, 60));
  assert.throws(() => validateKit(KIT, 'other-kit'), /not "other-kit"/);
});

test('installKit copies the kit, names the project, protects the kit files, and lists the Day 0 services as human tasks', async t => {
  const src = await makeKit(t);
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git')); await fs.writeFile(path.join(root, 'README.md'), '# bare\n');
  const r = await installKit({ root, kitName: 'web-portal', source: src, name: 'Dealer Portal', now: () => 1792000000000 });
  assert.equal(r.kit, 'web-portal'); assert.equal(r.project, 'Dealer Portal');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dealer-portal'); assert.equal(pkg.version, '0.1.0');
  assert.equal(await fs.readFile(path.join(root, 'src/title.txt'), 'utf8'), 'Welcome to Dealer Portal\n');
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# kit readme\n');
  // Copied: sources and the env template. Not copied: secrets, dependencies, git history.
  for (const ok of ['src/lib/auth.ts', 'src/proxy.ts', '.env.example', 'kit.json']) await fs.access(path.join(root, ok));
  for (const no of ['.env', '.env.local', 'node_modules', '.git/HEAD']) await assert.rejects(fs.access(path.join(root, no)), no);
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /node_modules/);
  // Kit-owned paths are listed as read-only (a folder with a slash, a file without, a missing one is left out); the swarm's own slot is not.
  assert.deepEqual(r.readOnly.sort(), ['src/lib/', 'src/proxy.ts']);
  // Day 0: required first, optional marked, steps split, as human journal events.
  assert.deepEqual(r.day0, ['day0-supabase', 'day0-resend']);
  const events = (await readJournal(root)).events ?? (await readJournal(root));
  const human = [...events].filter(e => e.kind === 'human');
  assert.deepEqual(human.map(e => e.id), ['day0-supabase', 'day0-resend']);
  assert.match(human[1].title, /optional/);
  assert.deepEqual(human[0].steps, ['Create a project', 'copy its URL and keys', 'Run the migrations']);
});

test('installKit refuses a folder that is not new, a wrong kit, a missing source, a bad source word, and a kit with links', async t => {
  const src = await makeKit(t);
  const full = await tmp(t); await fs.writeFile(path.join(full, 'app.js'), 'x');
  await assert.rejects(installKit({ root: full, kitName: 'web-portal', source: src }), /not new \(app\.js\)/);
  const empty = await tmp(t);
  await assert.rejects(installKit({ root: empty, kitName: 'other-kit', source: src }), /not "other-kit"/);
  await assert.rejects(installKit({ root: empty, kitName: 'web-portal', source: path.join(src, 'nope') }), /no kit folder/);
  await assert.rejects(installKit({ root: empty, kitName: 'web-portal', source: 'file:///etc' }), /folder, an https address or a git@ address/);
  await assert.rejects(installKit({ root: empty, kitName: 'Bad Name', source: src }), /Usage/);
  const linked = await makeKit(t);
  await fs.symlink('/etc/passwd', path.join(linked, 'src/lib/evil'));
  const root = await tmp(t);
  const r = await installKit({ root, kitName: 'web-portal', source: linked });
  assert.deepEqual(r.skippedLinks, ['src/lib/evil']);
  await assert.rejects(fs.lstat(path.join(root, 'src/lib/evil')));
});

test('installKit: a git address is cloned by an injected cloner into a temp folder that is removed afterwards', async t => {
  const src = await makeKit(t);
  let cloned = null;
  const cloner = async (url, dir) => { cloned = { url, dir }; await fs.cp(src, dir, { recursive: true }); };
  const root = await tmp(t);
  const r = await installKit({ root, kitName: 'web-portal', source: 'https://github.com/RDW-Labz/web-portal-kit.git', cloner });
  assert.equal(r.kit, 'web-portal');
  assert.equal(cloned.url, 'https://github.com/RDW-Labz/web-portal-kit.git');
  await assert.rejects(fs.access(cloned.dir), 'the temp clone is gone');
  const failing = async () => { throw new Error('fatal: repository not found'); };
  await assert.rejects(resolveSource('git@github.com:x/y.git', { cloner: failing }), /could not fetch the kit/);
  assert.equal(slug('Dealer Portal!'), 'dealer-portal'); assert.equal(displayName('<b>Hi</b> there'), 'bHib there');
});

test('swarm init --kit runs end to end: the kit is copied, kit files are protected in the profile, Day 0 tasks are in the inbox', async t => {
  const src = await makeKit(t);
  const root = await tmp(t);
  spawnSync('git', ['init', '-q'], { cwd: root });
  const r = spawnSync(process.execPath, [SWARM, '--root', root, 'init', '--kit', 'web-portal', '--kit-source', src, '--name', 'Dealer Portal', '--not-sensitive', '--no-base-check', '--no-map'], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(result.kit.kit, 'web-portal');
  const pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
  assert.deepEqual(pointer.profile.readOnlyPaths, ['src/lib/', 'src/proxy.ts']);
  const inbox = spawnSync(process.execPath, [SWARM, '--root', root, 'inbox'], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.match(inbox.stdout, /day0-supabase/);
  const bad = spawnSync(process.execPath, [SWARM, '--root', root, 'init', '--kit-source', src], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /need --kit NAME/);
});

// ---- the scope interview ----
const ANSWERS = { name: 'Dealer Portal', summary: 'Dealers order parts and see their order history.', roles: 'customer, admin', features: [
  { text: 'A dealer can place an order', accept: ['The order appears in the history within 5 seconds', 'A confirmation email arrives within 2 minutes'] },
  { text: 'A dealer can see order history', accept: ['History lists the newest order first'] },
  { text: 'An admin can export orders', accept: ['The export has one row per order'] },
  { text: 'A dealer can reorder a past order', accept: ['A new order with the same 3 items is created'] },
  { text: 'A dealer can download an invoice', accept: ['A PDF downloads in under 3 seconds'] },
], payments: 'y', email: 'y', uploads: 'n', other: 'Hollander, NHTSA', sensitive: 'y', outOfScope: 'No mobile app.' };

test('the interview answers become a scope the checker accepts: IDs, stages of four, the kit section, external services, sensitive', () => {
  const built = scopeFromAnswers(ANSWERS);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const scope = parseScope(built.text);
  assert.equal(scope.name, 'Dealer Portal');
  assert.deepEqual(scope.requirements.map(r => r.id), ['R-001', 'R-002', 'R-003', 'R-004', 'R-005']);
  assert.deepEqual(scope.requirements.map(r => r.stage), ['S1', 'S1', 'S1', 'S1', 'S2']);
  assert.deepEqual(scope.stages.map(s => s.id), ['S1', 'S2']);
  assert.equal(scope.requirements[0].acceptance.length, 2);
  assert.equal(checkScope(scope).ok, true);
  assert.ok(scope.sections.some(s => /provided by the kit/i.test(s.title) && /Sign-in/.test(s.text) && /Email/.test(s.text) && /Payments/.test(s.text) && !/File upload/.test(s.text)));
  const ext = scope.external.map(e => e.name);
  assert.ok(['Supabase', 'Vercel', 'Resend', 'Stripe', 'Hollander', 'NHTSA'].every(n => ext.includes(n)), ext.join());
  assert.ok(scope.sensitive.some(x => /payments/.test(x)));
  assert.match(built.text, /Not in the first version: No mobile app\./);
  assert.equal(scope.requirements.length, built.requirements);
});

test('stages follow the person\'s choice and are numbered without gaps', () => {
  const a = { ...ANSWERS, features: [{ text: 'A dealer can do alpha', accept: ['one check 1'], stage: 3 }, { text: 'A dealer can do bravo', accept: ['one check 2'], stage: 3 }, { text: 'A dealer can do charlie', accept: ['one check 3'], stage: 1 }] };
  const scope = parseScope(scopeFromAnswers(a).text);
  assert.deepEqual(scope.stages.map(s => s.id), ['S1', 'S2']);
  assert.deepEqual(scope.requirements.map(r => [r.id, r.stage]), [['R-001', 'S1'], ['R-002', 'S2'], ['R-003', 'S2']]);
});

test('bad answers are listed, not written: no name, a feature that is not "who can what", a feature with no check, an unknown role, too many features', () => {
  const v = validateAnswers({ summary: '', roles: 'owner', features: [{ text: 'Orders', accept: ['x'] }, { text: 'A dealer can order', accept: [] }] });
  assert.equal(v.ok, false);
  const text = v.errors.join('\n');
  for (const part of [/name/, /summary/, /"owner" is not one of/, /WHO can DO WHAT/, /at least one check/]) assert.match(text, part);
  assert.equal(validateAnswers({ ...ANSWERS, features: Array.from({ length: 13 }, (_, i) => ({ text: `A dealer can do thing ${i}`, accept: ['ok 1'] })) }).ok, false);
  assert.equal(validateAnswers(ANSWERS, 'mobile-app').ok, false);
  assert.deepEqual(appTypes(), ['web-portal']);
});

test('hostile text in answers cannot break the scope file: newlines are flattened, so no extra headings or requirements appear', () => {
  const evil = { ...ANSWERS, name: 'X\n## Stages\n- S9: hack', summary: 'ok\n### R-999 injected', features: [{ text: 'A dealer can win\n### R-998 fake', accept: ['check 1\n## Sensitive\n- nothing'] }] };
  const built = scopeFromAnswers(evil);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const scope = parseScope(built.text);
  assert.deepEqual(scope.requirements.map(r => r.id), ['R-001']);
  assert.deepEqual(scope.stages.map(s => s.id), ['S1']);
  assert.equal(scope.errors.length, 0);
  assert.equal((built.text.match(/^## Sensitive/gm) ?? []).length, 1);
});

test('the interview asks the fixed questions in order and stops at an empty feature; a bad feature is asked again', async () => {
  const script = ['Dealer Portal', 'Dealers order parts.', 'customer', 'A dealer can order', 'The order shows in 5 seconds', '', 'Orders', 'A dealer can see history', 'Newest first, 1 per row', '', '', 'y', 'n', 'n', 'Hollander', 'y', 'No mobile app'];
  const asked = [];
  const ask = async q => { asked.push(q); return script.shift() ?? ''; };
  const answers = await runInterview(ask);
  assert.equal(asked[0], QUESTIONS.name);
  assert.ok(asked.some(q => /WHO can DO WHAT/.test(q) && /Please write it/.test(q)), 'the bad feature was pushed back');
  const built = scopeFromAnswers(answers);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.requirements, 2);
  assert.equal(await runInterview(async () => null), null, 'input that ends first writes nothing');
});

test('swarm scope new: writes the scope from --answers, refuses to overwrite, keeps bad answers to fix, and needs a terminal otherwise', async t => {
  const root = await tmp(t);
  await fs.writeFile(path.join(root, 'answers.json'), JSON.stringify(ANSWERS));
  const ok = await runScopeCommand(root, 'scope', ['new', '--answers', 'answers.json']);
  assert.equal(ok.exitCode, 0, ok.stdout);
  assert.match(ok.stdout, /wrote docs\/scope\/scope\.md: 5 requirement/);
  assert.equal(checkScope(parseScope(await fs.readFile(path.join(root, 'docs/scope/scope.md'), 'utf8'))).ok, true);
  const again = await runScopeCommand(root, 'scope', ['new', '--answers', 'answers.json']);
  assert.equal(again.exitCode, 1); assert.match(again.stdout, /already exists; not overwritten/);
  await fs.writeFile(path.join(root, 'bad.json'), JSON.stringify({ name: 'X', summary: 's', features: [{ text: 'Orders', accept: [] }] }));
  const bad = await runScopeCommand(root, 'scope', ['new', '--answers', 'bad.json', '--out', 'docs/scope/b.md']);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /scope-answers\.json/);
  await assert.rejects(fs.access(path.join(root, 'docs/scope/b.md')));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.swarm/project/scope-answers.json'), 'utf8')).name, 'X');
  const noTty = await runScopeCommand(root, 'scope', ['new', '--out', 'docs/scope/c.md']);
  assert.equal(noTty.exitCode, 1); assert.match(noTty.stdout, /in a terminal/);
  assert.equal((await runScopeCommand(root, 'scope', ['new', '--type', 'mobile-app', '--answers', 'answers.json', '--out', 'd.md'])).exitCode, 1);
  const asked = await runScopeCommand(root, 'scope', ['new', '--out', 'docs/scope/e.md'], { ask: async q => (q === QUESTIONS.name ? 'Quick' : q === QUESTIONS.summary ? 'A thing.' : /Feature 1/.test(q) ? 'A user can log a visit' : /How will you know/.test(q) ? 'The visit shows within 3 seconds' : '') });
  assert.equal(asked.exitCode, 0, asked.stdout);
  assert.match(await fs.readFile(path.join(root, 'docs/scope/e.md'), 'utf8'), /A user can log a visit/);
});

// ---- Opus review fixes ----
const reuse = async (t, over = {}) => ({ src: await makeKit(t, over), root: await tmp(t) });

test('kit files are read-only for tickets: a worker may read them as context, but not edit, create or delete them', () => {
  const profile = { protectedPaths: ['.env'], readOnlyPaths: ['src/lib/', 'src/proxy.ts'] };
  assert.equal(protectedPathHit(profile, 'src/lib/auth.ts'), 'src/lib/');
  assert.equal(protectedPathHit(profile, 'src/lib/auth.ts', { read: true }), null);
  assert.equal(protectedPathHit(profile, '.env', { read: true }), '.env', 'a protected path stays unreadable');
  const jobs = [{ id: 'a', context: ['src/lib/auth.ts'], outputs: ['src/features/x.ts'] }, { id: 'b', outputs: ['src/lib/auth.ts'] }, { id: 'c', deletes: ['src/proxy.ts'] }];
  assert.deepEqual(protectedViolations(profile, jobs).map(v => `${v.job}:${v.kind}`), ['b:output', 'c:deletes']);
  assert.deepEqual(validateProfile({ sensitive: false, protectedPaths: [], budget: { maxUsd: 1, maxTokens: 10 }, baseCheck: { status: 'none' }, readOnlyPaths: ['src/lib/'] }).errors, []);
  assert.ok(validateProfile({ sensitive: false, protectedPaths: [], budget: { maxUsd: 1, maxTokens: 10 }, baseCheck: { status: 'none' }, readOnlyPaths: ['../x'] }).errors.some(e => /readOnlyPaths/.test(e)));
});

test('placeholders are replaced only in files the kit just wrote, never in what was already in the folder', async t => {
  const { src, root } = await reuse(t, { placeholders: { '.git/config': ['[core]'], '.project-swarm.json': ['x'], 'src/title.txt': ['Web portal'] } });
  await fs.mkdir(path.join(root, '.git')); await fs.writeFile(path.join(root, '.git/config'), '[core]\n'); await fs.writeFile(path.join(root, '.project-swarm.json'), '{"x":1}');
  await installKit({ root, kitName: 'web-portal', source: src, name: 'Dealer Portal' });
  assert.equal(await fs.readFile(path.join(root, '.git/config'), 'utf8'), '[core]\n');
  assert.equal(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'), '{"x":1}');
  assert.equal(await fs.readFile(path.join(root, 'src/title.txt'), 'utf8'), 'Welcome to Dealer Portal\n');
});

test('a .gitignore that is a link is never written through; the project is left as it was', async t => {
  const { src, root } = await reuse(t);
  const outside = await tmp(t); await fs.writeFile(path.join(outside, 'target'), 'keep\n');
  await fs.symlink(path.join(outside, 'target'), path.join(root, '.gitignore'));
  await fs.writeFile(path.join(root, 'README.md'), '# bare\n');
  await assert.rejects(installKit({ root, kitName: 'web-portal', source: src }), /link or not a file/);
  assert.equal(await fs.readFile(path.join(outside, 'target'), 'utf8'), 'keep\n');
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# bare\n', 'the README is back');
  await assert.rejects(fs.access(path.join(root, 'src')), 'nothing the kit wrote is left');
});

test('a kit that ships the owner\'s files (.project-swarm.json, coordination/checks.json) is refused before anything is written', async t => {
  for (const file of ['.project-swarm.json', 'coordination/checks.json']) {
    const { src, root } = await reuse(t);
    await fs.mkdir(path.dirname(path.join(src, file)), { recursive: true }); await fs.writeFile(path.join(src, file), '{}');
    await fs.writeFile(path.join(root, 'README.md'), '# bare\n');
    await assert.rejects(installKit({ root, kitName: 'web-portal', source: src }), /only the project owner writes/, file);
    assert.deepEqual((await fs.readdir(root)).sort(), ['README.md']);
  }
});

test('a failure part-way puts the folder back (README and .gitignore restored, nothing left); limits are checked before any write', async t => {
  const { src, root } = await reuse(t);
  await fs.writeFile(path.join(root, 'README.md'), '# bare\n'); await fs.writeFile(path.join(root, '.gitignore'), 'mine\n');
  await fs.writeFile(path.join(src, 'zz-unreadable.txt'), 'x'); await fs.chmod(path.join(src, 'zz-unreadable.txt'), 0o000);
  t.after(() => fs.chmod(path.join(src, 'zz-unreadable.txt'), 0o644).catch(() => {}));
  if (process.getuid?.() !== 0) {
    await assert.rejects(installKit({ root, kitName: 'web-portal', source: src }));
    assert.deepEqual((await fs.readdir(root)).sort(), ['.gitignore', 'README.md']);
    assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# bare\n');
    assert.equal(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), 'mine\n');
    await fs.chmod(path.join(src, 'zz-unreadable.txt'), 0o644);
    assert.equal((await installKit({ root, kitName: 'web-portal', source: src })).kit, 'web-portal', 'a rerun works');
  }
  const big = await reuse(t);
  await fs.writeFile(path.join(big.root, 'README.md'), '# bare\n');
  await fs.writeFile(path.join(big.src, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(installKit({ root: big.root, kitName: 'web-portal', source: big.src }), /larger than 2 MB/);
  assert.equal(await fs.readFile(path.join(big.root, 'README.md'), 'utf8'), '# bare\n');
  assert.deepEqual((await fs.readdir(big.root)).sort(), ['README.md']);
});

test('a README with real content stays; the kit\'s README is added as KIT-README.md. A kit .gitignore never un-ignores anything', async t => {
  const { src, root } = await reuse(t);
  await fs.writeFile(path.join(src, '.gitignore'), 'node_modules/\n!.env\n!.env.local\n.next/\n');
  await fs.writeFile(path.join(root, 'README.md'), `# Mine\n${'real notes '.repeat(400)}`);
  await installKit({ root, kitName: 'web-portal', source: src });
  assert.match(await fs.readFile(path.join(root, 'README.md'), 'utf8'), /^# Mine/);
  assert.equal(await fs.readFile(path.join(root, 'KIT-README.md'), 'utf8'), '# kit readme\n');
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /node_modules\//); assert.match(ignore, /\.next\//); assert.doesNotMatch(ignore, /^!/m);
});

test('secrets and local state never come from a kit, in any case or depth; a names-only template does', async t => {
  const { src, root } = await reuse(t);
  for (const f of ['.ENV', '.Env.Production', '.npmrc', 'id_rsa', 'secrets/key.pem', 'src/deep/.env.local', '.vercel/project.json', 'server.key']) { await fs.mkdir(path.dirname(path.join(src, f)), { recursive: true }); await fs.writeFile(path.join(src, f), 'secret'); }
  await installKit({ root, kitName: 'web-portal', source: src });
  const have = async f => fs.access(path.join(root, f)).then(() => true, () => false);
  for (const f of ['.ENV', '.Env.Production', '.npmrc', 'id_rsa', 'secrets', 'src/deep/.env.local', '.vercel', 'server.key', '.env.local']) assert.equal(await have(f), false, f);
  assert.equal(await have('.env.example'), true);
});

test('kit.json paths must be plain: no spaces or control characters at the ends, and a kit cannot own more paths than a profile holds', () => {
  for (const p of ['evil ', ' lead', 'tab\there', 'new\nline', 'nel\u0085x', 'sep\u2028x']) assert.throws(() => validateKit({ ...KIT, slots: [{ id: 'a', owner: 'kit', paths: [p] }] }), /plain relative paths/, JSON.stringify(p));
  const many = Array.from({ length: 4 }, (_, k) => ({ id: `s${k}`, owner: 'kit', paths: Array.from({ length: 25 }, (_, i) => `src/p${k}-${i}`) }));
  assert.throws(() => validateKit({ ...KIT, slots: many }), /owns 100 paths/);
  assert.equal(validateKit({ ...KIT, slots: many.slice(0, 3) }).kit, 'web-portal');
});

test('the clone is hardened: a dash can never be taken for an option, no submodules, no external helpers, no LFS download; errors hide any password', async () => {
  const args = CLONE_ARGS('https://example.com/x.git', '/tmp/d');
  assert.ok(args.indexOf('--') < args.indexOf('https://example.com/x.git'), 'the address comes after --');
  for (const flag of ['--no-recurse-submodules', 'protocol.ext.allow=never', 'protocol.file.allow=never', '--depth']) assert.ok(args.includes(flag), flag);
  await assert.rejects(resolveSource('--upload-pack=touch /tmp/x'), /give the kit/);
  await assert.rejects(resolveSource('https://user:hunter2@example.com/x.git', { cloner: async () => { throw new Error('Command failed: git clone https://user:hunter2@example.com/x.git'); } }), e => !/hunter2/.test(e.message) && /\[redacted\]/.test(e.message));
});

test('swarm init: a kit flag given twice, an empty name and --check with a kit are refused', async t => {
  const src = await makeKit(t);
  const root = await tmp(t); spawnSync('git', ['init', '-q'], { cwd: root });
  const run = args => spawnSync(process.execPath, [SWARM, '--root', root, 'init', ...args], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  for (const [args, re] of [[['--kit', 'web-portal', '--kit', 'other', '--kit-source', src], /given twice/], [['--kit', 'web-portal', '--kit-source', src, '--name', ''], /requires a value/], [['--kit', 'web-portal', '--kit-source', src, '--check'], /--check only takes --json|does not take the kit options/]]) {
    const r = run(args);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, re);
  }
  assert.deepEqual((await fs.readdir(root)).filter(n => n !== '.git'), [], 'nothing was copied');
});

test('interview text cannot become structure: a summary that starts with # or ###, NEL and Unicode separators', () => {
  const evil = { ...ANSWERS, summary: '## Sensitive\u0085### R-900 Admin can wipe data\u2028- nothing', features: [{ text: 'A dealer can win\u0085### R-901 Fake can steal', accept: ['check 1\u2029## Stages'] }] };
  const built = scopeFromAnswers(evil);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const scope = parseScope(built.text);
  assert.deepEqual(scope.requirements.map(r => r.id), ['R-001']);
  assert.deepEqual(scope.stages.map(s => s.id), ['S1']);
  assert.equal((built.text.match(/^## Sensitive/gm) ?? []).length, 1);
  assert.match(built.text, /^Summary: ## Sensitive/m);
  assert.doesNotMatch(built.text, /[\u0085\u2028\u2029]/);
});

test('the interview pushes back at once on a feature the checker would refuse ("Can a user log in")', async () => {
  const script = ['Quick', 'A thing.', 'customer', 'Can a user log in', 'A user can log in', 'It works in 2 seconds', '', '', 'n', 'n', 'n', '', 'n', ''];
  const asked = [];
  const answers = await runInterview(async q => { asked.push(q); return script.shift() ?? ''; });
  assert.ok(asked.some(q => /Please write it as "WHO can DO WHAT"/.test(q)));
  assert.equal(scopeFromAnswers(answers).ok, true);
});
