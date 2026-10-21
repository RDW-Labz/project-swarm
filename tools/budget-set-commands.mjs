// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveConfigPath } from './local-config.mjs';
import {
  resolveDailyLimit,
  validateDailyLimit,
  centralMidnightAfter,
} from './daily-limit.mjs';

export const BUDGET_SET_LOG_REL = '.swarm/project/daily-limit-set.log';
export const BUDGET_RAISE_APPROVAL_REL = '.swarm/project/daily-limit-raise-approval.json';
export const OWNER_APPROVAL_TTL_MS = 15 * 60 * 1000;

const SET_OPTS = new Set(['--daily', '--mode', '--ceiling', '--machine']);

function stripBudgetPrefix(args) {
  if (args[0] === 'budget') return args.slice(1);
  return args;
}

export function budgetSetActor(env = process.env) {
  if (env?.CLAUDECODE !== undefined && env.CLAUDECODE !== null && String(env.CLAUDECODE) !== '') {
    return 'agent-session';
  }
  return 'owner-terminal';
}

export function agentBudgetRaiseRefusalMessage() {
  return 'budget-set: raising the daily limit or ceiling by more than $5, or switching stop to notify, needs owner approval. '
    + 'The owner runs: swarm budget approve-raise --yes (outside an agent session), then retries within 15 minutes.';
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

  if (cmd === 'approve-raise') {
    const yes = rest.includes('--yes');
    const unknown = rest.filter(token => token !== 'approve-raise' && token !== '--yes');
    if (unknown.length) return { errors: [`unknown option: ${unknown[0]}`] };
    if (!yes) return { errors: ['budget approve-raise needs --yes'] };
    return { command: 'approve-raise' };
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

async function atomicWriteJson(fs, file, data, { mode = 0o600, chmod = true } = {}) {
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
  if (chmod) await fs.chmod(file, mode);
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

export async function readOwnerBudgetApproval(fs, root, { now = Date.now } = {}) {
  const file = path.join(root, BUDGET_RAISE_APPROVAL_REL);
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const at = Date.parse(raw?.at);
    const expiresAt = Date.parse(raw?.expiresAt);
    const nowMs = typeof now === 'function' ? now() : now;
    if (!Number.isFinite(at) || !Number.isFinite(expiresAt) || nowMs > expiresAt) return null;
    if (raw?.by !== 'owner') return null;
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeOwnerBudgetApproval(fs, root, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const at = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + OWNER_APPROVAL_TTL_MS).toISOString();
  const file = path.join(root, BUDGET_RAISE_APPROVAL_REL);
  await atomicWriteJson(fs, file, { at, expiresAt, by: 'owner' }, { mode: 0o600 });
}

function effectiveSnapshot(machineLayer, projectLayer) {
  const resolved = resolveDailyLimit({ machine: machineLayer, project: projectLayer });
  return {
    usd: resolved.dailyLimitUsd,
    mode: resolved.dailyLimitMode,
    ceilingUsd: resolved.hardCeilingUsd,
    source: resolved.source,
  };
}

function isLoweringChange(before, after, patch) {
  if (patch.usd !== undefined && patch.usd < before.usd) return true;
  if (patch.ceilingUsd !== undefined && patch.ceilingUsd < before.ceilingUsd) return true;
  if (patch.mode === 'stop' && before.mode === 'notify') return true;
  return false;
}

function needsOwnerApproval(before, after, patch) {
  if (isLoweringChange(before, after, patch)) return false;
  if (patch.mode === 'notify' && before.mode === 'stop') return true;
  if (patch.usd !== undefined && patch.usd > before.usd + 5) return true;
  if (patch.ceilingUsd !== undefined && patch.ceilingUsd > before.ceilingUsd + 5) return true;
  return false;
}

async function appendBudgetSetLog(fs, root, record) {
  const file = path.join(root, BUDGET_SET_LOG_REL);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function appendBudgetJournal(root, record, { appendEvent } = {}) {
  const append = appendEvent ?? (async (r, event, opts) => {
    const { appendEvent: journalAppend } = await import('./journal.mjs');
    return journalAppend(r, event, opts);
  });
  await append(root, {
    kind: 'command',
    id: `budget-set-${record.at}`,
    title: `budget set (${record.who})`,
    detail: JSON.stringify({ before: record.before, after: record.after, machine: record.machine }),
  });
}

export async function budgetCommand(args, { out, env, root, fs, homedir, billedToday, now = Date.now, appendEvent } = {}) {
  const parsed = parseBudgetSetArgs(args);
  if (parsed.errors) {
    out.write(`${parsed.errors.join('\n')}\n`);
    return 1;
  }

  const homedirFn = homedir ?? (() => env?.HOME ?? process.env.HOME);

  if (parsed.command === 'approve-raise') {
    if (budgetSetActor(env) === 'agent-session') {
      out.write('budget approve-raise must be run from the owner terminal (not inside an agent session)\n');
      return 1;
    }
    await writeOwnerBudgetApproval(fs, root, { now });
    out.write('budget raise approval recorded (valid 15 minutes)\n');
    return 0;
  }

  if (parsed.command === 'set') {
    const machineInfo = await loadMachineLayer(fs, env, homedirFn);
    const projectInfo = await loadProjectLayer(fs, root);
    const before = effectiveSnapshot(machineInfo.layer, projectInfo.layer);

    if (parsed.machine) {
      const merged = mergeLayer(machineInfo.layer, parsed.values);
      const mergedErrors = validateDailyLimit(merged);
      if (mergedErrors.length) {
        out.write(`${mergedErrors.join('\n')}\n`);
        return 1;
      }
      const after = effectiveSnapshot(merged, projectInfo.layer);
      if (budgetSetActor(env) === 'agent-session' && needsOwnerApproval(before, after, parsed.values)) {
        const approval = await readOwnerBudgetApproval(fs, root, { now });
        if (!approval) {
          out.write(`${agentBudgetRaiseRefusalMessage()}\n`);
          return 1;
        }
      }
      machineInfo.config.dailyLimit = merged;
      let mode = 0o600;
      try {
        const stat = await fs.stat(machineInfo.file);
        mode = stat.mode & 0o777;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await atomicWriteJson(fs, machineInfo.file, machineInfo.config, { mode, chmod: false });
      const at = new Date(typeof now === 'function' ? now() : now).toISOString();
      const who = budgetSetActor(env);
      const record = { at, who, machine: true, before, after, patch: parsed.values };
      await appendBudgetSetLog(fs, root, record);
      await appendBudgetJournal(root, record, { appendEvent });
      return 0;
    }

    const merged = mergeLayer(projectInfo.layer, parsed.values);
    const mergedErrors = validateDailyLimit(merged);
    if (mergedErrors.length) {
      out.write(`${mergedErrors.join('\n')}\n`);
      return 1;
    }
    const after = effectiveSnapshot(machineInfo.layer, merged);
    if (budgetSetActor(env) === 'agent-session' && needsOwnerApproval(before, after, parsed.values)) {
      const approval = await readOwnerBudgetApproval(fs, root, { now });
      if (!approval) {
        out.write(`${agentBudgetRaiseRefusalMessage()}\n`);
        return 1;
      }
    }
    await atomicWriteJson(fs, projectInfo.file, merged, { mode: 0o600 });
    const at = new Date(typeof now === 'function' ? now() : now).toISOString();
    const who = budgetSetActor(env);
    const record = { at, who, machine: false, before, after, patch: parsed.values };
    await appendBudgetSetLog(fs, root, record);
    await appendBudgetJournal(root, record, { appendEvent });
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
    reports: resolved.reports ?? [],
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
