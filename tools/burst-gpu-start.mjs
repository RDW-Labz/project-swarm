import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GATE_THRESHOLDS = Object.freeze({
  minReadyOverFreeDays: 3,
  minGpuFirstTryPassRate: 0.9,
});

export function evaluateGates(metrics) {
  const m = metrics ?? {};
  const days = Number(m.readyOverFreeDays);
  const gpuRate = Number(m.gpuFirstTryPassRate);
  const rows = [
    {
      name: 'ready-over-free-slots',
      value: `${Number.isFinite(days) ? days : 'missing'} consecutive days`,
      pass: Number.isFinite(days) && days >= GATE_THRESHOLDS.minReadyOverFreeDays,
    },
    {
      name: 'flat-rate-rate-limited',
      value: m.flatRateRateLimited === true ? 'all flat-rate lanes limited' : 'not all flat-rate lanes limited',
      pass: m.flatRateRateLimited === true,
    },
    {
      name: 'gpu-first-try-pass-rate',
      value: Number.isFinite(gpuRate) ? `${(gpuRate * 100).toFixed(0)} percent` : 'missing',
      pass: Number.isFinite(gpuRate) && gpuRate >= GATE_THRESHOLDS.minGpuFirstTryPassRate,
    },
  ];
  return { rows, pass: rows.every((r) => r.pass) };
}

export function formatGates(result) {
  return result.rows.map((r) => `gate ${r.name}: ${r.value} ${r.pass ? 'PASS' : 'FAIL'}`);
}

export function assertRentedLaneAllowed(ticket) {
  if (!ticket || ticket.sensitive !== false) {
    const id = ticket && ticket.id ? ticket.id : 'unknown';
    throw new Error(`not allowed on rented lane: ${id}`);
  }
  return ticket;
}

export function filterRentedTickets(tickets) {
  return (tickets ?? []).map((t) => assertRentedLaneAllowed(t));
}

export async function gpuStart(metrics, provision) {
  const result = evaluateGates(metrics);
  const lines = formatGates(result);
  if (!result.pass) {
    return { started: false, exitCode: 1, message: 'gates not met', lines };
  }
  if (typeof provision !== 'function') {
    return { started: false, exitCode: 1, message: 'no provisioner configured', lines };
  }
  await provision();
  return { started: true, exitCode: 0, message: 'started', lines };
}

function readArg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'burst' || args[1] !== 'gpu' || (args[2] !== 'status' && args[2] !== 'start')) {
    process.stderr.write('usage: swarm burst gpu status|start --metrics <file.json>\n');
    return 2;
  }
  const metricsPath = readArg(args, '--metrics');
  let metrics = {};
  if (metricsPath) {
    metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
  }
  if (args[2] === 'status') {
    const result = evaluateGates(metrics);
    for (const line of formatGates(result)) process.stdout.write(`${line}\n`);
    return 0;
  }
  const result = await gpuStart(metrics, null);
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (!result.started) {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  }, (err) => {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
