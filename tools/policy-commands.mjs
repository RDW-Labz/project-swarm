// SPDX-License-Identifier: Apache-2.0
// swarm policy show | validate | path | init  (not wired into the main CLI yet)
import path from 'node:path';
import {
  DEFAULT_POLICY_FILE,
  NEVER_AUTO,
  loadPolicy,
  policyPath,
  validatePolicy,
} from './policy.mjs';

export const POLICY_USAGE = [
  'Usage: swarm policy show     print effective auto-approve rules and the never-auto list',
  '       swarm policy validate  check policy.json (prints errors or ok)',
  '       swarm policy path      print the policy file path on this machine',
  '       swarm policy init      write default policy.json when missing (never overwrites)',
].join('\n');

function writeln(out, text, code = 0) {
  out(text.endsWith('\n') ? text : `${text}\n`);
  return code;
}

export function policyCommand(args, { out, env = process.env, home = env?.HOME, fs } = {}) {
  const write = out ?? (text => process.stdout.write(text));
  const [sub, ...rest] = args;
  if (rest.length) return writeln(write, POLICY_USAGE, 2);
  if (sub === 'path') return writeln(write, policyPath(env, home));
  if (sub === 'init') {
    const file = policyPath(env, home);
    try {
      fs.accessSync(file);
      return writeln(write, `${file} already exists (not overwritten)`);
    } catch (error) {
      if (error?.code !== 'ENOENT') return writeln(write, String(error.message ?? error), 1);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(DEFAULT_POLICY_FILE, null, 2)}\n`);
    return writeln(write, `Wrote default policy to ${file}`);
  }
  if (sub === 'show') {
    const file = policyPath(env, home);
    const { rules, error } = loadPolicy(file, { fs });
    const lines = ['Never auto-approved:', ...NEVER_AUTO.map(k => `  - ${k}`), ''];
    if (error) lines.push(`Policy file error (fail closed): ${error}`, '');
    lines.push('Auto-approve rules (effective):');
    for (const rule of rules) {
      const state = rule.enabled ? 'enabled' : 'disabled';
      const extra = [];
      if (rule.projects?.length) extra.push(`projects=${rule.projects.join(',')}`);
      if (rule.maxPerDay != null) extra.push(`maxPerDay=${rule.maxPerDay}`);
      const suffix = extra.length ? ` (${extra.join(', ')})` : '';
      lines.push(`  - ${rule.id}: ${rule.description} [${state}]${suffix}`);
    }
    return writeln(write, lines.join('\n'));
  }
  if (sub === 'validate') {
    const file = policyPath(env, home);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return writeln(write, 'ok (no policy file; built-in defaults apply)');
      return writeln(write, String(error.message ?? error), 1);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return writeln(write, 'invalid policy json', 1);
    }
    const errors = validatePolicy(parsed);
    if (errors.length) return writeln(write, errors.join('\n'), 1);
    return writeln(write, 'ok');
  }
  return writeln(write, POLICY_USAGE, 2);
}
