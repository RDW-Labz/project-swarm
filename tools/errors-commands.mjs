// SPDX-License-Identifier: Apache-2.0
// swarm errors ingest [FILE|-] | pull [--dry-run] | list [--status S] | show ID | ignore ID --reason TEXT | resolve ID | digest [--no-write]
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateErrorsConfig, ingestErrors, readErrors, pullErrors, parseVercelLine, setGroupStatus, buildDigest, normalizeEvent, scrubText } from './errors.mjs';
import { readLedger } from './tickets.mjs';
import { appendEvent } from './journal.mjs';

export const ERRORS_USAGE = 'Usage: swarm errors pull [--dry-run]          (reads recent production errors with the vercel CLI you are logged in with)\n       swarm errors ingest [FILE|-]        (JSON lines: the vercel log format, or {at,message,route,stack})\n       swarm errors list [--status open|ignored|fixed] | show ID | ignore ID --reason TEXT | resolve ID | digest [--no-write]\nNew error groups become PROPOSED tickets (you approve them with swarm tickets ID --approve); a spike or a payments/auth error is an inbox decision now, the rest waits for the digest.\n';
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });

async function profileConfig(root) {
  let pointer;
  try { pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8')); } catch { return { config: validateErrorsConfig({}).config }; }
  if (pointer?.profile?.errors === undefined) return { config: validateErrorsConfig({}).config };
  const checked = validateErrorsConfig(pointer.profile.errors);
  return checked.ok ? { config: checked.config } : { error: `the errors block of the profile is invalid: ${checked.errors[0]}` };
}

const ticketDeps = root => ({
  addTicket: async partial => (await import('./scope-commands.mjs')).addProposedTicket(root, partial),
  ticketStatus: async id => (await readLedger(root).catch(() => null))?.tickets.find(t => t.id === id)?.status ?? null,
  notify: async (group, reason, ticketId) => {
    const stamp = Date.now();
    if (reason === 'flood') { await appendEvent(root, { kind: 'decision', id: `error-flood-${stamp}`, text: `${group.count} more production error groups need a look (a flood; only the first few were listed one by one). swarm errors list shows them; their proposed tickets are in swarm tickets --status proposed.`, choice: 'looked', options: ['looked'], confirm: true }).catch(() => {}); return; }
    const text = `Production error ERR-${group.fingerprint.slice(0, 8)} (${reason === 'spike' ? 'a spike' : 'a payments or auth route'}): ${group.kind} on ${group.route}, ${group.count} time(s), last ${new Date(group.lastSeen).toISOString()}. ${ticketId ? `Proposed ticket ${ticketId}: read it, name its files, approve it with swarm tickets ${ticketId} --approve --yes.` : 'No ticket ledger yet, so no ticket was proposed.'} Details: swarm errors show ERR-${group.fingerprint.slice(0, 8)}.`;
    await appendEvent(root, { kind: 'decision', id: `error-${group.fingerprint.slice(0, 8)}-${reason}-${stamp}`, text, choice: 'looked', options: ['looked'], confirm: true }).catch(() => {});
  },
});

// An id is at least 8 hex characters and names exactly one group.
const find = (store, id) => { const want = String(id ?? '').replace(/^ERR-/i, '').toLowerCase(); if (!/^[0-9a-f]{8,}$/.test(want)) return null; const hits = Object.values(store.groups).filter(g => g.fingerprint.startsWith(want)); return hits.length === 1 ? hits[0] : null; };

const summary = r => `${r.accepted} new event(s) (${r.duplicates} already seen, ${r.skipped} skipped): ${r.newGroups.length} new group(s), ${r.reopened.length} came back, ${r.tickets.length} proposed ticket(s)${r.tickets.length ? ` (${r.tickets.join(', ')})` : ''}${r.held ? `, ${r.held} more held for the next pull` : ''}, ${r.notified.length} notification(s) in your inbox`;

export async function runErrorsCommand(root, args, { run, now, stdin = () => '' } = {}) {
  const [verb, ...rest] = args;
  const { config, error } = await profileConfig(root);
  if (error) return out(error, 1);
  if (verb === 'pull') {
    const dry = rest.includes('--dry-run');
    if (rest.some(a => a !== '--dry-run')) return out(`Unknown argument\n${ERRORS_USAGE}`, 2);
    let pulled;
    try { pulled = await pullErrors(root, { config, ...(run ? { run } : {}) }); } catch (e) { return out(e.message, 1); }
    const warn = (pulled.warnings ?? []).map(w => `warning: ${w}`);
    if (dry) {
      const sample = pulled.events.slice(0, 5).map(e => normalizeEvent(e)).filter(Boolean).map(e => `  ${e.kind} on ${e.route}: ${e.message}`);
      return out([`dry run: ${pulled.lines} line(s) from the log command, ${pulled.events.length} error event(s)`, ...sample, ...warn, 'nothing was stored'].join('\n'));
    }
    const result = await ingestErrors(root, pulled.events, { config, ...ticketDeps(root), ...(now ? { now } : {}) });
    return out([`pulled ${pulled.events.length} error event(s) from ${pulled.lines} line(s): ${summary(result)}`, ...warn].join('\n'));
  }
  if (verb === 'ingest') {
    const source = rest[0] ?? '-';
    let text;
    try { text = source === '-' ? await stdin() : await fs.readFile(source, 'utf8'); } catch { return out(`cannot read ${source}`, 1); }
    // A line the vercel parser declines (an info line, the summary) is not an error; only a line with no log level or status of its own is read as our own {at, message} shape.
    const events = String(text).split('\n').filter(Boolean).flatMap(line => { try { const obj = JSON.parse(line); const own = obj && typeof obj === 'object' && !obj.type && obj.level === undefined && obj.statusCode === undefined && obj.responseStatusCode === undefined; return [parseVercelLine(line) ?? (own ? obj : null)].filter(Boolean); } catch { return []; } });
    const result = await ingestErrors(root, events, { config, ...ticketDeps(root), ...(now ? { now } : {}) });
    return out(summary(result));
  }
  let store;
  try { store = await readErrors(root); } catch (e) { return out(e.message, 1); }
  if (verb === 'list') {
    const wanted = rest[0] === '--status' ? rest[1] : null;
    const groups = Object.values(store.groups).filter(g => !wanted || g.status === wanted).sort((a, b) => b.lastSeen - a.lastSeen);
    return out(groups.length ? groups.map(g => `ERR-${g.fingerprint.slice(0, 8)}  ${g.status}  ${g.count}x  ${g.kind} on ${g.route}  last ${new Date(g.lastSeen).toISOString()}${g.tickets.length ? `  ticket ${g.tickets.at(-1).id}` : ''}`).join('\n') : 'No error groups.');
  }
  if (verb === 'show') {
    const g = rest[0] ? find(store, rest[0]) : null;
    if (!g) return out(`no error ${rest[0] ?? ''}`, 1);
    return out([`ERR-${g.fingerprint.slice(0, 8)} (${g.status})`, `${g.kind} on ${g.route}`, `seen ${g.count} time(s), first ${new Date(g.firstSeen).toISOString()}, last ${new Date(g.lastSeen).toISOString()}`, `message (scrubbed): ${g.message}`, `frames: ${g.frames.map(f => `${f.fn} (${f.file})`).join(' <- ') || 'none'}`, `tickets: ${g.tickets.map(t => `${t.id}${t.reopenOf ? ` (came back after ${t.reopenOf})` : ''}`).join(', ') || 'none'}`].join('\n'));
  }
  if (verb === 'ignore' || verb === 'resolve') {
    const g = rest[0] ? find(store, rest[0]) : null;
    if (!g) return out(`no error ${rest[0] ?? ''}`, 1);
    const reasonAt = rest.indexOf('--reason');
    const reason = reasonAt >= 0 ? rest[reasonAt + 1] : null;
    if (verb === 'ignore' && Array.from(String(reason ?? '').trim()).length < 8) return out('ignore needs --reason TEXT (at least 8 characters)', 2);
    await setGroupStatus(root, g.fingerprint, verb === 'ignore' ? 'ignored' : 'fixed', { reason });
    return out(`ERR-${g.fingerprint.slice(0, 8)} is now ${verb === 'ignore' ? 'ignored' : 'fixed (a new occurrence reopens it as a new proposal)'}`);
  }
  if (verb === 'digest') {
    const digest = await buildDigest(root, { config, write: !rest.includes('--no-write'), ...(now ? { now } : {}) });
    return out(`${digest.text}${digest.file ? `written to ${digest.file}` : '(not written)'}`);
  }
  return out(`${verb ? `Unknown errors command: ${verb}\n` : ''}${ERRORS_USAGE}`, 2);
}
