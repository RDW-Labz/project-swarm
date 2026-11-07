#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Project Swarm contributors
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MANIFEST_NAME = '.swarm-install.json';
const IGNORE_EXTRA = new Set([MANIFEST_NAME, '.DS_Store']);

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function listInstalledFiles(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listInstalledFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export async function verifyInstall({ installRoot, versionDir } = {}) {
  if (!versionDir) {
    const current = path.join(installRoot, 'current');
    versionDir = await fs.realpath(current);
  } else {
    versionDir = await fs.realpath(versionDir);
  }
  const manifestPath = path.join(versionDir, MANIFEST_NAME);
  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        ok: false,
        versionDir,
        manifest: false,
        source: null,
        problems: [{ kind: 'no-manifest', path: 'installed before install manifests; reinstall to verify' }],
      };
    }
    throw error;
  }
  const manifest = JSON.parse(raw);
  const problems = [];
  const expected = manifest.files ?? {};
  const onDisk = await listInstalledFiles(versionDir);
  const onDiskSet = new Set(onDisk);
  for (const [rel, expectedHash] of Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))) {
    const filePath = path.join(versionDir, rel);
    if (!onDiskSet.has(rel)) {
      problems.push({ kind: 'missing', path: rel });
      continue;
    }
    const actualHash = await sha256File(filePath);
    if (actualHash !== expectedHash) problems.push({ kind: 'changed', path: rel });
  }
  for (const rel of onDisk.sort()) {
    const base = path.basename(rel);
    if (IGNORE_EXTRA.has(base) || IGNORE_EXTRA.has(rel)) continue;
    if (!(rel in expected)) problems.push({ kind: 'extra', path: rel });
  }
  return {
    ok: problems.length === 0,
    versionDir,
    manifest: true,
    source: manifest.source ?? null,
    problems,
  };
}

export function formatVerifyInstall(result) {
  const lines = [];
  if (result.ok) {
    const commit = result.source?.commit;
    const from = commit ?? 'unknown source';
    lines.push(`install ok: ${result.versionDir} (from ${from})`);
    return lines;
  }
  lines.push(`WARNING: installed swarm files do not match the build they were installed from (${result.versionDir})`);
  for (const problem of result.problems) {
    if (problem.kind === 'no-manifest') lines.push(`  no-manifest ${problem.path}`);
    else lines.push(`  ${problem.kind} ${problem.path}`);
  }
  return lines;
}

export async function runVerifyInstallCommand(args, { installRoot } = {}) {
  let json = false;
  let root = installRoot;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') json = true;
    else if (flag === '--install') {
      i += 1;
      if (i >= args.length) return { stdout: 'missing value for --install\n', exitCode: 2 };
      root = args[i];
    } else if (flag.startsWith('-')) return { stdout: `unknown flag: ${flag}\n`, exitCode: 2 };
    else positional.push(flag);
  }
  if (!root) return { stdout: 'install root required\n', exitCode: 2 };
  if (positional.length > 1) return { stdout: 'Usage: swarm verify-install [--json] [--install DIR] [VERSION_DIR]\n', exitCode: 2 };
  let versionDir = positional[0] ?? null;
  const result = await verifyInstall({ installRoot: root, versionDir });
  if (json) {
    return { stdout: `${JSON.stringify(result)}\n`, exitCode: result.ok ? 0 : 1 };
  }
  const text = `${formatVerifyInstall(result).join('\n')}\n`;
  return { stdout: text, exitCode: result.ok ? 0 : 1 };
}
