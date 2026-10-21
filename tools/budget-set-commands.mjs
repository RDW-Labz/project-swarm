// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveConfigPath } from './local-config.mjs';
import {
  resolveDailyLimit,
  validateDailyLimit,
  centralMidnightAfter,
} from './daily-limit.mjs';

const SET_OPTS = new Set(['--daily', '--mode', '--ceiling', '--machine']);

function stripBudgetPrefix(args) {
  if (args[0] === 'budget') return args.slice(1);
  return args;
}

export function parseBudgetSetArgs(args) {
  const rest = stripBudgetPrefix([...args]);
  if (!rest.length) return { errors: ['unknown budget command'] };

  const cmd = rest[0];
  if (cmd === 'show') {
    const json = rest.includes('--json');
    const unknown = rest.filter(token => token !== 'show' && token !== '--json');
    if (unknown.length) return { errors: [`unknown option: ${unknown[0]}`] };
    return { command: 'show', json };
  }

  if (cmd !== 'set') return { errors: [`unknown budget command: ${cmd}`] };

  let machine = false;
  const values = {};
  for (let i = 1; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--machine') {
      machine = true;
      continue;
    }
    if (!SET_OPTS.has(token)) return { errors: [`unknown option: ${token}`] };
    const key = token === '--daily' ? 'usd' : token === '--mode' ? 'mode' : 'ceilingUsd';
    const raw = rest[++i];
    if (raw === undefined) return { errors: [`missing value for ${token}`] };
    if (key === 'usd' || key === 'ceilingUsd') {
      const num = Number(raw);
      if (!Number.isFinite(num)) return { errors: [`invalid number: ${raw}`] };
      values[key] = num;
    } else {
      values[key] = raw;
    }
  }

  if (!Object.keys(values).length) return { errors: ['nothing to set'] };

  const errors = validateDailyLimit(values);
  if (values.usd !== undefined && values.ceilingUsd !== undefined && values.ceilingUsd < values.usd) {
    if (!errors.includes('ceilingUsd must be at least usd')) errors.push('ceilingUsd must be at least usd');
  }
  if (errors.length) return { errors };

  return { command: 'set', machine, values };
}

async function readJsonFile(fs, file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function atomicWriteJson(fs, file, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, 'wx', mode);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  await fs.chmod(file, mode);
}

function projectDailyLimitPath(root) {
  return path.join(root, '.swarm', 'project', 'daily-limit.json');
}

async function loadMachineLayer(fs, env, homedir) {
  const file = resolveConfigPath({ env, home: homedir() });
  const config = await readJsonFile(fs, file);
  return { file, config, layer: config.dailyLimit ?? null };
}

async function loadProjectLayer(fs, root) {
  const file = projectDailyLimitPath(root);
  const data = await readJsonFile(fs, file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { file, layer: null };
  const { usd, mode, ceilingUsd } = data;
  const layer = {};
  if (usd !== undefined) layer.usd = usd;
  if (mode !== undefined) layer.mode = mode;
  if (ceilingUsd !== undefined) layer.ceilingUsd = ceilingUsd;
  return { file, layer: Object.keys(layer).length ? layer : null };
}

function mergeLayer(existing, patch) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  for (const [key, value] of Object.entries(patch)) base[key] = value;
  return base;
}

export async function budgetCommand(args, { out, env, root, fs, homedir, billedToday } = {}) {
  const parsed = parseBudgetSetArgs(args);
  if (parsed.errors) {
    out.write(`${parsed.errors.join('\n')}\n`);
    return 1;
  }

  const now = Date.now;
  const homedirFn = homedir ?? (() => env?.HOME ?? process.env.HOME);

  if (parsed.command === 'set') {
    if (parsed.machine) {
      const { file, config, layer } = await loadMachineLayer(fs, env, homedirFn);
      const merged = mergeLayer(layer, parsed.values);
      const mergedErrors = validateDailyLimit(merged);
      if (mergedErrors.length) {
        out.write(`${mergedErrors.join('\n')}\n`);
        return 1;
      }
      config.dailyLimit = merged;
      await atomicWriteJson(fs, file, config, { mode: 0o644 });
    } else {
      const { file, layer } = await loadProjectLayer(fs, root);
      const merged = mergeLayer(layer, parsed.values);
      const mergedErrors = validateDailyLimit(merged);
      if (mergedErrors.length) {
        out.write(`${mergedErrors.join('\n')}\n`);
        return 1;
      }
      await atomicWriteJson(fs, file, merged, { mode: 0o600 });
    }
    return 0;
  }

  const machineInfo = await loadMachineLayer(fs, env, homedirFn);
  const projectInfo = await loadProjectLayer(fs, root);
  const resolved = resolveDailyLimit({ machine: machineInfo.layer, project: projectInfo.layer });
  const billed =
    typeof billedToday === 'function'
      ? await billedToday({ root, env })
      : 0;
  const resetsAt = centralMidnightAfter(now);
  const payload = {
    dailyLimitUsd: resolved.dailyLimitUsd,
    dailyLimitMode: resolved.dailyLimitMode,
    hardCeilingUsd: resolved.hardCeilingUsd,
    source: resolved.source,
    billedTodayUsd: billed,
    resetsAt,
    machine: machineInfo.layer,
    project: projectInfo.layer,
  };

  if (parsed.json) {
    out.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    out.write(
      `daily limit: $${resolved.dailyLimitUsd.toFixed(2)} (${resolved.dailyLimitMode}, ceiling $${resolved.hardCeilingUsd.toFixed(2)}) [${resolved.source}]\n`,
    );
    out.write(`billed today: $${Number(billed).toFixed(2)}\n`);
    out.write(`resets at: ${new Date(resetsAt).toISOString()}\n`);
  }
  return 0;
}
