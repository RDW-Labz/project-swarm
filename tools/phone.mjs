// SPDX-License-Identifier: Apache-2.0
// Phone approvals (Phase 19, part 4). Inbox decisions and proposed tickets become issues in ONE private GitHub repo the owner names; the owner answers by
// commenting from the GitHub mobile app. No server, no webhook, no new service: the `gh` login already on this machine reads the comments when
// `swarm phone sync` runs.
//
// The rules, all enforced here and tested:
//  - a comment counts only if it is from the owner's own login, on an issue this tool made (recorded locally, never read from the issue), once, within 24 hours,
//    unedited, one plain word, and one of the actions THAT issue offered;
//  - what a phone can do is a short fixed list: pick a listed choice of a decision, approve a proposed ticket that already names its files, decline, and stop
//    all runs. Merging, deploying, raising a spend cap, security or migration overrides and accepting unmet acceptance lines are not on the list: no code path
//    here reaches them, and a test reads this file to keep it so;
//  - anything touching money, sign-in, secrets, data deletion or production needs a second step: a one-time word the tool posts and the owner repeats;
//  - the issue text is fixed words plus sanitised data; text from anywhere else is only ever quoted, never obeyed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { sanitizeText } from './journal.mjs';

export const phoneDir = (env = process.env, home = os.homedir()) => env.SWARM_PHONE_DIR || path.join(home, '.project-swarm', 'phone');
export const EXPIRY_MS = 24 * 3600000;
export const WORD_EXPIRY_MS = 3600000;
// Decisions and proposed tickets only become phone issues after this long with no owner answer (see syncPhone).
export const PHONE_NOTIFY_WAIT_MS = 60 * 60 * 1000;

export function waitingLongEnoughForPhoneNotify(item, nowMs = Date.now()) {
  const since = item?.since;
  if (since === null || since === undefined || since === '') return true;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > PHONE_NOTIFY_WAIT_MS;
}
export const MAX_NEW_PER_SYNC = 10;
export const MAX_OPEN = 30;
const MAX_WRONG_WORDS = 3;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const LABEL = 'swarm-phone';
const MAX_OWNERS = 4;
const MARK = '<!-- swarm-phone -->';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TICKET_ID = /^T-\d{4}$/;

// The only things a phone may ask for. Anything else is not offered, so it cannot be asked for.
export const PHONE_ACTIONS = Object.freeze(['choose', 'approve-ticket', 'decline', 'stop-all']);
export const NEVER_FROM_PHONE = Object.freeze(['merge', 'deploy', 'force-push', 'branch-D', 'raise a spend cap', 'a security or migration override', 'accepting an unmet acceptance line']);

const SECOND_STEP = /\b(pay\w*|billing|bill|charge|price|prices|auth\w*|log-?in|sign-?in|passwords?|secrets?|tokens?|keys?|delete|drop|wipe|migrat\w*|deploy\w*|production|prod|refund)\b/i;
const HANDBUILD_COMPUTER_ONLY = 'handbuild-computer-only: merge, deploy, force-push and branch -D need the owner at the computer (swarm decide), not from the phone or board';

async function refuseElevatedHandbuildChoose(root, itemId, choice) {
  const picked = String(choice ?? '').trim().toLowerCase();
  if (!String(itemId ?? '').startsWith('handbuild-') || picked !== 'approve') return;
  const { readState, ELEVATED_GIT_OPS } = await import('./handbuild.mjs');
  const req = readState(root).requests[String(itemId).slice('handbuild-'.length)];
  if (!req || req.git === undefined) throw new Error('handbuild-request-unknown');
  if (req.git.some(g => ELEVATED_GIT_OPS.includes(g))) throw new Error(HANDBUILD_COMPUTER_ONLY);
}
const clean = (text, n = 120) => sanitizeText(String(text ?? '')).replace(/[`<>\[\]|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readPhoneConfig(dir = phoneDir()) {
  const c = await readJson(path.join(dir, 'config.json'), null).catch((error) => {
    console.error('[tools/phone.mjs] readPhoneConfig read config:', error?.message ?? error);
    return null;
  });
  if (!c || typeof c.repo !== 'string' || !REPO_RE.test(c.repo)) return null;
  // The owner may have more than one GitHub login (all of them are the owner); a config from before had a single `owner`.
  const owners = [...new Set([...(Array.isArray(c.owners) ? c.owners : []), ...(typeof c.owner === 'string' ? [c.owner] : [])].filter(l => typeof l === 'string' && LOGIN_RE.test(l)))].slice(0, MAX_OWNERS);
  if (!owners.length) return null;
  return { repo: c.repo, owner: owners[0], owners, enabled: c.enabled !== false };
}
export const writePhoneConfig = (dir, config) => writeJson(path.join(dir, 'config.json'), config);
const stateFile = dir => path.join(dir, 'state.json');
export async function readPhoneState(dir = phoneDir(), repo) {
  const s = await readJson(stateFile(dir), { issues: {} }).catch(() => ({ issues: {} }));
  // Issue numbers belong to one repo: state made for another repo is never applied to this one.
  if (repo !== undefined && s?.repo !== undefined && s.repo !== repo) return { repo, issues: {} };
  return { repo: s?.repo ?? repo, issues: s && typeof s.issues === 'object' && s.issues ? s.issues : {} };
}

// Two syncs at once (a loop and a hand run) must not both act on one answer: a lock file, stale after 10 minutes.
async function withSyncLock(dir, fn) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'sync.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await fs.writeFile(file, `${process.pid} ${Date.now()}\n`, { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (await fs.stat(file).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
      if (age < 600000 || attempt === 1) return { busy: true };
      await fs.rm(file, { force: true });
    }
  }
  try { return await fn(); } finally { await fs.rm(file, { force: true }); }
}
async function logIgnored(dir, entry, now) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.appendFile(path.join(dir, 'ignored.ndjson'), `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`, { mode: 0o600 });
}

// ---- gh, always as an argument list (no shell) ------------------------------------------------------------------------------------------------

const api = async (deps, args, body) => {
  const out = await deps.gh(body === undefined ? args : [...args, '--input', '-'], body === undefined ? undefined : { input: JSON.stringify(body) });
  const text = String(out ?? '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
};

// Create the private repo if it is not there (the owner chose this repo), and refuse a repo that is not private: decisions must not be public.
export async function setupPhone({ repo, dir = phoneDir(), deps, owners: extra = [] }) {
  if (!REPO_RE.test(repo ?? '')) return { ok: false, error: 'the repo must look like OWNER/NAME' };
  let login;
  try { login = String(await deps.gh(['api', 'user', '--jq', '.login'])).trim(); } catch { return { ok: false, error: 'gh is not logged in (gh auth login)' }; }
  if (!LOGIN_RE.test(login)) return { ok: false, error: 'could not read your GitHub login' };
  if (extra.some(l => !LOGIN_RE.test(String(l)))) return { ok: false, error: '--owner must be a GitHub login' };
  const owners = [];
  for (const l of [login, ...extra.map(String)]) if (!owners.some(o => o.toLowerCase() === l.toLowerCase())) owners.push(l);
  owners.splice(MAX_OWNERS);
  let info = null;
  try { info = JSON.parse(await deps.gh(['repo', 'view', repo, '--json', 'isPrivate,nameWithOwner'])); } catch { info = null; }
  let created = false;
  if (!info) {
    try { await deps.gh(['repo', 'create', repo, '--private', '--description', 'swarm phone inbox (private)']); created = true; } catch (error) { return { ok: false, error: `could not create ${repo}: ${String(error.message ?? error).split('\n')[0]}` }; }
    try { info = JSON.parse(await deps.gh(['repo', 'view', repo, '--json', 'isPrivate,nameWithOwner'])); } catch { return { ok: false, error: `${repo} was created but cannot be read back` }; }
  }
  if (info.isPrivate !== true) return { ok: false, error: `${repo} is PUBLIC. Phone decisions must be private: make it private or pick another repo` };
  try { await deps.gh(['api', '-X', 'POST', `repos/${repo}/labels`, '--input', '-'], { input: JSON.stringify({ name: LABEL, color: '5319e7', description: 'created by swarm phone sync' }) }); } catch (error) {
    const msg = String(error?.message ?? error);
    if (!/already exists|422|name already/i.test(msg)) console.error('[tools/phone.mjs] setupPhone create label:', msg);
  }
  await writePhoneConfig(dir, { repo, owner: owners[0], owners, enabled: true });
  return { ok: true, repo, owner: owners[0], owners, created };
}

// ---- what is offered ----------------------------------------------------------------------------------------------------------------------------

// Items that may be answered from a phone: decisions with choices, proposed tickets that name their files. Everything else is not offered.
export function phoneItems({ projectName, root, inbox, proposed }) {
  const items = [];
  for (const it of inbox) {
    if (it.kind !== 'decision' || !Array.isArray(it.choices) || !it.choices.length) continue;
    // A choice is offered only exactly as `swarm decide` will compare it: cleaning must not change it, and it must not start with a dash (it becomes an argument).
    const raw = it.choices.map(String);
    if (raw.length > 9 || raw.some(c => !c || c !== clean(c, 40) || c.startsWith('-')) || !SAFE_ID.test(String(it.id))) continue;
    const options = raw;
    items.push({ key: `${root}|decision|${it.id}`, root, projectName, kind: 'decision', itemId: String(it.id), title: clean(it.title), options, default: it.default === undefined ? null : String(it.default), secondStep: SECOND_STEP.test(`${it.title} ${options.join(' ')}`), since: it.since ?? null });
  }
  for (const t of proposed) {
    if (t.status !== 'proposed' || !(t.files ?? []).length || !TICKET_ID.test(String(t.id))) continue;
    items.push({ key: `${root}|ticket|${t.id}`, root, projectName, kind: 'ticket', itemId: String(t.id), title: clean(t.title), options: [], files: t.files.slice(0, 5).map(f => clean(f, 80)), secondStep: Boolean(t.sensitive) || t.risk === 'high' || (t.files ?? []).some(f => SECOND_STEP.test(f)) || SECOND_STEP.test(t.title ?? ''), since: t.createdAt ?? null });
  }
  return items;
}

const actionsOf = rec => (rec.kind === 'decision' ? [...rec.options.map((_, i) => String(i + 1)), 'decline'] : rec.kind === 'ticket' ? ['approve', 'decline'] : ['stop']);

export function issueBody(rec, { expiresAt }) {
  const lines = [`<!-- swarm-phone v1 -->`, `Project: ${rec.projectName}`];
  if (rec.kind === 'decision') {
    lines.push(`Decision ${rec.itemId}: ${rec.title}`, '', 'Reply with ONE word:', ...rec.options.map((o, i) => `- \`${i + 1}\` = ${o}`), '- `decline` = do nothing (answer it at your computer)');
  } else if (rec.kind === 'ticket') {
    lines.push(`Proposed ticket ${rec.itemId}: ${rec.title}`, `Files: ${(rec.files ?? []).join(', ')}`, '', 'Reply with ONE word:', '- `approve` = it becomes a ticket a worker may run', '- `decline` = do nothing');
  } else {
    lines.push('Panic button: stop every running run on this machine.', '', 'Reply `stop`. I will ask for a one-time word; reply with it.');
  }
  if (rec.kind === 'decision') lines.push('', 'Picking a choice other than the current default adds a change to the backlog, so it needs the confirmation word.');
  if (rec.secondStep && rec.kind !== 'panic') lines.push('', 'This one touches money, sign-in, secrets, deletion or production: after your answer I will post a one-time word, and you reply with it to confirm.');
  lines.push('', `Only your own GitHub login(s) are listened to. One answer, until ${new Date(expiresAt).toISOString()}. Merging, deploying, spend caps and overrides are never done from here: do those at your computer.`);
  return lines.join('\n');
}

// ---- sync ---------------------------------------------------------------------------------------------------------------------------------------

const word = random => `${['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'heron', 'iris', 'jade', 'kelp', 'lark'][random(12)]}-${['otter', 'pine', 'quartz', 'reed', 'slate', 'tide', 'umber', 'vale', 'wren', 'yarrow', 'zinc', 'moss'][random(12)]}-${String(random(90) + 10)}`;
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// Every comment the swarm posts starts with a marker and is never read back as an answer (the swarm's gh login may itself be one of the owner's logins).
const comment = (deps, repo, number, body) => api(deps, ['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`], { body: `${MARK}\n${body}` });
const closeIssue = (deps, repo, number) => api(deps, ['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`], { state: 'closed' });

/**
 * deps: gh(args, {input}) -> stdout ; runSwarm(root|null, args) -> {ok, text} ; items() -> phone items of every project ; now() ; random(n)
 */
export async function syncPhone({ dir = phoneDir(), deps, dryRun = false }) {
  if (dryRun) return syncUnlocked({ dir, deps, dryRun });
  const locked = await withSyncLock(dir, () => syncUnlocked({ dir, deps, dryRun }));
  return locked.busy ? { ok: false, error: 'another swarm phone sync is running; try again in a minute' } : locked;
}

async function syncUnlocked({ dir, deps, dryRun }) {
  const config = await readPhoneConfig(dir);
  if (!config) return { ok: false, error: 'phone is not set up: swarm phone setup --repo OWNER/NAME' };
  if (!config.enabled) return { ok: false, error: 'phone is switched off (swarm phone setup turns it on)' };
  const now = deps.now ?? Date.now;
  const random = deps.random ?? randomInt;
  const state = await readPhoneState(dir, config.repo);
  const report = { created: [], answered: [], expired: [], closed: [], ignored: 0, confirming: [], dryRun };
  const save = async () => { if (!dryRun) await writeJson(stateFile(dir), state); };
  const items = await deps.items();
  const offered = new Map(items.map(i => [i.key, i]));

  // 1) answers
  for (const [number, rec] of Object.entries(state.issues)) {
    if (rec.status !== 'open' && rec.status !== 'confirming') continue;
    if (now() > rec.expiresAt) {
      rec.status = 'expired'; report.expired.push(number);
      if (!dryRun) {
        await comment(deps, config.repo, number, 'Expired. Nothing was done.').catch((error) => { console.error('[tools/phone.mjs] syncUnlocked expired comment:', error?.message ?? error); });
        await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked expired closeIssue:', error?.message ?? error); });
      }
      continue;
    }
    if (rec.kind !== 'panic' && !offered.has(rec.key)) {
      rec.status = 'closed-elsewhere'; report.closed.push(number);
      if (!dryRun) {
        await comment(deps, config.repo, number, 'Already handled at the computer. Nothing more to do.').catch((error) => { console.error('[tools/phone.mjs] syncUnlocked closed-elsewhere comment:', error?.message ?? error); });
        await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked closed-elsewhere closeIssue:', error?.message ?? error); });
      }
      continue;
    }
    if (rec.kind === 'decision' && JSON.stringify(offered.get(rec.key).options) !== JSON.stringify(rec.options)) {
      rec.status = 'superseded'; report.closed.push(number);
      if (!dryRun) {
        await comment(deps, config.repo, number, 'The choices changed, so this question is closed. A new one is opened if it still needs you.').catch((error) => { console.error('[tools/phone.mjs] syncUnlocked superseded comment:', error?.message ?? error); });
        await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked superseded closeIssue:', error?.message ?? error); });
      }
      continue;
    }
    if (rec.kind !== 'panic') rec.secondStep = rec.secondStep || Boolean(offered.get(rec.key).secondStep);
    let comments = [];
    try { const got = await api(deps, ['api', `repos/${config.repo}/issues/${number}/comments?per_page=100`]); comments = Array.isArray(got) ? got : []; } catch { continue; }
    for (const c of comments) {
      if (rec.status !== 'open' && rec.status !== 'confirming') break;
      const id = String(c?.id ?? '');
      if (!id || rec.seen.includes(id)) continue;
      rec.seen.push(id);
      if (String(c?.body ?? '').startsWith(MARK)) continue;
      const login = String(c?.user?.login ?? '');
      const why = !config.owners.some(o => o.toLowerCase() === login.toLowerCase()) ? 'not the owner' : c.user?.type && c.user.type !== 'User' ? 'not a user account' : c.updated_at !== c.created_at ? 'edited' : !(Date.parse(c.created_at) >= rec.createdAt) ? 'before the issue' : Date.parse(c.created_at) > rec.expiresAt ? 'after expiry' : null;
      if (why) { report.ignored += 1; if (!dryRun) await logIgnored(dir, { issue: Number(number), login: clean(login, 40), reason: why }, now); continue; }
      const token = String(c.body ?? '').trim().toLowerCase();
      if (token.length > 40 || /\s/.test(token)) { report.ignored += 1; if (!dryRun) await logIgnored(dir, { issue: Number(number), login, reason: 'not one word' }, now); continue; }
      if (rec.status === 'confirming') {
        if (token === 'decline') {
          rec.status = 'declined'; report.answered.push(number);
          if (!dryRun) {
            await comment(deps, config.repo, number, 'Declined. Nothing was done.').catch((error) => { console.error('[tools/phone.mjs] syncUnlocked confirming decline comment:', error?.message ?? error); });
            await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked confirming decline closeIssue:', error?.message ?? error); });
          }
          continue;
        }
        if (now() > rec.wordExpiresAt) {
          rec.status = 'expired'; report.expired.push(number);
          if (!dryRun) {
            await comment(deps, config.repo, number, 'The confirmation word expired. Nothing was done.').catch((error) => { console.error('[tools/phone.mjs] syncUnlocked word-expired comment:', error?.message ?? error); });
            await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked word-expired closeIssue:', error?.message ?? error); });
          }
          break;
        }
        if (!same(token, rec.word)) {
          rec.wrong = (rec.wrong ?? 0) + 1; report.ignored += 1;
          if (rec.wrong >= MAX_WRONG_WORDS) {
            rec.status = 'locked';
            if (!dryRun) {
              await comment(deps, config.repo, number, 'Too many wrong words. Locked; nothing was done.').catch((error) => { console.error('[tools/phone.mjs] syncUnlocked locked comment:', error?.message ?? error); });
              await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked locked closeIssue:', error?.message ?? error); });
            }
          }
          continue;
        }
        await execute(number, rec, rec.pending);
        continue;
      }
      const actions = actionsOf(rec);
      if (!actions.includes(token)) { report.ignored += 1; if (!dryRun) await logIgnored(dir, { issue: Number(number), login, reason: 'not an offered action' }, now); continue; }
      if (token === 'decline') {
        rec.status = 'declined'; report.answered.push(number);
        if (!dryRun) {
          await comment(deps, config.repo, number, 'Declined. Nothing was done.').catch((error) => { console.error('[tools/phone.mjs] syncUnlocked decline comment:', error?.message ?? error); });
          await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked decline closeIssue:', error?.message ?? error); });
        }
        continue;
      }
      const action = rec.kind === 'decision' ? { type: 'choose', choice: rec.options[Number(token) - 1] } : rec.kind === 'ticket' ? { type: 'approve-ticket' } : { type: 'stop-all' };
      const changesDefault = rec.kind === 'decision' && action.choice !== rec.default;
      if (rec.secondStep || rec.kind === 'panic' || changesDefault) {
        rec.status = 'confirming'; rec.pending = action; rec.word = word(random); rec.wordExpiresAt = Math.min(now() + WORD_EXPIRY_MS, rec.expiresAt); rec.wrong = 0;
        report.confirming.push(number);
        if (!dryRun) await comment(deps, config.repo, number, `To confirm, reply with this one-time word within one hour: \`${rec.word}\`. Reply \`decline\` to cancel.`).catch((error) => { console.error('[tools/phone.mjs] syncUnlocked confirmation prompt comment:', error?.message ?? error); });
        continue;
      }
      await execute(number, rec, action);
    }
  }
  async function execute(number, rec, action) {
    // Once only: the record is marked answered BEFORE anything runs, so a crash or a second comment can never run it twice.
    rec.status = 'answered'; rec.answer = action.type; rec.answeredAt = now();
    report.answered.push(number);
    if (dryRun) return;
    await save();
    let result;
    try {
      if (!PHONE_ACTIONS.includes(action.type)) throw new Error('not an allowed phone action');
      if (action.type === 'choose') {
        let choice = String(action.choice ?? '').trim();
        if (String(rec.itemId ?? '').startsWith('handbuild-')) choice = choice.toLowerCase();
        await refuseElevatedHandbuildChoose(rec.root, rec.itemId, choice);
        if (typeof deps.decideInbox !== 'function') throw new Error('phone decide requires decideInbox');
        result = await deps.decideInbox(rec.root, rec.itemId, choice);
      }
      else if (action.type === 'approve-ticket') result = await deps.runSwarm(rec.root, ['tickets', rec.itemId, '--approve', '--yes']);
      else result = await deps.runSwarm(null, ['stop', '--all']);
    } catch (error) { result = { ok: false, text: String(error.message ?? error) }; }
    rec.result = result.ok ? 'ok' : 'failed';
    await comment(deps, config.repo, number, result.ok ? `Done: ${clean(result.text, 200) || 'ok'}` : `That did not work: ${clean(result.text, 200)}. Nothing else was done; try it at your computer.`).catch((error) => { console.error('[tools/phone.mjs] execute result comment:', error?.message ?? error); });
    await closeIssue(deps, config.repo, number).catch((error) => { console.error('[tools/phone.mjs] execute closeIssue:', error?.message ?? error); });
  }

  // 2) new issues for what is waiting (and one panic button)
  const open = Object.values(state.issues).filter(r => r.status === 'open' || r.status === 'confirming');
  const have = new Set(open.map(r => r.key));
  // A question that was answered, declined, locked or failed is not asked again; an expired one may be asked again, but not in the same sync that expired it.
  const settled = new Set(['answered', 'declined', 'locked', 'failed']);
  const wanted = items.filter(i => waitingLongEnoughForPhoneNotify(i, now()) && !have.has(i.key) && !Object.values(state.issues).some(r => r.key === i.key && (settled.has(r.status) || (r.status === 'expired' && report.expired.includes(String(r.number))))));
  if (!open.some(r => r.kind === 'panic')) wanted.push({ key: 'panic', root: null, projectName: 'all projects', kind: 'panic', itemId: 'panic', title: 'stop all', options: [], secondStep: true });
  let made = 0;
  for (const item of wanted) {
    if (made >= MAX_NEW_PER_SYNC || open.length + made >= MAX_OPEN) break;
    const createdAt = now();
    const rec = { key: item.key, kind: item.kind, root: item.root, projectName: item.projectName, itemId: clean(item.itemId, 64), default: item.default ?? null, title: clean(item.title), options: (item.options ?? []).map(o => clean(o, 40)), files: item.files?.map(f => clean(f, 80)), secondStep: item.secondStep, status: 'open', createdAt, expiresAt: createdAt + EXPIRY_MS, seen: [] };
    if (dryRun) { report.created.push(`(would open) ${item.kind} ${item.itemId}`); made += 1; continue; }
    const title = item.kind === 'panic' ? 'swarm: panic button (stop all runs)' : `swarm: ${item.projectName}: ${item.kind} ${item.itemId}`;
    try {
      const issue = await api(deps, ['api', '-X', 'POST', `repos/${config.repo}/issues`], { title, body: issueBody(rec, { expiresAt: rec.expiresAt }), labels: [LABEL] });
      if (!issue?.number) continue;
      rec.number = issue.number;
      state.issues[String(issue.number)] = rec;
      report.created.push(String(issue.number));
      made += 1;
    } catch (error) {
      console.error('[tools/phone.mjs] syncUnlocked create issue:', error?.message ?? error);
    }
  }
  await save();
  return { ok: true, ...report };
}

export async function phoneStatus(dir = phoneDir()) {
  const config = await readPhoneConfig(dir);
  const state = await readPhoneState(dir, config?.repo);
  const counts = {};
  for (const r of Object.values(state.issues)) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return { config, counts };
}

export async function phoneOff(dir = phoneDir()) {
  const config = await readPhoneConfig(dir);
  if (!config) return { ok: false, error: 'phone is not set up' };
  await writePhoneConfig(dir, { ...config, enabled: false });
  return { ok: true };
}
