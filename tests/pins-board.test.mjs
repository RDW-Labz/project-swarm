// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectOverview, projectDetail } from '../tools/board-data.mjs';

async function tmp(t, prefix = 'swarm-pins-board-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return fs.realpath(d);
}

const project = (root, id = 'pid', name = 'demo') => ({ id, name, root });

test('pinnedVersion on overview and detail for pin shapes and unreadable pointer', async t => {
  const install = await tmp(t);
  const cases = [
    { label: 'pinned true only', pointer: { install, version: '2.3.4', pinned: true }, expect: '2.3.4' },
    { label: 'pinnedVersion only', pointer: { install, version: '9.0.0', pinnedVersion: '1.2.3' }, expect: '1.2.3' },
    { label: 'both fields', pointer: { install, version: '9.0.0', pinned: true, pinnedVersion: '4.5.6' }, expect: '4.5.6' },
    { label: 'neither pin', pointer: { install, version: '1.0.0' }, expect: null },
    { label: 'unreadable pointer', pointer: null, expect: null },
  ];
  for (const { label, pointer, expect } of cases) {
    const root = await tmp(t, `case-${label}-`);
    const file = path.join(root, '.project-swarm.json');
    if (pointer === null) {
      await fs.writeFile(file, '{ not json');
    } else {
      await fs.writeFile(file, JSON.stringify(pointer));
    }
    const p = project(root);
    const overview = await projectOverview(p, [], { summary: async () => ({}) });
    const detail = await projectDetail(p, { summary: async () => ({}) });
    assert.equal(overview.pinnedVersion, expect, `${label} overview`);
    assert.equal(detail.pinnedVersion, expect, `${label} detail`);
  }
});

test('board.js renders pinned at badge from pinnedVersion', async () => {
  const boardJs = await fs.readFile(fileURLToPath(new URL('../tools/watch-assets/board.js', import.meta.url)), 'utf8');
  assert.match(boardJs, /pinned at '\s*\+\s*p\.pinnedVersion/);
  assert.match(boardJs, /function pinnedBadge|pinnedBadge\(p\)/);
});
