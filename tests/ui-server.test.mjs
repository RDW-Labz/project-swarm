import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { freePort, expandStart, startEnv, screenUrl, mockupUrlSuffix, validWaitFor } from '../tools/ui-server.mjs';

test('freePort resolves to an integer port in range', async () => {
  const port = await freePort();
  assert.equal(typeof port, 'number');
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port <= 65535);
});

test('freePort returns a port that can be listened on', async () => {
  const first = await freePort();
  const second = await freePort();
  assert.equal(typeof second, 'number');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(first, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
});

test('expandStart replaces every {port} token with the port text', () => {
  assert.deepEqual(
    expandStart(['serve', '--port', '{port}', '--x={port}'], 4321),
    ['serve', '--port', '4321', '--x=4321']
  );
});

test('expandStart returns a copy and does not change its input', () => {
  const input = ['a', '{port}'];
  const out = expandStart(input, 9);
  assert.notEqual(out, input);
  assert.deepEqual(input, ['a', '{port}']);
  assert.deepEqual(out, ['a', '9']);
});

test('expandStart on empty argv returns an empty array', () => {
  assert.deepEqual(expandStart([], 1), []);
});

test('expandStart leaves args without the token unchanged', () => {
  assert.deepEqual(expandStart(['npm', 'run', 'dev'], 5), ['npm', 'run', 'dev']);
});

test('startEnv sets PORT and SWARM_UI_PORT as text', () => {
  assert.deepEqual(startEnv(8080), { PORT: '8080', SWARM_UI_PORT: '8080' });
});

test('startEnv keeps other variables and overrides PORT', () => {
  const env = { A: '1', PORT: '1' };
  const out = startEnv(3000, env);
  assert.deepEqual(out, { A: '1', PORT: '3000', SWARM_UI_PORT: '3000' });
  assert.deepEqual(env, { A: '1', PORT: '1' });
});

test('screenUrl joins base and route', () => {
  assert.equal(screenUrl('http://127.0.0.1:3000', { route: '/login' }), 'http://127.0.0.1:3000/login');
});

test('screenUrl keeps a query string in the route', () => {
  assert.equal(screenUrl('http://127.0.0.1:3000', { route: '/a?step=1' }), 'http://127.0.0.1:3000/a?step=1');
});

test('screenUrl with an empty route returns the base', () => {
  assert.equal(screenUrl('http://h', { route: '' }), 'http://h');
});

test('mockupUrlSuffix is empty when mockupQuery is missing', () => {
  assert.equal(mockupUrlSuffix({}), '');
});

test('mockupUrlSuffix adds a question mark and the query', () => {
  assert.equal(mockupUrlSuffix({ mockupQuery: 'step=2' }), '?step=2');
  assert.equal(mockupUrlSuffix({ mockupQuery: 'step=2&tab=x.y-z_1' }), '?step=2&tab=x.y-z_1');
});

test('mockupUrlSuffix accepts exactly 100 allowed characters', () => {
  const q = 'a'.repeat(100);
  assert.equal(mockupUrlSuffix({ mockupQuery: q }), '?' + q);
});

test('mockupUrlSuffix rejects 101 characters', () => {
  assert.throws(() => mockupUrlSuffix({ mockupQuery: 'a'.repeat(101) }), { name: 'Error', message: 'invalid mockupQuery' });
});

test('mockupUrlSuffix rejects a hash', () => {
  assert.throws(() => mockupUrlSuffix({ mockupQuery: 'a#b' }), { name: 'Error', message: 'invalid mockupQuery' });
});

test('mockupUrlSuffix rejects spaces and other characters', () => {
  assert.throws(() => mockupUrlSuffix({ mockupQuery: 'a b' }), { name: 'Error', message: 'invalid mockupQuery' });
  assert.throws(() => mockupUrlSuffix({ mockupQuery: 'a;b' }), { name: 'Error', message: 'invalid mockupQuery' });
});

test('mockupUrlSuffix rejects an empty string and wrong types', () => {
  assert.throws(() => mockupUrlSuffix({ mockupQuery: '' }), { name: 'Error', message: 'invalid mockupQuery' });
  assert.throws(() => mockupUrlSuffix({ mockupQuery: 42 }), { name: 'Error', message: 'invalid mockupQuery' });
});

test('validWaitFor accepts typical selectors', () => {
  assert.equal(validWaitFor('#login button'), true);
  assert.equal(validWaitFor('a.btn'), true);
  assert.equal(validWaitFor('[data-test=save]'), true);
  assert.equal(validWaitFor('div[role=dialog] p'), true);
});

test('validWaitFor accepts exactly 100 characters', () => {
  assert.equal(validWaitFor('a'.repeat(100)), true);
});

test('validWaitFor rejects an empty string and 101 characters', () => {
  assert.equal(validWaitFor(''), false);
  assert.equal(validWaitFor('a'.repeat(101)), false);
});

test('validWaitFor rejects non-string values', () => {
  assert.equal(validWaitFor(null), false);
  assert.equal(validWaitFor(undefined), false);
  assert.equal(validWaitFor(5), false);
});

test('validWaitFor rejects characters outside the allowed set', () => {
  assert.equal(validWaitFor('a;b'), false);
  assert.equal(validWaitFor('a<b'), false);
  assert.equal(validWaitFor('a{b}'), false);
  assert.equal(validWaitFor('a:b'), false);
  assert.equal(validWaitFor('a\u005cb'), false);
  assert.equal(validWaitFor('a\nb'), false);
});
