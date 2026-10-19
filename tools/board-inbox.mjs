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
const txt = (v, n = 160) => (v === null || v === undefined ? null : sanitizeText(v).replace(new RegExp(UNSAFE.source, 'g'), ' ').replace(/\s+/g, ' ').trim().slice(0, n));
const PROJECT_MS = 3000;
const deadline = (promise, ms, label) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000} seconds`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const quote = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const MAX_PER_PROJECT = 50;
const phoneOf = (rec, now) => (rec ? { status: Number.isFinite(rec.expiresAt) && rec.expiresAt <= now ? 'expired' : rec.status, expiresAt: Number.isFinite(rec.expiresAt) ? new Date(rec.expiresAt).toISOString() : null, issue: Number.isInteger(rec.number) ? rec.number : null } : null);

const commandFor = (item, root) => {
  // Never offer a command that holds anything but plain characters (a pasted escape or a look-alike could change what it does), or a choice that would read as a flag.
  const parts = [root, String(item.id), ...(item.kind === 'decision' ? [String(item.default ?? item.choices?.[0] ?? 'CHOICE')] : [])];
  if (parts.some(p => UNSAFE.test(p) || !p)) return null;
  if (item.kind === 'decision' && parts[2].startsWith('-')) return null;
  const swarm = `swarm --root ${quote(root)}`;
  if (item.kind === 'human') return `${swarm} done ${quote(item.id)}`;
  if (item.kind === 'decision') return `${swarm} decide ${quote(item.id)} ${quote(item.default ?? item.choices?.[0] ?? 'CHOICE')}`;
  if (item.kind === 'proposed-ticket') return item.files ? `${swarm} tickets ${quote(item.id)} --approve --yes` : `${swarm} tickets ${quote(item.id)} --files FILE[,FILE] --yes`;
  return null;
};

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
        mine.push({ kind: it.kind, id: txt(it.id, 80), title: txt(it.title, 200), since: it.since ?? null, unblocks: Number.isFinite(it.unblocks) ? it.unblocks : 0, steps: (it.steps ?? []).length, choices: Array.isArray(it.choices) ? it.choices.slice(0, 9).map(c => txt(c, 40)) : null, command: commandFor(it, project.root), phone: phoneOf(phone, now) });
      }
      const ledger = await ledgerOf(project.root).catch(() => null);
      for (const t of ledger?.tickets ?? []) {
        if (t?.status !== 'proposed') continue;
        const phone = asked.get(`${project.root}|ticket|${t.id}`);
        mine.push({ kind: 'proposed-ticket', id: txt(t.id, 20), title: txt(t.title, 200), since: t.createdAt ?? ledger.updatedAt ?? null, unblocks: 0, steps: 0, choices: null, origin: txt(t.origin, 20), filesNamed: (t.files ?? []).length > 0, command: commandFor({ kind: 'proposed-ticket', id: t.id, files: (t.files ?? []).length > 0 }, project.root), phone: phoneOf(phone, now) });
      }
      return mine;
    };
    try { return { project, mine: await deadline(read(), projectMs, `reading ${project.name}`) }; }
    catch (error) { problems.push({ project: txt(project.name, 80), problem: txt(error.message, 120) }); return { project, mine: [] }; }
  }));
  const items = [];
  let hidden = 0;
  for (const { project, mine } of perProject) {
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
    problems,
    phone: config ? { on: config.enabled, repo: config.repo, owners: config.owners, open, confirming: asked.size - open } : null,
    at: new Date(now).toISOString(),
  };
}

export function inboxText(inbox) {
  if (!inbox?.total) return '';
  const lines = [`Needs you: ${inbox.total}`];
  for (const it of inbox.items.slice(0, 20)) lines.push(`  [${it.kind}] ${it.project}: ${it.title}${it.phone ? `  (asked on your phone, ${it.phone.status})` : ''}\n    at the computer: ${it.command ?? 'see swarm inbox'}`);
  const more = inbox.total - Math.min(20, inbox.items.length);
  if (more > 0) lines.push(`  ... and ${more} more (swarm inbox --all)`);
  return `${lines.join('\n')}\n`;
}
