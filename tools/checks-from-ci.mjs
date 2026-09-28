// SPDX-License-Identifier: Apache-2.0
// Field lesson #177: a hand-typed `ship --check` list drifts from what a repo's CI actually runs —
// a format check CI never ran failed on files the repo had already committed unformatted, and
// ship's own (passing) hand-typed list never caught it, costing one wasted re-ship once CI ran.
// (a) `ship --checks-from-ci [path]` reads a CI workflow's own `run:` steps and keeps the ones
// that invoke a known checker/test runner as ship's own checks, so ship runs what CI runs instead
// of a hand-typed guess. (b) any hand `--check` whose program+subcommand is not among those
// CI-derived checks warns `check-not-in-ci` instead of silently drifting further.
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CI_PATH = '.github/workflows/ci.yml';
// The programs a hand-typed or CI-derived check is actually worth keeping for: build/lint/type/
// test tools this project (and most repos it ships for) invoke from CI. Anything else in a `run:`
// step (a deploy script, a curl, an echo) is not a check and is left out, not guessed at.
export const CI_CHECK_PROGRAMS = new Set(['uv', 'npm', 'npx', 'ruff', 'mypy', 'pytest', 'vitest', 'tsc', 'eslint']);

// A `run:` step's shell may chain commands with `&&`, pipe with `|`, redirect with `>`, or
// separate with `;`; a check list only ever runs one program per entry, so a line using any of
// these is reported as skipped (named, with the line itself) rather than split apart and guessed.
const SHELL_OPERATOR_RE = /&&|\|\||[|>;]|`|\$\(/;

// A small, documented line-based reader of a workflow's `run:` steps — this repo has no YAML
// dependency to reuse for this, and a `run:` step is simple enough (a one-line scalar, or a `|`/`>`
// block) not to need one. Anything not shaped like one of those two forms is left alone: this is a
// reader of `run:` steps, not a general YAML parser.
export function extractRunLines(yamlText) {
  const lines = String(yamlText ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A workflow's steps are a YAML list; a step's first key commonly sits right after its own
    // "- " marker ("      - run: ..."), so that marker (and its own extra indent) is stripped
    // before matching "run:" itself. The block form ("run: |" / "run: >") is checked first: its
    // own line ends in just the block indicator, which would otherwise also match the scalar form
    // with "|"/">" as a (wrong) one-line value.
    const block = /^(\s*)(?:-\s+)?run:\s*[|>][+-]?\s*$/.exec(line);
    if (block) {
      const parentIndent = block[1].length;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const bodyLine = lines[j];
        if (bodyLine.trim() === '') continue;
        const indent = bodyLine.match(/^(\s*)/)[1].length;
        if (indent <= parentIndent) break;
        out.push(bodyLine.trim());
      }
      i = j - 1;
      continue;
    }
    const scalar = /^(\s*)(?:-\s+)?run:\s*(.+)$/.exec(line);
    if (scalar) {
      const value = scalar[2].trim();
      const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
      out.push(quoted ? quoted[2] : value);
    }
  }
  return out.filter(Boolean);
}

// A minimal argv splitter for the simple, single-command lines a `run:` step's checks actually
// use ("uv run pytest", "npm run lint -- --max-warnings 0"): whitespace-separated, with single or
// double quotes grouping one token. Not a full shell parser — lines with shell operators never
// reach this (SHELL_OPERATOR_RE catches them first).
export function splitArgv(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(line))) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

export function ciChecksFromWorkflowText(yamlText) {
  const checks = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of extractRunLines(yamlText)) {
    if (SHELL_OPERATOR_RE.test(raw)) { skipped.push({ raw, reason: 'shell-operator' }); continue; }
    const argv = splitArgv(raw);
    if (!argv.length) continue;
    const program = path.basename(argv[0]);
    if (!CI_CHECK_PROGRAMS.has(program)) continue;
    const key = JSON.stringify(argv);
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push({ name: `ci-${checks.length + 1}-${program}`, argv, raw });
  }
  return { checks, skipped };
}

// Reads and parses the CI workflow at ciPath (default .github/workflows/ci.yml) relative to root.
// A missing file is not an error: it just means ship has nothing to compare against or derive
// checks from, reported via `missing` so a caller can warn instead of guessing at its contents.
export async function loadChecksFromCi(root, ciPath = DEFAULT_CI_PATH, { readFile = fs.readFile } = {}) {
  let text;
  try { text = await readFile(path.join(root, ciPath), 'utf8'); }
  catch { return { checks: [], skipped: [], missing: true, path: ciPath }; }
  return { ...ciChecksFromWorkflowText(text), missing: false, path: ciPath };
}

// A hand check's "program + subcommand" (e.g. `uv run pytest ...` -> `uv run`) is the part CI
// drift actually breaks; trailing arguments (paths, flags) commonly differ between a hand-typed
// list and CI's own invocation of the same underlying command without anything real having drifted.
function programAndSubcommand(argv) {
  const program = path.basename(argv?.[0] ?? '');
  const sub = argv?.[1] && !argv[1].startsWith('-') ? argv[1] : null;
  return sub ? `${program} ${sub}` : program;
}

export function checkNotInCiWarnings(handChecks, ciChecks) {
  const known = new Set((ciChecks ?? []).map(check => programAndSubcommand(check.argv)));
  return (handChecks ?? [])
    .filter(check => !known.has(programAndSubcommand(check.argv)))
    .map(check => `check-not-in-ci: ${check.name} (${programAndSubcommand(check.argv)})`);
}
