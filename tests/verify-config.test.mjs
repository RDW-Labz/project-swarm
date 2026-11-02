import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketTests, doneEvidence, validateVerifyConfig, verifyJobFields } from '../tools/verify-config.mjs';

const sorted = (list) => [...new Set(list)].sort();

const base = { command: ['node', '--test', '{tests}'] };
const withEnv = (testEnv) => ({ ...base, testEnv });

test('ticketTests: build ticket returns its tests plus its own test-looking files', () => {
  const ticket = {
    id: 'b1',
    type: 'build',
    files: ['src/app/page.tsx', 'tests/page.test.tsx'],
    tests: ['tests/page.test.tsx'],
  };
  assert.deepEqual(sorted(ticketTests(ticket)), ['tests/page.test.tsx']);
});

test('ticketTests: build ticket with a separate test ticket lists the test files it names', () => {
  const ticket = {
    id: 'b2',
    type: 'build',
    files: ['src/lib/parse.mjs'],
    tests: ['tests/parse.test.mjs'],
  };
  assert.deepEqual(sorted(ticketTests(ticket)), ['tests/parse.test.mjs']);
});

test('ticketTests: test ticket returns its own test files', () => {
  const ticket = {
    id: 't1',
    type: 'test',
    files: ['tests/login.test.mjs'],
    tests: [],
  };
  assert.deepEqual(sorted(ticketTests(ticket)), ['tests/login.test.mjs']);
});

test('ticketTests: migration ticket includes the SQL test file next to the migration', () => {
  const ticket = {
    id: 'm1',
    type: 'migration',
    files: ['supabase/migrations/0001_init.sql', 'tests/db/r001.test.sql'],
    tests: ['tests/db/r001.test.sql'],
  };
  assert.deepEqual(sorted(ticketTests(ticket)), ['tests/db/r001.test.sql']);
});

test('ticketTests: migration file itself is not treated as a test file', () => {
  const ticket = {
    id: 'm2',
    type: 'migration',
    files: ['supabase/migrations/0002_users.sql'],
    tests: [],
  };
  assert.deepEqual(ticketTests(ticket), []);
});

test('ticketTests: contract, config, docs and human tickets return empty', () => {
  for (const type of ['contract', 'config', 'docs', 'human']) {
    const ticket = {
      id: `x-${type}`,
      type,
      files: type === 'contract' ? ['contracts/api.json'] : ['docs/readme.md'],
      tests: ['tests/any.test.mjs'],
    };
    assert.deepEqual(ticketTests(ticket), [], `type ${type}`);
  }
});

test('ticketTests: a listed path starting with a dash is dropped', () => {
  const ticket = {
    id: 'd1',
    type: 'test',
    files: [],
    tests: ['--inspect=0.0.0.0', '-x.test.mjs', 'tests/ok.test.mjs'],
  };
  assert.deepEqual(ticketTests(ticket), ['tests/ok.test.mjs']);
});

test('ticketTests: a dash-only listed path yields no tests and no job fields', () => {
  const ticket = {
    id: 'd2',
    type: 'test',
    files: [],
    tests: ['--rm.test.mjs'],
  };
  assert.deepEqual(ticketTests(ticket), []);
  assert.equal(verifyJobFields(ticket, base), null);
});

test('ticketTests: a listed path that is not a test file is dropped', () => {
  const ticket = {
    id: 'n1',
    type: 'build',
    files: ['src/lib/parse.mjs'],
    tests: ['src/lib/parse.mjs', 'tests/parse.test.mjs'],
  };
  assert.deepEqual(sorted(ticketTests(ticket)), ['tests/parse.test.mjs']);
});

test('verifyJobFields: {tests} is expanded with a dot-slash prefix in the prompt line', () => {
  const ticket = {
    id: 'p1',
    type: 'test',
    files: ['tests/x.test.mjs'],
    tests: [],
  };
  const fields = verifyJobFields(ticket, base);
  assert.ok(fields);
  assert.ok(fields.promptLine.includes('Run node --test ./tests/x.test.mjs. The ticket is done only when they pass'), fields.promptLine);
  assert.ok(!fields.promptLine.includes('Run node --test tests/x.test.mjs'));
});

test('validateVerifyConfig: a plain testEnv name is accepted', () => {
  const r = validateVerifyConfig(withEnv({ NODE_ENV: 'test' }));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('validateVerifyConfig: each testEnv name word rule refuses the name', () => {
  const words = ['KEY', 'JWT', 'DSN', 'SESSION', 'COOKIE', 'CERT', 'SIGN', 'PASS', 'AUTH', 'SECRET', 'TOKEN', 'PRIVATE', 'CREDENTIAL'];
  for (const w of words) {
    const r = validateVerifyConfig(withEnv({ [`APP_${w}`]: 'value' }));
    assert.equal(r.ok, false, `name containing ${w} should be refused`);
  }
});

test('validateVerifyConfig: a testEnv name containing a secret word inside a longer word is refused', () => {
  const r = validateVerifyConfig(withEnv({ DBDSNURL: 'local' }));
  assert.equal(r.ok, false);
});

test('validateVerifyConfig: a JWT-shaped value is refused', () => {
  const jwt = ['ey', 'J', 'hbGciOi'].join('') + 'JIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxIn0' + '.' + 'c2lnbmF0dXJl';
  const r = validateVerifyConfig(withEnv({ FIXTURE_VALUE: jwt }));
  assert.equal(r.ok, false);
});

test('validateVerifyConfig: a URL with a password to a remote host is refused', () => {
  const pw = ['hunter', '2x'].join('');
  const url = 'postgres://app:' + pw + '@db.example.com:5432/app';
  const r = validateVerifyConfig(withEnv({ TEST_URL: url }));
  assert.equal(r.ok, false);
});

test('validateVerifyConfig: a URL with a password to 127.0.0.1 is accepted', () => {
  const pw = ['hunter', '2x'].join('');
  const url = 'postgres://app:' + pw + '@127.0.0.1:5432/app';
  const r = validateVerifyConfig(withEnv({ TEST_URL: url }));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('validateVerifyConfig: a secret-looking value built at run time from pieces is refused', () => {
  const value = ['ghp_', 'a'.repeat(36)].join('');
  const r = validateVerifyConfig(withEnv({ STRIPE_MODE: value }));
  assert.equal(r.ok, false);
});

test('doneEvidence: queue pass with tests check passed is ok', () => {
  const state = {
    mergeQueue: {
      batches: [
        {
          id: 'batch-1',
          jobs: ['job-1'],
          checks: 'passed',
          checkResults: [{ name: 'tests', status: 'passed', mode: 'full' }],
        },
      ],
    },
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, true);
  assert.equal(typeof result.reason, 'string');
});

test('doneEvidence: queue pass with tests check failed is not ok', () => {
  const state = {
    mergeQueue: {
      batches: [
        {
          id: 'batch-1',
          jobs: ['job-1'],
          checkResults: [{ name: 'tests', status: 'failed', mode: 'full' }],
        },
      ],
    },
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});

test('doneEvidence: queue pass with tests check skipped is not ok', () => {
  const state = {
    mergeQueue: {
      batches: [
        {
          id: 'batch-1',
          jobs: ['job-1'],
          checkResults: [{ name: 'tests', status: 'skipped', mode: 'full' }],
        },
      ],
    },
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, false);
});

test('doneEvidence: job integrated in another batch does not borrow that batch passing', () => {
  const state = {
    mergeQueue: {
      batches: [
        {
          id: 'batch-1',
          jobs: ['job-other'],
          checkResults: [{ name: 'tests', status: 'passed', mode: 'full' }],
        },
        {
          id: 'batch-2',
          jobs: ['job-1'],
          checkResults: [],
        },
      ],
    },
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, false);
});

test('doneEvidence: queue batch without a tests check is not ok', () => {
  const state = {
    mergeQueue: {
      batches: [
        {
          id: 'batch-1',
          jobs: ['job-1'],
          checkResults: [{ name: 'audit', status: 'passed', mode: 'full' }],
        },
      ],
    },
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, false);
});

test('doneEvidence: plain integrate with passed tests check and job integrated is ok', () => {
  const state = {
    jobs: [{ id: 'job-1', outputs: ['src/a.ts'] }],
    integratedFiles: ['src/a.ts'],
    checks: [{ name: 'tests', status: 'passed' }],
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, true);
  assert.equal(doneEvidence({ ...state, integratedFiles: [] }, 'job-1').ok, false);
});

test('doneEvidence: plain integrate with failed tests check is not ok', () => {
  const state = {
    integrated: ['job-1'],
    checks: [{ name: 'tests', status: 'failed' }],
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, false);
});

test('doneEvidence: worker checksRun is never evidence', () => {
  const state = {
    integrated: ['job-1'],
    checks: [],
    jobs: { 'job-1': { checksRun: [{ name: 'tests', status: 'passed' }] } },
  };
  const result = doneEvidence(state, 'job-1');
  assert.equal(result.ok, false);
});

test('doneEvidence: no evidence at all is not ok', () => {
  const result = doneEvidence({}, 'job-1');
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});

test('doneEvidence: only the batch the queue says integrated the job counts, and it must not be security-blocked or skip tests', () => {
  const passed = [{ name: 'tests', status: 'passed', mode: 'full' }];
  const base = (extra, batches) => ({ mergeQueue: { integratedIn: { 'job-1': 2 }, batches, ...extra } });
  assert.equal(doneEvidence(base({}, [{ id: 1, jobs: ['job-1'], checks: 'passed', checkResults: passed }, { id: 2, jobs: ['job-1'], checks: 'passed', security: 'passed', checkResults: [{ name: 'tests', status: 'skipped' }] }]), 'job-1').ok, false);
  assert.equal(doneEvidence(base({}, [{ id: 2, jobs: ['job-1'], checks: 'passed', security: 'blocked', checkResults: passed }]), 'job-1').ok, false);
  assert.equal(doneEvidence(base({}, [{ id: 2, jobs: ['job-1'], checks: 'passed', security: 'passed', checkResults: [{ name: 'tests', status: 'passed', mode: 'affected', tests: 0 }] }]), 'job-1').ok, false);
  assert.equal(doneEvidence(base({}, [{ id: 2, jobs: ['job-1'], checks: 'passed', security: 'passed', checkResults: [{ name: 'tests', status: 'passed', mode: 'affected', tests: 3 }] }]), 'job-1').ok, true);
});
