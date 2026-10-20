// SPDX-License-Identifier: Apache-2.0
// orchestrator-up: a second always-on Claude remote-control seat in tmux, startable at login via launchd.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const ORCHESTRATOR_USAGE =
  'Usage: node tools/orchestrator-up.mjs up|down|status|launchd install|launchd uninstall [--root DIR] [--name NAME] [--permission-mode MODE] [--dry-run]';

const PERMISSION_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;

export function slugFromBasename(name) {
  const lower = String(name).toLowerCase();
  let slug = lower.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/-+$/g, '');
  return slug;
}

export function defaultSessionName(rootBasename) {
  return `swarm-orch-${slugFromBasename(rootBasename)}`;
}

export function launchdLabel(sessionOrSlug) {
  const part = String(sessionOrSlug).replace(/[^A-Za-z0-9._-]/g, '-');
  return `com.project-swarm.orchestrator.${part}`;
}

export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function findExecutableOnPath(name, envPath = process.env.PATH ?? '') {
  for (const dir of String(envPath).split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export function pathDirsForTools(tmuxPath, claudePath, fallback = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin') {
  const dirs = [];
  const add = d => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  if (tmuxPath) add(path.dirname(tmuxPath));
  if (claudePath) add(path.dirname(claudePath));
  for (const d of fallback.split(':')) add(d);
  return dirs.join(':');
}

export function buildPlist({ label, programArguments, root, logPath, pathEnv }) {
  const argsXml = programArguments.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(root)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

export function parseArgv(argv) {
  const out = { root: null, name: null, permissionMode: null, dryRun: false, rest: [] };
  const args = [...argv];
  while (args.length) {
    const a = args[0];
    if (a === '--root') {
      args.shift();
      out.root = args.shift();
      if (!out.root) throw new Error('missing --root value');
      continue;
    }
    if (a === '--name') {
      args.shift();
      out.name = args.shift();
      if (!out.name) throw new Error('missing --name value');
      continue;
    }
    if (a === '--permission-mode') {
      args.shift();
      out.permissionMode = args.shift();
      if (!out.permissionMode) throw new Error('missing --permission-mode value');
      continue;
    }
    if (a === '--dry-run') {
      args.shift();
      out.dryRun = true;
      continue;
    }
    out.rest.push(args.shift());
  }
  return out;
}

export function defaultDeps(overrides = {}) {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? os.homedir();
  const platform = overrides.platform ?? process.platform;
  const uid = overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const realpath = overrides.realpath ?? (p => fsp.realpath(p));
  const run =
    overrides.run ??
    ((cmd, args, opts = {}) => {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        env: opts.env ?? env,
        cwd: opts.cwd,
        shell: false,
        ...opts,
      });
      return {
        code: r.status ?? 1,
        stdout: String(r.stdout ?? ''),
        stderr: String(r.stderr ?? ''),
      };
    });
  return { run, env, home, platform, uid, realpath, scriptPath: overrides.scriptPath ?? SCRIPT_PATH };
}

async function resolveRoot(deps, rootOpt) {
  const raw = rootOpt ?? process.cwd();
  return await deps.realpath(raw);
}

async function resolveSession(deps, rootOpt, nameOpt) {
  const root = await resolveRoot(deps, rootOpt);
  const basename = path.basename(root);
  const session = nameOpt ?? defaultSessionName(basename);
  return { root, session, basename };
}

function refuse(code, error) {
  return { exitCode: 1, json: { status: 'error', code, error } };
}

function ok(json) {
  return { exitCode: 0, json };
}

function validateName(name) {
  if (!SESSION_NAME_RE.test(name)) {
    return refuse('orchestrator-bad-name', `session name must match ${SESSION_NAME_RE}`);
  }
  return null;
}

function validateMode(mode) {
  if (mode != null && !PERMISSION_MODES.has(mode)) {
    return refuse('orchestrator-bad-mode', `permission mode must be one of: ${[...PERMISSION_MODES].join(', ')}`);
  }
  return null;
}

function checkTools(deps) {
  const tmux = findExecutableOnPath('tmux', deps.env.PATH);
  if (!tmux) {
    return refuse(
      'orchestrator-missing-tool',
      'tmux is not on PATH (hint: brew install tmux)',
    );
  }
  const claude = findExecutableOnPath('claude', deps.env.PATH);
  if (!claude) {
    return refuse(
      'orchestrator-missing-tool',
      'claude is not on PATH (install Claude Code and ensure the claude CLI is available)',
    );
  }
  return { tmux, claude };
}

export async function cmdUp(deps, opts = {}) {
  const { root, session } = await resolveSession(deps, opts.root, opts.name);
  const badName = validateName(session);
  if (badName) return badName;
  const badMode = validateMode(opts.permissionMode);
  if (badMode) return badMode;
  const tools = checkTools(deps);
  if (tools.exitCode) return tools;

  const has = deps.run(tools.tmux, ['has-session', '-t', `=${session}`], { env: deps.env });
  if (has.code === 0) {
    return ok({
      status: 'running',
      session,
      root,
      attach: `tmux attach -t ${session}`,
    });
  }

  const claudeArgs = ['remote-control', '--name', session];
  if (opts.permissionMode) claudeArgs.push('--permission-mode', opts.permissionMode);
  const newArgs = ['new-session', '-d', '-s', session, '-c', root, 'claude', ...claudeArgs];
  const started = deps.run(tools.tmux, newArgs, { env: deps.env });
  if (started.code !== 0) {
    return refuse('orchestrator-tmux-failed', (started.stderr || started.stdout || 'tmux new-session failed').trim());
  }
  return ok({
    status: 'started',
    session,
    root,
    attach: `tmux attach -t ${session}`,
  });
}

export async function cmdDown(deps, opts = {}) {
  const { session } = await resolveSession(deps, opts.root, opts.name);
  const badName = validateName(session);
  if (badName) return badName;

  const tmux = findExecutableOnPath('tmux', deps.env.PATH);
  if (!tmux) {
    return refuse('orchestrator-missing-tool', 'tmux is not on PATH (hint: brew install tmux)');
  }

  const has = deps.run(tmux, ['has-session', '-t', `=${session}`], { env: deps.env });
  if (has.code !== 0) {
    return ok({ status: 'not-running', session });
  }

  const killed = deps.run(tmux, ['kill-session', '-t', `=${session}`], { env: deps.env });
  if (killed.code !== 0) {
    return refuse('orchestrator-tmux-failed', (killed.stderr || killed.stdout || 'tmux kill-session failed').trim());
  }
  return ok({ status: 'stopped', session });
}

export async function cmdStatus(deps, opts = {}) {
  const { root, session } = await resolveSession(deps, opts.root, opts.name);
  const badName = validateName(session);
  if (badName) return badName;

  const tmux = findExecutableOnPath('tmux', deps.env.PATH);
  if (!tmux) {
    return ok({ status: 'not-running', session, root });
  }

  const has = deps.run(tmux, ['has-session', '-t', `=${session}`], { env: deps.env });
  return ok({
    status: has.code === 0 ? 'running' : 'not-running',
    session,
    root,
  });
}

function labelForSession(session, basename) {
  const slug = slugFromBasename(basename);
  const defaultName = defaultSessionName(basename);
  const part = session === defaultName ? slug : session;
  return launchdLabel(part);
}

export async function cmdLaunchdInstall(deps, opts = {}) {
  if (deps.platform !== 'darwin') {
    return refuse('orchestrator-not-macos', 'launchd is only available on macOS');
  }
  const { root, session, basename } = await resolveSession(deps, opts.root, opts.name);
  const badName = validateName(session);
  if (badName) return badName;
  const badMode = validateMode(opts.permissionMode);
  if (badMode) return badMode;

  const tools = checkTools(deps);
  if (tools.exitCode) return tools;

  const label = labelForSession(session, basename);
  const plistPath = path.join(deps.home, 'Library', 'LaunchAgents', `${label}.plist`);
  const logPath = path.join(deps.home, 'Library', 'Logs', 'project-swarm', `${label}.log`);
  const pathEnv = pathDirsForTools(tools.tmux, tools.claude);

  const programArguments = [
    process.execPath,
    deps.scriptPath,
    'up',
    '--root',
    root,
    '--name',
    session,
  ];
  if (opts.permissionMode) {
    programArguments.push('--permission-mode', opts.permissionMode);
  }

  const plist = buildPlist({ label, programArguments, root, logPath, pathEnv });

  if (opts.dryRun) {
    return ok({ status: 'dry-run', label, plistPath, plist });
  }

  await fsp.mkdir(path.dirname(plistPath), { recursive: true });
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const tmp = `${plistPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, plist, { mode: 0o644 });
  await fsp.rename(tmp, plistPath);
  await fsp.chmod(plistPath, 0o644);

  const domain = `gui/${deps.uid}`;
  deps.run('launchctl', ['bootout', `${domain}/${label}`], { env: deps.env });
  const boot = deps.run('launchctl', ['bootstrap', domain, plistPath], { env: deps.env });
  if (boot.code !== 0) {
    return refuse('orchestrator-launchctl-failed', (boot.stderr || boot.stdout || 'launchctl bootstrap failed').trim());
  }

  return ok({ status: 'installed', label, plistPath });
}

export async function cmdLaunchdUninstall(deps, opts = {}) {
  if (deps.platform !== 'darwin') {
    return refuse('orchestrator-not-macos', 'launchd is only available on macOS');
  }
  const { session, basename } = await resolveSession(deps, opts.root, opts.name);
  const badName = validateName(session);
  if (badName) return badName;

  const label = labelForSession(session, basename);
  const plistPath = path.join(deps.home, 'Library', 'LaunchAgents', `${label}.plist`);
  const domain = `gui/${deps.uid}`;

  deps.run('launchctl', ['bootout', `${domain}/${label}`], { env: deps.env });

  let removed = false;
  try {
    await fsp.unlink(plistPath);
    removed = true;
  } catch {
    removed = false;
  }

  return ok({
    status: 'uninstalled',
    label,
    plistPath,
    removed,
    note: 'tmux session left running; use down',
  });
}

export async function runOrchestratorCommand(args, deps = defaultDeps()) {
  if (!args.length || args.includes('--help') || args[0] === 'help') {
    return { exitCode: 0, stdout: `${ORCHESTRATOR_USAGE}\n`, json: null };
  }

  let parsed;
  try {
    parsed = parseArgv(args);
  } catch (e) {
    return refuse('orchestrator-usage', String(e.message ?? e));
  }

  const [cmd, sub, ...subRest] = parsed.rest;
  const flagOpts = {
    root: parsed.root,
    name: parsed.name,
    permissionMode: parsed.permissionMode,
    dryRun: parsed.dryRun,
  };

  if (cmd === 'up') {
    if (subRest.length) return refuse('orchestrator-usage', 'unexpected arguments to up');
    const r = await cmdUp(deps, flagOpts);
    return { exitCode: r.exitCode, json: r.json };
  }
  if (cmd === 'down') {
    if (subRest.length) return refuse('orchestrator-usage', 'unexpected arguments to down');
    const r = await cmdDown(deps, flagOpts);
    return { exitCode: r.exitCode, json: r.json };
  }
  if (cmd === 'status') {
    if (subRest.length) return refuse('orchestrator-usage', 'unexpected arguments to status');
    const r = await cmdStatus(deps, flagOpts);
    return { exitCode: r.exitCode, json: r.json };
  }
  if (cmd === 'launchd' && sub === 'install') {
    if (subRest.length) return refuse('orchestrator-usage', 'unexpected arguments to launchd install');
    const r = await cmdLaunchdInstall(deps, flagOpts);
    return { exitCode: r.exitCode, json: r.json };
  }
  if (cmd === 'launchd' && sub === 'uninstall') {
    if (subRest.length) return refuse('orchestrator-usage', 'unexpected arguments to launchd uninstall');
    const r = await cmdLaunchdUninstall(deps, flagOpts);
    return { exitCode: r.exitCode, json: r.json };
  }

  return {
    exitCode: 1,
    stdout: `${ORCHESTRATOR_USAGE}\n`,
    json: { status: 'error', code: 'orchestrator-usage', error: `unknown command: ${cmd ?? '(none)'}` },
  };
}

export async function main(argv = process.argv.slice(2), deps = defaultDeps()) {
  const result = await runOrchestratorCommand(argv, deps);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.json) process.stdout.write(`${JSON.stringify(result.json)}\n`);
  return result.exitCode ?? 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => {
    process.exitCode = code;
  });
}
