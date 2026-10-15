// SPDX-License-Identifier: Apache-2.0
// Runs a text-envelope CLI worker (Hermes, Qwen) on another machine over ssh. The machine config
// names the host and the absolute path of the CLI there:
//   "cliHosts": { "hermes": { "target": "dev2@10.10.10.220", "command": "/home/dev2/.local/bin/hermes" } }
// The job message goes to the remote CLI's stdin. No key, .env file or environment variable is sent:
// ssh forwards none, and the ssh client reads its own key from ~/.ssh on this machine.
import { EXTRA_CLI_AGENTS } from './cli-adapters.mjs';

const SSH_TARGET = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;
const REMOTE_COMMAND = /^\/[A-Za-z0-9._/+@-]{1,200}$/;

function invalid(message) {
  return Object.assign(new Error(`cli-hosts-invalid: ${message}`), { code: 'cli-hosts-invalid' });
}

// Returns { agent: { target, command } } for the agents that run remotely. Unknown agents, extra
// fields and unsafe values are refused so a typo can never point a job somewhere unintended.
export function resolveCliHosts(source) {
  if (source === undefined || source === null) return {};
  if (typeof source !== 'object' || Array.isArray(source)) throw invalid('cliHosts must be an object');
  const hosts = {};
  for (const [agent, entry] of Object.entries(source)) {
    if (!EXTRA_CLI_AGENTS.includes(agent)) throw invalid(`${agent} cannot run on a cli host; use ${EXTRA_CLI_AGENTS.join(' or ')}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid(`${agent} must be an object`);
    for (const key of Object.keys(entry)) if (!['target', 'command'].includes(key)) throw invalid(`unknown field ${agent}.${key}`);
    if (typeof entry.target !== 'string' || !SSH_TARGET.test(entry.target)) throw invalid(`${agent}.target must be a host or user@host`);
    if (typeof entry.command !== 'string' || !REMOTE_COMMAND.test(entry.command)) throw invalid(`${agent}.command must be an absolute path on the host`);
    hosts[agent] = { target: entry.target, command: entry.command };
  }
  return hosts;
}

// ssh joins its arguments into one string for the remote shell, so every part is single-quoted.
export function shellQuote(value) {
  if (typeof value !== 'string' || /[\0\n\r]/.test(value)) throw invalid('arguments must be strings without newline or NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshInvocation(host, args) {
  return {
    command: 'ssh',
    args: [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=20',
      '-o', 'ConnectionAttempts=4',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-o', 'SendEnv=-*',
      host.target,
      [host.command, ...args].map(shellQuote).join(' '),
    ],
  };
}

// An exec(command, args, options) for doctor that runs the CLI on the host instead.
export function remoteExec(host, exec) {
  return (command, args, options) => {
    const { command: ssh, args: sshArgs } = sshInvocation(host, args);
    // A flaky link needs longer than a local probe: ssh itself retries the connection up to 4 times.
    return exec(ssh, sshArgs, { ...options, timeout: Math.max(options?.timeout ?? 0, 90000) });
  };
}

export function cliHostFailure(code) {
  return code === 255 ? 'cli host unreachable (ssh exit 255)' : null;
}
