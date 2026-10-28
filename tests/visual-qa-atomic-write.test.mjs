// SPDX-License-Identifier: Apache-2.0

import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { atomicWrite } from '../tools/managers/visual-qa/screenshots.mjs';

test('atomicWrite rethrows rename failure after write, closes once, and removes tmp', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-qa-atomic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm', 'visual-qa'), { recursive: true });
  const segments = ['.swarm', 'visual-qa', 'screen', 'default', 'phone.png'];
  const renameError = Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
  let closeCount = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (typeof args[0] === 'string' && args[0].includes('.tmp')) {
      const close = handle.close.bind(handle);
      handle.close = async (...closeArgs) => {
        closeCount += 1;
        return close(...closeArgs);
      };
    }
    return handle;
  });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from.includes('.tmp')) {
      throw renameError;
    }
    return rename(from, to);
  });

  await assert.rejects(
    () => atomicWrite(root, segments, Buffer.from('png-bytes')),
    (err) => {
      assert.equal(err, renameError);
      return true;
    },
  );
  assert.equal(closeCount, 1);

  const dir = path.join(root, '.swarm', 'visual-qa');
  const names = await fs.readdir(dir);
  assert.equal(names.some((name) => name.includes('.tmp')), false);
  await assert.rejects(fs.access(path.join(dir, 'phone.png')));
});
