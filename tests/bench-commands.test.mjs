// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseEvalArgs, evalCommand, EVAL_USAGE } from '../tools/bench-commands.mjs';

function memFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    async readFile(file, enc = 'utf8') {
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const v = files.get(file);
      return typeof v === 'string' ? v : v.toString(enc);
    },
    async writeFile(file, data) {
      files.set(file, data);
    },
    async mkdir() {},
    async readdir(dir) {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          names.add(rest.split(path.sep)[0]);
        }
      }
      return [...names];
    },
    _files: files,
  };
}

test('parseEvalArgs separates subcommand, flags and positionals', () => {
  const { subcommand, flags, rest } = parseEvalArgs(['compare', 'a.json', 'b.json', '--target', 'pass_rate', '--markdown']);
  assert.equal(subcommand, 'compare');
  assert.deepEqual(rest, ['a.json', 'b.json']);
  assert.equal(flags.get('target'), 'pass_rate');
  assert.equal(flags.get('markdown'), true);
  assert.throws(() => parseEvalArgs(['baseline', '--since']), /--since needs a value/);
});

test('unknown baseline option prints usage', async () => {
  const logs = [];
  const r = await evalCommand(['baseline', '--nope'], {
    root: '/proj',
    fs: memFs(),
    out: s => logs.push(s),
    deps: { collectBaseline: async () => ({ project: 'p', metrics: {} }) },
  });
  assert.equal(r.exitCode, 1);
  assert.match(logs.join(''), /usage:/);
});

test('baseline calls collectBaseline and writes json', async () => {
  const root = '/proj';
  const fs = memFs();
  const logs = [];
  let collected = null;
  const baseline = {
    project: 'demo',
    metrics: { first_try_pass_rate: { value: 0.5, status: 'missing' } },
  };
  const r = await evalCommand(['baseline', '--project', 'demo'], {
    root,
    fs,
    now: 1,
    out: s => logs.push(s),
    deps: {
      collectBaseline: async (opts) => {
        collected = opts;
        return baseline;
      },
      formatBaseline: () => 'BASELINE TABLE',
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(collected.project, 'demo');
  const outPath = path.join(root, 'evals', 'baseline', 'demo.json');
  assert.ok(fs._files.has(outPath));
  assert.match(logs.join(''), /BASELINE TABLE/);
  assert.match(logs.join(''), /Missing metrics/);
  assert.match(logs.join(''), /first_try_pass_rate/);
});

test('replay calls runReplay with parallel', async () => {
  const root = '/proj';
  const fs = memFs();
  let replayOpts = null;
  const r = await evalCommand(['replay', '--label', 'L1', '--parallel', '4'], {
    root,
    fs,
    deps: {
      loadCases: async () => [{ id: 'c1' }],
      runReplay: async (opts) => {
        replayOpts = opts;
        return { label: 'L1', metrics: { pass_rate: 1 } };
      },
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(replayOpts.parallel, 4);
  assert.equal(replayOpts.label, 'L1');
});

test('replay --load calls runLoadSeries', async () => {
  let load = false;
  const r = await evalCommand(['replay', '--label', 'load1', '--load'], {
    root: '/p',
    fs: memFs(),
    deps: {
      loadCases: async () => [],
      runLoadSeries: async () => {
        load = true;
        return { label: 'load1', levels: [] };
      },
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(load, true);
});

test('compare exits 1 on fail and 0 on pass', async () => {
  const root = '/proj';
  const before = path.join(root, 'before.json');
  const after = path.join(root, 'after.json');
  const fs = memFs({
    [before]: '{}',
    [after]: '{}',
  });
  const fail = await evalCommand(['compare', before, after, '--target', 'pass_rate'], {
    root,
    fs,
    deps: {
      compareReplays: () => ({ verdict: 'fail', rows: [] }),
      formatCompareTable: () => 'FAIL TABLE',
    },
  });
  assert.equal(fail.exitCode, 1);
  const pass = await evalCommand(['compare', before, after, '--target', 'pass_rate'], {
    root,
    fs,
    deps: {
      compareReplays: () => ({ verdict: 'pass', rows: [] }),
      formatCompareTable: () => 'PASS TABLE',
    },
  });
  assert.equal(pass.exitCode, 0);
});

test('compare missing target prints usage', async () => {
  const logs = [];
  const r = await evalCommand(['compare', 'a.json', 'b.json'], {
    root: '/p',
    fs: memFs({ '/p/a.json': '{}', '/p/b.json': '{}' }),
    out: s => logs.push(s),
    deps: { compareReplays: () => ({ verdict: 'pass' }) },
  });
  assert.equal(r.exitCode, 1);
  assert.match(logs.join(''), /usage:/);
});

test('scorecard builds from baseline files', async () => {
  const root = '/proj';
  const baselinePath = path.join(root, 'evals', 'baseline', 'demo.json');
  const fs = memFs({
    [baselinePath]: JSON.stringify({
      project: 'demo',
      metrics: { billed_usd: { value: 0.1, status: 'measured' } },
    }),
  });
  const logs = [];
  const r = await evalCommand(['scorecard'], { root, fs, now: Date.parse('2026-10-20T00:00:00Z'), out: s => logs.push(s) });
  assert.equal(r.exitCode, 0);
  assert.match(logs.join(''), /Weekly scorecard/);
  assert.ok(fs._files.has(path.join(root, 'evals', 'scorecard', 'latest.json')));
});

test('EVAL_USAGE documents subcommands', () => {
  assert.match(EVAL_USAGE, /baseline/);
  assert.match(EVAL_USAGE, /replay/);
  assert.match(EVAL_USAGE, /compare/);
  assert.match(EVAL_USAGE, /scorecard/);
});
