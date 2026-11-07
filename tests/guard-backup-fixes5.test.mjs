// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach } from 'node:test';
import { memoryPressureLevel } from '../tools/autotune.mjs';
import {
  createLedger,
  writeLedger,
  setBackupLedgerForWrite,
  resetBackupLedgerForWrite,
} from '../tools/tickets.mjs';

const scope = { name: 't', version: 1, stages: [{ id: 's1', title: 'S' }] };

function minimalLedger() {
  return createLedger({
    scope,
    tickets: [{
      id: 'T-0001',
      title: 'x',
      type: 'docs',
      stage: 's1',
      scopeRefs: ['R-001'],
      size: 'S',
      risk: 'low',
      status: 'todo',
    }],
  });
}

async function tmpRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  resetBackupLedgerForWrite();
  delete process.env.PROJECT_SWARM_HOME;
  delete process.env.PROJECT_SWARM_NO_LEDGER_BACKUP;
  delete process.env.TMPDIR;
});

describe('setBackupLedgerForWrite production guard', () => {
  it('throws outside test runner unless NODE_ENV is test', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevCtx = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_ENV;
    delete process.env.NODE_TEST_CONTEXT;
    assert.throws(
      () => setBackupLedgerForWrite(async () => {}),
      /only available in tests/,
    );
    process.env.NODE_ENV = 'test';
    setBackupLedgerForWrite(async () => {});
    resetBackupLedgerForWrite();
    delete process.env.NODE_ENV;
    process.env.NODE_TEST_CONTEXT = '1';
    setBackupLedgerForWrite(async () => {});
    resetBackupLedgerForWrite();
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
    else delete process.env.NODE_ENV;
    if (prevCtx !== undefined) process.env.NODE_TEST_CONTEXT = prevCtx;
    else delete process.env.NODE_TEST_CONTEXT;
  });
});

describe('writeLedger backup skip and custom TMPDIR', () => {
  it('does not apply temp-dir skip when TMPDIR resolves outside system temp roots', async () => {
    const root = await tmpRoot('gbf5-custom-tmp-');
    const customTmp = path.join('/Users', 'bean', 'guard5-project-tmp');
    process.env.TMPDIR = customTmp;

    const origRealpath = fs.realpath.bind(fs);
    const origTmpdir = os.tmpdir;
    os.tmpdir = () => customTmp;
    fs.realpath = async (p) => {
      if (String(p) === customTmp) return customTmp;
      return origRealpath(p);
    };

    let called = false;
    setBackupLedgerForWrite(async () => {
      called = true;
    });
    try {
      await writeLedger(root, minimalLedger());
      assert.equal(called, true);
    } finally {
      fs.realpath = origRealpath;
      os.tmpdir = origTmpdir;
    }
  });
});

describe('memoryPressureLevel missing RAM', () => {
  it('treats empty machine object as ok', () => {
    assert.equal(memoryPressureLevel({}, 'linux'), 'ok');
    assert.equal(memoryPressureLevel({}, 'darwin'), 'ok');
  });

  it('treats both availRamGb and freeRamGb nullish as ok', () => {
    assert.equal(memoryPressureLevel({ availRamGb: null, freeRamGb: null }, 'linux'), 'ok');
    assert.equal(memoryPressureLevel({ availRamGb: undefined, freeRamGb: undefined }, 'darwin'), 'ok');
  });
});
