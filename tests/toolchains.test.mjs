// SPDX-License-Identifier: Apache-2.0
// Field lesson #106 (docs/shell/scratch.md): macOS purges unread files under /tmp (and its
// /private/tmp realpath) after about 3 days; toolchains belong at SWARM_TOOLCHAINS or
// ~/.project-swarm/toolchains instead. `toolchainsReport` is advice only: it never changes a
// provider's status or configured field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolchainsReport, doctor, tmpToolPathWarnings } from '../tools/swarm.mjs';

const noDir = { stat: async () => { throw Error('ENOENT'); } };

test('toolchainsReport: default dir is <home>/.project-swarm/toolchains, or SWARM_TOOLCHAINS when set', async () => {
  const withDefault = await toolchainsReport({ env: {}, home: '/Users/example', fsImpl: noDir });
  assert.equal(withDefault.dir, '/Users/example/.project-swarm/toolchains');
  assert.equal(withDefault.exists, false);
  assert.deepEqual(withDefault.tmpPaths, []);
  const withOverride = await toolchainsReport({ env: { SWARM_TOOLCHAINS: '/opt/toolchains' }, home: '/Users/example', fsImpl: noDir });
  assert.equal(withOverride.dir, '/opt/toolchains');
});

test('toolchainsReport: exists reflects a real directory, false for a file or a missing path', async () => {
  const isDir = await toolchainsReport({ env: {}, home: '/x', fsImpl: { stat: async () => ({ isDirectory: () => true }) } });
  assert.equal(isDir.exists, true);
  const isFile = await toolchainsReport({ env: {}, home: '/x', fsImpl: { stat: async () => ({ isDirectory: () => false }) } });
  assert.equal(isFile.exists, false);
  assert.equal((await toolchainsReport({ env: {}, home: '/x', fsImpl: noDir })).exists, false);
});

test('toolchainsReport: PATH entries and each toolchain env var under /tmp or /private/tmp are flagged; /Users/x/tmp is not', async () => {
  const env = {
    PATH: '/usr/bin:/tmp/toolbin:/private/tmp/other:/Users/x/tmp/bin',
    RUSTUP_HOME: '/tmp/rustup', CARGO_HOME: '/private/tmp/cargo', UV_CACHE_DIR: '/Users/x/tmp/uv',
    UV_PYTHON_INSTALL_DIR: '/tmp/uvpy', UV_TOOL_DIR: '/tmp/uvtool', PLAYWRIGHT_BROWSERS_PATH: '/tmp/pw', npm_config_cache: '/tmp/npm',
  };
  const report = await toolchainsReport({ env, home: '/Users/example', fsImpl: noDir });
  const pathEntries = report.tmpPaths.filter(p => p.name === 'PATH').map(p => p.path);
  assert.deepEqual(pathEntries, ['/tmp/toolbin', '/private/tmp/other']);
  const names = report.tmpPaths.map(p => p.name);
  for (const name of ['RUSTUP_HOME', 'CARGO_HOME', 'UV_PYTHON_INSTALL_DIR', 'UV_TOOL_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache']) assert.ok(names.includes(name), name);
  assert.equal(names.includes('UV_CACHE_DIR'), false, '/Users/x/tmp/uv is not caught');
});

test('doctor adds toolchains to its result without changing status', async () => {
  const help = ['--restricted', '--safe-mode', '--tools', '--permission-prompts', '--strict-mcp-config', '--mcp-config', '--no-session-persistence', '--no-chrome', '--output-format'].join(' ');
  const exec = async (_cmd, args) => ({ stdout: args[0] === '--version' ? '2.1.280 (Claude Code)' : help });
  const result = await doctor({ exec, env: { SWARM_TOOLCHAINS: '/opt/toolchains' }, home: '/Users/example', fsImpl: noDir });
  assert.equal(result.status, 'compatible');
  assert.deepEqual(result.toolchains, { dir: '/opt/toolchains', exists: false, tmpPaths: [] });
});

test('the tmp-tool-path validate warning names the toolchains dir', () => {
  const manifest = { version: 1, jobs: [{ id: 'j', readPaths: ['/tmp/toolchain'] }], checks: [{ name: 'unit', argv: ['/tmp/bin/tool', 'test'] }] };
  const warnings = tmpToolPathWarnings(manifest, { dir: '/opt/toolchains' });
  assert.deepEqual(warnings.map(w => w.message), [
    '/tmp/toolchain resolves under /tmp: macOS removes files here after 3 days unread; move it under /opt/toolchains',
    '/tmp/bin/tool resolves under /tmp: macOS removes files here after 3 days unread; move it under /opt/toolchains',
  ]);
});
