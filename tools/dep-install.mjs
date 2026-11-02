// SPDX-License-Identifier: Apache-2.0
// A ticket may declare npm packages it needs (`dependencies`). A worker's sandbox has no network, so the runner does the install:
// it builds the new package.json and package-lock.json in a scratch folder (no scripts run), hands both to integrate as ordinary writes
// (so the security gate sees the manifest and lockfile change and audits it), and installs into the project only after the gate passes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// name, optional @version or range: registry packages only (no urls, git, file paths or aliases).
const SPEC = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@(?:latest|[\^~]?\d[A-Za-z0-9.+-]*))?$/;
export const validDependencySpec = spec => typeof spec === 'string' && spec.length <= 120 && SPEC.test(spec) && !/\.(?:tgz|tar(?:\.gz)?)(?:@|$)/i.test(spec);

const CLEAN_ENV = () => ({ PATH: process.env.PATH ?? '', HOME: os.tmpdir(), npm_config_ignore_scripts: 'true' });
const FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'];

// exec(argv, {cwd, env, timeoutMs}) -> {exitCode, stdout, stderr}. Returns changes: [{file, bytes, previous, mode, fromDependencies: true}].
export async function dependencyWrites({ root, specs, exec }) {
  const list = [...new Set(specs)];
  const bad = list.find(spec => !validDependencySpec(spec));
  if (bad) throw Object.assign(new Error(`dependency ${JSON.stringify(bad)} is not a registry package name with an optional version`), { code: 'dependency-spec' });
  const read = async file => { try { return await fs.readFile(path.join(root, file)); } catch { return null; } };
  const before = { 'package.json': await read('package.json'), 'package-lock.json': await read('package-lock.json') };
  if (!before['package.json']) throw Object.assign(new Error('the project has no package.json to add dependencies to'), { code: 'dependency-no-package' });
  for (const other of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']) if (await read(other)) throw Object.assign(new Error(`${other} exists: dependencies are installed with npm only`), { code: 'dependency-manager' });
  // A workspaces project would get a lockfile without its workspaces; a scoped registry in .npmrc would be ignored here (dependency confusion).
  const pkgBefore = JSON.parse(before['package.json'].toString('utf8'));
  if (pkgBefore.workspaces) throw Object.assign(new Error('package.json has workspaces: add these dependencies by hand'), { code: 'dependency-workspaces' });
  const npmrc = (await read('.npmrc'))?.toString('utf8') ?? '';
  for (const spec of list) { const scope = /^(@[^/]+)\//.exec(spec)?.[1]; if (scope && npmrc.includes(`${scope}:registry`)) throw Object.assign(new Error(`${spec} comes from a private registry set in .npmrc: add it by hand`), { code: 'dependency-private-registry' }); }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-deps-'));
  try {
    for (const [file, bytes] of Object.entries(before)) if (bytes) await fs.writeFile(path.join(tmp, file), bytes);
    const res = await exec(['npm', 'install', '--package-lock-only', ...FLAGS, ...list], { cwd: tmp, env: { ...CLEAN_ENV(), npm_config_cache: path.join(tmp, '.npm-cache') }, timeoutMs: 300000 });
    if ((res.exitCode ?? res.code) !== 0) throw Object.assign(new Error(`npm could not resolve ${list.join(', ')}: ${String(res.stderr || res.stdout).trim().slice(-300)}`), { code: 'dependency-resolve' });
    // Only the named packages may be added to package.json (the lockfile follows from them): nothing else in the manifest may change.
    const pkgAfter = JSON.parse(await fs.readFile(path.join(tmp, 'package.json'), 'utf8'));
    const names = new Set(list.map(spec => spec.replace(/^(@?[^@]+).*$/, '$1')));
    const strip = pkg => { const { dependencies, devDependencies, ...rest } = pkg; return rest; };
    if (JSON.stringify(strip(pkgBefore)) !== JSON.stringify(strip(pkgAfter))) throw Object.assign(new Error('npm changed more of package.json than the named dependencies'), { code: 'dependency-extra-change' });
    for (const field of ['dependencies', 'devDependencies']) for (const [name, range] of Object.entries(pkgAfter[field] ?? {})) if (pkgBefore[field]?.[name] !== range && !names.has(name)) throw Object.assign(new Error(`npm changed ${name} in package.json, which no ticket named`), { code: 'dependency-extra-change' });
    const changes = [];
    for (const [file, previous] of Object.entries(before)) {
      const bytes = await fs.readFile(path.join(tmp, file)).catch(() => null);
      if (!bytes || (previous && previous.equals(bytes))) continue;
      const mode = previous ? (await fs.stat(path.join(root, file))).mode & 0o777 : 0o644;
      changes.push({ file, bytes, previous, mode, fromDependencies: true });
    }
    return changes;
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

// After the gate passed and the files are written: add the new packages to node_modules from the approved lockfile (npm install only adds what is missing, so
// existing packages and their built output stay; scripts never run).
export async function installDependencies({ root, exec }) {
  const res = await exec(['npm', 'install', ...FLAGS], { cwd: root, env: { ...CLEAN_ENV(), HOME: process.env.HOME ?? os.tmpdir() }, timeoutMs: 600000 });
  return { ok: (res.exitCode ?? res.code) === 0, tail: String(res.stderr || res.stdout).trim().slice(-300) };
}
