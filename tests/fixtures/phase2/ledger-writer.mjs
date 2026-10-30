// JSON lines over stdout/stdin form barriers; no timing sleeps.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { addGoal, removeGoal } from '../../../tools/backlog.mjs';
import { readLedger, writeLedger, transition } from '../../../tools/tickets.mjs';
import { claim, renew, release, sweepExpiredLeases } from '../../../tools/ledger-lease.mjs';

const [root, raw] = process.argv.slice(2);
const options = JSON.parse(raw);
const lines = readline.createInterface({ input: process.stdin });
const commands = [];
let waiter;
lines.on('line', line => {
  const value = JSON.parse(line);
  if (waiter) { const resolve = waiter; waiter = null; resolve(value); }
  else commands.push(value);
});
const next = () => commands.length ? Promise.resolve(commands.shift()) : new Promise(resolve => { waiter = resolve; });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const trace = [];
const original = Object.fromEntries(['readFile', 'open', 'mkdir', 'rename'].map(key => [key, fs[key].bind(fs)]));
for (const key of ['open', 'mkdir']) {
  fs[key] = async (file, ...args) => {
    trace.push({ operation: key, path: path.relative(root, String(file)) });
    return original[key](file, ...args);
  };
}
let paused = false;
async function pause(point, extra = {}) {
  if (paused) return;
  paused = true;
  send({ event: 'paused', point, trace, ...extra });
  await next();
}
fs.readFile = async (file, ...args) => {
  const result = await original.readFile(file, ...args);
  if (options.pauseRead && path.basename(String(file)) === options.pauseRead) await pause('read');
  return result;
};
fs.rename = async (from, to) => {
  if (options.pauseTicketRename && path.basename(String(to)) === 'tickets.json') {
    await pause('ticket-rename', { temporary: path.relative(root, from) });
  }
  const result = await original.rename(from, to);
  if (options.pauseAfterLeases && path.basename(String(to)) === 'leases.json') await pause('leases-persisted');
  return result;
};
send({ event: 'ready', pid: process.pid });
await next();
try {
  let result;
  switch (options.operation) {
    case 'add': result = await addGoal(root, { id: options.id, goal: options.id }, { now: () => options.now }); break;
    case 'remove': result = await removeGoal(root, options.id); break;
    case 'write': {
      const ledger = await readLedger(root);
      ledger.tickets.find(ticket => ticket.id === options.id).title = options.title;
      result = await writeLedger(root, ledger);
      break;
    }
    case 'transition': result = await transition(root, options.id, options.to, { now: options.now }); break;
    case 'claim': result = await claim(root, options.id, options.holder, { now: options.now, leaseTtlMs: 60000 }); break;
    case 'renew': result = await renew(root, options.id, options.token, { now: options.now, leaseTtlMs: 60000 }); break;
    case 'release': result = await release(root, options.id, options.token, { now: options.now }); break;
    case 'sweep': result = await sweepExpiredLeases(root, { now: options.now }); break;
    default: throw new Error(`unknown operation: ${options.operation}`);
  }
  send({ event: 'result', ok: true, result: result ?? null, trace });
} catch (error) {
  send({ event: 'result', ok: false, code: error.code ?? null, message: error.message, trace });
} finally {
  lines.close();
  process.stdin.destroy();
}
