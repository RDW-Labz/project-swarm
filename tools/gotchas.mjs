// SPDX-License-Identifier: Apache-2.0
// Field lesson #167: known platform gotchas (e.g. Windows refuses a private file created under a
// raw pytest tmp_path) lived only in the orchestrator's own memory, so every fresh worker
// rediscovered the same one by hand. A per-root .swarm/gotchas.md — same linked-worktree fallback
// as .swarm/env.json (field lesson #160) — is appended to every job prompt (claude, codex, shell)
// and to `env --print`, so a fresh worker starts already knowing them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const GOTCHAS_FILE = '.swarm/gotchas.md';
const MAX_GOTCHAS_BYTES = 16 * 1024;

async function readGotchasFile(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (Buffer.byteLength(text, 'utf8') > MAX_GOTCHAS_BYTES) throw Error(`${file} is too large (limit ${MAX_GOTCHAS_BYTES} bytes); keep it to real platform gotchas, not a full runbook`);
  return text;
}

// The root's own file wins; a linked worktree with none falls back to its main worktree's file,
// exactly like .swarm/env.json, so one gotchas file serves every worktree of a repository.
export async function loadGotchas(root, { mainRoot } = {}) {
  const own = path.join(root, GOTCHAS_FILE);
  const text = await readGotchasFile(own);
  if (text !== null) return { text, source: own };
  let main = mainRoot;
  if (main === undefined) {
    try {
      // Only for a root that is itself a worktree's top level, never a plain dir inside some repo.
      const [top, common] = (await execFileAsync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8' })).stdout.trim().split('\n');
      main = path.resolve(await fs.realpath(top)) === path.resolve(await fs.realpath(root)) && path.basename(common) === '.git' ? path.dirname(common) : null;
    } catch { main = null; }
  }
  if (main && path.resolve(main) !== path.resolve(root)) {
    const shared = path.join(main, GOTCHAS_FILE);
    const fallback = await readGotchasFile(shared);
    if (fallback !== null) return { text: fallback, source: shared };
  }
  return { text: null, source: null };
}

// Appended to a job prompt (claude, codex, shell) right after the other rule lines; '' when there
// is no gotchas file, so a project with none sees no change to its prompt at all.
export function gotchasPromptBlock(text) {
  if (!text || !text.trim()) return '';
  return `Known platform gotchas for this project:\n${text.trim()}\n`;
}

async function hasWindowsWorkflow(root) {
  let entries;
  try { entries = await fs.readdir(path.join(root, '.github/workflows'), { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    let text;
    try { text = await fs.readFile(path.join(root, '.github/workflows', entry.name), 'utf8'); } catch { continue; }
    if (/windows/i.test(text)) return true;
  }
  return false;
}

// Field lesson #167: a repo whose own CI already runs on Windows and has no gotchas file is about
// to have its next Windows-specific worker rediscover the same platform quirk by hand.
export async function windowsCiGotchasWarnings(root) {
  if (!(await hasWindowsWorkflow(root))) return [];
  const { source } = await loadGotchas(root);
  if (source) return [];
  return [{ code: 'windows-ci-no-gotchas', message: `CI runs on Windows (a .github/workflows file mentions it) but no ${GOTCHAS_FILE} exists; put known platform gotchas there (e.g. path length, file locking, tmp_path quirks) so every job prompt and env --print carries them` }];
}
