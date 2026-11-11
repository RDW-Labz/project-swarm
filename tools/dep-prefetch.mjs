// SPDX-License-Identifier: Apache-2.0
// Batch prefetch for ticket dependencies (perf, fetch mechanics only — see docs/download-batching.md).
// A wave's tickets each resolve their `dependencies` through tools/dep-install.mjs; run on a cold machine
// cache, every resolve downloads its tarballs itself. This tool warms the ONE shared machine cache
// (resolveSharedNpmCacheDir) for a whole batch up front: the union of every spec — from the command line
// and/or from manifest files — fetched in a SINGLE npm invocation, so npm fetches the batch in parallel
// (bounded by --maxsockets) and each package is downloaded exactly once, however many tickets name it.
// It writes nothing to any project: the scratch manifest and lockfile are throwaway, scripts never run,
// and the security gate still sees every real manifest/lockfile change at integrate time, unchanged.
// Usage: node tools/dep-prefetch.mjs <spec...> [--from-manifest <file.json> ...]
// Config: SWARM_NPM_CACHE_DIR (shared cache location; 'off' is refused here — prefetch IS the cache),
//         SWARM_DL_CONCURRENCY (parallel registry connections, 1..64, default: npm's own default of 15).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveSharedNpmCacheDir, validDependencySpec } from './dep-install.mjs';

const FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'];
export const DEFAULT_DL_CONCURRENCY = 15; // npm's own maxsockets default.

export function resolveDownloadConcurrency({ env = process.env } = {}) {
  const parsed = Number.parseInt(env.SWARM_DL_CONCURRENCY ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(64, Math.max(1, parsed)) : DEFAULT_DL_CONCURRENCY;
}

// Every dependency spec a manifest declares, deduplicated: jobs (manifest format) and tickets (ledger format).
export function specsFromManifest(manifest) {
  const found = [];
  for (const entry of [...(manifest?.jobs ?? []), ...(manifest?.tickets ?? [])]) {
    if (Array.isArray(entry?.dependencies)) found.push(...entry.dependencies);
  }
  return [...new Set(found)];
}

// exec(argv, {cwd, env, timeoutMs}) -> {exitCode, stdout, stderr}, the dep-install shape.
// Returns { specs, cacheDir, concurrency } — what was fetched, where it landed, how wide it fetched.
export async function prefetchDependencies({ specs, exec, cacheDir = resolveSharedNpmCacheDir(), concurrency = resolveDownloadConcurrency() }) {
  const list = [...new Set(specs)];
  const bad = list.find(spec => !validDependencySpec(spec));
  if (bad) throw Object.assign(new Error(`dependency ${JSON.stringify(bad)} is not a registry package name with an optional version`), { code: 'dependency-spec' });
  if (!cacheDir) throw Object.assign(new Error('SWARM_NPM_CACHE_DIR=off disables the shared cache; batch prefetch has nowhere to land'), { code: 'dependency-cache-off' });
  if (!list.length) return { specs: [], cacheDir, concurrency };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-prefetch-'));
  try {
    await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'swarm-prefetch', version: '0.0.0', private: true }));
    const res = await exec(['npm', 'install', '--package-lock-only', ...FLAGS, `--maxsockets=${concurrency}`, ...list], { cwd: tmp, env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), npm_config_ignore_scripts: 'true', npm_config_cache: cacheDir }, timeoutMs: 600000 });
    if ((res.exitCode ?? res.code) !== 0) throw Object.assign(new Error(`npm could not resolve ${list.join(', ')}: ${String(res.stderr || res.stdout).trim().slice(-300)}`), { code: 'dependency-resolve' });
    return { specs: list, cacheDir, concurrency };
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

const defaultExec = (argv, { cwd, env, timeoutMs }) => new Promise(resolve => {
  execFile(argv[0], argv.slice(1), { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ exitCode: error ? (error.code ?? 1) : 0, stdout, stderr }));
});

async function main(argv) {
  const specs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-manifest') {
      const file = argv[++i];
      if (!file) throw new Error('--from-manifest needs a file path');
      specs.push(...specsFromManifest(JSON.parse(await fs.readFile(file, 'utf8'))));
    } else specs.push(argv[i]);
  }
  const started = Date.now();
  const result = await prefetchDependencies({ specs, exec: defaultExec });
  console.log(result.specs.length
    ? `prefetched ${result.specs.length} spec(s) into ${result.cacheDir} at concurrency ${result.concurrency} in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.specs.join(', ')}`
    : 'nothing to prefetch: no dependency specs given');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`dep-prefetch: ${error?.message ?? error}`); process.exit(1); });
}
