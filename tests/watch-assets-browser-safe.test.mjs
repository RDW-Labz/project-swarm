// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const assetDir = path.join(repo, 'tools', 'watch-assets');
const entry = path.join(assetDir, 'command-center-boot.js');

const STATIC_IMPORT_FROM_RE = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function parseStaticImports(source) {
  const specs = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import ')) continue;
    if (trimmed.includes('import(')) continue;
    let m;
    STATIC_IMPORT_FROM_RE.lastIndex = 0;
    const chunk = trimmed.endsWith(';') ? trimmed : `${trimmed};`;
    while ((m = STATIC_IMPORT_FROM_RE.exec(chunk)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

function resolveAssetImport(fromFile, spec) {
  assert.ok(spec.startsWith('.'), `${fromFile}: non-relative import ${spec}`);
  assert.ok(!spec.includes('..'), `${fromFile}: import leaves watch-assets: ${spec}`);
  const base = path.dirname(fromFile);
  let resolved = path.normalize(path.join(base, spec));
  if (!resolved.startsWith(assetDir + path.sep) && resolved !== assetDir) {
    throw new Error(`${fromFile}: resolved path outside watch-assets: ${spec}`);
  }
  const candidates = [resolved, `${resolved}.js`, `${resolved}.mjs`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${fromFile}: missing import target ${spec}`);
}

function assertNoForbiddenImports(filePath, source) {
  for (const spec of parseStaticImports(source)) {
    if (spec.startsWith('node:')) {
      throw new Error(`${filePath}: node builtin import ${spec}`);
    }
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      throw new Error(`${filePath}: bare package import ${spec}`);
    }
  }
}

function walkModuleGraph(startFile) {
  const seen = new Set();
  const queue = [startFile];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    assertNoForbiddenImports(file, source);
    for (const spec of parseStaticImports(source)) {
      const target = resolveAssetImport(file, spec);
      if (!seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

test('command-center-boot module graph stays inside watch-assets without node or package imports', () => {
  assert.ok(fs.existsSync(entry), 'command-center-boot.js missing');
  const graph = walkModuleGraph(entry);
  assert.ok(graph.size > 1, 'expected a non-trivial import graph');
  for (const file of graph) {
    assert.ok(file.startsWith(assetDir), `graph file outside assets: ${file}`);
  }
});
