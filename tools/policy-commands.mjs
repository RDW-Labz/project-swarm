// SPDX-License-Identifier: Apache-2.0
// swarm policy show | validate | path  (not wired into the main CLI yet)
import {
  DEFAULT_RULES,
  NEVER_AUTO,
  loadPolicy,
  policyPath,
  validatePolicy,
} from './policy.mjs';

export const POLICY_USAGE = [
  'Usage: swarm policy show     print effective auto-approve rules and the never-auto list',
  '       swarm policy validate  check policy.json (prints errors or ok)',
  '       swarm policy path      print the policy file path on this machine',
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
  if (sub === 'show') {
    const file = policyPath(env, home);
    const { rules, error } = loadPolicy(file, { fs });
    const lines = ['Never auto-approved:', ...NEVER_AUTO.map(k => `  - ${k}`), ''];
    if (error) lines.push(`Policy file error (fail closed): ${error}`, '');
    lines.push('Auto-approve rules (effective):');
    for (const rule of rules) {
      const bits = [rule.id, `kind=${rule.kind}`, rule.enabled ? 'enabled' : 'disabled'];
      if (rule.projects?.length) bits.push(`projects=${rule.projects.join(',')}`);
      if (rule.maxPerDay != null) bits.push(`maxPerDay=${rule.maxPerDay}`);
      bits.push(rule.conditions);
      lines.push(`  - ${bits.join('  ')}`);
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
