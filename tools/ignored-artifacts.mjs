// SPDX-License-Identifier: Apache-2.0
// Build files a test or build command leaves behind (tsconfig.tsbuildinfo, .next/, coverage/ ...) are not worker output:
// they are never a "dropped write", so --accept-dropped is not needed for them.
// Never hidden: a file git tracks (a real edit), a secret-looking file, or a file hidden only by a catch-all ignore rule.
import { spawn } from 'node:child_process';

const ARTIFACT_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', '__pycache__', '.pytest_cache', '.nyc_output', '.vite', '.parcel-cache', '.svelte-kit', '.nuxt']);
const ARTIFACT_FILE = /(?:\.tsbuildinfo|\.pyc|\.eslintcache|\.DS_Store)$/;
// A secret-looking file is always kept (a worker writing a dot-env file must stay visible), even when .gitignore names it.
const SECRET_LOOKING = /(?:^|\/)(?:\.env(?:[.\w-]*)$|\.envrc$|id_(?:rsa|dsa|ed25519|ecdsa)|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|tfvars)$|\.npmrc$|\.netrc$|\.pgpass$|\.pypirc$|\.git-credentials$|credentials(?:\.|$)|secrets?\.[\w.]+$|\.docker\/config\.json$)/i;
const CATCH_ALL = new Set(['*', '/*', '**', '/**', '*/', '**/*', '!*']);

export const isSecretLooking = file => SECRET_LOOKING.test(String(file ?? ''));

export function isBuildArtifact(file) {
  const parts = String(file ?? '').split('/');
  if (!parts[0] || isSecretLooking(file)) return false;
  return parts.slice(0, -1).some(part => ARTIFACT_DIRS.has(part)) || ARTIFACT_FILE.test(parts[parts.length - 1]);
}

function git(root, args, input) {
  return new Promise(resolve => {
    let stdout = '';
    let child;
    try { child = spawn('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
    child.on('error', () => resolve(null));
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('close', () => resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// The files git tracks in this project (a tracked file that changed is a real edit); null when this is not a git project.
export async function trackedFiles(root) {
  const text = await git(root, ['ls-files', '-z']);
  return text === null ? null : new Set(text.split('\0').filter(Boolean));
}

// Which of the files the project's own .gitignore files ignore. The global ignore file and .git/info/exclude are not trusted
// (a worker could not set them, but they hide more than the project meant), and a catch-all rule such as `*` hides nothing here.
export async function gitIgnoredFiles(root, files) {
  const list = [...new Set(files)].filter(f => typeof f === 'string' && f && !f.includes('\0'));
  if (!list.length) return new Set();
  const text = await git(root, ['-c', 'core.excludesFile=', 'check-ignore', '-z', '-v', '-n', '--stdin'], list.join('\0'));
  const parts = (text ?? '').split('\0');
  const ignored = new Set();
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const [source, , pattern, file] = parts.slice(i, i + 4);
    if (source && /(?:^|\/)\.gitignore$/.test(source) && pattern && !pattern.startsWith('!') && !CATCH_ALL.has(pattern)) ignored.add(file);
  }
  return ignored;
}

// The files that are not build artifacts and not ignored by the project's .gitignore (tracked files and secrets always stay).
export async function withoutIgnored(root, files) {
  const tracked = (await trackedFiles(root)) ?? new Set();
  const keepAlways = f => tracked.has(f) || isSecretLooking(f);
  const candidates = files.filter(f => keepAlways(f) || !isBuildArtifact(f));
  const ignored = await gitIgnoredFiles(root, candidates.filter(f => !keepAlways(f)));
  return candidates.filter(f => !ignored.has(f));
}
