// SPDX-License-Identifier: Apache-2.0
// swarm handoff generate --stage S3 [--max-usd N] [--yes] [--dry-run] | check --url URL [--propose] | status | final
// (swarm handoff --to AGENT is the older command that briefs another agent; it is unchanged.)
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { DEFAULT_MODELS, worstCaseUsd } from './anthropic.mjs';
import { readLedger } from './tickets.mjs';
import { readGallery, screenshotPath } from './watch-gallery.mjs';
import { DEFAULT_SCOPE_FILE } from './scope-commands.mjs';
import { validateHandoffConfig, renderRunbook, renderInputs, buildManifest, MAX_OUTPUT_TOKENS, guidesHash, extractChecks, runCheck, realGet, previewBase, failureTicket, todoLines, readHandoffState, writeHandoffState, guideFiles, parseScope, HANDOFF_DIR, DEFAULT_CAP_USD, TODO } from './handoff-docs.mjs';

const exec = promisify(execFile);
const SWARM = fileURLToPath(new URL('./swarm.mjs', import.meta.url));
const MAX_CAP_USD = 20;
export const HANDOFF_USAGE = [
  'Usage: swarm handoff generate --stage S3 [--max-usd N] [--yes] [--dry-run]   write docs/handoff (a runbook from your profile, two guides by a worker under a cap)',
  '       swarm handoff check --url PREVIEW [--propose]                          run every check line in the guides against the preview; --propose files proposed tickets',
  '       swarm handoff status                                                   what exists, what is still TODO (owner), the last check',
  '       swarm handoff final                                                    mark the handoff final (only with no TODO left and a clean check)',
  '       swarm handoff --to codex|cursor|claude|gemini                          brief another agent (older command)',
].join('\n');
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });
const usd = v => `$${v.toFixed(2)}`;

export function realDeps() {
  return {
    runSwarm: async (root, args) => {
      try { const { stdout } = await exec(process.execPath, [SWARM, '--root', root, ...args], { timeout: 1800000, maxBuffer: 16 * 1024 * 1024 }); return { ok: true, text: stdout }; }
      catch (error) { return { ok: false, text: String(error.stdout || error.stderr || error.message || '') }; }
    },
    get: realGet,
    confirm: async question => { if (!process.stdin.isTTY) return null; const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); } },
    now: Date.now,
  };
}

async function profileOf(root) {
  let pointer = null;
  try { const { readRunnerPointer } = await import('./runner-pointer.mjs'); pointer = await readRunnerPointer(root); } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[tools/handoff-commands.mjs] readRunnerPointer:', error?.message ?? error, root);
  }
  if (pointer?.profile?.handoff === undefined) return { config: {} };
  const checked = validateHandoffConfig(pointer.profile.handoff);
  return checked.ok ? { config: checked.config } : { error: `the handoff block of the profile is invalid: ${checked.errors[0]}` };
}

async function loadScope(root) {
  const ledger = await readLedger(root).catch((error) => {
    if (error?.code !== 'ENOENT') {
      const detail = (error instanceof SyntaxError || error?.name === 'SyntaxError') ? 'corrupt ledger (SyntaxError)' : (error?.message ?? error);
      console.error('[tools/handoff-commands.mjs] readLedger:', detail, root);
    }
    return null;
  });
  const file = ledger?.scope?.file ?? DEFAULT_SCOPE_FILE;
  let text;
  try { text = await fs.readFile(path.join(root, file), 'utf8'); } catch { return { error: `no scope file at ${file}: the guides are written from the approved scope` }; }
  return { scope: parseScope(text), file };
}

function flags(args, spec) {
  const o = { rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (spec.bool?.includes(a)) o[a.slice(2)] = true;
    else if (spec.value?.includes(a) && args[i + 1] !== undefined) o[a.slice(2)] = args[++i];
    else return null;
  }
  return o;
}

export async function runHandoffDocs(root, args, { deps = realDeps() } = {}) {
  const [verb, ...rest] = args;
  if (verb === 'generate') return generate(root, rest, deps);
  if (verb === 'check') return check(root, rest, deps);
  if (verb === 'status') return status(root);
  if (verb === 'final') return final(root, deps);
  return out(HANDOFF_USAGE, 1);
}

async function generate(root, args, deps) {
  const f = flags(args, { bool: ['--yes', '--dry-run'], value: ['--stage', '--max-usd'] });
  if (!f || !/^S\d+$/.test(f.stage ?? '')) return out(HANDOFF_USAGE, 1);
  const cap = f['max-usd'] === undefined ? DEFAULT_CAP_USD : Number(f['max-usd']);
  if (!Number.isFinite(cap) || cap <= 0 || cap > MAX_CAP_USD) return out(`--max-usd must be more than 0 and at most ${MAX_CAP_USD}`, 1);
  const { config, error } = await profileOf(root);
  if (error) return out(error, 1);
  const loaded = await loadScope(root);
  if (loaded.error) return out(loaded.error, 1);
  const { scope } = loaded;
  if (!scope.stages.some(s => s.id === f.stage)) return out(`the scope has no stage ${f.stage} (it has ${scope.stages.map(s => s.id).join(', ') || 'none'})`, 1);
  const gallery = await readGallery(root).catch(() => ({ screens: [] }));
  const screens = gallery.screens.filter(s => s.hasPage).map(s => s.id);
  const images = Object.fromEntries(screens.map(id => [id, `${id}.png`]));
  const inputs = renderInputs({ scope, stage: f.stage, screens, images });
  const model = DEFAULT_MODELS.mid;
  const worst = 2 * worstCaseUsd(model, { inputChars: inputs.length + 2000, maxTokens: MAX_OUTPUT_TOKENS });
  const overCap = worst > cap;
  const plan = [
    `Handoff for ${f.stage} of ${scope.name}.`,
    `Cost: 2 guides (user, admin) by ${model}. Worst case ${usd(worst)}, capped at ${usd(cap)} for the whole run${overCap ? ' (the worst case is above the cap: the run stops at the cap and a guide may be left unwritten)' : ''}. The runbook costs nothing: it is built from your profile.`,
    `Writes: ${HANDOFF_DIR}/runbook.md, user-guide.md, admin-guide.md, inputs.md, ${screens.length} screenshot(s) in img/.`,
  ].join('\n');
  if (f['dry-run']) return out(`${plan}\nNothing was written or spent (--dry-run).`);
  if (!f.yes) {
    const answer = await deps.confirm(`${plan}\nSpend up to ${usd(cap)}?`);
    if (answer === null) return out(`${plan}\nThis spends money. Re-run with --yes to spend up to ${usd(cap)}.`, 1);
    if (!answer) return out('Nothing was spent.', 1);
  }
  // From here the old handoff is no longer what is on disk: it is not final until it is generated and checked again.
  await writeHandoffState(root, { stage: f.stage, generatedAt: null, capUsd: cap, run: null, final: false, checkedAt: null, failures: null, guidesHash: null });
  const dir = path.join(root, HANDOFF_DIR);
  await fs.mkdir(path.join(dir, 'img'), { recursive: true });
  for (const id of screens) { const src = await screenshotPath(root, id, 'page'); if (src) await fs.copyFile(src, path.join(dir, 'img', `${id}.png`)); }
  const runbook = renderRunbook(config, { project: scope.name, stage: f.stage });
  await fs.writeFile(path.join(dir, 'runbook.md'), runbook);
  await fs.writeFile(path.join(dir, 'inputs.md'), inputs);
  const manifest = buildManifest({ stage: f.stage, capUsd: cap, model, inputsFile: `${HANDOFF_DIR}/inputs.md` });
  // A normal manifest, in the folder manifests live in (the swarm refuses paths under .swarm).
  const manifestRel = `coordination/manifests/handoff-${f.stage.toLowerCase()}.json`;
  const manifestFile = path.join(root, manifestRel);
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const ran = await deps.runSwarm(root, ['run', manifestRel]);
  const final = [...ran.text.trim().split('\n')].reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).find(j => j && j.status && j.id);
  if (!ran.ok || !final || final.status !== 'complete') return out(`${plan}\nThe guide run did not complete (${final?.status ?? 'no result'}). Nothing was integrated. The runbook was written.\n${ran.text.slice(-400)}`, 1);
  const merged = await deps.runSwarm(root, ['integrate', final.id, '--no-checks']);
  if (!merged.ok) return out(`The guides were written by the worker but integrating them failed: swarm integrate ${final.id}\n${merged.text.slice(-400)}`, 1);
  const todos = (await guideFiles(root)).flatMap(g => todoLines(g.text).map(t => `${g.name}:${t.line}`));
  await writeHandoffState(root, { stage: f.stage, generatedAt: new Date(deps.now()).toISOString(), capUsd: cap, run: final.id, final: false, checkedAt: null, failures: null });
  return out([plan, `Done: run ${final.id}.`, todos.length ? `${todos.length} item(s) still say ${TODO}: ${todos.slice(0, 8).join(', ')}. Fill the profile's handoff block, then run swarm handoff generate again (the runbook is rebuilt for free).` : 'No TODO (owner) is left.', 'Next: swarm handoff check --url PREVIEW, then swarm handoff final.'].join('\n'));
}

async function check(root, args, deps) {
  const f = flags(args, { bool: ['--propose'], value: ['--url'] });
  if (!f) return out(HANDOFF_USAGE, 1);
  const { config, error } = await profileOf(root);
  if (error) return out(error, 1);
  const target = previewBase({ url: f.url, config });
  if (target.error) return out(target.error, 1);
  const guides = (await guideFiles(root)).filter(g => g.name !== 'runbook.md');
  if (!guides.length) return out('There are no guides yet. Run swarm handoff generate --stage S1 first.', 1);
  const checks = guides.flatMap(g => extractChecks(g.text, g.name));
  if (!checks.length) return out('The guides have no check lines, so nothing could be checked. A step that names a screen or visible text needs one.', 1);
  const results = [];
  for (const c of checks) results.push(await runCheck(target.base, c, { get: deps.get }));
  const failed = results.filter(r => !r.ok);
  const lines = results.map(r => `${r.ok ? 'ok  ' : 'FAIL'} ${r.guide}: ${r.route}${r.text ? ` "${r.text}"` : ''}${r.ok ? '' : ` (${r.reason})`}`);
  let filed = [];
  if (f.propose && failed.length) {
    const ledger = await readLedger(root).catch((error) => {
      if (error?.code !== 'ENOENT') {
        const detail = (error instanceof SyntaxError || error?.name === 'SyntaxError') ? 'corrupt ledger (SyntaxError)' : (error?.message ?? error);
        console.error('[tools/handoff-commands.mjs] readLedger:', detail, root);
      }
      return null;
    });
    const have = new Set((ledger?.tickets ?? []).filter(t => t.origin === 'handoff').map(t => t.source?.route));
    const { addProposedTicket } = await import('./scope-commands.mjs');
    for (const r of failed) { if (have.has(r.route)) continue; have.add(r.route); let id = null; try { id = await addProposedTicket(root, failureTicket(r)); } catch { id = null; } if (id) filed.push(typeof id === 'string' ? id : id.id ?? '?'); }
  }
  const state = (await readHandoffState(root)) ?? {};
  await writeHandoffState(root, { ...state, guidesHash: guidesHash(guides), checkedAt: new Date(deps.now()).toISOString(), failures: failed.length, checked: results.length, final: failed.length ? false : state.final ?? false });
  return out([`Checked ${results.length} step(s) against ${target.base}: ${results.length - failed.length} ok, ${failed.length} failed.`, ...lines, filed.length ? `Proposed ticket(s): ${filed.join(', ')} (read them, name their files, approve with swarm tickets ID --approve).` : failed.length && !f.propose ? 'Run again with --propose to file a proposed ticket for each failure.' : ''].filter(Boolean).join('\n'), failed.length ? 1 : 0);
}

async function status(root) {
  const guides = await guideFiles(root);
  const state = await readHandoffState(root);
  if (!guides.length && !state) return out('No handoff yet. swarm handoff generate --stage S1 --dry-run shows what it would cost.');
  const todos = guides.flatMap(g => todoLines(g.text).map(t => `${g.name}:${t.line}`));
  return out([
    `Handoff ${state?.stage ?? ''}: ${guides.map(g => g.name).join(', ') || 'no files'}.`,
    `TODO (owner) left: ${todos.length}${todos.length ? ` (${todos.slice(0, 8).join(', ')})` : ''}.`,
    state?.checkedAt ? `Last check: ${state.checked} step(s), ${state.failures} failed (${state.checkedAt}).` : 'Not checked against a preview yet.',
    `Final: ${state?.final ? 'yes' : 'no'}.`,
  ].join('\n'));
}

async function final(root, deps) {
  const guides = await guideFiles(root);
  const state = await readHandoffState(root);
  const need = ['user-guide.md', 'admin-guide.md', 'runbook.md'].filter(n => !guides.some(g => g.name === n));
  if (need.length) return out(`Not final: missing ${need.join(', ')}.`, 1);
  const todos = guides.flatMap(g => todoLines(g.text).map(t => `${g.name}:${t.line}`));
  if (todos.length) return out(`Not final: ${todos.length} item(s) still say ${TODO} (${todos.slice(0, 8).join(', ')}).`, 1);
  if (!state?.checkedAt) return out('Not final: the guides were never checked against a preview (swarm handoff check --url PREVIEW).', 1);
  if (state.failures) return out(`Not final: the last check had ${state.failures} failed step(s).`, 1);
  if (!state.generatedAt || Date.parse(state.checkedAt) < Date.parse(state.generatedAt)) return out('Not final: the guides were not generated and then checked (swarm handoff generate, then swarm handoff check).', 1);
  if (!state.guidesHash || state.guidesHash !== guidesHash(guides)) return out('Not final: a guide changed after the last check; run swarm handoff check again.', 1);
  await writeHandoffState(root, { ...state, final: true, finalAt: new Date(deps.now()).toISOString() });
  return out('The handoff is final: no TODO (owner) left and the last check passed.');
}
