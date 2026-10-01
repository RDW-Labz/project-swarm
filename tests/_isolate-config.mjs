// SPDX-License-Identifier: Apache-2.0
// Setup file imported before any test runs: isolate the test suite from the developer's real
// local config, preventing accidental dependencies on development machine state.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { defaultConfigPath } from '../tools/local-config.mjs';

// Lesson #299: every isolation directory must use the sandbox's writable temp base.
const testTmpBase = process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir();
const currentConfig = process.env.SWARM_CONFIG || defaultConfigPath();
process.env.SWARM_REAL_CONFIG = currentConfig;

const isolateDir = fs.mkdtempSync(path.join(testTmpBase, 'swarm-test-isolate-'));
process.env.SWARM_CONFIG = path.join(isolateDir, 'config.json');

// Lesson #152: a test that passes its own small `env` object (never `process.env`) to a function
// whose fallback is `env.HOME || os.homedir()` still lands on the real machine's home once that
// object has no HOME key of its own — os.homedir() itself reads process.env.HOME at call time, so
// overriding it here isolates every such fallback (and any real global git config HOME would
// resolve to) without that function needing to know it is under test.
process.env.SWARM_REAL_HOME = process.env.HOME || os.homedir();
const isolateHome = fs.mkdtempSync(path.join(testTmpBase, 'swarm-test-home-'));
process.env.HOME = isolateHome;
delete process.env.XDG_CONFIG_HOME;

const testTmpDir = fs.mkdtempSync(path.join(testTmpBase, 'swarm-test-tmp-'));
process.env.SWARM_TEST_TMP = testTmpDir;
