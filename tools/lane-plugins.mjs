// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import path from 'node:path';

export const LANE_PLUGINS = Object.freeze({
  claude: Object.freeze({
    name: 'claude',
    command: 'claude',
    loginHint: 'claude',
    healthArgs: ['--version'],
    args: ({ prompt }) => ['-p', prompt],
    loginFiles: ['~/.claude.json', '~/.claude/.credentials.json'],
    rateLimit: [/(?:you(?:'ve| have) hit your|usage|rate) limit[^\n]*/i, /\b429\b/],
    loggedOut: [/not logged in/i, /please run.*login/i, /authentication required/i],
  }),
  codex: Object.freeze({
    name: 'codex',
    command: 'codex',
    loginHint: 'codex login',
    healthArgs: ['--version'],
    args: ({ prompt }) => ['exec', prompt],
    loginFiles: ['~/.codex/auth.json'],
    rateLimit: [/rate[- ]?limit/i, /\b429\b/, /quota/i],
    loggedOut: [/not logged in/i, /login required/i, /unauthorized/i],
  }),
  gemini: Object.freeze({
    name: 'gemini',
    command: 'gemini',
    loginHint: 'gemini',
    healthArgs: ['--version'],
    args: ({ prompt }) => ['-p', prompt],
    loginFiles: ['~/.gemini/oauth_creds.json', '~/.gemini/settings.json'],
    rateLimit: [/rate[- ]?limit/i, /\b429\b/, /quota/i],
    loggedOut: [/not logged in/i, /login required/i, /authentication/i],
  }),
  opencode: Object.freeze({
    name: 'opencode',
    command: 'opencode',
    loginHint: 'opencode auth login',
    healthArgs: ['--version'],
    args: ({ prompt, model }) => ['run', ...(model ? ['-m', model] : []), prompt],
    loginFiles: ['~/.local/share/opencode/auth.json', '~/.config/opencode/auth.json'],
    rateLimit: [/rate[- ]?limit/i, /\b429\b/, /quota/i, /too many requests/i],
    loggedOut: [/not logged in/i, /login required/i, /api key/i, /unauthorized/i],
  }),
  cursor: Object.freeze({
    name: 'cursor',
    command: 'cursor-agent',
    loginHint: 'cursor-agent login',
    healthArgs: ['--version'],
    args: ({ prompt }) => ['-p', prompt],
    loginFiles: ['~/.cursor/cli-config.json', '~/.config/cursor/cli-config.json'],
    rateLimit: [/rate[- ]?limit/i, /\b429\b/, /too many requests/i],
    loggedOut: [/not logged in/i, /login required/i, /unauthorized/i, /no api key/i],
  }),
});

export const WORKER_LANE_NAMES = Object.freeze(Object.keys(LANE_PLUGINS));

export function laneDefinition(name) {
  return LANE_PLUGINS[name] ?? null;
}

export function isWorkerLane(name) {
  return Boolean(LANE_PLUGINS[name]);
}

export function buildLaneCommand({ lane, prompt, model, env = process.env } = {}) {
  const plugin = laneDefinition(lane);
  if (!plugin) throw Object.assign(new Error(`unknown lane ${lane}`), { code: 'lane-unknown' });
  if (typeof prompt !== 'string' || !prompt.trim()) throw Object.assign(new Error('lane prompt is empty'), { code: 'lane-prompt-empty' });
  const argv = plugin.args({ prompt, model, env });
  return { command: plugin.command, args: argv };
}

export function laneHealthArgs(name) {
  return laneDefinition(name)?.healthArgs ?? ['--version'];
}

export function laneLoginHint(name) {
  return laneDefinition(name)?.loginHint ?? `${LANE_PLUGINS[name]?.command ?? name} login`;
}

export function laneLoginFiles(name, home = os.homedir()) {
  return (laneDefinition(name)?.loginFiles ?? []).map(file => (file.startsWith('~/') ? path.join(home, file.slice(2)) : file));
}

export function detectLaneOutcome({ lane, exitCode = 0, stdout = '', stderr = '' } = {}) {
  const plugin = laneDefinition(lane);
  const text = `${stdout}\n${stderr}`;
  if (plugin) {
    for (const pattern of plugin.loggedOut) if (pattern.test(text)) return { state: 'logged-out', reason: 'login expired or missing' };
    for (const pattern of plugin.rateLimit) if (pattern.test(text)) return { state: 'rate-limited', reason: 'rate limit' };
  }
  if (exitCode !== 0) return { state: 'failed', reason: `exit ${exitCode}` };
  return { state: 'ok', reason: 'ok' };
}

export function pluginConfigEntry(name, { model = null } = {}) {
  const plugin = laneDefinition(name);
  if (!plugin) throw Object.assign(new Error(`unknown lane ${name}`), { code: 'lane-unknown' });
  return { name, command: plugin.command, model, loginHint: plugin.loginHint, health: plugin.healthArgs, loginFiles: plugin.loginFiles };
}
