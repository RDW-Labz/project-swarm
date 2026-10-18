// SPDX-License-Identifier: Apache-2.0
// swarm models watch [--force] [--json] | list | compare CURRENT CANDIDATE   (spec B3)
import fs from 'node:fs/promises';
import path from 'node:path';
import { watchModels, fetchOpenCandidates, fetchApiModels, readState, watchConfig, compareModels, evalAdvice } from './model-watch.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { readAnthropicKey } from './anthropic.mjs';

export const MODELS_USAGE = 'Usage: swarm models watch [--force] [--json]   (new open coding models that fit our GPUs and new API model versions, into the inbox; never rents)\n       swarm models list\n       swarm models compare CURRENT CANDIDATE   (from the recorded eval runs)\n';
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });

export async function runModelsCommand(root, args, { fetchImpl, env = process.env, now = Date.now, key } = {}) {
  const [verb, ...rest] = args;
  const local = (() => { try { return loadLocalConfig({ env }); } catch { return {}; } })();
  if (verb === 'watch') {
    const flags = new Set(rest);
    for (const f of flags) if (!['--force', '--json'].includes(f)) return out(`Unknown flag: ${f}\n${MODELS_USAGE}`, 2);
    const config = watchConfig(local);
    const result = await watchModels({
      root, local, env, now, force: flags.has('--force'),
      sources: {
        open: () => fetchOpenCandidates({ fetchImpl, config, now: now() }),
        api: () => fetchApiModels({ fetchImpl, key: key === undefined ? readAnthropicKey(env) : key }),
      },
    });
    if (flags.has('--json')) return out(JSON.stringify(result));
    if (!result.ran) return out(`Checked recently; the next check is due ${result.nextAt} (swarm models watch --force to check now).`);
    const lines = [result.baseline ? `First check: recorded ${result.seen} model(s) as the baseline. Only models that appear after this are reported.` : `${result.newOpen.length} new open coding model(s), ${result.newApi.length} new API model(s).`];
    for (const c of result.newOpen) lines.push(`  ${c.id}  ${c.weightGb ?? '?'} GB  ${c.fits === false ? 'too big for our GPUs' : c.fits ? 'fits' : 'fit unknown'}  ${c.downloads} downloads`);
    for (const id of result.newApi) lines.push(`  ${id}  (Anthropic API)`);
    if (result.decisions.length) lines.push(`${result.decisions.length} decision(s) in your inbox (swarm inbox). ${evalAdvice('MODEL', result.config).replace('MODEL', 'the model')}`);
    for (const note of result.notes) lines.push(`note: ${note}`);
    return out(lines.join('\n'));
  }
  if (verb === 'list') {
    const state = await readState(env);
    const entries = Object.entries(state.seen).sort(([, a], [, b]) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
    if (!entries.length) return out('Nothing recorded yet. swarm models watch');
    return out([`last check: ${state.lastRunAt ?? 'never'}`, ...entries.slice(0, 40).map(([k, v]) => `${k}  first seen ${String(v.firstSeen).slice(0, 10)}${v.fits === false ? '  (too big)' : ''}`)].join('\n'));
  }
  if (verb === 'compare') {
    if (rest.length !== 2) return out(`compare needs two model names\n${MODELS_USAGE}`, 2);
    let rows = [];
    try { rows = (await fs.readFile(path.join(root, 'docs/state/eval-scores.ndjson'), 'utf8')).split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { /* none yet */ }
    const result = compareModels(rows, rest[0], rest[1]);
    return out(result.message, result.ok ? 0 : 1);
  }
  return out(`${verb ? `Unknown models command: ${verb}\n` : ''}${MODELS_USAGE}`, 2);
}
