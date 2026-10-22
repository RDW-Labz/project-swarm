// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const vendorDir = path.join(repo, 'tools', 'watch-assets', 'vendor');
const watchAssetsDir = path.join(repo, 'tools', 'watch-assets');
const manifestPath = path.join(vendorDir, 'VENDOR.json');
const thirdPartyPath = path.join(repo, 'docs', 'third-party.md');

const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'OFL-1.1',
  'CC0-1.0',
]);

const CDN_HOST_RE =
  /https?:\/\/(?:[^/\s"'`]+\.)?(?:unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|googleapis\.com|gstatic\.com|bootstrapcdn\.com|cdn\.|fastly\.net\/)/i;

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const thirdPartyDoc = fs.readFileSync(thirdPartyPath, 'utf8');

function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(absPath));
  return hash.digest('hex');
}

function isLicensePath(relPath) {
  const base = path.basename(relPath);
  return base === 'LICENSE' || base.startsWith('LICENSE-');
}

function listVendorFilesRecursive(dir, base = vendorDir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listVendorFilesRecursive(abs, base));
      continue;
    }
    out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

test('VENDOR.json entries: files exist with matching sha256 and byte length', () => {
  for (const entry of manifest.entries) {
    for (const file of entry.files) {
      const abs = path.join(vendorDir, file.path);
      assert.ok(fs.existsSync(abs), `${entry.name}: missing ${file.path}`);
      const bytes = fs.statSync(abs).size;
      assert.equal(bytes, file.bytes, `${file.path} byte length`);
      assert.equal(sha256File(abs), file.sha256, `${file.path} sha256`);
    }
  }
});

test('VENDOR.json entries: at least one non-empty licence file exists', () => {
  for (const entry of manifest.entries) {
    assert.ok(entry.licenseFiles?.length, `${entry.name}: no licenseFiles`);
    let found = false;
    for (const rel of entry.licenseFiles) {
      const abs = path.join(vendorDir, rel);
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size > 0) {
        found = true;
        break;
      }
    }
    assert.ok(found, `${entry.name}: no non-empty licence file`);
  }
});

test('every vendored file under vendor is listed in VENDOR.json (except manifest and licence files)', () => {
  const listed = new Set();
  for (const entry of manifest.entries) {
    for (const file of entry.files) listed.add(file.path);
    for (const rel of entry.licenseFiles ?? []) listed.add(rel);
  }
  const onDisk = listVendorFilesRecursive(vendorDir);
  const unlisted = onDisk.filter((rel) => {
    if (rel === 'VENDOR.json') return false;
    if (isLicensePath(rel)) return false;
    return !listed.has(rel);
  });
  assert.deepEqual(unlisted, [], `unlisted vendor files: ${unlisted.join(', ')}`);
});

test('every VENDOR.json entry name appears in docs/third-party.md', () => {
  for (const entry of manifest.entries) {
    assert.match(
      thirdPartyDoc,
      new RegExp(`\\*\\*${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*`),
      `missing third-party row for ${entry.name}`,
    );
  }
});

test('VENDOR.json licences are on the allow-list', () => {
  for (const entry of manifest.entries) {
    assert.ok(ALLOWED_LICENSES.has(entry.license), `${entry.name}: licence ${entry.license}`);
  }
});

test('js, css and woff2 gzip total is within budget', () => {
  let gzipTotal = 0;
  for (const entry of manifest.entries) {
    for (const file of entry.files) {
      if (/\.(js|css|woff2)$/i.test(file.path)) gzipTotal += file.gzip;
    }
  }
  assert.ok(
    gzipTotal <= manifest.budget.gzipBytesMax,
    `gzip ${gzipTotal} exceeds budget ${manifest.budget.gzipBytesMax}`,
  );
});

test('board html and js under watch-assets do not load vendor assets from CDN hosts', () => {
  const boardFiles = fs
    .readdirSync(watchAssetsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && (/^board/.test(d.name) && /\.(?:html|js)$/.test(d.name)))
    .map((d) => d.name);
  assert.ok(boardFiles.length > 0, 'no board html/js files found');
  for (const name of boardFiles) {
    const text = fs.readFileSync(path.join(watchAssetsDir, name), 'utf8');
    assert.doesNotMatch(text, CDN_HOST_RE, `${name} references a CDN host`);
  }
});
