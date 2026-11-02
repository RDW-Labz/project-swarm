// SPDX-License-Identifier: Apache-2.0
// The board's "Needs you" panel: what is waiting for the owner in every registered project (inbox decisions, human tasks, blockers, proposed tickets)
// and which of those were also asked on the phone. READ-ONLY: the board never answers anything. Answers go through the commands shown here at the
// computer, or through the private swarm-inbox issues from the phone (swarm phone sync).
import path from 'node:path';
import { collectInbox } from './inbox.mjs';
import { inboxDeps } from './inbox-commands.mjs';
import { readLedger } from './tickets.mjs';
import { readPhoneConfig, readPhoneState, phoneDir } from './phone.mjs';
import { sanitizeText } from './journal.mjs';

// Secrets redacted, control characters (terminal escapes) removed, length bounded: everything shown here came from a file on disk.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;   // controls, C1, zero-width and text-direction characters
const txt = (v, n = 160) => (v === null || v === undefined ? null : clip(sanitizeText(v).replace(new RegExp(UNSAFE.source, 'g'), ' ').replace(/\s+/g, ' ').trim(), n));
// Cut at a word, never in the middle of one (the board wraps text; this only bounds how much is sent).
const clip = (text, n) => {
  if (text === null || text.length <= n) return text;
  const cut = text.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(-]+$/, '')}…`;
};
const TITLE_MAX = 900;
const PROJECT_MS = 3000;
const deadline = (promise, ms, label) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000} seconds`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const quote = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const MAX_PER_PROJECT = 50;
const stepsOf = ({ commands, next }) => ({ commands, command: commands[0]?.cmd ?? null, next });
const phoneOf = (rec, now) => (rec ? { status: Number.isFinite(rec.expiresAt) && rec.expiresAt <= now ? 'expired' : rec.status, expiresAt: Number.isFinite(rec.expiresAt) ? new Date(rec.expiresAt).toISOString() : null, issue: Number.isInteger(rec.number) ? rec.number : null } : null);

// "FYI, no action needed" notes are not for the owner: they are listed apart, collapsed, and never counted.
const isFyi = it => it.kind === 'human' && (String(it.id).startsWith('prune-') || /^FYI, no action needed/i.test(String(it.title ?? '')));

// The commands (with a label) the owner can run at the computer, and for a blocker always a plain "do this" line.
const plain = value => !UNSAFE.test(String(value)) && String(value) !== '';
function nextFor(item, root) {
  if (![root, String(item.id)].every(plain)) return { commands: [], next: null };
  const swarm = `swarm --root ${quote(root)}`;
  const commands = [];
  let next = null;
  if (item.kind === 'human') commands.push({ label: 'Mark it done', cmd: `${swarm} done ${quote(item.id)}` });
  else if (item.kind === 'decision') {
    const choice = String(item.default ?? item.choices?.[0] ?? 'CHOICE');
    if (plain(choice) && !choice.startsWith('-')) commands.push({ label: 'Choose', cmd: `${swarm} decide ${quote(item.id)} ${quote(choice)}` });
  } else if (item.kind === 'proposed-ticket') commands.push(item.files ? { label: 'Approve it', cmd: `${swarm} tickets ${quote(item.id)} --approve --yes` } : { label: 'Name its files first', cmd: `${swarm} tickets ${quote(item.id)} --files FILE[,FILE] --yes` });
  else if (item.kind === 'blocker') {
    const text = String(item.text ?? item.title ?? '');
    const run = /^security-(\d{10,}-[0-9a-f]{6,8})-/.exec(String(item.id))?.[1];
    const manifest = /unsupported-manifest: (\S+) changed/.exec(text)?.[1];
    if (run && manifest && /^[A-Za-z0-9_@+.\/-]+$/.test(manifest) && !manifest.startsWith('-') && !manifest.startsWith('/')) {
      next = `Read ${manifest} yourself first (it changes how dependencies or builds work). If it is fine, approve exactly that content and integrate again; if not, fix it in the run's change and integrate again. Dismiss this once it is dealt with.`;
      commands.push({ label: 'Approve that file and integrate', cmd: `${swarm} integrate ${run} --queue --approve-manifest ${manifest}` });
    } else if (/no scanner ran/.test(text)) next = 'The vulnerability audit could not run. Add a lockfile (run npm install in the project) or install osv-scanner, then integrate the run again. Dismiss this once it is dealt with.';
    else if (/Security gate blocked/.test(text)) next = 'Fix what the finding names (a secret is never shown, only its place), then integrate the run again. Dismiss this once it is dealt with.';
    else {
      const inspect = /swarm inspect (\d{10,}-[0-9a-f]{6,8})/.exec(text)?.[1];
      if (inspect) commands.push({ label: 'Look at the result', cmd: `${swarm} inspect ${inspect} --results` });
      next = 'Read the message, fix the cause, then dismiss it.';
    }
    commands.push({ label: 'Dismiss (you dealt with it)', cmd: `${swarm} resolve ${quote(item.id)}` });
  }
  return { commands, next };
}

export async function boardInbox({ projects, now = Date.now(), env = process.env, collect = collectInbox, deps = inboxDeps(), ledgerOf = readLedger, phoneDirectory = phoneDir(env), projectMs = PROJECT_MS } = {}) {
  const config = await readPhoneConfig(phoneDirectory).catch(() => null);
  const state = config ? await readPhoneState(phoneDirectory, config.repo).catch(() => ({ issues: {} })) : { issues: {} };
  const asked = new Map();
  for (const rec of Object.values(state.issues)) if (rec && (rec.status === 'open' || rec.status === 'confirming')) asked.set(rec.key, rec);
  const problems = [];
  // Every project is read at the same time with its own time limit: one that hangs is named and does not hold up the rest.
  const perProject = await Promise.all(projects.map(async project => {
    const read = async () => {
      const mine = [];
      for (const it of await collect([project.root], deps)) {
        const phone = asked.get(`${project.root}|${it.kind}|${it.id}`);
        mine.push({ kind: it.kind, id: txt(it.id, 80), title: txt(it.title, TITLE_MAX), since: it.since ?? null, unblocks: Number.isFinite(it.unblocks) ? it.unblocks : 0, steps: (it.steps ?? []).length, choices: Array.isArray(it.choices) ? it.choices.slice(0, 9).map(c => txt(c, 40)) : null, ...stepsOf(nextFor(it, project.root)), fyi: isFyi(it), phone: phoneOf(phone, now) });
      }
      const ledger = await ledgerOf(project.root).catch(() => null);
      for (const t of ledger?.tickets ?? []) {
        if (t?.status !== 'proposed') continue;
        const phone = asked.get(`${project.root}|ticket|${t.id}`);
        mine.push({ kind: 'proposed-ticket', id: txt(t.id, 20), title: txt(t.title, TITLE_MAX), since: t.createdAt ?? ledger.updatedAt ?? null, unblocks: 0, steps: 0, choices: null, origin: txt(t.origin, 20), filesNamed: (t.files ?? []).length > 0, ...stepsOf(nextFor({ kind: 'proposed-ticket', id: t.id, files: (t.files ?? []).length > 0 }, project.root)), fyi: false, phone: phoneOf(phone, now) });
      }
      return mine;
    };
    try { return { project, mine: await deadline(read(), projectMs, `reading ${project.name}`) }; }
    catch (error) { problems.push({ project: txt(project.name, 80), problem: txt(error.message, 120) }); return { project, mine: [] }; }
  }));
  const items = [];
  const fyi = [];
  let hidden = 0;
  for (const { project, mine: all } of perProject) {
    const mine = all.filter(it => !it.fyi);
    for (const it of all.filter(x => x.fyi).slice(0, 30)) fyi.push({ projectId: project.id, project: txt(project.name, 80), id: it.id, title: it.title, since: it.since, command: it.command });
    // The items that unblock the most come first, then the oldest; a project's list is capped, and the cap is reported, not hidden.
    mine.sort((a, b) => (b.unblocks - a.unblocks) || String(a.since).localeCompare(String(b.since)));
    hidden += Math.max(0, mine.length - MAX_PER_PROJECT);
    for (const it of mine.slice(0, MAX_PER_PROJECT)) items.push({ projectId: project.id, project: txt(project.name, 80), ...it });
  }
  items.sort((a, b) => (b.unblocks - a.unblocks) || String(a.since).localeCompare(String(b.since)) || String(a.project).localeCompare(String(b.project)));
  const open = [...asked.values()].filter(r => r.status === 'open').length;
  return {
    total: items.length + hidden,
    hidden,
    items,
    fyi: fyi.sort((a, b) => String(b.since).localeCompare(String(a.since))).slice(0, 60),
    problems,
    phone: config ? { on: config.enabled, repo: config.repo, owners: config.owners, open, confirming: asked.size - open } : null,
    at: new Date(now).toISOString(),
  };
}

export function inboxText(inbox) {
  if (!inbox?.total) return '';
  const lines = [`Needs you: ${inbox.total}`];
  for (const it of inbox.items.slice(0, 20)) {
    lines.push(`  [${it.kind}] ${it.project}: ${it.title}${it.phone ? `  (asked on your phone, ${it.phone.status})` : ''}`);
    if (it.next) lines.push(`    do this: ${it.next}`);
    for (const c of it.commands ?? []) lines.push(`    ${c.label}: ${c.cmd}`);
    if (!(it.commands ?? []).length && !it.next) lines.push('    at the computer: swarm inbox');
  }
  const more = inbox.total - Math.min(20, inbox.items.length);
  if (more > 0) lines.push(`  ... and ${more} more (swarm inbox --all)`);
  if (inbox.fyi?.length) lines.push(`  (${inbox.fyi.length} FYI note${inbox.fyi.length === 1 ? '' : 's'} not counted)`);
  return `${lines.join('\n')}\n`;
}
