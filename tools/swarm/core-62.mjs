import { git } from '../codex-adapter.mjs';
import { GOAL_BUDGET, manifestForGoal, topLevelFolders, trackedFiles } from '../goal.mjs';
import { loadSwarmEnv } from '../swarm-env.mjs';
import { digest, execFileAsync, fail } from './core-1.mjs';
import { expectedWorkspaceFor, runCheck } from './core-11.mjs';
import { isTestOutput } from './core-2.mjs';
import { safePath } from './core-21.mjs';
import { bytesAt, validateManifest, write } from './core-31.mjs';
import { readState } from './core-41.mjs';
import { redcheckCommitRun } from './core-51.mjs';
import { planLaneInfo } from './core-52.mjs';
import { MAX_FILE } from './patterns.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

async function redcheckRunLocked(root, id, argv, { spawnImpl = spawn, timeoutMs = 300000, base: baseRef, commit } = {}) {
  if (commit !== undefined) return await redcheckCommitRun(root, id, argv, { spawnImpl, timeoutMs, commit });
  const restored = [];
  const result = { status: 'error', exitCode: null, restored, tail: '', base: baseRef ?? 'run-base' };
  try {
    if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string' || item.includes('\0')) || !argv[0]) fail('redcheck requires --test <argv...>');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail('Invalid redcheck timeout');
    root = await fs.realpath(root);
    const state = await readState(root, id);
    if (state.root !== root || state.id !== id || !['complete', 'integrated'].includes(state.status)) fail('Only a complete or integrated run from this repository can be redchecked');
    const manifest = validateManifest(JSON.parse(await bytesAt(root, `.swarm/runs/${id}/manifest.json`, true)));
    if (state.jobs.length !== manifest.jobs.length) fail('Job records do not match manifest');
    let revision;
    if (baseRef !== undefined) {
      if (typeof baseRef !== 'string' || !baseRef || baseRef.startsWith('-')) fail('Invalid base revision');
      revision = (await git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
    } else if (state.baseCommit) {
      const defaultRef = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).then(text => text.trim(), () => null);
      if (defaultRef) {
        try { await git(root, ['merge-base', '--is-ancestor', state.baseCommit, defaultRef]); }
        catch (error) {
          if (error.code === 1) {
            result.suggestBase = defaultRef;
            result.warnings = [`run base is not on the default branch; old code may already contain the change — try --base ${defaultRef}`];
          }
        }
      }
    }
    const changes = [];
    for (const [index, job] of state.jobs.entries()) {
      const declared = manifest.jobs[index];
      const expectedWorkspace = expectedWorkspaceFor(id, declared.id, job);
      if (job.id !== declared.id || job.workspace !== expectedWorkspace || job.status !== 'complete' || JSON.stringify(job.outputs) !== JSON.stringify(declared.outputs)) fail('Worker metadata does not match manifest');
      const workspace = await safePath(root, expectedWorkspace, { internal: true });
      for (const file of declared.outputs.filter(file => !isTestOutput(file))) {
        const proposed = await bytesAt(workspace, file);
        if (proposed === null) fail(`Missing output: ${file}`);
        const current = await bytesAt(root, file);
        const currentHash = current === null ? null : digest(current);
        if (currentHash !== job.baseHashes[file] && currentHash !== digest(proposed)) fail(`Redcheck conflict: ${file} differs from both base and job versions`);
        const mode = current === null ? job.baseModes?.[file] ?? 0o644 : (await fs.stat(await safePath(root, file))).mode & 0o777;
        let base = null;
        if (revision) {
          // ls-tree distinguishes a missing path from a failed git show.
          const present = (await git(root, ['ls-tree', '--name-only', revision, '--', `:(literal)${file}`])).trim();
          if (present) base = (await execFileAsync('git', ['-C', root, 'show', `${revision}:${file}`], { encoding: 'buffer', maxBuffer: MAX_FILE })).stdout;
        } else if (job.baseHashes[file] !== null) {
          const expectedBase = `.swarm/runs/${id}/base/${job.id}`;
          if (job.baseWorkspace !== undefined && job.baseWorkspace !== expectedBase) fail('Base metadata does not match run');
          if (job.baseWorkspace) base = await bytesAt(root, `${expectedBase}/${file}`, true);
          else if (currentHash === job.baseHashes[file]) base = current;
          if (base === null) {
            // Old records may carry only hashes. Verify git's bytes before any write.
            const revision = job.baseCommit ?? state.baseCommit ?? 'HEAD';
            if (typeof revision !== 'string' || !/^(?:[a-f0-9]{40,64}|HEAD)$/.test(revision)) fail('Invalid base revision');
            base = (await execFileAsync('git', ['-C', root, 'show', `${revision}:${file}`], { encoding: 'buffer', maxBuffer: MAX_FILE })).stdout;
          }
          if (digest(base) !== job.baseHashes[file]) fail(`Base content unavailable or mismatched: ${file}`);
        }
        changes.push({ file, base, proposed, mode, baseMode: job.baseModes?.[file] ?? mode });
      }
    }
    const attempted = [];
    try {
      for (const change of changes) {
        attempted.push(change);
        if (change.base === null) await fs.rm(await safePath(root, change.file), { force: true });
        else await write(root, change.file, change.base, false, change.baseMode);
        restored.push(change.file);
      }
      const check = await runCheck('redcheck', argv, root, timeoutMs, spawnImpl, true, () => {}, { ...process.env, ...(await loadSwarmEnv(root)).env });
      result.status = check.status === 'passed' ? 'green' : check.status === 'failed' && Number.isInteger(check.exitCode) ? 'red' : 'error';
      result.exitCode = check.exitCode;
      result.tail = check.tail.slice(-2000);
      if (check.hint) result.hint = check.hint;
    } finally {
      // Attempt every restoration even if one path has become unwritable.
      const errors = [];
      for (const change of attempted) {
        try { await write(root, change.file, change.proposed, false, change.mode); }
        catch (error) { errors.push(`${change.file}: ${error.message}`); }
      }
      if (errors.length) fail(`Redcheck restoration failed: ${errors.join('; ')}`);
    }
  } catch (error) {
    result.status = 'error';
    result.tail = `${result.tail}\n${error.message}`.trim().slice(-2000);
  }
  return result;
}

async function planDeps(root) {
  return {
    folders: topLevelFolders, files: trackedFiles, manifestForGoal, laneInfo: (manifest, options) => planLaneInfo(manifest, options), defaults: GOAL_BUDGET,
    head: async dir => (await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).then(out => out.stdout.trim(), () => null)),
  };
}

export { planDeps, redcheckRunLocked };
