import { apiDoctor, probeLocalProvider } from '../api-adapters.mjs';
import { containsKey, resolveWorkerKey } from '../claude-shell.mjs';
import { execViaFile, EXTRA_CLI_AGENTS, extraCliDoctor } from '../cli-adapters.mjs';
import { remoteExec, resolveCliHosts } from '../cli-host.mjs';
import { codexDoctor } from '../codex-adapter.mjs';
import { cursorDoctor, readCursorKey } from '../cursor-adapter.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { fail, loadLocalConfigInline, validateOutputCap } from './core-1.mjs';
import { relative } from './core-11.mjs';
import { safePath, toolchainsReport } from './core-21.mjs';
import { NOTE_INVALID_ARGS, NOTE_INVALID_PATH, OUTPUT_CAP_BYTES, PRIVATE_DATA_WITHHELD_TEXT } from './patterns.mjs';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Decision #154 guard: a run with a claude shell job is refused by integrate and ship when its
// diff, results, logs or saved exchange hold the worker key (exact bytes), before any write to
// the project or git. The key comes from the same parent-only source the run used.
// A cursor job is checked the same way against CURSOR_API_KEY from the integrating environment.
export async function workerKeyGuard(root, id, state, { env = process.env, keyExec, extraFiles = [] } = {}) {
  const hasShell = state.jobs.some(job => job.shell === true), hasCursor = state.jobs.some(job => job.agent === 'cursor');
  if (!hasShell && !hasCursor) return;
  if (state.jobs.some(job => job.workerKeyExposed)) fail(`Refusing: run ${id} exposed the worker API key during a ${hasShell ? 'shell' : 'cursor'} job`);
  const keys = [];
  if (hasShell) {
    try { keys.push(await resolveWorkerKey({ env, exec: keyExec, config: loadLocalConfig({ env }) })); } catch (error) { fail(`Refusing: cannot check run ${id} for the worker API key: ${error.message}`); }
  }
  { const cursorKey = hasCursor ? readCursorKey(env) : undefined; if (cursorKey) keys.push(cursorKey); }
  if (!keys.length) return;
  const hits = [];
  const check = async file => { try { const info = await fs.lstat(file); if (info.isFile()) { const bytes = await fs.readFile(file); if (keys.some(key => containsKey(bytes, key))) hits.push(path.relative(root, file)); } } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const walk = async dir => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile()) await check(file); }
  };
  for (const dir of [`.swarm/runs/${id}`, `.swarm/workspaces/${id}`]) await walk(await safePath(root, dir, { internal: true }));
  for (const file of extraFiles) await check(file);
  if (hits.length) fail(`Refusing: run ${id} contains the worker API key in ${hits.slice(0, 5).join(', ')}`);
}

// Automatic jobs whose existing output files are too big for a single-request API worker (the output cap): they are routed to a lane that edits in place (Cursor, Codex, Claude)
// instead of failing at planning with output-cap-exceeded.
export async function editInPlaceOnlyJobs(root, manifest, { env = process.env, home = os.homedir() } = {}) {
  const ids = new Set();
  const config = loadLocalConfig({ env, home });
  const configured = config.outputCap === undefined ? OUTPUT_CAP_BYTES : validateOutputCap(config.outputCap, 'outputCap');
  for (const job of manifest.jobs ?? []) {
    if (job.agent !== 'auto' || job.shell === true || !Array.isArray(job.outputs)) continue;
    const cap = job.outputCapBytes ?? configured;
    const sizes = [];
    for (const file of job.outputs) {
      try { const info = await fs.stat(await safePath(root, file)); if (info.isFile()) sizes.push(info.size); } catch { /* a file that does not exist yet has no size */ }
    }
    const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
    if (sizes.some(bytes => bytes > cap.perFile || (total > cap.total && bytes > 0))) ids.add(job.id);
  }
  return ids;
}

async function snapshotHash(root, file) {
  const target = await safePath(root, file, { readOnly: true });
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function failedStderrTail(root, id, job, record) {
  if (record.status === 'complete') return {};
  if (job.privateData === true) return { stderrTail: PRIVATE_DATA_WITHHELD_TEXT };
  const file = await safePath(root, `.swarm/runs/${id}/${job.id}/stderr.txt`, { internal: true });
  let handle;
  try { handle = await fs.open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return { stderrTail: null }; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('Expected regular stderr stream');
    const chunks = [];
    let offset = info.size, newlines = 0;
    while (offset > 0 && newlines < 21) {
      const size = Math.min(offset, 65536);
      offset -= size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      const bytes = buffer.subarray(0, bytesRead);
      for (const byte of bytes) if (byte === 10) newlines++;
      chunks.unshift(bytes);
    }
    const lines = Buffer.concat(chunks).toString('utf8').replaceAll('\r\n', '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return { stderrTail: lines.slice(-20).join('\n') };
  } finally { await handle.close(); }
}

export async function noteRun(root, { text, file = 'TASK.md' } = {}, { now = Date.now, env = process.env, home = os.homedir(), config } = {}) {
  if (typeof text !== 'string' || !text.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) fail(NOTE_INVALID_ARGS, 'note-invalid-args');
  let target, coordinationDir, legacyRootNote = false, coordinationFile = false;
  try {
    const localConfig = config ?? await loadLocalConfigInline({ env, home });
    const hasConfiguredCoordination = Boolean(localConfig.coordinationDir ?? localConfig.coordination?.dir ?? localConfig.paths?.coordination);
    coordinationDir = localConfig.coordinationDir ?? localConfig.coordination?.dir ?? localConfig.paths?.coordination ?? 'coordination';
    relative(coordinationDir);
    const bareFile = ['TASK.md', 'HANDOFF.md'].includes(file) && path.basename(file) === file;
    coordinationFile = typeof file === 'string' && file.startsWith(`${coordinationDir}/`) &&
      ['TASK.md', 'HANDOFF.md'].includes(path.basename(file)) && path.dirname(file) === coordinationDir;
    if (!bareFile && !coordinationFile) throw Error();
    const useConfiguredCoordination = config !== undefined;
    if (!useConfiguredCoordination) {
      // Preserve the pre-coordination API for callers that have not selected a configured
      // coordination directory. The configured path below remains strict and never creates a
      // root-level replacement.
      target = await safePath(root, file);
      if (!(await fs.lstat(path.dirname(target))).isDirectory()) throw Error();
      if (coordinationFile) {
        if (!(await fs.lstat(target)).isFile()) throw Error();
      } else {
        try {
          if (!(await fs.lstat(target)).isFile()) throw Error();
        } catch (targetError) {
          if (targetError.code !== 'ENOENT') throw targetError;
        }
        legacyRootNote = true;
      }
    } else {
      if (!bareFile) throw Error();
      target = await safePath(root, `${coordinationDir}/${file}`);
      if (!(await fs.lstat(path.dirname(target))).isDirectory()) throw Error();
      if (!(await fs.lstat(target)).isFile()) throw Error();
    }
  } catch { fail(NOTE_INVALID_PATH, 'note-invalid-path'); }
  try {
    let prior;
    try { prior = await fs.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; prior = Buffer.alloc(0); }
    const timestamp = new Date(now()).toISOString();
    await fs.appendFile(target, `${prior.length && prior.at(-1) !== 10 ? '\n' : ''}- ${timestamp} ${text}\n`);
    return { status: 'complete', file: legacyRootNote || coordinationFile ? file : `${coordinationDir}/${file}`, timestamp };
  } catch { fail('note-write-failed: could not append a clock-stamped note', 'note-write-failed'); }
}

export async function doctor({exec=execViaFile, agent='claude', env=process.env, platform=process.platform, probeLocal=false, probeTimeoutMs=1500, fetchImpl=fetch, home=os.homedir(), fsImpl=fs, root, access}={}){
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<20||(major===20&&minor<3))fail('Node 20.3 or newer is required');
  // Field lesson 106: advisory only, added to every agent's result; it never changes status/configured.
  const toolchains=await toolchainsReport({root,env,home,platform,fsImpl,access});
  if(agent==='codex')return {...await codexDoctor({exec,platform}),toolchains};
  if(agent==='cursor')return {...await cursorDoctor({exec,platform,env}),toolchains};
  if(process.platform==='win32')fail('Use macOS, Linux, or WSL; native Windows process-group cleanup is not supported');
  if(EXTRA_CLI_AGENTS.includes(agent)){
    const host=resolveCliHosts(loadLocalConfig({env}).cliHosts)[agent];
    return {...await extraCliDoctor(agent,host?remoteExec(host,exec):exec),...(host?{host:host.target,hostCommand:host.command}:{}),toolchains};
  }
  if(agent!=='claude')return {...await(probeLocal ? probeLocalProvider(agent,env,{timeoutMs:probeTimeoutMs,fetchImpl}) : apiDoctor(agent,env)),toolchains};
  const options={timeout:10000,maxBuffer:1024*1024};
  const version=await exec('claude',['--version'],options);
  const required=['--restricted','--safe-mode','--tools','--permission-prompts','--strict-mcp-config','--mcp-config','--no-session-persistence','--no-chrome','--output-format'];
  // Claude 2.1.280's --help pipe can exit before it drains even through the file-backed exec; retry once,
  // then tell an empty/failed probe apart from output that is complete but genuinely missing a flag.
  let help=await exec('claude',['--help'],options).catch(()=>({stdout:''}));
  let missing=required.filter(flag=>!help.stdout.includes(flag));
  if(missing.length){help=await exec('claude',['--help'],options).catch(()=>({stdout:''}));missing=required.filter(flag=>!help.stdout.includes(flag));}
  if(!help.stdout)fail('Claude CLI help probe failed (no or empty output)');
  if(missing.length)fail(`Installed Claude CLI lacks required flags: ${missing.join(', ')}. Update Claude; restrictions will not be weakened.`);
  return {status:'compatible',node:process.versions.node,claude:version.stdout.trim(),auth:'not checked; use a live smoke job',liveVerified:false,platform:process.platform,toolchains};
}

export { failedStderrTail, snapshotHash };
