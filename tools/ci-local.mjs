// SPDX-License-Identifier: Apache-2.0
// Before a PR opens, run the project's own CI workflow commands locally, in CI order. A step nobody ran locally
// (parts-app PR #10) must not be the first time it runs. Reads .github/workflows/*.yml `run:` steps of every workflow that
// triggers on pull_request; steps that need CI-only values (secrets, ${{ }} expressions) or that publish or deploy are listed as skipped, never run.
import fs from 'node:fs/promises';
import path from 'node:path';

const WORKFLOW_DIR = '.github/workflows';
const NEVER_LOCAL = /\$\{\{|\bsecrets\.|\bdeploy\b|\bpublish\b|\bgit\s+push\b|\bgh\s+(?:release|pr|api)\b|\bvercel\b|\bnpm\s+publish\b|\b(?:db|migration)\s+push\b|\bdocker\s+push\b|\bterraform\s+(?:apply|destroy)\b|\bkubectl\b|\bhelm\s+(?:install|upgrade)\b|\baws\s|\bgit\s+clean\b/i;
const NOT_ON_SUCCESS = /failure\(\)|always\(\)|cancelled\(\)|^\s*false\s*$/i;
const PUSH_ONLY_IF = /github\.event_name\s*==\s*['"](?:push|schedule|release|workflow_dispatch)['"]|startsWith\(github\.ref|refs\/tags|refs\/heads\/main/i;

const indentOf = line => line.match(/^(\s*)/)[1].length;
const unquote = v => { const m = /^(['"])([\s\S]*)\1$/.exec(v.trim()); return m ? m[2] : v.trim(); };

// A small line-based reader of a workflow's steps in file order: { job, name, run, workingDirectory, cond }.
export function workflowSteps(text) {
  const lines = String(text ?? '').split('\n');
  const steps = [];
  let job = null;
  let inJobs = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (inJobs) { const j = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line); if (j) job = j[1]; }
    const stepsHead = /^(\s*)steps:\s*$/.exec(line);
    if (!stepsHead) continue;
    const base = stepsHead[1].length;
    // The job's own text (its if, environment, services, container, env): a step is judged together with it.
    let jobStart = i;
    while (jobStart > 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[jobStart])) jobStart -= 1;
    let jobEnd = i + 1;
    while (jobEnd < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[jobEnd]) && !/^\S/.test(lines[jobEnd] ?? ' ')) jobEnd += 1;
    const jobText = lines.slice(jobStart, jobEnd).join('\n');
    const jobHead = lines.slice(jobStart, i).join('\n');
    let current = null;
    let j = i + 1;
    const flush = () => { if (current?.run) steps.push({ ...current, jobText, jobHead }); current = null; };
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || l.trim().startsWith('#')) continue;
      if (indentOf(l) <= base) break;
      const item = /^(\s*)-\s+(.*)$/.exec(l);
      let body = l;
      if (item && indentOf(l) === base + 2 || item && indentOf(l) === base) { flush(); current = { job, name: null, run: null, workingDirectory: null, cond: null, raw: '' }; body = `${' '.repeat(item[1].length + 2)}${item[2]}`; }
      if (!current) continue;
      current.raw += `${l}\n`;
      const key = /^\s*([A-Za-z-]+):\s*(.*)$/.exec(body);
      if (!key || indentOf(body) > base + 4) continue;
      const [, k, v] = key;
      if (k === 'name') current.name = unquote(v);
      else if (k === 'if') current.cond = unquote(v);
      else if (k === 'working-directory') current.workingDirectory = unquote(v);
      else if (k === 'continue-on-error') current.continueOnError = /true/i.test(v);
      else if (k === 'run') {
        if (/^[|>][+-]?\s*$/.test(v)) {
          const parent = indentOf(body);
          const block = [];
          for (j += 1; j < lines.length; j++) {
            if (lines[j].trim() === '') { block.push(''); continue; }
            if (indentOf(lines[j]) <= parent) break;
            block.push(lines[j]);
          }
          j -= 1;
          const min = Math.min(...block.filter(x => x.trim()).map(indentOf));
          current.run = block.map(x => x.slice(min)).join('\n').trim();
        } else current.run = unquote(v);
      }
    }
    flush();
    i = j - 1;
  }
  return steps;
}

// pull_request only (not pull_request_target, which runs trusted code with secrets); comments do not count.
const runsOnPullRequest = text => /(?:^|[\s\[,:])pull_request(?![_\w])/.test(String(text).split(/\njobs:/)[0].split('\n').map(l => l.replace(/#.*$/, '')).join('\n'));

// Every runnable step of the project's pull-request workflows, in CI order (files by name, steps in file order), without repeats.
export async function ciLocalPlan(root) {
  let names = [];
  try { names = (await fs.readdir(path.join(root, WORKFLOW_DIR))).filter(n => /\.ya?ml$/.test(n)).sort(); } catch { return { steps: [], skipped: [], workflows: [] }; }
  const steps = [], skipped = [], workflows = [], seen = new Set();
  for (const name of names) {
    const text = await fs.readFile(path.join(root, WORKFLOW_DIR, name), 'utf8').catch(() => '');
    if (!runsOnPullRequest(text)) continue;
    workflows.push(name);
    for (const step of workflowSteps(text)) {
      const label = `${name}${step.job ? ` / ${step.job}` : ''}: ${step.name ?? step.run.split('\n')[0].slice(0, 60)}`;
      const wd = step.workingDirectory;
      if (/^\s+(?:environment|services|container):/m.test(step.jobHead ?? '')) { skipped.push(`${label} (its job needs an environment, services or a container)`); continue; }
      const jobIf = /^\s{4}if:\s*(.+)$/m.exec(step.jobHead ?? '')?.[1];
      if (jobIf && (PUSH_ONLY_IF.test(jobIf) || NOT_ON_SUCCESS.test(jobIf))) { skipped.push(`${label} (its job runs only on push, release or a branch)`); continue; }
      if (step.cond && NOT_ON_SUCCESS.test(step.cond)) { skipped.push(`${label} (runs only after a failure or always)`); continue; }
      if (step.continueOnError) { skipped.push(`${label} (continue-on-error)`); continue; }
      if (/\$\{\{\s*secrets\./.test(`${step.raw}\n${step.jobHead}`)) { skipped.push(`${label} (uses a secret)`); continue; }
      if (wd && (path.isAbsolute(wd) || wd.split('/').includes('..') || /\$\{\{/.test(wd))) { skipped.push(`${label} (working-directory ${wd} not usable locally)`); continue; }
      if (step.cond && PUSH_ONLY_IF.test(step.cond)) { skipped.push(`${label} (only on push or release)`); continue; }
      if (NEVER_LOCAL.test(step.run)) { skipped.push(`${label} (needs CI-only values or publishes)`); continue; }
      const key = `${wd ?? ''}\n${step.run}`;
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({ label, run: step.run, workingDirectory: wd });
    }
  }
  return { steps, skipped, workflows };
}

// Runs the plan through `exec(cmd, args, {cwd, env})` ({code, stdout, stderr}); stops at the first failure.
export async function runCiLocal({ root, exec, env = process.env, plan = null }) {
  const found = plan ?? await ciLocalPlan(root);
  const ran = [];
  for (const step of found.steps) {
    const cwd = step.workingDirectory ? path.join(root, step.workingDirectory) : root;
    // A minimal environment: the owner's own tokens and database urls are never handed to a workflow step.
    const clean = { PATH: env.PATH ?? process.env.PATH ?? '', HOME: env.HOME ?? process.env.HOME ?? '', LANG: env.LANG ?? 'C.UTF-8', TERM: 'dumb', CI: 'true' };
    const res = await exec('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd, env: clean, timeoutMs: 900000 });
    ran.push(step.label);
    if (res.code !== 0) {
      const tail = String(`${res.stderr ?? ''}\n${res.stdout ?? ''}`).trim().slice(-500);
      return { ok: false, failed: step.label, command: step.run.split('\n')[0].slice(0, 120), tail, ran, skipped: found.skipped };
    }
  }
  return { ok: true, ran, skipped: found.skipped, workflows: found.workflows };
}
