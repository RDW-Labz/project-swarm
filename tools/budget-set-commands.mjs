// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import crypto from 'node:crypto';
import tty from 'node:tty';
import { resolveConfigPath } from './local-config.mjs';
import {
  resolveDailyLimit,
  validateDailyLimit,
  centralMidnightAfter,
  centralDayKey,
} from './daily-limit.mjs';

export const BUDGET_SET_LOG_REL = '.swarm/project/daily-limit-set.log';
export const BUDGET_SET_MACHINE_LOG_BASENAME = 'daily-limit-set-machine.log';
export const BUDGET_RAISE_APPROVAL_REL = '.swarm/project/daily-limit-raise-approval.json';
export const BUDGET_RAISE_PENDING_REL = '.swarm/project/daily-limit-raise-pending.json';
export const BUDGET_RAISE_PENDING_MACHINE_BASENAME = 'daily-limit-raise-pending-machine.json';
export const BUDGET_RAISE_APPROVAL_MACHINE_BASENAME = 'daily-limit-raise-approval-machine.json';
export const OWNER_APPROVAL_TTL_MS = 15 * 60 * 1000;
export const DAILY_AGENT_RAISE_ALLOWANCE_USD = 5;

const SET_OPTS = new Set(['--daily', '--mode', '--ceiling', '--machine']);

function stripBudgetPrefix(args) {
  if (args[0] === 'budget') return args.slice(1);
  return args;
}

const AGENT_ENV_PREFIXES = ['CLAUDE', 'CODEX', 'CURSOR', 'AIDER', 'OPENCODE'];
const AGENT_TERM_PROGRAMS = new Set(['vscode', 'cursor', 'windsurf', 'zed']);

function envNamesSuggestAgent(env) {
  for (const key of Object.keys(env ?? {})) {
    const upper = key.toUpperCase();
    for (const prefix of AGENT_ENV_PREFIXES) {
      if (upper.startsWith(prefix)) return true;
    }
  }
  return false;
}

// Owner terminal: stdin and stdout TTYs, no CLAUDE/CODEX/CURSOR/AIDER/OPENCODE env names, TERM_PROGRAM not an agent shell.
export function budgetSetActor(env = process.env, { stdinIsTTY, stdoutIsTTY, overlay } = {}) {
  const agentEnv = overlay !== undefined ? overlay : env;
  if (envNamesSuggestAgent(agentEnv)) return 'agent-session';
  const termProgram = String(env?.TERM_PROGRAM ?? '').toLowerCase();
  if (termProgram && AGENT_TERM_PROGRAMS.has(termProgram)) return 'agent-session';
  const stdinTTY = stdinIsTTY ?? tty.isatty(0);
  const stdoutTTY = stdoutIsTTY ?? tty.isatty(1);
  if (!stdinTTY || !stdoutTTY) return 'agent-session';
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
    const machine = rest.includes('--machine');
    const unknown = rest.filter(token => token !== 'approve-raise' && token !== '--yes' && token !== '--machine');
    if (unknown.length) return { errors: [`unknown option: ${unknown[0]}`] };
    if (!yes) return { errors: ['budget approve-raise needs --yes'] };
    return { command: 'approve-raise', machine };
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

function machineBudgetLogPath(machineConfigFile) {
  return path.join(path.dirname(machineConfigFile), BUDGET_SET_MACHINE_LOG_BASENAME);
}

function machineBudgetPendingPath(machineConfigFile) {
  return path.join(path.dirname(machineConfigFile), BUDGET_RAISE_PENDING_MACHINE_BASENAME);
}

function machineBudgetApprovalPath(machineConfigFile) {
  return path.join(path.dirname(machineConfigFile), BUDGET_RAISE_APPROVAL_MACHINE_BASENAME);
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

function effectiveSnapshot(machineLayer, projectLayer) {
  const resolved = resolveDailyLimit({ machine: machineLayer, project: projectLayer });
  return {
    usd: resolved.dailyLimitUsd,
    mode: resolved.dailyLimitMode,
    ceilingUsd: resolved.hardCeilingUsd,
    source: resolved.source,
    reports: resolved.reports ?? [],
  };
}

function machineOnlySnapshot(machineLayer) {
  const resolved = resolveDailyLimit({ machine: machineLayer, project: null });
  return {
    usd: resolved.dailyLimitUsd,
    mode: resolved.dailyLimitMode,
    ceilingUsd: resolved.hardCeilingUsd,
    source: resolved.source,
    reports: resolved.reports ?? [],
  };
}

/** USD raised by this patch toward effective limits (includes implied 3× ceiling when only usd rises). */
export function raiseDeltaUsd(before, after, patch) {
  let delta = 0;
  if (patch.usd !== undefined && patch.usd > before.usd) delta += patch.usd - before.usd;
  if (patch.ceilingUsd !== undefined && patch.ceilingUsd > before.ceilingUsd) {
    delta += patch.ceilingUsd - before.ceilingUsd;
  }
  if (patch.usd !== undefined && patch.ceilingUsd === undefined && after.ceilingUsd > before.ceilingUsd + 1e-9) {
    delta += after.ceilingUsd - before.ceilingUsd;
  }
  return delta;
}

export function raisedTodayUsdFromLogLines(lines, { day, machine }) {
  let sum = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try { record = JSON.parse(trimmed); } catch { continue; }
    if (record.day !== day) continue;
    if (Boolean(record.machine) !== Boolean(machine)) continue;
    if (record.refused) continue;
    const delta = Number(record.raiseDeltaUsd);
    if (Number.isFinite(delta) && delta > 0) sum += delta;
  }
  return sum;
}

export async function readBudgetSetLogLines(fs, { root, machineConfigFile, machine }) {
  const file = machine
    ? machineBudgetLogPath(machineConfigFile)
    : path.join(root, BUDGET_SET_LOG_REL);
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split('\n');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function raisedTodayUsdFromLog(fs, { root, machine, machineConfigFile, now = Date.now }) {
  const day = centralDayKey(now);
  const lines = await readBudgetSetLogLines(fs, { root, machineConfigFile, machine });
  return raisedTodayUsdFromLogLines(lines, { day, machine });
}

export function needsOwnerApproval(before, after, patch, raisedTodayUsd = 0) {
  if (patch.mode === 'notify' && before.mode === 'stop') return true;
  const delta = raiseDeltaUsd(before, after, patch);
  if (delta <= 0) return false;
  return raisedTodayUsd + delta > DAILY_AGENT_RAISE_ALLOWANCE_USD;
}

function approvalRequestMatches(approval, { machine, patch }) {
  const req = approval?.request;
  if (req === undefined || req === null) return false;
  if (typeof req !== 'object') return false;
  if (Boolean(req.machine) !== Boolean(machine)) return false;
  const want = req.patch ?? {};
  for (const key of ['usd', 'mode', 'ceilingUsd']) {
    if (patch[key] === undefined) {
      if (want[key] !== undefined) return false;
    } else if (patch[key] !== want[key]) return false;
  }
  for (const key of Object.keys(want)) {
    if (patch[key] === undefined) return false;
  }
  return true;
}

export async function readOwnerBudgetApproval(fs, root, { now = Date.now } = {}) {
  return readOwnerBudgetApprovalFile(fs, path.join(root, BUDGET_RAISE_APPROVAL_REL), { now });
}

export async function readBudgetRaisePending(fs, root) {
  const file = path.join(root, BUDGET_RAISE_PENDING_REL);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeBudgetRaisePending(fs, root, request, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const file = path.join(root, BUDGET_RAISE_PENDING_REL);
  await atomicWriteJson(fs, file, { at: new Date(nowMs).toISOString(), request }, { mode: 0o600 });
}

export async function clearBudgetRaisePending(fs, root) {
  try {
    await fs.unlink(path.join(root, BUDGET_RAISE_PENDING_REL));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function readBudgetRaisePendingMachine(fs, machineConfigFile) {
  const file = machineBudgetPendingPath(machineConfigFile);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeBudgetRaisePendingMachine(fs, machineConfigFile, request, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const file = machineBudgetPendingPath(machineConfigFile);
  await atomicWriteJson(fs, file, { at: new Date(nowMs).toISOString(), request }, { mode: 0o600 });
}

export async function clearBudgetRaisePendingMachine(fs, machineConfigFile) {
  try {
    await fs.unlink(machineBudgetPendingPath(machineConfigFile));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readOwnerBudgetApprovalFile(fs, file, { now = Date.now } = {}) {
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

export async function readOwnerBudgetApprovalMachine(fs, machineConfigFile, { now = Date.now } = {}) {
  return readOwnerBudgetApprovalFile(fs, machineBudgetApprovalPath(machineConfigFile), { now });
}

export async function writeOwnerBudgetApprovalMachine(fs, machineConfigFile, { request, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const at = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + OWNER_APPROVAL_TTL_MS).toISOString();
  const file = machineBudgetApprovalPath(machineConfigFile);
  const payload = { at, expiresAt, by: 'owner' };
  if (request) payload.request = request;
  await atomicWriteJson(fs, file, payload, { mode: 0o600 });
}

export async function consumeOwnerBudgetApprovalMachine(fs, machineConfigFile) {
  try {
    await fs.unlink(machineBudgetApprovalPath(machineConfigFile));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function writeOwnerBudgetApproval(fs, root, { request, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const at = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + OWNER_APPROVAL_TTL_MS).toISOString();
  const file = path.join(root, BUDGET_RAISE_APPROVAL_REL);
  const payload = { at, expiresAt, by: 'owner' };
  if (request) payload.request = request;
  await atomicWriteJson(fs, file, payload, { mode: 0o600 });
}

export async function consumeOwnerBudgetApproval(fs, root) {
  try {
    await fs.unlink(path.join(root, BUDGET_RAISE_APPROVAL_REL));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function appendBudgetSetLog(fs, file, record) {
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

async function applyBudgetSet({
  parsed,
  machineInfo,
  projectInfo,
  before,
  after,
  actorEnv,
  root,
  fs,
  now,
  appendEvent,
  out,
  actorOpts,
}) {
  const who = budgetSetActor(actorEnv, actorOpts);
  const nowMs = typeof now === 'function' ? now() : now;
  const at = new Date(nowMs).toISOString();
  const day = centralDayKey(() => nowMs);
  const raiseDeltaUsdValue = who === 'agent-session' ? raiseDeltaUsd(before, after, parsed.values) : 0;
  const record = {
    at,
    day,
    who,
    machine: parsed.machine,
    before,
    after,
    patch: parsed.values,
    raiseDeltaUsd: raiseDeltaUsdValue,
  };

  const projectLog = path.join(root, BUDGET_SET_LOG_REL);
  const machineLog = machineBudgetLogPath(machineInfo.file);

  await appendBudgetSetLog(fs, parsed.machine ? machineLog : projectLog, record);
  if (!parsed.machine) {
    await appendBudgetJournal(root, record, { appendEvent });
  }

  if (parsed.machine) {
    machineInfo.config.dailyLimit = mergeLayer(machineInfo.layer, parsed.values);
    let mode = 0o600;
    try {
      const stat = await fs.stat(machineInfo.file);
      mode = stat.mode & 0o777;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await atomicWriteJson(fs, machineInfo.file, machineInfo.config, { mode, chmod: false });
  } else {
    const merged = mergeLayer(projectInfo.layer, parsed.values);
    await atomicWriteJson(fs, projectInfo.file, merged, { mode: 0o600 });
  }

  if (who === 'agent-session') {
    if (parsed.machine) {
      await consumeOwnerBudgetApprovalMachine(fs, machineInfo.file);
      await clearBudgetRaisePendingMachine(fs, machineInfo.file);
    } else {
      await consumeOwnerBudgetApproval(fs, root);
      await clearBudgetRaisePending(fs, root);
    }
  }

  if (parsed.machine && who === 'owner-terminal' && raiseDeltaUsd(before, after, parsed.values) <= 0) {
    await clearBudgetRaisePendingMachine(fs, machineInfo.file);
  }

  const refreshedMachine = parsed.machine
    ? mergeLayer(machineInfo.layer, parsed.values)
    : machineInfo.layer;
  const refreshedProject = parsed.machine
    ? projectInfo.layer
    : mergeLayer(projectInfo.layer, parsed.values);
  const effective = resolveDailyLimit({ machine: refreshedMachine, project: refreshedProject });
  for (const line of effective.reports ?? []) {
    out.write(`budget set: ${line}\n`);
  }
  return 0;
}

async function refuseBudgetSet({
  parsed,
  before,
  after,
  actorEnv,
  root,
  fs,
  machineInfo,
  now,
  out,
  reason,
  actorOpts,
}) {
  const who = budgetSetActor(actorEnv, actorOpts);
  const nowMs = typeof now === 'function' ? now() : now;
  const at = new Date(nowMs).toISOString();
  const day = centralDayKey(() => nowMs);
  const record = {
    at,
    day,
    who,
    machine: parsed.machine,
    before,
    after,
    patch: parsed.values,
    refused: true,
    reason,
    raiseDeltaUsd: 0,
  };
  const projectLog = path.join(root, BUDGET_SET_LOG_REL);
  const machineLog = machineBudgetLogPath(machineInfo.file);
  await appendBudgetSetLog(fs, parsed.machine ? machineLog : projectLog, record);
  if (parsed.machine) {
    await writeBudgetRaisePendingMachine(
      fs,
      machineInfo.file,
      { machine: true, patch: parsed.values },
      { now },
    );
  } else {
    await writeBudgetRaisePending(fs, root, { machine: false, patch: parsed.values }, { now });
  }
  out.write(`${agentBudgetRaiseRefusalMessage()}\n`);
  return 1;
}

export async function budgetCommand(args, { out, env, root, fs, homedir, billedToday, now = Date.now, appendEvent, stdinIsTTY, stdoutIsTTY } = {}) {
  const parsed = parseBudgetSetArgs(args);
  if (parsed.errors) {
    out.write(`${parsed.errors.join('\n')}\n`);
    return 1;
  }

  const actorEnv = env !== undefined ? env : process.env;
  const homedirFn = homedir ?? (() => actorEnv?.HOME ?? process.env.HOME);
  const actorOpts = { stdinIsTTY, stdoutIsTTY, overlay: env };

  if (parsed.command === 'approve-raise') {
    if (budgetSetActor(actorEnv, actorOpts) === 'agent-session') {
      out.write('budget approve-raise must be run from the owner terminal (not inside an agent session)\n');
      return 1;
    }
    const machineInfo = await loadMachineLayer(fs, env, homedirFn);
    if (parsed.machine) {
      const pending = await readBudgetRaisePendingMachine(fs, machineInfo.file);
      const request = pending?.request ?? null;
      if (!request) {
        out.write('budget approve-raise: no pending agent raise request\n');
        return 1;
      }
      await writeOwnerBudgetApprovalMachine(fs, machineInfo.file, { request, now });
      await clearBudgetRaisePendingMachine(fs, machineInfo.file);
      out.write('budget raise approval recorded (valid 15 minutes)\n');
      return 0;
    }
    const pending = await readBudgetRaisePending(fs, root);
    const request = pending?.request ?? null;
    if (!request) {
      const machinePending = await readBudgetRaisePendingMachine(fs, machineInfo.file);
      if (machinePending?.request) {
        out.write(
          'budget approve-raise: a machine-wide raise request is pending; run swarm budget approve-raise --machine --yes\n',
        );
        return 1;
      }
      out.write('budget approve-raise: no pending agent raise request\n');
      return 1;
    }
    await writeOwnerBudgetApproval(fs, root, { request, now });
    await clearBudgetRaisePending(fs, root);
    out.write('budget raise approval recorded (valid 15 minutes)\n');
    return 0;
  }

  if (parsed.command === 'set') {
    const machineInfo = await loadMachineLayer(fs, env, homedirFn);
    const projectInfo = await loadProjectLayer(fs, root);
    const before = parsed.machine
      ? machineOnlySnapshot(machineInfo.layer)
      : effectiveSnapshot(machineInfo.layer, projectInfo.layer);

    const mergedMachine = parsed.machine ? mergeLayer(machineInfo.layer, parsed.values) : machineInfo.layer;
    const mergedProject = parsed.machine ? projectInfo.layer : mergeLayer(projectInfo.layer, parsed.values);
    const mergedErrors = validateDailyLimit(parsed.machine ? mergedMachine : mergedProject);
    if (mergedErrors.length) {
      out.write(`${mergedErrors.join('\n')}\n`);
      return 1;
    }
    const after = parsed.machine
      ? machineOnlySnapshot(mergedMachine)
      : effectiveSnapshot(machineInfo.layer, mergedProject);

    if (budgetSetActor(actorEnv, actorOpts) === 'agent-session') {
      const raisedToday = await raisedTodayUsdFromLog(fs, {
        root,
        machine: parsed.machine,
        machineConfigFile: machineInfo.file,
        now,
      });
      if (needsOwnerApproval(before, after, parsed.values, raisedToday)) {
        const approval = parsed.machine
          ? await readOwnerBudgetApprovalMachine(fs, machineInfo.file, { now })
          : await readOwnerBudgetApproval(fs, root, { now });
        if (!approval || !approvalRequestMatches(approval, { machine: parsed.machine, patch: parsed.values })) {
          return await refuseBudgetSet({
            parsed,
            before,
            after,
            actorEnv,
            root,
            fs,
            machineInfo,
            now,
            out,
            reason: 'missing-or-mismatched-approval',
            actorOpts,
          });
        }
      }
    }

    return await applyBudgetSet({
      parsed,
      machineInfo,
      projectInfo,
      before,
      after,
      actorEnv,
      root,
      fs,
      now,
      appendEvent,
      out,
      actorOpts,
    });
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
