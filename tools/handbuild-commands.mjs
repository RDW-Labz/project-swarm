// SPDX-License-Identifier: Apache-2.0
// `swarm handbuild request | approve | deny | status | log | install | uninstall | off | on`: the hand-build guard's commands (see tools/handbuild.mjs and docs/handbuild-guard.md).
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, sanitizeText } from './journal.mjs';
import { createRequest, createScratchDeniedHandbuildRequest, decideRequest, listRequests, activeApprovals, REASON_KINDS, KIND_LIST, MAX_MINUTES, DEFAULT_MINUTES, LOG_FILE, OFF_FILE, SCRATCH_DENY_REASON } from './handbuild.mjs';
import { isScratchRoot } from './scratch-roots.mjs';
import { listProjects, projectsFile } from './projects.mjs';

async function registeredScratchHandbuildRoot(root, installRoot, env = process.env) {
  const home = env.HOME ?? os.homedir();
  const file = projectsFile(env, home);
  const projects = await listProjects({
    file,
    forOwner: false,
    includeScratch: true,
    pruneGone: false,
    env,
    home,
    installRoot,
  });
  return isScratchRoot(root, {
    env,
    home,
    installRoot,
    strict: true,
    registeredRoots: projects.map(p => p.root),
  });
}
import { ensureHandbuildGuard, removeHandbuildGuard, stableInstallDir, refreshProjectInstallHooks, readGuardHookCommandFromSettings, guardHookPathStatus, collectSwarmHookStatuses } from './install.mjs';
import { installGitHooks, removeGitHooks } from './git-hooks.mjs';

export const HANDBUILD_USAGE = [
  'Usage: swarm handbuild request --kind swarm-cannot|emergency|secret|tiny --reason "why the swarm cannot do it" --files "src/a.ts,src/b.ts" [--minutes 30] [--git commit,push]',
  '       swarm handbuild approve ID | deny ID      (the owner only: an orchestrator session cannot run these)',
  '       swarm handbuild status [--json] | log [--json]',
  '       swarm handbuild install | uninstall | off | on',
  `Valid reasons (anything else: write a ticket instead): ${KIND_LIST.map(k => `${k}: ${REASON_KINDS[k]}`).join('; ')}. An approval covers only the files named, for at most ${MAX_MINUTES} minutes (default ${DEFAULT_MINUTES}), then expires.`,
].join('\n') + '\n';

const flagsOf = args => {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (['json'].includes(k)) flags[k] = true; else { flags[k] = args[i + 1]; i += 1; } } else rest.push(a);
  }
  return { flags, rest };
};
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });
const describe = r => `${r.id}  ${r.status.padEnd(8)} ${r.kind}  ${r.files.join(', ')}${r.git?.length ? `  git: ${r.git.join(', ')}` : ''}${r.status === 'approved' ? `  until ${r.expiresAt}` : ''}\n    ${r.reason}`;

export async function runHandbuildCommand(root, args, { installRoot, env = process.env, now = Date.now } = {}) {
  const [sub, ...tail] = args;
  const { flags, rest } = flagsOf(tail);
  try {
    if (sub === 'request') {
      const fields = { kind: flags.kind, reason: flags.reason, files: flags.files, minutes: flags.minutes, git: flags.git };
      const r = (await registeredScratchHandbuildRoot(root, installRoot, env))
        ? createScratchDeniedHandbuildRequest(root, fields, { now })
        : createRequest(root, fields, { now });
      if (r.status === 'denied' && r.denyReason === SCRATCH_DENY_REASON) {
        return out(
          `Hand-build request auto-denied: ${r.id} (${SCRATCH_DENY_REASON}). Move the project out of the scratch base or remove the .swarm-scratch marker.`,
          1,
        );
      }
      const id = `handbuild-${r.id}`;
      // It shows up in Needs you (the board and the phone) as a decision with approve and deny.
      await appendEvent(root, { kind: 'decision', id, confirm: true, choice: 'deny', options: ['approve', 'deny'], text: sanitizeText(`Hand-build request (${r.kind}): ${r.reason} | files: ${r.files.join(', ')} | ${r.minutes} min${r.git.length ? ` | git: ${r.git.join(', ')}` : ''}. Recommendation: deny unless the swarm truly cannot do it; otherwise a ticket is the better route.`) }, { now });
      return out(`hand-build request ${r.id} is waiting for the owner (it shows in Needs you on the board and the phone).\nThe owner approves with: swarm handbuild approve ${r.id}   (or: swarm decide ${id} approve)\nUntil then every edit of ${r.files.join(', ')} stays blocked.`);
    }
    if (sub === 'approve' || sub === 'deny') {
      if (rest.length !== 1) return out(HANDBUILD_USAGE, 1);
      const r = decideRequest(root, rest[0], sub, { now, by: 'owner' });
      await appendEvent(root, { kind: 'decision', id: `handbuild-${r.id}`, confirmed: true, choice: sub, text: sanitizeText(`Hand-build request ${r.id}: ${sub}`) }, { now }).catch(() => {});
      return out(sub === 'approve' ? `approved ${r.id}: ${r.files.join(', ')}${r.git.length ? ` and git ${r.git.join(', ')}` : ''} until ${r.expiresAt}; then it expires` : `denied ${r.id}`);
    }
    if (sub === 'status') {
      const all = listRequests(root);
      const live = activeApprovals(root, now());
      let hookSettings = {};
      try {
        hookSettings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
      } catch { /* no local settings */ }
      const hookCommand = readGuardHookCommandFromSettings(hookSettings);
      const hookInfo = installRoot ? guardHookPathStatus({ hookCommand, installRoot }) : null;
      const swarmHooks = installRoot ? collectSwarmHookStatuses(hookSettings, installRoot) : [];
      if (flags.json) {
        return out(JSON.stringify({
          requests: all,
          active: live.map(r => r.id),
          off: fs.existsSync(path.join(root, OFF_FILE)),
          guardHook: hookInfo,
          swarmHooks,
        }));
      }
      const hookLines = [];
      if (hookInfo?.hookPath) {
        hookLines.push(`guard hook: ${hookInfo.hookPath}`);
        hookLines.push(`guard hook stable: ${hookInfo.matches ? 'yes' : 'no'}`);
        if (hookInfo.warn) hookLines.push('warning: guard hook path is not under the install current/ release; run swarm update or swarm handbuild install');
      }
      for (const row of swarmHooks) {
        if (row.label.startsWith('hand-build guard')) continue;
        const pathLine = row.hookPath ?? row.command;
        hookLines.push(`${row.label}: ${pathLine}`);
        hookLines.push(`${row.label} stable: ${row.matches ? 'yes' : 'no'}`);
        if (row.warn) hookLines.push(`warning: ${row.label} is not on the install current/ release or is missing; run swarm update or swarm handbuild install`);
      }
      return out([
        `guard: ${fs.existsSync(path.join(root, OFF_FILE)) ? 'OFF (.swarm/handbuild/off exists)' : 'on where the hook is installed (swarm handbuild install)'}`,
        ...hookLines,
        `${live.length} live approval(s), ${all.filter(r => r.status === 'pending').length} pending`,
        ...all.slice(0, 20).map(describe),
      ].join('\n'));
    }
    if (sub === 'log') {
      let lines = [];
      try { lines = fs.readFileSync(path.join(root, LOG_FILE), 'utf8').split('\n').filter(Boolean).slice(-200); } catch { /* none yet */ }
      return out(flags.json ? `[${lines.join(',')}]` : lines.map(l => { try { const e = JSON.parse(l); return `${e.at}  ${e.event}${e.id ? ` ${e.id}` : ''}${e.tool ? ` ${e.tool}` : ''}${e.files?.length ? ` ${e.files.join(', ')}` : ''}${e.reason ? `  ${e.reason}` : ''}`; } catch { return l; } }).join('\n') || 'nothing logged yet');
    }
    if (sub === 'install') {
      const refreshed = await refreshProjectInstallHooks(root, installRoot, { refreshOnly: true });
      let r = refreshed.handbuild;
      if (r.status === 'absent' || r.status === 'removed-by-owner') r = await ensureHandbuildGuard(root, installRoot);
      if (r.status === 'skipped') return out(`not installed: ${r.reason}`, 1);
      const install = stableInstallDir(installRoot);
      const hooks = installGitHooks(root, { checkScript: path.join(install, 'tools', 'githook-check.mjs') });
      const hookNote = hooks?.status === 'skipped' ? `git hooks not installed (${hooks.reason})` : 'git hooks installed';
      const trackedNote = refreshed.tracked?.status === 'updated' ? '\nhooks-path-fixed-tracked: .claude/settings.json (commit this file if your project tracks it)' : '';
      return out(`hand-build guard ${r.status} in ${root}/.claude/settings.local.json (it applies to new Claude Code sessions in this project)${trackedNote}\n${hookNote}`);
    }
    if (sub === 'uninstall') {
      const r = await removeHandbuildGuard(root);
      removeGitHooks(root);
      return out(`hand-build guard ${r.status}\ngit hooks removed`);
    }
    if (sub === 'off' || sub === 'on') {
      const file = path.join(root, OFF_FILE);
      if (sub === 'off') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); } else fs.rmSync(file, { force: true });
      return out(`hand-build guard ${sub}`);
    }
  } catch (error) {
    if (/^handbuild-/.test(error.message)) return out(error.message.replace(/^handbuild-[a-z]+: /, ''), 1);
    throw error;
  }
  return out(HANDBUILD_USAGE, sub ? 1 : 0);
}
