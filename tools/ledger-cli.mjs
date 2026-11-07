// SPDX-License-Identifier: Apache-2.0
import { backupLedger, listLedgerBackups, restoreLedgerSnapshot } from './ledger-backup.mjs';

const out = (stdout, exitCode = 0) => ({ stdout: `${stdout}\n`, exitCode });
const bad = (message) => out(message, 1);

function parseLedgerArgs(args) {
  const flags = {};
  const rest = [];
  const known = new Set(['--all', '--yes', '--from', '--into', '--json']);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (!known.has(arg)) throw new Error(`unknown flag: ${arg}`);
      if (arg === '--from' || arg === '--into') {
        const val = args[++i];
        if (val === undefined) throw new Error(`${arg} needs a value`);
        flags[arg.slice(2)] = val;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else rest.push(arg);
  }
  return { flags, rest };
}

export async function runLedgerCommand(root, args, deps = {}) {
  try {
    const { flags, rest } = parseLedgerArgs(args);
    const sub = rest[0];
    if (sub === 'now') {
      const result = await backupLedger(root, { reason: 'manual', home: deps.home });
      if (!result.ok) return bad(`ledger backup failed: ${result.reason}`);
      if (result.skipped) return out(flags.json ? JSON.stringify(result) : `unchanged (${result.ledgerSha256.slice(0, 12)}); newest snapshot ${result.id}`);
      return out(flags.json ? JSON.stringify(result) : `snapshot ${result.id} (key ${result.key})`);
    }
    if (sub === 'list') {
      const list = await listLedgerBackups(root, { home: deps.home, all: flags.all === true });
      if (flags.json) return out(JSON.stringify(list));
      if (flags.all) {
        const lines = list.map((row) => `${row.key}  root=${row.root ?? '?'}  snapshots=${row.snapshots}`);
        return out(lines.join('\n') || 'no ledger backup keys');
      }
      const lines = list.map((row) => `${row.id}  ${row.at}  tickets=${row.ticketCount} done=${row.doneCount}  ${row.reason}`);
      return out(lines.join('\n') || 'no snapshots for this checkout');
    }
    if (sub === 'restore') {
      const id = rest[1] ?? 'latest';
      const result = await restoreLedgerSnapshot(root, {
        id,
        fromKey: flags.from,
        into: flags.into,
        yes: flags.yes === true,
        home: deps.home,
      });
      if (result.planned) {
        return out(`plan: restore snapshot ${result.id} (key ${result.key}); current ledger is kept unless you pass --yes (a pre-restore backup is taken first).`);
      }
      const stageLines = (result.stages ?? []).map((s) => `${s.name}: ${s.done}/${s.total}`);
      if (!result.ok) return out([`restore failed: ${result.reason}`, ...stageLines].join('\n'), 1);
      return out([`restored snapshot ${result.id} into ${flags.into ?? root}`, ...stageLines].join('\n'));
    }
    return bad('usage: swarm backup ledger now | list [--all] | restore [ID|latest] [--from KEY] [--into DIR] [--yes]');
  } catch (error) {
    return bad(String(error?.message ?? error));
  }
}
