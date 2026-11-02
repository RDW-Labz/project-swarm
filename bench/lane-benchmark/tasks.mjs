// SPDX-License-Identifier: Apache-2.0
// Ten real tasks from this repo, two of each kind. Each task is a function of the base tree (a
// `git archive` of main without history and without bench/): `mutate` edits the tree to set the
// task up, `verify` says how a result is checked. Hidden tests and mutants live only here, never
// in the repo a worker sees.
const TEST = ['node', '--import', './tests/_isolate-config.mjs', '--test'];
const replaceOnce = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error(`setup string not found exactly once: ${from.slice(0, 60)}`);
  return text.replace(from, to);
};
const count = (text, needle) => text.split(needle).length - 1;

const durationHidden = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../tools/duration.mjs';
test('parseDuration', () => {
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('5m'), 300000);
  assert.equal(parseDuration('2h'), 7200000);
  assert.equal(parseDuration('1d'), 86400000);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration('  10 M '), 600000);
  assert.equal(parseDuration('0s'), 0);
  assert.equal(parseDuration('2.5s'), 2500);
  for (const bad of ['', '5', 'm', '-5m', '5x', '5 minutes', 'abc', '1..5s', '5m5s', null, undefined, 12, {}]) assert.equal(parseDuration(bad), null, String(bad));
});
`;
const costHidden = `import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCosts } from '../tools/cost-summary.mjs';
test('summarizeCosts', () => {
  const jobs = [
    { id: 'a', agent: 'codex', costUsd: 0.1 }, { id: 'b', agent: 'anthropic', costUsd: 0.0002 },
    { id: 'c', agent: 'anthropic', costUsd: 0.0003 }, { id: 'd', agent: 'cursor', costUsd: null },
    { id: 'e', agent: 'codex' }, { id: 'f', agent: 'claude', costUsd: -1 }, { id: 'g', agent: 'claude', costUsd: Infinity },
    { id: 'h', agent: 'claude', costUsd: 0 },
  ];
  const result = summarizeCosts(jobs);
  assert.equal(result.totalUsd, 0.1005);
  assert.deepEqual(Object.keys(result.byAgent), ['anthropic', 'claude', 'codex', 'cursor']);
  assert.deepEqual(result.byAgent.anthropic, { jobs: 2, usd: 0.0005 });
  assert.deepEqual(result.byAgent.codex, { jobs: 2, usd: 0.1 });
  assert.deepEqual(result.byAgent.claude, { jobs: 3, usd: 0 });
  assert.deepEqual(result.byAgent.cursor, { jobs: 1, usd: 0 });
  assert.deepEqual(result.unknown, ['d', 'e', 'f', 'g']);
  assert.deepEqual(summarizeCosts([]), { totalUsd: 0, byAgent: {}, unknown: [] });
  assert.equal(summarizeCosts([{ id: 'x', agent: 'a', costUsd: 0.1 }, { id: 'y', agent: 'a', costUsd: 0.2 }]).totalUsd, 0.3);
  assert.throws(() => summarizeCosts('no'), TypeError);
});
`;

export const TASKS = [
  {
    id: 'bug-percentile', type: 'bug-fix',
    prompt: 'The test `node --import ./tests/_isolate-config.mjs --test tests/scale.test.mjs` fails. Find the bug in tools/scale.mjs and fix it. Change only tools/scale.mjs and do not edit any test.',
    context: ['tools/scale.mjs', 'tests/scale.test.mjs'], outputs: ['tools/scale.mjs'],
    mutate: tree => { tree['tools/scale.mjs'] = replaceOnce(tree['tools/scale.mjs'], 'Math.ceil((p / 100) * sorted.length) - 1', 'Math.floor((p / 100) * sorted.length) - 1'); },
    verify: { argv: [...TEST, 'tests/scale.test.mjs'] },
  },
  {
    id: 'bug-router-failover', type: 'bug-fix',
    prompt: 'The test `node --import ./tests/_isolate-config.mjs --test tests/router.test.mjs` fails. Find the bug in tools/router.mjs and fix it. Change only tools/router.mjs and do not edit any test.',
    context: ['tools/router.mjs', 'tests/router.test.mjs'], outputs: ['tools/router.mjs'],
    mutate: tree => { tree['tools/router.mjs'] = replaceOnce(tree['tools/router.mjs'], 'candidates = candidates.filter(agent => !(failures[agent] >= 2));', 'candidates = candidates.filter(agent => !(failures[agent] > 2));'); },
    verify: { argv: [...TEST, 'tests/router.test.mjs'] },
  },
  {
    id: 'new-parse-duration', type: 'new-function',
    prompt: 'Add a new file tools/duration.mjs that exports `parseDuration(text)`. It turns a short duration into whole milliseconds. Accepted: a non-negative decimal number, optional spaces, then one unit s, m, h or d (case-insensitive), with optional spaces around the whole string. Examples: "90s" is 90000, "1.5h" is 5400000, " 10 M " is 600000. Anything else returns null (empty string, a number with no unit, a unit with no number, a negative number, an unknown unit, two units like "5m5s", or a value that is not a string). Round to the nearest millisecond. Also add tests/duration.test.mjs with node:test covering the cases above, and make it pass. Use the style of tools/scale.mjs.',
    context: ['tools/scale.mjs'], outputs: ['tools/duration.mjs', 'tests/duration.test.mjs'],
    mutate: () => {},
    verify: { argv: [...TEST, 'tests/__hidden.test.mjs', 'tests/duration.test.mjs'], hidden: { 'tests/__hidden.test.mjs': durationHidden } },
  },
  {
    id: 'new-cost-summary', type: 'new-function',
    prompt: 'Add a new file tools/cost-summary.mjs that exports `summarizeCosts(jobs)`. `jobs` is an array of { id, agent, costUsd }. Return { totalUsd, byAgent, unknown }. totalUsd is the sum of every costUsd that is a finite number of at least 0, rounded to 6 decimal places. byAgent maps each agent name (keys in alphabetical order) to { jobs, usd }: jobs counts every job for that agent, usd sums that agent\'s valid costUsd values (also rounded to 6 places). unknown lists, in input order, the ids of jobs whose costUsd is missing, null, negative, or not finite. A costUsd of 0 is valid. If jobs is not an array, throw a TypeError. Also add tests/cost-summary.test.mjs with node:test covering these rules, and make it pass. Use the style of tools/scale.mjs.',
    context: ['tools/scale.mjs'], outputs: ['tools/cost-summary.mjs', 'tests/cost-summary.test.mjs'],
    mutate: () => {},
    verify: { argv: [...TEST, 'tests/__hidden.test.mjs', 'tests/cost-summary.test.mjs'], hidden: { 'tests/__hidden.test.mjs': costHidden } },
  },
  {
    id: 'refactor-anthropic-rates', type: 'refactor',
    prompt: 'In tools/anthropic.mjs, `worstCaseUsd` and `usageCostUsd` each repeat the logic that decides whether a prompt is long and picks the long-prompt or normal rates. Refactor so that logic exists once, in a small helper used by both. Behavior and exports must not change. Change only tools/anthropic.mjs. `node --import ./tests/_isolate-config.mjs --test tests/anthropic-lane.test.mjs` must still pass.',
    context: ['tools/anthropic.mjs', 'tests/anthropic-lane.test.mjs'], outputs: ['tools/anthropic.mjs'],
    mutate: () => {},
    verify: { argv: [...TEST, 'tests/anthropic-lane.test.mjs'], structural: { file: 'tools/anthropic.mjs', needle: 'longInput', fewerThan: 3, sameExports: true } },
  },
  {
    id: 'refactor-spend-reserve', type: 'refactor',
    prompt: 'In tools/spend.mjs, `estimateReservation` computes the lane default reservation (`laneDefaults[lane]?.reserveUsd ?? laneDefaults[lane] ?? LANE_RESERVE_DEFAULTS[lane]`) in two places. Refactor so that expression exists once, in a small helper used by both places. Behavior and exports must not change. Change only tools/spend.mjs. `node --import ./tests/_isolate-config.mjs --test tests/spend.test.mjs` must still pass.',
    context: ['tools/spend.mjs', 'tests/spend.test.mjs'], outputs: ['tools/spend.mjs'],
    mutate: () => {},
    verify: { argv: [...TEST, 'tests/spend.test.mjs'], structural: { file: 'tools/spend.mjs', needle: 'laneDefaults[lane]?.reserveUsd', fewerThan: 2, sameExports: true } },
  },
  {
    id: 'tests-model-matches', type: 'test-writing',
    prompt: 'The exported function `modelMatches` in tools/cli-adapters.mjs has no tests. Write tests/model-matches.test.mjs with node:test and node:assert/strict that cover its behavior thoroughly: non-string inputs, the short aliases, exact ids and prefixes, and near misses. Import it from ../tools/cli-adapters.mjs. Do not edit any other file. The tests must pass against the current code and should fail if the function is changed.',
    context: ['tools/cli-adapters.mjs'], outputs: ['tests/model-matches.test.mjs'],
    mutate: () => {},
    verify: { argv: [...TEST, 'tests/model-matches.test.mjs'], mutants: { file: 'tools/cli-adapters.mjs', testFile: 'tests/model-matches.test.mjs', list: [
      ['return id.includes(requested);', 'return id.startsWith(requested);'],
      ['return id === requested || id.startsWith(requested);', 'return id === requested;'],
      ["if (typeof requested !== 'string' || typeof id !== 'string') return true;", "if (typeof requested !== 'string' || typeof id !== 'string') return false;"],
      ['if (MODEL_ALIASES.includes(requested))', 'if (!MODEL_ALIASES.includes(requested))'],
    ] } },
  },
  {
    id: 'tests-npm-script', type: 'test-writing',
    prompt: 'The exported functions `npmScriptName` and `scriptIsPlainNode` in tools/swarm-env.mjs have no tests. Write tests/npm-script.test.mjs with node:test and node:assert/strict that cover their behavior thoroughly. Import them from ../tools/swarm-env.mjs. Do not edit any other file. The tests must pass against the current code and should fail if either function is changed.',
    context: ['tools/swarm-env.mjs'], outputs: ['tests/npm-script.test.mjs'],
    mutate: () => {},
    verify: { argv: [...TEST, 'tests/npm-script.test.mjs'], mutants: { file: 'tools/swarm-env.mjs', testFile: 'tests/npm-script.test.mjs', list: [
      ["if (path.basename(argv[0] ?? '') !== 'npm') return null;", "if (path.basename(argv[0] ?? '') === 'npm') return null;"],
      ["if (argv[1] === 'test') return 'test';", "if (argv[1] === 'test') return 'tests';"],
      ['/^node(\\s|$)/.test(script.trim())', '/^node/.test(script.trim())'],
      ["return typeof script === 'string' && /^node", 'return /^node'],
    ] } },
  },
  {
    id: 'docs-anthropic-lane', type: 'docs',
    prompt: 'docs/providers.md has no section for the `anthropic` lane. Add a section titled `## Anthropic API (`anthropic`)` at the end of docs/providers.md, written from tools/anthropic.mjs and tools/api-adapters.mjs. Plain, short sentences. Cover: where the key comes from and that the ambient ANTHROPIC_API_KEY is ignored, that sensitive jobs are allowed, which models run by default and what Opus needs, the three spend caps and where the ledger is, and that config can only lower the day cap. Change only docs/providers.md.',
    context: ['docs/providers.md', 'tools/anthropic.mjs', 'tools/api-adapters.mjs'], outputs: ['docs/providers.md'],
    mutate: tree => { const text = tree['docs/providers.md']; const at = text.indexOf('\n## Anthropic API (`anthropic`)'); if (at < 0) throw new Error('anthropic doc section missing in base'); tree['docs/providers.md'] = text.slice(0, at) + '\n'; },
    verify: { facts: { file: 'docs/providers.md', patterns: ['## Anthropic API', 'project-swarm', 'anthropic\\.api_key', 'ANTHROPIC_API_KEY', '(?i)sensitive', '(?i)haiku', '(?i)sonnet', '(?i)opus', '(?i)tier.{0,12}expensive', '\\$500', '\\$20', '\\$5', 'anthropic-spend\\.jsonl|ledger', '(?i)lower'] } },
  },
  {
    id: 'docs-host-failures', type: 'docs',
    prompt: 'docs/executors.md has no section on what happens when a remote host fails. Add a section titled `## Host failures` at the end of docs/executors.md, written from tools/executors.mjs. Plain, short sentences. Cover: the check of every remote host before any job is placed, what is recorded for a host that fails it, what happens to a job when ssh exits 255 or the connection is refused mid-run, that other jobs are never cancelled, what happens for a remote command that exits with another code, and what happens when no usable host is left. Change only docs/executors.md.',
    context: ['docs/executors.md', 'tools/executors.mjs'], outputs: ['docs/executors.md'],
    mutate: tree => { const text = tree['docs/executors.md']; const at = text.indexOf('\n## Host failures'); if (at < 0) throw new Error('host failures doc section missing in base'); tree['docs/executors.md'] = text.slice(0, at) + '\n'; },
    verify: { facts: { file: 'docs/executors.md', patterns: ['## Host failures', '(?i)ping', '(?i)excluded|left out|not used|skipped', '255', '(?i)placed again|re-?placed|another host|live host', '(?i)nothing else is cancelled|never cancel|not cancel', 'host-exit|any other code|one job', 'hosts-exhausted'] } },
  },
];
export { count };
