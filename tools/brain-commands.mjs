// SPDX-License-Identifier: Apache-2.0
// Glue for the local brain (Phase 14b): config, the lazy link to dev2, the Haiku fallback, the ledger file, and the
// commands `think`, `digest`, `draft` and `brain`. Runner-side only; workers never get any of this.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openBrainLink } from './brain-link.mjs';
import { createBrain, summarizeBrainLedger, estimateTokens } from './brain.mjs';
import { think, digest, triage, draftThenPolish, preflight } from './brain-tasks.mjs';
import { safeWritableDir, assertRegularOrMissing, sanitizeText } from './journal.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { DEFAULT_MODELS, ANTHROPIC_ENDPOINT, ANTHROPIC_VERSION, readAnthropicKey, ledgerPath, readLedger, appendLedger, spentSoFar, worstCaseUsd, assertWithinCaps, caps, usageCostUsd } from './anthropic.mjs';
import { protectedPathHit } from './init-profile.mjs';

const LEDGER = ['.swarm', 'project'];
const USAGE = {
  think: 'Usage: swarm think "QUESTION" [--rounds N] [--json]\n',
  digest: 'Usage: swarm digest <file|run-id|-> [--kind log|diff|tests|run] [--json]\n',
  draft: 'Usage: swarm draft docs|pr|plan "BRIEF" [--context f1,f2] [--out FILE] [--json]\n',
  brain: 'Usage: swarm brain status|stats|test [--json] [--markdown]\n',
};
const bad = command => ({ stdout: USAGE[command], exitCode: 1 });
const SECRET_PATH = /(^|\/)(\.env(\..*)?|\.git|\.git-credentials|\.ssh|\.aws|\.gnupg|\.docker|\.swarm|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|id_ecdsa|credentials(\.json)?)(\/|$)|\.(pem|key|p12|pfx|keystore)$/i;
const MAX_FILE = 2 * 1024 * 1024;

export function brainSettings(env = process.env) {
  let config = {};
  try { config = loadLocalConfig({ env }).localBrain ?? {}; } catch { config = {}; }
  return { enabled: config.enabled === true, ...config, concurrency: Math.min(2, Math.max(1, Number(config.concurrency) || 1)) };
}

const expandHome = file => (typeof file === 'string' && file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);

// Haiku on the Anthropic lane, under the machine-wide caps. Never used for sensitive material (the brain enforces that).
export function haikuFallback({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  let counter = 0;
  return async (messages, { maxTokens = 600 } = {}) => {
    const key = readAnthropicKey(env);
    if (!key) throw Object.assign(new Error('brain-unavailable: no Anthropic key for the fallback'), { code: 'brain-unavailable' });
    const model = DEFAULT_MODELS.cheap;
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    const turns = messages.filter(message => message.role !== 'system').map(message => ({ role: message.role, content: message.content }));
    const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
    const stamp = now(), file = ledgerPath(env), jobId = `brain-${stamp.getTime()}-${counter++}`;
    const worstUsd = worstCaseUsd(model, { inputChars: chars, maxTokens });
    try { assertWithinCaps({ worstUsd, spent: spentSoFar(readLedger(file), { jobId, day: stamp.toISOString().slice(0, 10) }), limits: caps(env) }); }
    catch (error) { throw Object.assign(new Error(`brain-unavailable: ${error.message}`), { code: 'brain-unavailable' }); }
    let response;
    try {
      response = await fetchImpl(ANTHROPIC_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }, body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: turns }), signal: AbortSignal.timeout(120000) });
    } catch { throw Object.assign(new Error('brain-unavailable: fallback request failed'), { code: 'brain-unavailable' }); }
    if (!response.ok) throw Object.assign(new Error(`brain-unavailable: fallback answered ${response.status}`), { code: 'brain-unavailable' });
    const body = await response.json().catch((error) => {
      console.error('[tools/brain-commands.mjs] haikuFallback response.json:', error?.message ?? error);
      return null;
    });
    const text = Array.isArray(body?.content) ? body.content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
    const usage = body?.usage ?? {};
    // A reply without usage is recorded at the worst case, never at zero.
    const known = Number.isFinite(Number(usage.input_tokens)) && Number.isFinite(Number(usage.output_tokens));
    const paidUsd = known ? usageCostUsd(model, usage) : worstUsd;
    appendLedger(file, { ts: stamp.toISOString(), jobId, model, costUsd: paidUsd, estimated: !known });
    return { text, usage: { inTokens: Number(usage.input_tokens) || 0, outTokens: Number(usage.output_tokens) || 0 }, paidUsd };
  };
}

async function readEvents(root) {
  try {
    const text = await fs.readFile(path.join(root, ...LEDGER, 'brain-ledger.ndjson'), 'utf8');
    return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  } catch { return []; }
}

async function writeEvent(root, event) {
  const dir = await safeWritableDir(root, LEDGER);
  const file = path.join(dir, 'brain-ledger.ndjson');
  await assertRegularOrMissing(file);
  await fs.appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

export async function brainStats(root) {
  return summarizeBrainLedger(await readEvents(root));
}

// A brain for this process: the link opens on first use and is closed by close().
export function createProjectBrain({ root, env = process.env, openLink = openBrainLink, fetchImpl = fetch } = {}) {
  const settings = brainSettings(env);
  let linkPromise = null;
  const getLink = async () => {
    if (!settings.enabled || !settings.sshTarget || !settings.sshKey || !settings.keyCommand) return null;
    if (linkPromise && (await linkPromise)?.status().up === false) linkPromise = null;
    linkPromise ??= openLink({ sshTarget: settings.sshTarget, sshKey: expandHome(settings.sshKey), remotePort: settings.remotePort ?? 8000, keyCommand: settings.keyCommand }, {}).catch((error) => {
      const code = error?.code;
      if (!code || !['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) {
        console.error('[tools/brain-commands.mjs] createProjectBrain openBrainLink:', error?.message ?? error);
      }
      return null;
    });
    return linkPromise;
  };
  const brain = createBrain({ getLink, fallback: haikuFallback({ env, fetchImpl }), concurrency: settings.concurrency, ledger: event => writeEvent(root, event) });
  return {
    brain, settings, link: getLink,
    ask: request => brain.ask(request),
    saved: (kind, savedTokens) => writeEvent(root, { kind, savedOnly: true, savedTokens }).catch((error) => {
      console.error('[tools/brain-commands.mjs] createProjectBrain saved writeEvent:', error?.message ?? error);
    }),
    async close() {
      brain.close();
      const link = await linkPromise?.catch((error) => {
        const code = error?.code;
        if (!code || !['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) {
          console.error('[tools/brain-commands.mjs] createProjectBrain close linkPromise:', error?.message ?? error);
        }
        return null;
      });
      link?.close();
    },
  };
}

const oneLine = text => sanitizeText(String(text)).replace(/\s+/g, ' ').trim();

async function readProjectFile(root, profile, relative, { max = MAX_FILE } = {}) {
  const clean = path.posix.normalize(String(relative).split(path.sep).join('/'));
  if (path.isAbsolute(clean) || clean.startsWith('..') || SECRET_PATH.test(clean) || protectedPathHit(profile, clean, { read: true })) throw new Error(`brain-path-refused: ${oneLine(relative)} is a protected or secret path`);
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(path.join(root, clean));
  if (!real.startsWith(`${realRoot}${path.sep}`)) throw new Error(`brain-path-refused: ${oneLine(relative)} resolves outside the project`);
  // What the path really points at is checked too: a link to .env or a protected folder is that file.
  const target = path.relative(realRoot, real).split(path.sep).join('/');
  if (SECRET_PATH.test(target) || protectedPathHit(profile, target)) throw new Error(`brain-path-refused: ${oneLine(relative)} is a protected or secret path`);
  const handle = await fs.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw new Error(`brain-path-refused: ${oneLine(relative)} is not a plain file under ${max} bytes`);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

function flagValue(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return { value: undefined, rest: args };
  if (at + 1 >= args.length) return null;
  return { value: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

// What a finished run looks like to a reader: its status and every job that did not complete, with errors.
export function runDigestText(state) {
  const lines = [`run ${state.id} ${state.status}`, `jobs ${state.jobs?.length ?? 0}`];
  for (const job of state.jobs ?? []) {
    if (job.status === 'complete') continue;
    lines.push(`job ${job.id} ${job.status}${job.agent ? ` agent ${job.agent}` : ''}${job.error ? ` error: ${String(job.error).slice(0, 400)}` : ''}${job.heldReason ? ` held: ${job.heldReason}` : ''}`);
  }
  return lines.join('\n');
}

export async function runBrainCommand(root, command, args, { env = process.env, readState, projectProfile, stdin = process.stdin, createBrain: make = createProjectBrain } = {}) {
  const profile = await projectProfile?.(root);
  const sensitive = profile?.sensitive !== false;
  const json = args.includes('--json');
  const rest0 = args.filter(arg => arg !== '--json' && arg !== '--markdown');
  const project = make({ root, env });
  const finish = async result => { await project.close?.(); return result; };
  try {
    if (command === 'brain') {
      const [verb, ...extra] = rest0;
      if (extra.length || !['status', 'stats', 'test'].includes(verb ?? '')) return finish(bad('brain'));
      if (verb === 'stats') {
        const stats = await brainStats(root);
        if (args.includes('--markdown')) return finish({ stdout: `- **Local brain:** ${stats.calls} calls (${stats.local} local, ${stats.haiku} Haiku fallback, ${stats.failed} failed); about ${stats.savedTokens} orchestrator tokens saved; paid $${stats.paidUsd.toFixed(4)}.\n`, exitCode: 0 });
        return finish({ stdout: json ? `${JSON.stringify(stats)}\n` : `calls ${stats.calls} (local ${stats.local}, haiku ${stats.haiku}, failed ${stats.failed})\ntokens in ${stats.inTokens}, out ${stats.outTokens}\norchestrator tokens saved (estimate) ${stats.savedTokens}\npaid $${stats.paidUsd.toFixed(4)}\n`, exitCode: 0 });
      }
      const settings = project.settings;
      if (verb === 'status') {
        const link = settings.enabled ? await project.link() : null;
        const out = { configured: settings.enabled, target: settings.enabled ? settings.sshTarget : null, concurrency: settings.concurrency, fallback: 'haiku (non-sensitive only)', linkUp: Boolean(link?.status().up), model: link?.status().model ?? null };
        return finish({ stdout: json ? `${JSON.stringify(out)}\n` : `local brain: ${out.configured ? `configured (${out.target}), ${out.linkUp ? `up, model ${out.model}` : 'DOWN'}` : 'not configured (fallback only)'}; concurrency ${out.concurrency}; fallback ${out.fallback}\n`, exitCode: 0 });
      }
      const answer = await project.ask({ kind: 'status', system: 'Reply with the single word ok.', user: 'ping', maxTokens: 8, sensitive: true });
      return finish({ stdout: json ? `${JSON.stringify({ via: answer.via, ms: answer.ms })}\n` : `local brain answered via ${answer.via} in ${answer.ms} ms\n`, exitCode: 0 });
    }
    if (command === 'think') {
      const rounds = flagValue(rest0, '--rounds');
      if (!rounds || rounds.rest.length !== 1) return finish(bad('think'));
      const result = await think(request => project.ask({ ...request, sensitive }), rounds.rest[0], { ...(rounds.value !== undefined ? { rounds: Number(rounds.value) } : {}) });
      await project.saved('think', result.savedTokens);
      return finish({ stdout: json ? `${JSON.stringify(result)}\n` : `${result.top3.map((entry, index) => `${index + 1}. ${entry.title} - ${entry.reason}`).join('\n')}\n(via ${result.via}, ${result.rounds} rounds)\n`, exitCode: 0 });
    }
    if (command === 'digest') {
      const kind = flagValue(rest0, '--kind');
      if (!kind || kind.rest.length !== 1 || (kind.value !== undefined && !['log', 'diff', 'tests', 'run'].includes(kind.value))) return finish(bad('digest'));
      const source = kind.rest[0];
      let text;
      if (source === '-') { const chunks = []; let size = 0; for await (const chunk of stdin) { chunks.push(chunk); size += chunk.length; if (size >= MAX_FILE) break; } text = Buffer.concat(chunks).toString('utf8').slice(0, MAX_FILE); }
      else if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(source) && await fs.stat(path.join(root, '.swarm', 'runs', source)).then(() => true, () => false)) text = runDigestText(await readState(root, source));
      else text = await readProjectFile(root, profile, source);
      const result = await digest((request) => project.ask({ ...request, sensitive }), text, { kind: kind.value ?? 'log' });
      await project.saved('digest', result.savedTokens);
      return finish({ stdout: json ? `${JSON.stringify(result)}\n` : `${result.lines.join('\n')}\n`, exitCode: 0 });
    }
    if (command === 'draft') {
      const context = flagValue(rest0, '--context');
      const out = context && flagValue(context.rest, '--out');
      if (!context || !out || out.rest.length !== 2 || !['docs', 'pr', 'plan'].includes(out.rest[0])) return finish(bad('draft'));
      // The destination is checked before any model is asked (and before anything is paid for): inside the project, not a secret or
      // protected path, and no folder on the way may be a link out of the project.
      let target = null;
      if (out.value) {
        const clean = path.posix.normalize(out.value);
        if (path.isAbsolute(clean) || clean.startsWith('..') || SECRET_PATH.test(clean) || protectedPathHit(profile, clean)) throw new Error(`brain-path-refused: ${oneLine(out.value)} is protected or outside the project`);
        target = path.join(root, clean);
        const realRoot = await fs.realpath(root);
        let probe = path.dirname(target);
        while (!(await fs.lstat(probe).then(() => true, () => false))) probe = path.dirname(probe);
        const realParent = await fs.realpath(probe);
        if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) throw new Error(`brain-path-refused: ${oneLine(out.value)} would be written outside the project`);
        if (SECRET_PATH.test(path.relative(realRoot, path.join(realParent, path.relative(probe, target))).split(path.sep).join('/'))) throw new Error(`brain-path-refused: ${oneLine(out.value)} is a secret path`);
      }
      const files = context.value ? context.value.split(',').filter(Boolean).slice(0, 10) : [];
      const texts = [];
      for (const file of files) texts.push(`--- ${oneLine(file)}\n${(await readProjectFile(root, profile, file, { max: 200000 })).slice(0, 20000)}`);
      const ask = request => project.ask({ ...request, sensitive });
      // The polish step sends the draft to Haiku, so a sensitive project keeps the draft local and unpolished.
      const polish = sensitive ? null : async (draft, { kind, brief }) => {
        const fallback = haikuFallback({ env });
        const reply = await fallback([{ role: 'system', content: `Review and fix this ${kind} draft: correct mistakes, tighten wording, keep every fact. Reply with the final text only.` }, { role: 'user', content: `Brief:\n${brief}\n\nDraft:\n${draft}` }], { maxTokens: 1500 });
        return { text: reply.text, note: 'polished by Haiku' };
      };
      const result = await draftThenPolish(ask, polish, { kind: out.rest[0], brief: out.rest[1], context: texts.join('\n\n') });
      await project.saved('draft', result.savedTokens);
      if (target) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const handle = await fs.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644).catch(error => { throw error.code === 'EEXIST' ? new Error(`brain-path-refused: ${oneLine(out.value)} already exists`) : error; });
        try { await handle.writeFile(`${result.text}\n`); } finally { await handle.close(); }
      }
      return finish({ stdout: json ? `${JSON.stringify(result)}\n` : `${result.text}\n${result.polished ? '' : `(${result.polishNote})\n`}`, exitCode: 0 });
    }
  } catch (error) {
    await project.close?.();
    return { stdout: `${oneLine(String(error.message ?? error).split('\n')[0])}\n`, exitCode: 1 };
  }
  return finish(bad('brain'));
}

// Failure triage for a run: one verdict per failed job. Hints go to the report for the owner and are never put into prompts.
export async function triageRun(root, runId, { project, readState, projectProfile }) {
  const state = await readState(root, runId);
  const profile = await projectProfile?.(root);
  const projectSensitive = profile?.sensitive !== false;
  // A job is sensitive unless both the project and the job itself say it is not.
  let manifestJobs = [];
  try { manifestJobs = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'runs', runId, 'manifest.json'), 'utf8')).jobs ?? []; } catch { manifestJobs = []; }
  const verdicts = [];
  for (const job of (state.jobs ?? []).filter(entry => ['failed', 'timeout'].includes(entry.status)).slice(0, 20)) {
    let tail = '';
    try {
      const handle = await fs.open(path.join(root, '.swarm', 'runs', runId, job.id, 'response.txt'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { tail = (await handle.readFile('utf8')).slice(-2000); } finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[tools/brain-commands.mjs] triageRun read response tail:', error?.message ?? error);
    }
    const sensitive = projectSensitive || manifestJobs.find(entry => entry.id === job.id)?.sensitive !== false;
    const attempts = Array.isArray(job.attempts) ? job.attempts.length : Number(job.attempts) || 0;
    const result = await triage(request => project.ask({ ...request, sensitive }), { jobId: job.id, status: job.status, error: job.error ?? '', tail, attempts, agent: job.agent ?? '', sensitive });
    await project.saved('triage', result.savedTokens);
    verdicts.push({ job: job.id, verdict: result.verdict, hint: result.hint, via: result.via });
    try {
      const dir = path.join(root, '.swarm', 'runs', runId, job.id);
      const file = path.join(dir, 'triage.json');
      await assertRegularOrMissing(file);
      const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${JSON.stringify({ verdict: result.verdict, hint: result.hint, via: result.via, at: new Date().toISOString() })}\n`); } finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[tools/brain-commands.mjs] triageRun write triage.json:', error?.message ?? error);
    }
  }
  return verdicts;
}

export async function preflightManifest(manifest, { project, sensitiveDefault = true }) {
  const risky = (manifest.jobs ?? []).filter(job => job.agent === 'claude' || /opus/i.test(String(job.model ?? '')) || job.tier === 'expensive');
  if (!risky.length) return [];
  const sensitive = risky.some(job => job.sensitive !== false) || sensitiveDefault;
  const found = await preflight(request => project.ask({ ...request, sensitive }), risky.map(job => ({ id: job.id, prompt: job.prompt, context: job.context ?? [], outputs: job.outputs ?? [], agent: job.agent })));
  return found.map(entry => ({ job: entry.job?.id ?? String(entry.job), issues: entry.issues }));
}

export { estimateTokens };
