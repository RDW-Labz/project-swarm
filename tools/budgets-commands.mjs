// SPDX-License-Identifier: Apache-2.0
// swarm budgets check [--url URL] [--screens a,b] | status   (spec A2: speed and accessibility budgets)
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBudgets, recordBudgetResults, readBudgetState, openFailures, validateBudgetsConfig, finishesLastStage, checkBaseUrl } from './budgets.mjs';
import { readLedger } from './tickets.mjs';

export const BUDGETS_USAGE = 'Usage: swarm budgets check [--url PREVIEW_URL] [--screens home,cart]\n       swarm budgets status\nThe budgets live in the project profile (budgets: {performance, accessibility, axeBlock, screens, lighthouse, axe}); see docs/budgets.md.\n';
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });

async function profileBudgets(root) {
  let pointer;
  try { pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8')); } catch { return { error: 'no project profile (swarm init)' }; }
  if (pointer?.profile?.budgets === undefined) return { error: 'the profile has no budgets block; add budgets to .project-swarm.json (docs/budgets.md)' };
  const checked = validateBudgetsConfig(pointer.profile.budgets);
  return checked.ok ? { config: checked.config } : { error: `the budgets block is invalid: ${checked.errors[0]}` };
}

const line = r => `${r.id}  ${r.status}  ${r.scores ? Object.entries(r.scores).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`).join(', ') : ''}${r.failures?.length ? `\n    ${r.failures.slice(0, 5).map(f => f.message).join('\n    ')}` : ''}`;

export async function runBudgetsCommand(root, args, { run, now, onFailure } = {}) {
  const [verb, ...rest] = args;
  if (verb === 'status') {
    const state = await readBudgetState(root);
    const ids = Object.keys(state.screens);
    if (!ids.length) return out('No budget runs yet. swarm budgets check --url PREVIEW_URL');
    const open = openFailures(state);
    const ledger = await readLedger(root).catch(() => null);
    return out([...ids.sort().map(id => line({ id, ...state.screens[id] })), open.length ? `${open.length} screen(s) failing${finishesLastStage(ledger) ? ': the last stage is finished, so shipping is blocked until they pass' : ' (they block only the PR that finishes the last stage)'}` : 'all screens within budget'].join('\n'), open.length ? 1 : 0);
  }
  if (verb !== 'check') return out(`${verb ? `Unknown budgets command: ${verb}\n` : ''}${BUDGETS_USAGE}`, 2);
  let url = null, screens = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--url' && rest[i + 1]) url = rest[++i];
    else if (rest[i] === '--screens' && rest[i + 1]) screens = rest[++i].split(',').map(s => s.trim()).filter(Boolean);
    else return out(`Unknown argument: ${rest[i]}\n${BUDGETS_USAGE}`, 2);
  }
  if (!url) return out(`budgets check needs --url (a preview address, or a local http://127.0.0.1:PORT server)\n${BUDGETS_USAGE}`, 2);
  if (!checkBaseUrl(url)) return out('the address must be an https preview or a local http server', 2);
  const { config, error } = await profileBudgets(root);
  if (error) return out(error, 1);
  const unknown = (screens ?? []).filter(id => !config.screens.some(s => s.id === id));
  if (unknown.length) return out(`unknown screen(s): ${unknown.join(', ')} (the profile lists ${config.screens.map(s => s.id).join(', ')})`, 2);
  const results = await runBudgets({ root, baseUrl: url, config, screens, ...(run ? { run } : {}), ...(now ? { now } : {}) });
  await recordBudgetResults(root, results);
  if (onFailure) for (const r of results.filter(x => !x.pass)) await onFailure(r);
  const failed = results.filter(r => !r.pass);
  return out([...results.map(line), failed.length ? `${failed.length} of ${results.length} screen(s) outside budget` : `all ${results.length} screen(s) within budget`].join('\n'), failed.length ? 1 : 0);
}
