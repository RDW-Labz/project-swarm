// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stressScript = path.join(repoRoot, 'tools/stress-tests.mjs');

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function hangCommand(pidFile) {
  return JSON.stringify([
    process.execPath,
    '-e',
    `import fs from 'node:fs'; console.log(process.pid); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
  ]);
}

test('stress-tests.mjs rejects invalid STRESS_TEST_COMMAND without spawning a round', { timeout: 30_000 }, async t => {
  const invalidCommands = [
    '[malformed', '', 'null', '{}', '"node"', '42', '[]',
    '[null]', '[42]', '[""]', '["   "]', JSON.stringify([process.execPath, 42]),
  ];
  for (const command of invalidCommands) {
    await t.test(JSON.stringify(command), async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        childProcess.spawn = () => {
          console.error('unexpected round child spawn');
          process.exit(99);
        };
        syncBuiltinESMExports();
        await import(${JSON.stringify(stressScript)});
      `], {
        cwd: repoRoot,
        env: { ...process.env, STRESS_ROUNDS: '1', STRESS_TEST_COMMAND: command },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const [code, signal] = await once(child, 'close');
      assert.equal(code, 2, stderr);
      assert.equal(signal, null);
      assert.equal(stdout, '', 'invalid input must not start a round');
      assert.equal(stderr, 'test:stress: STRESS_TEST_COMMAND must be a non-empty JSON array of strings\n');
    });
  }
});

test('stress-tests.mjs waits for round exit with a bounded signal fallback', { timeout: 15_000 }, async t => {
  for (const [signal, exitCode, emitsExit] of [
    ['SIGINT', 130, true], ['SIGTERM', 143, true], ['SIGINT', 130, false],
  ]) {
    await t.test(`${signal}, child ${emitsExit ? 'exits' : 'never exits'}`, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import childProcess from 'node:child_process';
        import { EventEmitter } from 'node:events';
        import { syncBuiltinESMExports } from 'node:module';
        const round = new EventEmitter();
        round.pid = 12345;
        round.stdout = new EventEmitter();
        round.stderr = new EventEmitter();
        process.kill = (pid, signal) => {
          if (pid !== -round.pid || signal !== 'SIGKILL') throw new Error('wrong group kill');
          console.log('round group killed');
          ${emitsExit ? `setTimeout(() => {
            console.log('round child exiting');
            round.emit('exit', null, 'SIGKILL');
          }, 100);` : ''}
          return true;
        };
        childProcess.spawn = () => {
          setImmediate(() => process.emit(${JSON.stringify(signal)}));
          return round;
        };
        syncBuiltinESMExports();
        await import(${JSON.stringify(stressScript)});
      `], {
        cwd: repoRoot,
        env: { ...process.env, STRESS_ROUNDS: '2', STRESS_TEST_COMMAND: hangCommand('unused') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const started = Date.now();
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const [code] = await once(child, 'close');
      const elapsed = Date.now() - started;
      assert.equal(code, exitCode, stderr);
      assert.equal(stdout, `stress round 1/2: interrupted by ${signal}; killed the round process group\nround group killed\n${emitsExit ? 'round child exiting\n' : ''}`);
      assert.equal(stderr, '');
      if (!emitsExit) assert.ok(elapsed >= 1_900, `fallback exited too soon: ${elapsed}ms`);
      assert.ok(elapsed < 5_000, `shutdown exceeded its bound: ${elapsed}ms`);
    });
  }
});

async function runInterruptCase(signal, expectedExitCode) {
  const pidFile = path.join(os.tmpdir(), `stress-interrupt-${process.pid}-${Date.now()}.pid`);
  const runner = spawn(process.execPath, [stressScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STRESS_ROUNDS: '1',
      STRESS_TEST_COMMAND: hangCommand(pidFile),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let combined = '';
  runner.stdout.setEncoding('utf8');
  runner.stderr.setEncoding('utf8');
  runner.stdout.on('data', chunk => { combined += chunk; });
  runner.stderr.on('data', chunk => { combined += chunk; });

  const deadline = Date.now() + 10_000;
  let roundPid;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      roundPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(roundPid)) break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(roundPid, 'expected fake round pid file before interrupt');

  runner.kill(signal);

  const [exitCode] = await once(runner, 'exit');
  assert.equal(exitCode, expectedExitCode, `runner exit for ${signal}`);
  assert.match(
    combined,
    new RegExp(`stress round 1/1: interrupted by ${signal}; killed the round process group`),
  );

  await new Promise(r => setTimeout(r, 200));
  assert.equal(processAlive(roundPid), false, 'fake round pid should be dead');
  assert.equal(processGroupAlive(roundPid), false, 'fake round process group should be dead');

  try { fs.unlinkSync(pidFile); } catch { /* ok */ }
}

test('stress-tests.mjs stops the round on SIGINT with exit 130', { timeout: 30_000 }, async () => {
  await runInterruptCase('SIGINT', 130);
});

test('stress-tests.mjs stops the round on SIGTERM with exit 143', { timeout: 30_000 }, async () => {
  await runInterruptCase('SIGTERM', 143);
});

test('STRESS_ROUNDS=1 STRESS_CONCURRENCY=4 test:stress still passes', { timeout: 600_000 }, async () => {
  const env = { ...process.env, STRESS_ROUNDS: '1', STRESS_CONCURRENCY: '4' };
  delete env.STRESS_TEST_COMMAND;
  const child = spawn(process.execPath, [stressScript], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });

  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  assert.match(out, /test:stress: 1 rounds passed/);
});
