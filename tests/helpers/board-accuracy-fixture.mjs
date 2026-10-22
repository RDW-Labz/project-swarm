// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectId } from '../../tools/projects.mjs';
import { approveLedger } from '../../tools/tickets.mjs';

const execFileP = promisify(execFile);
const fixtureDir = fileURLToPath(new URL('../fixtures/ledgers/', import.meta.url));

function fixturePath(name) {
  const file = path.basename(String(name ?? ''));
  if (!['roadmap-ledger.json', 'atlas.anon.json', 'parts-app-ledger.anon.json'].includes(file)) {
    throw new Error(`unknown board accuracy ledger: ${name}`);
  }
  return path.join(fixtureDir, file);
}

async function git(root, args) {
  return execFileP('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

async function readFixtureLedger(name) {
  const ledger = JSON.parse(await fs.readFile(fixturePath(name), 'utf8'));
  // The anonymized fixtures retain their historical approval metadata; refresh the ticket hash
  // so the current approval predicate recognizes the copied fixture as approved.
  return ledger.approved ? approveLedger(ledger, { now: ledger.approved.at }) : ledger;
}

async function writeScope(root, ledger) {
  const relative = String(ledger?.scope?.file ?? 'docs/scope/scope.md');
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (await fs.stat(file).then(() => true, () => false)) return;
  const scopeName = String(ledger?.scope?.name ?? 'Board accuracy fixture');
  await fs.writeFile(file, `# Scope: ${scopeName}\nVersion: ${ledger?.scope?.version ?? 1}\n\n## S0 Foundation\n### R-001 Requirement\nAcceptance:\n- fixture\n`);
}

function normalizedRuns(runs) {
  return (Array.isArray(runs) ? runs : []).map((input, index) => {
    const value = typeof input === 'string' ? { id: input } : (input && typeof input === 'object' ? input : {});
    const id = String(value.id ?? value.runId ?? `fixture-run-${index + 1}`);
    const state = value.state && typeof value.state === 'object' ? value.state : value;
    return { id, state: { id, status: 'complete', jobs: [], ...state, id, jobs: Array.isArray(state.jobs) ? state.jobs : [] } };
  });
}

async function writeRuns(root, runs) {
  for (const { id, state } of normalizedRuns(runs)) {
    const dir = path.join(root, '.swarm', 'runs', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }
}

/** Build the real filesystem shape used by board accuracy tests. */
export async function makeBoardFixture({
  ledger: ledgerName,
  worktrees = [],
  scratch = [],
  runs = [],
  prs = [],
  spend = {},
} = {}) {
  const tmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();
  const temp = await fs.mkdtemp(path.join(tmpBase, 'board-accuracy-'));
  const root = path.join(temp, 'main');
  const scratchDir = path.join(temp, 'scratch');
  const spendDir = path.join(temp, 'spend');
  const lanesDir = path.join(temp, 'lanes');
  const projectsFile = path.join(temp, 'projects.json');
  const historyFile = path.join(temp, 'history.ndjson');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.mkdir(spendDir, { recursive: true });
  await fs.mkdir(lanesDir, { recursive: true });
  await fs.writeFile(historyFile, '');

  const mainLedger = await readFixtureLedger(ledgerName);
  await writeScope(root, mainLedger);
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), `${JSON.stringify(mainLedger)}\n`);
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Board Accuracy Fixture']);
  await git(root, ['config', 'user.email', 'board-accuracy@example.invalid']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'board accuracy fixture']);

  const worktreeRoots = [];
  for (const [index, spec] of (Array.isArray(worktrees) ? worktrees : []).entries()) {
    const name = String(spec?.name ?? `worktree-${index + 1}`).replace(/[^A-Za-z0-9._-]/g, '-');
    const child = path.join(temp, name);
    await git(root, ['worktree', 'add', '-q', '-b', `board-accuracy-${name}`, child]);
    const childLedger = spec?.ledger === null ? null : await readFixtureLedger(spec?.ledger ?? ledgerName);
    if (childLedger) {
      await writeScope(child, childLedger);
      await fs.mkdir(path.join(child, '.swarm', 'project'), { recursive: true });
      await fs.writeFile(path.join(child, '.swarm', 'project', 'tickets.json'), `${JSON.stringify(childLedger)}\n`);
    } else {
      await fs.rm(path.join(child, '.swarm', 'project', 'tickets.json'), { force: true });
    }
    await writeRuns(child, spec?.runs ?? []);
    worktreeRoots.push(await fs.realpath(child));
  }
  await writeRuns(root, runs);

  const scratchRoots = [];
  for (const [index, spec] of (Array.isArray(scratch) ? scratch : []).entries()) {
    const scratchRoot = path.join(scratchDir, `scratch-${index + 1}`);
    await fs.mkdir(scratchRoot, { recursive: true });
    await writeRuns(scratchRoot, spec?.runs ?? []);
    scratchRoots.push(await fs.realpath(scratchRoot));
  }

  const projectRows = [
    { id: projectId(await fs.realpath(root)), root: await fs.realpath(root), name: 'main' },
    ...worktreeRoots.map((worktreeRoot, index) => ({ id: projectId(worktreeRoot), root: worktreeRoot, name: worktrees[index]?.name ?? `worktree-${index + 1}` })),
    ...scratchRoots.map((scratchRoot, index) => ({ id: projectId(scratchRoot), root: scratchRoot, name: `scratch-${index + 1}` })),
  ];
  await fs.writeFile(projectsFile, `${JSON.stringify({ version: 1, projects: projectRows }, null, 2)}\n`, { mode: 0o600 });

  const day = new Date().toISOString().slice(0, 10);
  const billedToday = Number(spend?.billedToday ?? 0);
  const listToday = Number(spend?.listToday ?? 0);
  await fs.writeFile(path.join(spendDir, 'daily.json'), `${JSON.stringify({ version: 1, entries: { [day]: { billedToday, listToday } } })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(spendDir, 'totals.json'), `${JSON.stringify({ day, billedToday, listToday })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(lanesDir, 'lanes.json'), `${JSON.stringify({ slots: {}, demand: {}, pauses: {} })}\n`, { mode: 0o600 });

  const env = {
    ...process.env,
    SWARM_PROJECTS_FILE: projectsFile,
    SWARM_SPEND_DIR: spendDir,
    SWARM_LANES_DIR: lanesDir,
    SWARM_SCRATCH_DIR: scratchDir,
    SWARM_SCRATCH_ROOT: scratchDir,
    SWARM_TEST_TMP: temp,
  };
  const fakePrs = (Array.isArray(prs) ? prs : []).map(pr => ({ state: 'OPEN', headRefName: null, ...pr }));
  const prState = async () => fakePrs;
  const cleanup = async () => fs.rm(temp, { recursive: true, force: true });
  return {
    root: await fs.realpath(root),
    worktreeRoots,
    scratchRoots,
    env,
    prs: fakePrs,
    prState,
    projects: projectRows,
    projectsFile,
    historyFile,
    spendDir,
    lanesDir,
    cleanup,
  };
}
