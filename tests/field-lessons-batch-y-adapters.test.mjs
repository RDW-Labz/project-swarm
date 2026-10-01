// SPDX-License-Identifier: Apache-2.0
// Lesson 296: adapter saves raw reply to response-invalid.txt with detailed error messages
// Lesson 295: envelope accepts optional result object with attached skills' resultKeys
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeApi, validateEnvelope, outputSchema } from '../tools/api-adapters.mjs';

const env = { OPENAI_API_KEY: 'secret-key' };
const job = (agent = 'openai', overrides = {}) => ({
  id: 'test-job',
  agent,
  model: 'test-model',
  context: [],
  outputs: ['output.txt'],
  prompt: 'Test task.',
  timeoutMs: 1000,
  ...overrides
});

function body(agent, value) {
  const text = JSON.stringify(value);
  if (agent === 'openai') {
    return {
      status: 'completed',
      model: 'resolved-openai',
      usage: { input_tokens: 10, output_tokens: 10 },
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }]
    };
  }
  return {};
}

function reply(agent, value) {
  return new Response(JSON.stringify(body(agent, value)), { headers: { 'content-type': 'application/json' } });
}

// --- Lesson 295: result object with attached skills' resultKeys ---

test('Lesson 295: outputSchema includes resultKeys from attached skills', () => {
  const attachedSkills = [
    {
      name: 'debugging',
      attached: 'named',
      checks: { resultKeys: ['status', 'reproTest'] }
    }
  ];
  const schema = outputSchema(['output.txt'], attachedSkills);
  assert.deepEqual(schema.properties.result.required, ['status', 'reproTest']);
  assert.ok(schema.properties.result.properties.status);
  assert.ok(schema.properties.result.properties.reproTest);
});

test('Lesson 295: outputSchema ignores index-only skills', () => {
  const attachedSkills = [
    {
      name: 'unused',
      attached: 'index-only',
      checks: { resultKeys: ['neverRequired'] }
    }
  ];
  const schema = outputSchema(['output.txt'], attachedSkills);
  assert.equal(schema.properties.result.required?.length ?? 0, 0);
});

test('Lesson 295: envelope with result object validates when result has required keys', async () => {
  const envelope = {
    summary: 'Completed.',
    files: [{ path: 'output.txt', content: 'result' }],
    edits: [],
    result: { status: 'ok', reproTest: 'passed' }
  };
  assert.doesNotThrow(() => validateEnvelope(envelope, ['output.txt']));
});

test('Lesson 295: openai adapter includes result object in response as JSON line', async () => {
  const envelope = {
    summary: 'Completed.',
    files: [{ path: 'output.txt', content: 'output' }],
    edits: [],
    result: { status: 'done', reproTest: 'verified' }
  };
  const result = await executeApi(
    job('openai', {
      outputs: ['output.txt']
    }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope),
      attachedSkills: [
        {
          name: 'debugging',
          attached: 'named',
          checks: { resultKeys: ['status', 'reproTest'] }
        }
      ]
    }
  );
  assert.equal(result.status, 'complete');
  assert.match(result.response, /Completed\./);
  assert.match(result.response, /\{"status":"done","reproTest":"verified"\}/);
});

// --- Lesson 296: invalid envelope saves raw reply with detailed error messages ---

test('Lesson 296: validation error includes undeclared path detail', async () => {
  const envelope = {
    summary: 'Done.',
    files: [{ path: 'wrong.txt', content: 'content' }],
    edits: []
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /wrong\.txt.*not in declared outputs/);
  assert.ok(result.invalidResponseText);
});

test('Lesson 296: validation error includes duplicate path detail', async () => {
  const envelope = {
    summary: 'Done.',
    files: [
      { path: 'output.txt', content: 'first' },
      { path: 'output.txt', content: 'second' }
    ],
    edits: []
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /output\.txt.*is duplicate/);
});

test('Lesson 296: validation error specifies when edits is not an array', async () => {
  const envelope = {
    summary: 'Done.',
    files: [{ path: 'output.txt', content: 'content' }],
    edits: 'not-an-array'
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /edits.*must be an array.*string/);
});

test('Lesson 296: validation error specifies edits array of strings', async () => {
  const envelope = {
    summary: 'Done.',
    files: [{ path: 'output.txt', content: 'content' }],
    edits: ['string-not-object']
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /invalid.*output/);
});

test('Lesson 296: validation error details unexpected envelope key', async () => {
  const envelope = {
    summary: 'Done.',
    files: [{ path: 'output.txt', content: 'content' }],
    edits: [],
    unexpected: true
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /unexpected key.*unexpected/);
});

test('Lesson 296: validation error details unexpected file object key', async () => {
  const envelope = {
    summary: 'Done.',
    files: [{ path: 'output.txt', content: 'content', mode: 511 }],
    edits: []
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /files\[\]\.mode.*unexpected/);
});

test('Lesson 296: rawResponseText is available to callers for response-invalid.txt', async () => {
  const envelope = {
    summary: 'Bad.',
    files: [{ path: 'invalid.txt', content: 'content' }],
    edits: []
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.ok(result.invalidResponseText);
  const parsed = JSON.parse(result.invalidResponseText);
  assert.equal(parsed.files[0].path, 'invalid.txt');
});

test('Lesson 296: validation error for empty find in edit', async () => {
  const envelope = {
    summary: 'Done.',
    files: [{ path: 'output.txt', content: 'original' }],
    edits: [{ path: 'output.txt', find: '', replace: 'new' }]
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /find.*cannot be empty/);
});

test('Lesson 296: validation error for undeclared edit path', async () => {
  const envelope = {
    summary: 'Done.',
    files: [{ path: 'output.txt', content: 'content' }],
    edits: [{ path: 'other.txt', find: 'a', replace: 'b' }]
  };
  const result = await executeApi(
    job('openai', { outputs: ['output.txt'] }),
    [],
    {
      env,
      fetchImpl: async () => reply('openai', envelope)
    }
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /other\.txt.*not in declared outputs/);
});

test('Lesson 296: existing validateEnvelope tests still pass', () => {
  // Test that error messages keep old prefix for backward compatibility
  const cases = [
    [null, /Invalid/],
    [{ summary: 'x', files: [] }, /declared output/],
    [{ summary: 'x', files: [{ path: '../bad', content: 'x' }] }, /Worker returned/],
    [{ summary: 'x', files: [{ path: 'other.txt', content: 'x' }] }, /declared output/]
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => validateEnvelope(value, ['output.txt']), pattern);
  }
});
