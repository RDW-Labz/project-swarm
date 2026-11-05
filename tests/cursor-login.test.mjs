// SPDX-License-Identifier: Apache-2.0
// A Mac logged in with `cursor-agent login` runs Cursor workers on that subscription: the parent reads
// the login token from the Keychain and the worker gets it as CURSOR_AUTH_TOKEN. Synthetic tokens only.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorAuthEnv, cursorDoctor, cursorEnvironment, CURSOR_LOGIN_ITEM, readCursorLogin, resolveCursorAuth } from '../tools/cursor-adapter.mjs';

const NOW = Date.parse('2026-11-05T20:00:00Z');
const jwt = expMs => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: 'user', exp: Math.floor(expMs / 1000) })).toString('base64url'), 'c2lnbmF0dXJl'].join('.');
const keychain = items => (file, args) => {
  assert.equal(file, '/usr/bin/security');
  const service = args[args.indexOf('-s') + 1], account = args[args.indexOf('-a') + 1];
  const value = items[`${service}/${account}`];
  if (value === undefined) throw Object.assign(new Error('item not found'), { status: 44 });
  return `${value}\n`;
};
const loginKey = `${CURSOR_LOGIN_ITEM.service}/${CURSOR_LOGIN_ITEM.account}`;

test('a valid subscription login is used, ahead of an API key', () => {
  const token = jwt(NOW + 30 * 24 * 3600 * 1000);
  const exec = keychain({ [loginKey]: token, 'project-swarm/cursor.api_key': 'key-from-keychain-123' });
  const auth = resolveCursorAuth({ CURSOR_API_KEY: 'env-key-12345678' }, { platform: 'darwin', exec, now: () => NOW });
  assert.equal(auth.kind, 'login');
  assert.equal(auth.envName, 'CURSOR_AUTH_TOKEN');
  assert.equal(auth.secret, token);
  assert.equal(auth.expiresAt, Math.floor((NOW + 30 * 24 * 3600 * 1000) / 1000) * 1000);
});

test('an expired or nearly expired login falls back to an API key, and says so with none', () => {
  for (const exp of [NOW - 1000, NOW + 60 * 1000]) {
    const exec = keychain({ [loginKey]: jwt(exp) });
    assert.equal(readCursorLogin({}, { platform: 'darwin', exec, now: () => NOW }).token, undefined);
    const withKey = resolveCursorAuth({ CURSOR_API_KEY: 'env-key-12345678' }, { platform: 'darwin', exec, now: () => NOW });
    assert.deepEqual([withKey.kind, withKey.envName, withKey.secret], ['api-key', 'CURSOR_API_KEY', 'env-key-12345678']);
    assert.throws(() => resolveCursorAuth({}, { platform: 'darwin', exec, now: () => NOW }), /cursor-not-authenticated: the Cursor login expired .*run `cursor-agent login` again/);
  }
  assert.throws(() => resolveCursorAuth({}, { platform: 'darwin', exec: keychain({}), now: () => NOW }), /run `cursor-agent login` to use your Cursor subscription/);
  assert.equal(readCursorLogin({}, { platform: 'darwin', exec: keychain({ [loginKey]: 'not-a-jwt' }), now: () => NOW }).token, undefined);
});

test('SWARM_CURSOR_NO_KEYCHAIN and other platforms never read the Keychain', () => {
  const exec = () => { throw Error('keychain must not be read'); };
  assert.equal(readCursorLogin({ SWARM_CURSOR_NO_KEYCHAIN: '1' }, { platform: 'darwin', exec }).token, undefined);
  assert.equal(readCursorLogin({}, { platform: 'linux', exec }).token, undefined);
});

test('the worker gets exactly one Cursor credential and a memory-only credential store', async () => {
  const base = await cursorEnvironment({ PATH: '/usr/bin', HOME: '/h', CURSOR_API_KEY: 'env-key-12345678' }, async () => false);
  assert.equal(base.AGENT_CLI_CREDENTIAL_STORE, 'memory', 'cursor-agent never writes to the Keychain (no "keychain not found" dialog)');
  const login = cursorAuthEnv({ ...base, CURSOR_AUTH_TOKEN: 'stale' }, { kind: 'login', envName: 'CURSOR_AUTH_TOKEN', secret: 'tok' });
  assert.equal(login.CURSOR_AUTH_TOKEN, 'tok');
  assert.equal('CURSOR_API_KEY' in login, false);
  const key = cursorAuthEnv(base, { kind: 'api-key', envName: 'CURSOR_API_KEY', secret: 'key-12345678' });
  assert.equal(key.CURSOR_API_KEY, 'key-12345678');
  assert.equal('CURSOR_AUTH_TOKEN' in key, false);
});

test('doctor reports a subscription login as authenticated', async () => {
  const token = jwt(NOW + 3600 * 1000);
  const exec = async (file, args) => ({ stdout: args[0] === '--help' ? '-p --output-format --model --trust --workspace --sandbox --force' : '2026.11.05' });
  const env = { PATH: process.env.PATH };
  let report;
  try {
    report = await cursorDoctor({ platform: 'darwin', exec, env, authOptions: { platform: 'darwin', exec: keychain({ [loginKey]: token }), now: () => NOW } });
  } catch (error) {
    if (/cursor-not-installed/.test(error.message)) return; // no cursor-agent on this machine's PATH
    throw error;
  }
  assert.equal(report.status, 'compatible');
  assert.match(report.auth, /^Cursor login \(subscription\), expires 2026-11-05T21:00:00/);
});
