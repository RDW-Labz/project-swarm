// SPDX-License-Identifier: Apache-2.0
// R-042 / T-0238: machine-level swarm doctor sections for stage-1 rollout.
// Required sections fail doctor when any stage-1 flag is on; optional lane sections warn only.

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_AGENTS } from './api-adapters.mjs';
import { EXTRA_CLI_AGENTS } from './cli-adapters.mjs';
import { loadLocalConfig, resolveConfigPath } from './local-config.mjs';
import { isScratchRoot } from './projects.mjs';
import { isPortFree, resolvePortBlock } from './ports.mjs';

/** Stage-1 machine config keys (flags-off by default until opted in). */
export const STAGE1_FLAG_KEYS = Object.freeze([
  'event_store',
  'external_state',
  'swarm_service',
  'test_isolation',
  'branch_only_push',
]);

/** Tools this module depends on; verified before any real work. */
export const DOCTOR_CHECKS_DEPS = Object.freeze([
  'tools/local-config.mjs',
  'tools/projects.mjs',
  'tools/scratch-roots.mjs',
  'tools/ports.mjs',
  'tools/api-adapters.mjs',
  'tools/cli-adapters.mjs',
]);

export const OPTIONAL_LANE_AGENTS = Object.freeze([
  'claude',
  'codex',
  'cursor',
  ...EXTRA_CLI_AGENTS,
  ...API_AGENTS,
]);

const EVENT_STORE_MIN_NODE = Object.freeze({ major: 22, minor: 13 });

export function parseNodeVersion(version = process.versions.node) {
  const [major, minor, patch] = String(version).split('.').map(part => Number(part));
  return { major, minor, patch };
}

export function nodeSupportsEventStore(version = process.versions.node) {
  const { major, minor } = parseNodeVersion(version);
  if (major > EVENT_STORE_MIN_NODE.major) return true;
  if (major < EVENT_STORE_MIN_NODE.major) return false;
  return minor >= EVENT_STORE_MIN_NODE.minor;
}

function flagValue(machine, key) {
  if (!machine || typeof machine !== 'object') return undefined;
  const nested = machine.stage1;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && nested[key] !== undefined) {
    return nested[key];
  }
  return machine[key];
}

/** True when a stage-1 flag is explicitly on (primary counts as on for store/state). */
export function stage1FlagEnabled(machine, key) {
  const raw = flagValue(machine, key);
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const norm = raw.trim().toLowerCase();
    return norm === 'on' || norm === 'true' || norm === 'primary' || norm === 'enabled';
  }
  return false;
}

export function enabledStage1Flags(machine) {
  return STAGE1_FLAG_KEYS.filter(key => stage1FlagEnabled(machine, key));
}

export function anyStage1FlagEnabled(machine) {
  return enabledStage1Flags(machine).length > 0;
}

export function shouldSkipDoctorChecksForRoot(root) {
  if (!root || typeof root !== 'string') return false;
  try {
    return isScratchRoot(root, { strict: true });
  } catch {
    return false;
  }
}

export function doctorCheckPremises(repoRoot) {
  const resolved = path.resolve(repoRoot ?? '.');
  const missing = [];
  const found = [];
  for (const rel of DOCTOR_CHECKS_DEPS) {
    const target = path.join(resolved, rel);
    if (existsSync(target)) found.push(rel);
    else missing.push(rel);
  }
  return { ok: missing.length === 0, root: resolved, found, missing };
}

function section(name, status, detail = {}) {
  return { name, status, ...detail };
}

async function requiredMachineConfigSection({ env, home }) {
  try {
    const configPath = resolveConfigPath({ env, home });
    if (!existsSync(configPath)) {
      return section('machine-config', 'passed', { note: 'no machine config file yet', path: configPath });
    }
    loadLocalConfig({ env, home });
    return section('machine-config', 'passed', { path: configPath });
  } catch (error) {
    return section('machine-config', 'failed', { message: String(error?.message ?? error) });
  }
}

function requiredEventStoreNodeSection({ nodeVersion = process.versions.node }) {
  if (nodeSupportsEventStore(nodeVersion)) {
    return section('event-store-node', 'passed', { node: nodeVersion });
  }
  return section('event-store-node', 'failed', {
    node: nodeVersion,
    message: `event_store requires Node ${EVENT_STORE_MIN_NODE.major}.${EVENT_STORE_MIN_NODE.minor}+ (built-in node:sqlite)`,
  });
}

async function requiredExternalStateSection({ env, home }) {
  const base = path.join(home ?? os.homedir(), '.project-swarm', 'projects');
  try {
    await fs.mkdir(base, { recursive: true });
    const probe = path.join(base, '.doctor-probe');
    await fs.writeFile(probe, 'ok\n', { flag: 'w' });
    await fs.rm(probe);
    return section('external-state-store', 'passed', { dir: base });
  } catch (error) {
    return section('external-state-store', 'failed', {
      dir: base,
      message: String(error?.message ?? error),
    });
  }
}

async function requiredTestIsolationSection({ repoRoot, isFree = isPortFree }) {
  const root = path.resolve(repoRoot ?? '.');
  if (shouldSkipDoctorChecksForRoot(root)) {
    return section('test-isolation-ports', 'skipped', { reason: 'scratch-root' });
  }
  try {
    const { base, moved } = await resolvePortBlock(root, { isFree });
    return section('test-isolation-ports', 'passed', { portBase: base, moved });
  } catch (error) {
    return section('test-isolation-ports', 'failed', { message: String(error?.message ?? error) });
  }
}

/**
 * Required doctor sections for stage-1. Fails closed when a enabled flag needs a check that did not pass.
 */
export async function runRequiredDoctorSections({
  machine,
  repoRoot,
  env = process.env,
  home = env.HOME || os.homedir(),
  nodeVersion = process.versions.node,
  isFree = isPortFree,
} = {}) {
  const flags = enabledStage1Flags(machine);
  const premises = doctorCheckPremises(repoRoot);
  const sections = [];

  sections.push(
    premises.ok
      ? section('dependencies', 'passed', { found: premises.found })
      : section('dependencies', 'failed', { found: premises.found, missing: premises.missing }),
  );

  if (!premises.ok) return { flags, sections };

  sections.push(await requiredMachineConfigSection({ env, home }));

  if (stage1FlagEnabled(machine, 'event_store')) {
    sections.push(requiredEventStoreNodeSection({ nodeVersion }));
  }
  if (stage1FlagEnabled(machine, 'external_state')) {
    sections.push(await requiredExternalStateSection({ env, home }));
  }
  if (stage1FlagEnabled(machine, 'test_isolation')) {
    sections.push(await requiredTestIsolationSection({ repoRoot, isFree }));
  }

  return { flags, sections };
}

function laneWarning(agent, result) {
  if (!result || typeof result !== 'object') {
    return `lane ${agent}: no doctor result`;
  }
  const ready = result.status === 'compatible' || result.reachable === true;
  if (ready) return null;
  if (result.status === 'remote-unchecked') {
    return `lane ${agent}: remote host ${result.host ?? 'unknown'} (not probed on this machine)`;
  }
  if (result.configured === true && result.reachable === false) {
    return `lane ${agent}: configured but unreachable`;
  }
  if (result.configured === true) {
    return `lane ${agent}: configured; run a bounded smoke job`;
  }
  const note = result.note || result.message;
  return `lane ${agent}: ${note || 'needs setup — run swarm doctor ' + agent}`;
}

/**
 * Optional lane sections: warnings only; never fail doctor (AC2).
 */
export async function runOptionalLaneSections({
  machine,
  agents = OPTIONAL_LANE_AGENTS,
  doctorImpl,
  skipRemote = true,
} = {}) {
  const configured = machine?.lanes && typeof machine.lanes === 'object' ? machine.lanes : {};
  const list = agents.filter(agent => {
    if (agent === 'claude') return true;
    const lane = configured[agent];
    return lane && typeof lane === 'object' && (lane.model || lane.endpoint || lane.host);
  });
  const sections = [];
  if (!doctorImpl) {
    for (const agent of list) {
      sections.push(section(`lane:${agent}`, 'warn', { message: `lane ${agent}: doctor hook not run (no doctorImpl)` }));
    }
    return sections;
  }
  for (const agent of list) {
    try {
      const result = await doctorImpl({ agent, probeLocal: false });
      if (skipRemote && result?.status === 'remote-unchecked') {
        sections.push(section(`lane:${agent}`, 'warn', { message: laneWarning(agent, result) }));
        continue;
      }
      const message = laneWarning(agent, result);
      if (message) sections.push(section(`lane:${agent}`, 'warn', { message, agent, result }));
      else sections.push(section(`lane:${agent}`, 'ok', { agent }));
    } catch (error) {
      sections.push(section(`lane:${agent}`, 'warn', {
        message: `lane ${agent}: ${String(error?.message ?? error)}`,
      }));
    }
  }
  return sections;
}

export function requiredSectionsPassed(sections) {
  return (sections ?? []).every(entry => {
    if (!entry || typeof entry !== 'object') return false;
    return entry.status === 'passed' || entry.status === 'skipped';
  });
}

/** Overall doctor ok: optional lane sections never affect this (AC2). */
export function doctorReportOk({ stage1Enabled, required, optional: _optional }) {
  if (!stage1Enabled) return true;
  return requiredSectionsPassed(required);
}

export function collectDoctorWarnings(optional) {
  return (optional ?? [])
    .filter(entry => entry && (entry.status === 'warn' || entry.status === 'warning'))
    .map(entry => entry.message || `${entry.name}: warning`);
}

/**
 * Run stage-1 doctor checks for a machine config and repo root.
 * Skips scratch copies (orchestrator worktrees) for port allocation checks.
 */
export async function runMachineDoctorChecks({
  machine,
  repoRoot,
  env = process.env,
  home = env.HOME || os.homedir(),
  doctorImpl,
  skipScratch = true,
  ...rest
} = {}) {
  const resolvedRoot = path.resolve(repoRoot ?? '.');
  if (skipScratch && shouldSkipDoctorChecksForRoot(resolvedRoot)) {
    return {
      ok: true,
      skipped: true,
      reason: 'scratch-root',
      stage1Enabled: anyStage1FlagEnabled(machine),
      required: [],
      optional: [],
      warnings: [],
    };
  }

  const stage1Enabled = anyStage1FlagEnabled(machine);
  if (!stage1Enabled) {
    return {
      ok: true,
      skipped: true,
      reason: 'stage-1-flags-off',
      stage1Enabled: false,
      required: [],
      optional: [],
      warnings: [],
    };
  }

  const premises = doctorCheckPremises(resolvedRoot);
  if (!premises.ok) {
    const required = [
      section('dependencies', 'failed', { found: premises.found, missing: premises.missing }),
    ];
    return {
      ok: false,
      skipped: false,
      stage1Enabled: true,
      required,
      optional: [],
      warnings: [],
      found: premises.found,
      missing: premises.missing,
    };
  }

  const { flags, sections: required } = await runRequiredDoctorSections({
    machine,
    repoRoot: resolvedRoot,
    env,
    home,
    ...rest,
  });
  const optional = await runOptionalLaneSections({ machine, doctorImpl });
  const ok = doctorReportOk({ stage1Enabled: true, required, optional });
  return {
    ok,
    skipped: false,
    stage1Enabled: true,
    flags,
    required,
    optional,
    warnings: collectDoctorWarnings(optional),
    found: premises.found,
  };
}

function parseCliArgs(argv) {
  const out = { root: process.cwd(), command: null };
  const rest = [...argv];
  out.command = rest.shift() ?? null;
  while (rest.length) {
    const token = rest.shift();
    if (token === '--root' && rest[0]) out.root = path.resolve(rest.shift());
  }
  return out;
}

async function runCli(argv) {
  const { command, root } = parseCliArgs(argv);
  if (command === 'premises') {
    const premises = doctorCheckPremises(root);
    process.stdout.write(`${JSON.stringify(premises)}\n`);
    process.exitCode = premises.ok ? 0 : 2;
    return;
  }
  if (command !== 'check') {
    process.stderr.write(
      'usage: node tools/doctor-checks.mjs check [--root DIR]\n'
        + '       node tools/doctor-checks.mjs premises [--root DIR]\n',
    );
    process.exitCode = 2;
    return;
  }
  const premises = doctorCheckPremises(root);
  if (!premises.ok) {
    process.stderr.write(
      `${JSON.stringify({
        status: 'unrunnable',
        error: `doctor-checks missing dependency: ${premises.missing.join(', ')}`,
        found: premises.found,
        missing: premises.missing,
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const machine = loadLocalConfig();
  const report = await runMachineDoctorChecks({ machine, repoRoot: root });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok && !report.skipped) process.exitCode = 1;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
