// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePrPayload } from './ship.mjs';

export const SCAFFOLD_USAGE = [
  'Usage: swarm [--root PROJECT] scaffold job --id X --agent A --model M --tier cheap|mid|expensive',
  '       --context a,b --outputs c,d [--command "swarm command"] [--prompt-file F] [--ticket docs/TICKETS.md#T81] [--out F]',
  '       swarm [--root PROJECT] scaffold pr --from RUN --title T [--repo O/R] [--out F]',
  '       scaffold [job|pr] [--help|-h]',
].join('\n') + '\n';
const failure = (code, detail) => ({ status: 'error', code, ...detail });
function invalid(message) {
  throw Object.assign(new Error(message), { scaffoldError: failure('scaffold-args', { message }) });
}
function commaList(value, empty = false) {
  if (empty && !value.trim()) return [];
  const items = value.split(',').map(item => item.trim());
  if (items.some(item => !item)) invalid('comma lists cannot contain empty members');
  return [...new Set(items)];
}
export function parseScaffoldArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const options = {}, seen = new Set();
  const common = { '--root': 'root', '--out': 'out' };
  const job = { '--id': 'id', '--agent': 'agent', '--model': 'model', '--tier': 'tier', '--context': 'context', '--outputs': 'outputs', '--prompt-file': 'promptFile', '--ticket': 'ticket', '--command': 'swarmCommand' };
  const pr = { '--from': 'from', '--title': 'title', '--repo': 'repo' };
  // Global --root is accepted before or after the subcommand.
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('-')) {
      if (options.command || !['job', 'pr'].includes(flag)) invalid('expected scaffold job or pr');
      options.command = flag;
      continue;
    }
    const key = common[flag] ?? job[flag] ?? pr[flag];
    if (!key) invalid('unknown scaffold flag: ' + flag);
    if (seen.has(flag)) invalid('duplicate scaffold flag: ' + flag);
    seen.add(flag);
    const value = argv[++index];
    if (typeof value !== 'string' || value.includes('\0') || value.startsWith('-') || (!value.trim() && flag !== '--outputs')) invalid(flag + ' requires a value');
    options[key] = flag === '--context' || flag === '--outputs' ? commaList(value, flag === '--outputs') : value;
  }
  if (!options.command) invalid('expected scaffold job or pr');
  const allowed = { ...common, ...(options.command === 'job' ? job : pr) };
  for (const flag of seen) if (!allowed[flag]) invalid('unsupported flag for scaffold ' + options.command + ': ' + flag);
  for (const key of options.command === 'job' ? ['id', 'agent', 'model', 'tier', 'context', 'outputs'] : ['from', 'title']) {
    if (options[key] === undefined) invalid('missing --' + key);
  }
  if (options.command === 'job' && !['cheap', 'mid', 'expensive'].includes(options.tier)) invalid('invalid tier');
  if (options.from && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(options.from)) invalid('invalid run id');
  if (options.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) invalid('invalid repo');
  return options;
}

// Lesson 327: derive command ownership from the installed CLI dispatch, not a second table.
export async function commandHandlers() {
  const source = await fs.readFile(new URL('./swarm.mjs', import.meta.url), 'utf8');
  const imports = new Map();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"]/g)) {
    for (const name of match[1].split(',')) imports.set(name.trim().split(/\s+as\s+/).at(-1), 'tools/' + match[2]);
  }
  const localHandlers = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)].map(match => match[1]);
  const main = source.slice(source.indexOf('async function main()'));
  const branches = [...main.matchAll(/^  (?:if\s*\(|(?:}\s*)?else if\s*\(|case\s+['"])/gm)];
  const handlers = new Map();
  for (const [index, branch] of branches.entries()) {
    const block = main.slice(branch.index, branches[index + 1]?.index ?? main.length);
    const condition = block.split('\n')[0];
    const commands = [...condition.matchAll(/(?:args\[0\]|command|newCommand)\s*===\s*['"]([a-z][a-z-]*)['"]|case\s+['"]([a-z][a-z-]*)['"]/g)].map(match => match[1] ?? match[2]);
    const modules = new Set();
    if (localHandlers.some(name => new RegExp('\\b' + name + '\\s*\\(').test(block))) modules.add('tools/swarm.mjs');
    for (const match of block.matchAll(/import\(['"]\.\/([^'"]+)['"]\)/g)) modules.add('tools/' + match[1]);
    for (const [name, module] of imports) if (new RegExp('\\b' + name + '\\b').test(block)) modules.add(module);
    for (const command of commands) {
      const files = handlers.get(command) ?? new Set();
      for (const module of modules) files.add(module);
      handlers.set(command, files);
      // A subcommand table may dispatch to a different module than the parent parser.
      for (const route of block.matchAll(/\[([^\]]+)\]\.includes\(options\.command\)\s*\?\s*await\s*\(await import\(['"]\.\/([^'"]+)['"]\)\)/g)) {
        for (const verb of route[1].matchAll(/['"]([a-z][a-z-]*)['"]/g)) handlers.set(command + ' ' + verb[1], new Set(['tools/' + route[2]]));
      }
    }
  }
  // Commands implemented in this entry point have no separate imported handler.
  return new Map([...handlers].map(([command, modules]) => [command, modules.size ? [...modules].sort() : ['tools/swarm.mjs']]));
}
function namedCommand(text, handlers) {
  const command = text.trim().replace(/^swarm\s+/, '');
  return [...handlers.keys()].sort((a, b) => b.length - a.length).find(name => command === name || command.startsWith(name + ' '));
}
export function commandHandlerWarnings(job, handlers) {
  const commands = new Set();
  for (const match of job.prompt.matchAll(/\x60([^\x60\n]+)\x60|\bswarm\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)/g)) {
    const command = namedCommand(match[1] ?? match[2], handlers);
    if (command) commands.add(command);
  }
  const declared = new Set([...job.context, ...job.outputs]);
  return [...commands].flatMap(command => (handlers.get(command) ?? []).filter(file => !declared.has(file)).map(file => ({
    code: 'command-handler-not-in-job', jobId: job.id, command, path: file,
    message: 'command-handler-not-in-job: Job ' + job.id + ': swarm ' + command + ' handler ' + file + ' is in neither context nor outputs',
  })));
}

// New scaffold paths stay inside the selected root and never traverse symlinks.
async function safeFile(root, file, internal = false) {
  if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('\\')) throw Error('invalid file path');
  const relative = path.relative(root, path.resolve(root, file));
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Error('file must be inside root');
  const parts = relative.split(path.sep);
  if (parts[0] === '.git' || (!internal && parts[0] === '.swarm')) throw Error('reserved file path');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error('symlink path refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
async function writeScaffold(root, file, key, value) {
  let absolute;
  try {
    absolute = await safeFile(root, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    return { status: 'ok', file, [key]: value };
  } catch (error) {
    return error.code === 'EEXIST' ? failure('scaffold-exists', { file }) : failure('scaffold-io', { file, message: error.message });
  }
}
export async function scaffoldJob(root, options, deps) {
  let manifest, inputFile = root;
  try {
    root = await fs.realpath(root);
    const context = [...options.context];
    if (options.swarmCommand) {
      const handlers = await commandHandlers();
      const command = namedCommand(options.swarmCommand, handlers);
      if (!command) invalid('unknown swarm command: ' + options.swarmCommand);
      for (const file of handlers.get(command)) if (!context.includes(file)) context.push(file);
    }
    inputFile = options.promptFile ?? root;
    let prompt = options.promptFile ? await fs.readFile(await safeFile(root, options.promptFile), 'utf8') : 'Implement the declared outputs using the supplied context.';
    if (options.ticket) {
      const ticketFile = options.ticket.split('#')[0];
      inputFile = ticketFile;
      if (!(await fs.stat(await safeFile(root, ticketFile))).isFile()) throw Error('ticket file is missing');
      if (!context.includes(ticketFile)) context.push(ticketFile);
      prompt += '\nTicket: ' + options.ticket;
    }
    const job = { id: options.id, agent: options.agent, model: options.model, tier: options.tier, prompt, context, outputs: [...options.outputs], timeoutMs: { cheap: 900000, mid: 1800000, expensive: 2400000 }[options.tier], ignoreTests: [] };
    if (job.tier === 'expensive') job.tierReason = 'Explicit expensive tier requested for scaffolded job.';
    manifest = { version: 1, jobs: [job] };
    deps.validateManifest(manifest);
    const projectFiles = await deps.listProjectFiles(root);
    const uncovered = await deps.findUncoveredTests(root, job, projectFiles);
    const uncoveredTests = [...new Set(uncovered.map(item => item.test))].sort();
    job.ignoreTests = uncoveredTests;
    for (const test of uncoveredTests) job.prompt += '\nignoreTests: ' + test + " — Existing test is outside this job's declared outputs; the coordinator runs it after integration.";
    job.prompt += '\nReturn JSON only: {"status":"complete|partial|blocked","filesChanged":[],"reproTest":"PATH or n/a"}';
    deps.validateManifest(manifest);
    await deps.validateProject(root, manifest);
  } catch (error) { return error.code && /^E[A-Z]+$/.test(error.code) ? failure('scaffold-io', { file: inputFile, message: error.message }) : failure('scaffold-invalid', { message: error.message }); }
  return writeScaffold(root, options.out ?? '.swarm-manifests/' + options.id + '.json', 'manifest', manifest);
}

// Findings are inert text, escaped so they cannot inject scaffold section markers.
const markdown = value => (typeof value === 'string' ? value : JSON.stringify(value))
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '').replaceAll('\n', '\n  ');
// Read through the next level-two heading, without consuming later entries.
function changelogEntry(text) {
  const start = text.search(/^## /m);
  if (start === -1) return '';
  const remainder = text.slice(start), next = remainder.slice(1).search(/^## /m);
  return (next === -1 ? remainder : remainder.slice(0, next + 1)).trim();
}
export async function scaffoldPr(root, options, deps) {
  const runId = options.from;
  let state, manifest, inspected;
  try {
    root = await fs.realpath(root);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)) throw Error('invalid run id');
    await safeFile(root, '.swarm/runs/' + runId + '/state.json', true);
    state = await deps.readState(root, runId);
    if (state.root !== root || state.id !== runId) throw Error('run belongs to another root');
    manifest = deps.validateManifest(JSON.parse(await fs.readFile(await safeFile(root, '.swarm/runs/' + runId + '/manifest.json', true), 'utf8')));
    inspected = await deps.inspectResults(root, runId);
  } catch (error) { return failure('scaffold-run-invalid', { runId, message: error.message }); }
  let head, base;
  try {
    const branch = await deps.exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
    const defaultBranch = await deps.exec('gh', ['repo', 'view', ...(options.repo ? [options.repo] : []), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd: root });
    head = branch.code === 0 ? branch.stdout.trim() : '';
    base = defaultBranch.code === 0 ? defaultBranch.stdout.trim() : '';
    if (![head, base].every(value => /^[A-Za-z0-9._/-]{1,200}$/.test(value) && !value.startsWith('-'))) throw Error('branch unavailable');
  } catch { return failure('scaffold-branch-unavailable', { runId }); }
  let payload;
  try {
    const what = [];
    let changelogJob = null;
    for (const job of manifest.jobs) {
      const report = inspected.jobs.find(item => item.id === job.id)?.result ?? {};
      what.push('### ' + markdown(job.id));
      const changed = Array.isArray(report.filesChanged) ? report.filesChanged : Array.isArray(report.files_changed) ? report.files_changed : null;
      for (const file of changed ?? job.outputs) what.push('- ' + (changed ? '' : 'Declared path: ') + markdown(file));
      for (const finding of Array.isArray(report.findings) ? report.findings : report.findings ? [report.findings] : []) what.push('- ' + markdown(finding));
      if (changed?.includes('CHANGELOG.md')) changelogJob = job.id;
    }
    if (state.integratedFiles?.includes('CHANGELOG.md') || changelogJob) {
      const owner = changelogJob ?? manifest.jobs.find(job => job.outputs.includes('CHANGELOG.md'))?.id;
      const file = state.integratedAt ? 'CHANGELOG.md' : '.swarm/workspaces/' + runId + '/' + owner + '/CHANGELOG.md';
      const entry = changelogEntry(await fs.readFile(await safeFile(root, file, !state.integratedAt), 'utf8'));
      if (entry) what.push('', ...entry.split('\n').map(line => '> ' + markdown(line)));
    }
    const body = '## What\n\n' + what.join('\n') + '\n\n## Checks\n\n<!-- swarm:checks -->\n\n## Mutation check\n\n<!-- swarm:stub mutation -->\n\nSwarm-Run: ' + runId + '\nSwarm-Jobs: ' + manifest.jobs.map(job => job.id).join(', ') + '\n';
    payload = parsePrPayload(JSON.stringify({ title: options.title, head, base, body }));
  } catch (error) { return failure('scaffold-run-invalid', { runId, message: error.message }); }
  return writeScaffold(root, options.out ?? '.swarm-manifests/' + runId + '-pr.json', 'payload', payload);
}
