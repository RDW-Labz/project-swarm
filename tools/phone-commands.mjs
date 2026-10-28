// SPDX-License-Identifier: Apache-2.0
// swarm phone setup --repo OWNER/NAME | sync [--dry-run] | status | off
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setupPhone, syncPhone, phoneStatus, phoneOff, phoneItems, phoneDir, PHONE_ACTIONS, NEVER_FROM_PHONE } from './phone.mjs';
import { listProjects } from './projects.mjs';
import { collectInbox, decide } from './inbox.mjs';
import { inboxDeps } from './inbox-commands.mjs';
import { readLedger } from './tickets.mjs';

const run = promisify(execFile);
const SWARM = fileURLToPath(new URL('./swarm.mjs', import.meta.url));

export const PHONE_USAGE = [
  'Usage: swarm phone setup --repo OWNER/NAME [--owner LOGIN]...   use (or create) a PRIVATE repo; the active gh login is the owner, each --owner adds another of YOUR logins',
  '       swarm phone sync [--dry-run]            open issues for what waits for you, read your answers (run it by hand or in a loop)',
  '       swarm phone status                      what is set up and how many questions are open',
  '       swarm phone off                         stop opening issues and reading answers',
].join('\n');
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });

export function realDeps() {
  return {
    gh: async (args, { input } = {}) => {
      const child = run('gh', args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: process.env });
      if (input !== undefined) child.child.stdin.end(input);
      try { return (await child).stdout; }
      catch (error) { throw new Error(String(error.stderr || error.message || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'gh failed'); }
    },
    runSwarm: async (root, args) => {
      try { const { stdout } = await run(process.execPath, [SWARM, ...(root ? ['--root', root] : []), ...args], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); return { ok: true, text: stdout }; }
      catch (error) { return { ok: false, text: String(error.stdout || error.stderr || error.message || '') }; }
    },
    items: async () => {
      const items = [];
      for (const project of await listProjects()) {
        try {
          const inbox = await collectInbox([project.root], inboxDeps());
          const ledger = await readLedger(project.root).catch((error) => {
            if (error?.code !== 'ENOENT') console.error('[tools/phone-commands.mjs] items readLedger:', error?.message ?? error);
            return null;
          });
          items.push(...phoneItems({ projectName: project.name, root: project.root, inbox, proposed: (ledger?.tickets ?? []).filter(t => t.status === 'proposed') }));
        } catch { /* a project that cannot be read is skipped */ }
      }
      return items;
    },
    now: Date.now,
    decideInbox: async (root, id, choice) => {
      try {
        await decide(root, id, choice, { ...inboxDeps(), channel: 'phone' });
        return { ok: true, text: `decided ${id}: ${choice}` };
      } catch (error) {
        return { ok: false, text: String(error.message ?? error) };
      }
    },
  };
}

export async function runPhoneCommand(args, { deps = realDeps(), dir = phoneDir() } = {}) {
  const [sub, ...rest] = args;
  if (sub === 'setup') {
    let repo; const owners = [];
    for (let k = 0; k < rest.length; k += 1) {
      if (rest[k] === '--repo' && rest[k + 1] !== undefined && repo === undefined) repo = rest[++k];
      else if (rest[k] === '--owner' && rest[k + 1] !== undefined) owners.push(rest[++k]);
      else return out(PHONE_USAGE, 2);
    }
    if (repo === undefined) return out(PHONE_USAGE, 2);
    const result = await setupPhone({ repo, dir, deps, owners });
    if (!result.ok) return out(result.error, 1);
    return out([`${result.created ? 'created the private repo' : 'using the private repo'} ${result.repo}`, `only replies from ${result.owners.join(' or ')} count; every other login is ignored`,
      'On your phone: install the GitHub app, sign in, and turn on notifications for that repo (Watch > All activity).',
      'Then: swarm phone sync   (opens a question per waiting decision, plus a panic button)',
      `Offered from a phone: ${PHONE_ACTIONS.join(', ')}. Never: ${NEVER_FROM_PHONE.join(', ')}.`].join('\n'));
  }
  if (sub === 'sync') {
    if (rest.some(a => a !== '--dry-run')) return out(PHONE_USAGE, 2);
    const r = await syncPhone({ dir, deps, dryRun: rest.includes('--dry-run') });
    if (!r.ok) return out(r.error, 1);
    return out([`${r.dryRun ? 'dry run: nothing was changed. ' : ''}opened ${r.created.length}, answered ${r.answered.length}, waiting for the confirmation word ${r.confirming.length}, expired ${r.expired.length}, handled elsewhere ${r.closed.length}, ignored ${r.ignored} comment(s)`].join('\n'));
  }
  if (sub === 'status' && !rest.length) {
    const s = await phoneStatus(dir);
    if (!s.config) return out('phone is not set up. swarm phone setup --repo OWNER/NAME');
    return out([`repo: ${s.config.repo}   listening to: ${s.config.owners.join(', ')}   ${s.config.enabled ? 'on' : 'OFF'}`, Object.entries(s.counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no questions yet'].join('\n'));
  }
  if (sub === 'off' && !rest.length) { const r = await phoneOff(dir); return r.ok ? out('phone is off: no issues are opened and no answers are read. swarm phone setup --repo ... turns it on again') : out(r.error, 1); }
  return out(PHONE_USAGE, 2);
}
