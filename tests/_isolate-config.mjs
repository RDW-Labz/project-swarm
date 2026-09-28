// SPDX-License-Identifier: Apache-2.0
// Setup file imported before any test runs: isolate the test suite from the developer's real
// local config, preventing accidental dependencies on development machine state.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { defaultConfigPath } from '../tools/local-config.mjs';

const currentConfig = process.env.SWARM_CONFIG || defaultConfigPath();
process.env.SWARM_REAL_CONFIG = currentConfig;

const isolateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-isolate-'));
process.env.SWARM_CONFIG = path.join(isolateDir, 'config.json');
