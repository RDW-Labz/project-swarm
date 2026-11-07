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

const scope = { name: 'guard-backup', version: 1, hash: 'a'.repeat(64), stages: [] };
const minimalTicket = {
  id: 'T-9001',
  title: 'x',
  type: 'docs',
  scopeRefs: ['R-001'],
  size: 'S',
  risk: 'low',
  status: 'todo',
  stage: 's1',
};

function minimalLedger() {
  return createLedger({ scope, tickets: [minimalTicket] });
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

describe('writeLedger backup cap timer', () => {
  it('clears the cap timer and unrefs it so the process is not held for 5s', async () => {
    const root = await tmpRoot('gbf2-timer-');
    const home = await tmpRoot('gbf2-home-');
    process.env.PROJECT_SWARM_HOME = home;

    let cleared = false;
    let unrefCalled = false;
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    let capTimer = null;

    globalThis.setTimeout = (...args) => {
      const t = origSetTimeout(...args);
      if (args[1] === 5000) {
        capTimer = t;
        const origUnref = t.unref?.bind(t);
        t.unref = () => {
          unrefCalled = true;
          return origUnref?.();
        };
      }
      return t;
    };
    globalThis.clearTimeout = (id) => {
      if (id === capTimer) cleared = true;
      return origClearTimeout(id);
    };

    setBackupLedgerForWrite(async () => {});

    try {
      await writeLedger(root, minimalLedger());
      assert.equal(unrefCalled, true);
      assert.equal(cleared, true);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});

describe('writeLedger temp-dir backup skip', () => {
  it('realpaths tmpdir and skips backup for a normal temp project root', async () => {
    const root = await tmpRoot('gbf2-skip-');
    const origHomedir = os.homedir;
    os.homedir = () => process.env.SWARM_REAL_HOME || origHomedir();

    let backupCalls = 0;
    setBackupLedgerForWrite(async () => {
      backupCalls++;
    });

    try {
      await writeLedger(root, minimalLedger());
      assert.equal(backupCalls, 0);
    } finally {
      os.homedir = origHomedir;
    }
  });

  it('does not skip backup when tmpdir equals the user home', async () => {
    const shared = await tmpRoot('gbf2-home-tmp-');
    const root = path.join(shared, 'proj');
    await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    process.env.TMPDIR = shared;
    process.env.PROJECT_SWARM_HOME = path.join(shared, 'backups');

    const realShared = await fs.realpath(shared);
    const origHomedir = os.homedir;
    os.homedir = () => realShared;

    let backupCalls = 0;
    setBackupLedgerForWrite(async () => {
      backupCalls++;
    });

    try {
      await writeLedger(root, minimalLedger());
      assert.equal(backupCalls, 1);
    } finally {
      os.homedir = origHomedir;
    }
  });

  it('does not skip backup when tmpdir contains the user home path', async () => {
    const outer = await tmpRoot('gbf2-outer-tmp-');
    const innerHome = path.join(outer, 'nested-home');
    await fs.mkdir(innerHome, { recursive: true });
    const root = path.join(innerHome, 'proj');
    await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    process.env.TMPDIR = outer;

    const realOuter = await fs.realpath(outer);
    const realInner = await fs.realpath(innerHome);
    const origHomedir = os.homedir;
    os.homedir = () => realInner;

    process.env.PROJECT_SWARM_HOME = path.join(outer, 'backups');

    let backupCalls = 0;
    setBackupLedgerForWrite(async () => {
      backupCalls++;
    });

    try {
      await writeLedger(root, minimalLedger());
      assert.equal(backupCalls, 1);
      assert.ok(realInner.startsWith(realOuter + path.sep));
    } finally {
      os.homedir = origHomedir;
    }
  });
});

describe('memoryPressureLevel null availRamGb', () => {
  it('returns ok when availRamGb is null (not hard)', () => {
    assert.equal(memoryPressureLevel({ availRamGb: null, freeRamGb: 1 }, 'linux'), 'ok');
    assert.equal(memoryPressureLevel({ availRamGb: null, freeRamGb: 1 }, 'darwin'), 'ok');
  });
});
