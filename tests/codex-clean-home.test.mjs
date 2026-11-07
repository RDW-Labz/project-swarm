// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanCodexConfig, prepareCodexCleanHome } from '../tools/codex-clean-home.mjs';

const REAL = `notify = [
    "/Applications/Hook.app/hook",
    "turn-ended",
]
service_tier = "fast"
model = "gpt-5.5-codex"
model_reasoning_effort = "high"
approval_policy = "never"

[desktop]
theme = "dark"

[profiles.swarm]
model = "gpt-5.5-codex"
sandbox_mode = "workspace-write"

[plugins."browser@openai-bundled"]
enabled = true

[mcp_servers.cluer-crm]
url = "https://crm.example/mcp"

[mcp_servers.cluer-crm.http_headers]
Authorization = "Bearer abc"

[model_providers.local]
base_url = "http://127.0.0.1:1234/v1"

[projects."/Users/me/x"]
trust_level = "trusted"
`;

test('clean config keeps model settings, profiles and providers; drops MCP servers, plugins, hooks, projects', () => {
  const out = cleanCodexConfig(REAL);
  for (const kept of ['model = "gpt-5.5-codex"', 'model_reasoning_effort = "high"', 'service_tier = "fast"', '[profiles.swarm]', 'sandbox_mode = "workspace-write"', '[model_providers.local]']) assert.ok(out.includes(kept), kept);
  for (const dropped of ['mcp_servers', 'cluer-crm', 'Bearer', 'plugins', 'notify', 'Hook.app', 'turn-ended', '[desktop]', 'projects', 'approval_policy']) assert.ok(!out.includes(dropped), dropped);
});

test('prepareCodexCleanHome writes the clean config and links (never copies) the login', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(path.join(home, '.codex', 'config.toml'), REAL);
  await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"tokens":"x"}');
  const target = await prepareCodexCleanHome({ env: {}, home });
  assert.equal(target, path.join(home, '.codex', 'swarm-worker-home'));
  assert.ok(!(await fs.readFile(path.join(target, 'config.toml'), 'utf8')).includes('mcp_servers'));
  assert.equal(await fs.readlink(path.join(target, 'auth.json')), path.join(home, '.codex', 'auth.json'));
  assert.equal(await fs.readFile(path.join(home, '.codex', 'auth.json'), 'utf8'), '{"tokens":"x"}', 'real login unchanged');
  assert.equal(await prepareCodexCleanHome({ env: {}, home }), target, 'second run is a no-op');
  assert.equal(await prepareCodexCleanHome({ env: { SWARM_CODEX_CLEAN_HOME: '0' }, home }), null);
});

test('no login file: the clean home still works (API key or keyring logins)', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = await prepareCodexCleanHome({ env: {}, home });
  await assert.rejects(fs.lstat(path.join(target, 'auth.json')));
  assert.match(await fs.readFile(path.join(target, 'config.toml'), 'utf8'), /^# Written by project-swarm/);
});
