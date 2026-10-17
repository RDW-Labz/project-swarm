// SPDX-License-Identifier: Apache-2.0
// A fingerprint of the project's code state: HEAD plus the content of every changed or untracked file. A verdict made on one
// state (the rendered UI check) is only worth something for exactly that state. Generated folders are left out.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const SKIP = [/^\.swarm\//, /^docs\/scope\//, /^docs\/state\//, /^coordination\/(?:HANDOFF|review)/, /^node_modules\//, /^\.next\//, /^dist\//, /^coverage\//, /^evals\/\.run\//];
const MAX_FILES = 3000;
const MAX_BYTES = 8 * 1024 * 1024;

export async function workTreeFingerprint(root) {
  const git = args => execFileAsync('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 }).then(r => r.stdout, () => null);
  const head = (await git(['rev-parse', 'HEAD']))?.trim() ?? 'no-head';
  const changed = await git(['ls-files', '-m', '-o', '--exclude-standard', '-z']);
  if (changed === null) return `${head}:no-git`;
  const files = [...new Set(changed.split('\0').filter(Boolean))].filter(file => !SKIP.some(re => re.test(file))).sort().slice(0, MAX_FILES);
  const hash = createHash('sha256');
  hash.update(head);
  for (const file of files) {
    hash.update(`\0${file}\0`);
    try {
      const full = path.join(root, file);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) { hash.update(`link:${await fs.readlink(full)}`); continue; }
      if (!stat.isFile()) { hash.update('other'); continue; }
      if (stat.size > MAX_BYTES) { hash.update(`big:${stat.size}:${stat.mtimeMs}`); continue; }
      hash.update(await fs.readFile(full));
    } catch { hash.update('gone'); }
  }
  return `${head}:${hash.digest('hex').slice(0, 32)}`;
}
