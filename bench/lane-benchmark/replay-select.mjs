// SPDX-License-Identifier: Apache-2.0
// Pure selection logic for replay benchmark tickets; git/test hooks are injectable for unit tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALLOWED_TYPES = new Set(['build', 'test', 'docs', 'fix']);
const ALLOWED_RISK = new Set(['low', 'medium']);
const ALLOWED_SIZE = new Set(['S', 'M']);
const SEED = 0x62656e63;
const TARGET = 20;

const HASH_RE = /\b([0-9a-f]{7,40})\b/i;

export function parseLogLines(text) {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/** Last delivery wins: delivered events or done transitions with a merge hash. */
export function deliveryByTicket(events) {
  const out = new Map();
  for (const ev of events) {
    const id = ev.id;
    if (!id) continue;
    if (ev.event === 'delivered' && ev.mergeCommits?.length) {
      out.set(id, { mergeCommit: ev.mergeCommits[0], prs: ev.prs ?? [] });
      continue;
    }
    if (ev.event === 'transition' && ev.to === 'done' && ev.mergeCommits?.length) {
      out.set(id, { mergeCommit: ev.mergeCommits[0], prs: ev.prs ?? [] });
      continue;
    }
    if (ev.event === 'transition' && ev.to === 'done' && ev.note) {
      const m = HASH_RE.exec(ev.note);
      if (m) out.set(id, { mergeCommit: m[1], prs: [], fromNote: true });
    }
  }
  return out;
}

export function mergeHashFromTicketNote(note) {
  if (!note || typeof note !== 'string') return null;
  const m = HASH_RE.exec(note);
  return m ? m[1] : null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spread picks across ledger and type; candidates must already be sorted by id. */
export function seededPick(candidates, target = TARGET, seed = SEED) {
  if (candidates.length <= target) return [...candidates];
  const rng = mulberry32(seed);
  const buckets = new Map();
  for (const c of candidates) {
    const key = `${c.ledger}\0${c.type}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  for (const list of buckets.values()) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const keys = [...buckets.keys()].sort();
  const picked = [];
  const used = new Set();
  while (picked.length < target) {
    let progressed = false;
    for (const key of keys) {
      const list = buckets.get(key);
      while (list.length && used.has(list[0].id)) list.shift();
      if (!list.length) continue;
      const c = list.shift();
      picked.push(c);
      used.add(c.id);
      progressed = true;
      if (picked.length >= target) break;
    }
    if (!progressed) break;
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

export function ownedFilesOk(files, baseCommit, mergeCommit, git) {
  if (!files?.length || files.length > 3) return false;
  for (const file of files) {
    if (!git.existsAt(mergeCommit, file)) return false;
    const atMerge = git.readAt(mergeCommit, file);
    if (atMerge === null) return false;
    if (!git.existsAt(baseCommit, file)) continue;
    const atBase = git.readAt(baseCommit, file);
    if (atBase === null) return false;
    if (atBase === atMerge) return false;
  }
  return true;
}

export function ticketQualifies(ticket, delivery, git, runTestsAtMerge) {
  if (ticket.status !== 'done') return { ok: false, reason: 'not done' };
  if (ticket.sensitive) return { ok: false, reason: 'sensitive' };
  if (!ALLOWED_RISK.has(ticket.risk)) return { ok: false, reason: 'risk' };
  if (!ALLOWED_SIZE.has(ticket.size)) return { ok: false, reason: 'size' };
  if (!ALLOWED_TYPES.has(ticket.type)) return { ok: false, reason: 'type' };
  const files = ticket.files ?? [];
  if (files.length < 1 || files.length > 3) return { ok: false, reason: 'file count' };
  let mergeRef = delivery?.mergeCommit ?? mergeHashFromTicketNote(ticket.note);
  if (!mergeRef) return { ok: false, reason: 'no merge' };
  const resolved = git.resolveCommit(mergeRef);
  if (!resolved) return { ok: false, reason: 'unreachable merge' };
  const parents = git.parents(resolved);
  if (!parents.length) return { ok: false, reason: 'no parent' };
  const baseCommit = parents[0];
  if (!ownedFilesOk(files, baseCommit, resolved, git)) return { ok: false, reason: 'files' };
  const tests = (ticket.tests ?? []).filter(t => git.existsAt(resolved, t));
  if (!tests.length) return { ok: false, reason: 'no tests at merge' };
  if (!runTestsAtMerge(resolved, tests)) return { ok: false, reason: 'tests fail at merge' };
  return {
    ok: true,
    record: {
      id: ticket.id,
      title: ticket.title,
      type: ticket.type,
      baseCommit,
      mergeCommit: resolved,
      files,
      tests,
    },
  };
}

export function selectFromLedgers({ ledgers, git, runTestsAtMerge, target = TARGET, seed = SEED }) {
  const candidates = [];
  const byId = new Map();
  for (const { name: ledger, tickets, logText } of ledgers) {
    const deliveries = deliveryByTicket(parseLogLines(logText));
    for (const ticket of tickets) {
      const delivery = deliveries.get(ticket.id);
      const verdict = ticketQualifies(ticket, delivery, git, runTestsAtMerge);
      if (!verdict.ok) continue;
      const row = { ...verdict.record, ledger };
      const prev = byId.get(row.id);
      if (!prev) byId.set(row.id, row);
      else byId.set(row.id, { ...prev, ledger: [...new Set([prev.ledger, ledger])].join('+') });
    }
  }
  candidates.push(...byId.values());
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  const picked = seededPick(candidates, target, seed);
  return { selected: picked, qualifiedCount: candidates.length, target };
}

export function defaultGitOps(repoRoot) {
  const run = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return {
    resolveCommit(ref) {
      const r = run(['rev-parse', '--verify', `${ref}^{commit}`]);
      return r.status === 0 ? r.stdout.trim() : null;
    },
    parents(commit) {
      const r = run(['rev-parse', `${commit}^1`]);
      if (r.status !== 0) return [];
      return [r.stdout.trim()].filter(Boolean);
    },
    existsAt(commit, file) {
      return run(['cat-file', '-e', `${commit}:${file}`]).status === 0;
    },
    readAt(commit, file) {
      const r = run(['show', `${commit}:${file}`]);
      return r.status === 0 ? r.stdout : null;
    },
  };
}

export function archiveCheckout(repoRoot, commit, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(os.tmpdir(), `replay-select-${process.pid}-${Date.now()}.tar`);
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', '--format=tar', '-o', tar, commit, '--', '.'], { encoding: 'utf8' });
  if (archive.status !== 0) return false;
  const untar = spawnSync('tar', ['-xf', tar, '-C', dest], { encoding: 'utf8' });
  fs.rmSync(tar, { force: true });
  return untar.status === 0;
}

export function defaultRunTestsAtMerge(repoRoot) {
  return (mergeCommit, testFiles) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-select-verify-'));
    try {
      if (!archiveCheckout(repoRoot, mergeCommit, dir)) return false;
      const r = spawnSync(process.execPath, ['--import', './tests/_isolate-config.mjs', '--test', ...testFiles], {
        cwd: dir,
        env: { ...process.env, PATH: process.env.PATH },
        encoding: 'utf8',
        timeout: 180000,
      });
      return r.status === 0;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function runCli(argv = process.argv.slice(2)) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const inputDir = path.join(dir, 'replay-input');
  const repoRoot = path.resolve(dir, '../..');
  const ledgers = [
    { name: 'roadmap', tickets: JSON.parse(fs.readFileSync(path.join(inputDir, 'roadmap-tickets.json'), 'utf8')).tickets, logText: fs.readFileSync(path.join(inputDir, 'roadmap-tickets.log'), 'utf8') },
    { name: 'swarm', tickets: JSON.parse(fs.readFileSync(path.join(inputDir, 'swarm-tickets.json'), 'utf8')).tickets, logText: fs.readFileSync(path.join(inputDir, 'swarm-tickets.log'), 'utf8') },
  ];
  const git = defaultGitOps(repoRoot);
  const runTestsAtMerge = defaultRunTestsAtMerge(repoRoot);
  const { selected, qualifiedCount, target } = selectFromLedgers({ ledgers, git, runTestsAtMerge, target: TARGET });
  const outPath = path.join(dir, 'replay-selected.json');
  fs.writeFileSync(outPath, `${JSON.stringify({ version: 1, qualifiedCount, target, selected }, null, 2)}\n`);
  return { outPath, selected, qualifiedCount, target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { selected, qualifiedCount, target } = runCli();
  process.stderr.write(`replay-select: ${selected.length}/${target} from ${qualifiedCount} qualified\n`);
}
