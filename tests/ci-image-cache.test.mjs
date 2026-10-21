// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { cacheKey, imagesFromCompose, mirroredRef } from '../tools/ci-image-cache.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(repoRoot, 'templates/coordination/ci-docker-hub-mirror.yml');

describe('mirroredRef', () => {
  const mirror = 'mirror.gcr.io';

  it('rewrites implicit library images with tag and digest', () => {
    assert.equal(mirroredRef('nginx:1.25', mirror), 'mirror.gcr.io/library/nginx:1.25');
    assert.equal(
      mirroredRef('nginx:1.25@sha256:deadbeef', mirror),
      'mirror.gcr.io/library/nginx:1.25@sha256:deadbeef',
    );
  });

  it('rewrites docker.io library and user paths', () => {
    assert.equal(mirroredRef('docker.io/library/redis:7', mirror), 'mirror.gcr.io/library/redis:7');
    assert.equal(mirroredRef('docker.io/acme/widget:latest', mirror), 'mirror.gcr.io/acme/widget:latest');
  });

  it('leaves non-Docker-Hub registries unchanged', () => {
    const refs = [
      'ghcr.io/org/app:v1',
      'quay.io/coreos/etcd:v3.5',
      'gcr.io/google-containers/pause:3.9',
    ];
    for (const ref of refs) {
      assert.equal(mirroredRef(ref, mirror), ref);
    }
  });
});

describe('imagesFromCompose', () => {
  it('collects image lines from compose YAML', () => {
    const yaml = `
services:
  web:
    image: nginx:alpine
  db:
    image: "postgres:16"
`;
    assert.deepEqual(imagesFromCompose(yaml), ['nginx:alpine', 'postgres:16']);
  });

  it('parses a plain list when no image keys exist', () => {
    const list = 'redis:7\n# comment\nghcr.io/org/tool:1\n';
    assert.deepEqual(imagesFromCompose(list), ['redis:7', 'ghcr.io/org/tool:1']);
  });
});

describe('cacheKey', () => {
  it('is stable regardless of input order', () => {
    const a = cacheKey(['b:2', 'a:1']);
    const b = cacheKey(['a:1', 'b:2']);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });
});

describe('ci-docker-hub-mirror workflow template', () => {
  it('is YAML-ish and documents mirror input and actions/cache', () => {
    const text = fs.readFileSync(templatePath, 'utf8');
    assert.match(text, /mirror\.gcr\.io/);
    assert.match(text, /\bmirror\b/i);
    assert.match(text, /uses:\s*actions\/cache@/);
    assert.match(text, /workflow_dispatch:/);
  });
});
