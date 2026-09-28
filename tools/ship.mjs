// SPDX-License-Identifier: Apache-2.0
// Ships a reviewed run's integrated tree: push the branch, open or update a PR, wait for CI,
// and merge when everything is green and nobody has asked for a human to look first. No shell:
// git and gh are invoked through the injected `exec` with an argv array.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packagingChangeWarnings } from './packaging-check.mjs';

export const SHIP_DEFAULTS = Object.freeze({ pollMs: 20_000, timeoutMs: 45 * 60_000, noCiGraceMs: 5 * 60_000, mergeMethod: 'squash' });
export const CHECKS_PLACEHOLDER = '<!-- swarm:checks -->';
export const SWARM_MARKER_RE = /<!-- swarm:[a-z0-9_-]+ -->/g;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const REQUIRED_PAYLOAD_FIELDS = ['title', 'head', 'base', 'body'];
const ALLOWED_EXTRA_PAYLOAD_FIELDS = new Set(['draft', 'maintainer_can_modify']);
const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);
const VALID_MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

// Field lesson 147: a version bump's outputs include the lockfile that records the project's own
// version; a stale lockfile fails CI at `uv sync --locked`/`npm ci` long after ship already
// pushed. The manifest file a run touched picks which project lock check to run before pushing.
const LOCK_CHECKS = [
  { name: 'npm-lock-check', triggers: new Set(['package.json', 'package-lock.json']), argv: ['npm', 'ci', '--dry-run'] },
  { name: 'uv-lock-check', triggers: new Set(['pyproject.toml', 'uv.lock']), argv: ['uv', 'lock', '--check'] },
];
// Field lesson #172: `uv lock --check` used to spawn a bare `uv`, which is not on PATH when `uv`
// lives only in the swarm's own toolchains dir (SWARM_TOOLCHAINS, else ~/.project-swarm/toolchains)
// — the same place every other toolchain binary is expected. A spawn failure there used to surface
// as `uv-lock-check failed: ` with an empty reason (the exec wrapper never runs, so there is no
// stderr to report); `uv` is now resolved the same way first (toolchains dir, then PATH), and a
// lock check that cannot even start says so, naming every path it tried.
function toolchainsDirFor(env, home) {
  return env.SWARM_TOOLCHAINS || path.join(home, '.project-swarm/toolchains');
}
// Field lesson #175: the identical "not on PATH" problem hits any bare check argv[0]
// (`ship --check '["uv",...]'` run from a shell without the toolchains dir on PATH), not only
// `uv lock --check`; this is the one resolver both use — toolchains dir, then its own bin/, then
// every PATH entry — so a program that cannot be found anywhere is named with every path tried.
// Field lesson #181: a toolchain package directory can share its binary's own name (real case:
// ~/.project-swarm/toolchains/uv is the pip package directory; the real binary sits one level
// down at toolchains/bin/uv). `fs.access(X_OK)` alone passes on a directory too — every directory
// has its own search/execute bit — so that package directory used to get picked over the real
// binary, and every spawn of "it" then failed before it ever started. The default check now also
// requires `fs.stat` to say "regular file" (following a symlink) before a candidate counts; a
// caller-injected `access` (tests, alternate resolution) fully replaces this default and is
// trusted as-is, same as before.
async function accessExecutableFile(file) {
  const info = await fs.stat(file);
  if (!info.isFile()) throw Object.assign(new Error(`not a regular file: ${file}`), { code: 'EISDIR' });
  await fs.access(file, fs.constants.X_OK);
}

export async function resolveToolchainBin(prog, { env = process.env, home = os.homedir(), access = accessExecutableFile } = {}) {
  const dir = toolchainsDirFor(env, home);
  const pathDirs = String(env.PATH ?? '').split(':').filter(Boolean);
  const tried = [path.join(dir, prog), path.join(dir, 'bin', prog), ...pathDirs.map(entry => path.join(entry, prog))];
  for (const candidate of tried) {
    try { await access(candidate); return { path: candidate, tried }; } catch { /* try the next candidate */ }
  }
  return { path: null, tried };
}
export async function resolveUv(options = {}) {
  return resolveToolchainBin('uv', options);
}
export function selectLockCheck(files) {
  const basenames = new Set((files ?? []).map(file => path.basename(file)));
  for (const candidate of LOCK_CHECKS) {
    for (const trigger of candidate.triggers) if (basenames.has(trigger)) return { name: candidate.name, argv: candidate.argv };
  }
  return null;
}

// Field lesson 150: a plain push only ever fails this way when the remote branch moved out from
// under us (a squash-amend of our own PR, or someone else's push); other push failures (auth,
// permissions, branch protection) keep their existing plain "push failed" reason untouched below.
const NON_FAST_FORWARD_RE = /\[rejected\]|non-fast-forward|failed to push some refs|stale info/i;

// Field lesson 150: --force-with-lease is only safe when nobody else's commit sits on the branch
// we're about to overwrite; the GitHub login of the remote tip (not just a local git identity)
// is what actually answers "did someone else move this head".
async function resolveLeasePush(exec, root, repo, branch) {
  const remoteRes = await exec('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd: root });
  const remoteSha = remoteRes.code === 0 ? remoteRes.stdout.trim().split(/\s+/)[0] : null;
  if (!remoteSha) return null;
  const meRes = await exec('gh', ['api', 'user', '--jq', '.login'], { cwd: root });
  const me = meRes.code === 0 ? meRes.stdout.trim() : null;
  const authorRes = await exec('gh', ['api', `repos/${repo}/commits/${remoteSha}`, '--jq', '.author.login'], { cwd: root });
  const remoteAuthor = authorRes.code === 0 ? authorRes.stdout.trim() : null;
  if (!me || remoteAuthor !== me) return { ok: false, remoteSha, remoteAuthor, me };
  return { ok: true, remoteSha, me };
}

// Field lesson 151: a CI matrix name embeds its OS ("test (ubuntu-latest, 20.x)"); a failure only
// on some of the OS entries present is a platform difference, not a real red build, and is worth
// naming up front instead of leaving it to be rediscovered by hand.
const OS_TOKEN_RE = /\b(ubuntu-latest|ubuntu|windows-latest|windows|macos-latest|macos)\b/i;
function extractOs(name) {
  const match = OS_TOKEN_RE.exec(name);
  return match ? match[1].toLowerCase().replace(/-latest$/, '') : null;
}
export function platformOnlyFailures(rollup) {
  const items = Array.isArray(rollup) ? rollup : [];
  const oses = new Set();
  const failedByOs = new Map();
  for (const item of items) {
    const name = item.name ?? item.context ?? 'unknown';
    const os = extractOs(name);
    if (!os) continue;
    oses.add(os);
    const isPending = 'state' in item ? PENDING_STATES.has(item.state) : item.status !== 'COMPLETED';
    if (isPending) continue;
    const passed = 'state' in item ? item.state === 'SUCCESS' : PASSING_CONCLUSIONS.has(item.conclusion);
    if (!passed) {
      if (!failedByOs.has(os)) failedByOs.set(os, []);
      failedByOs.get(os).push(name);
    }
  }
  const failedOses = [...failedByOs.keys()];
  if (oses.size < 2 || failedOses.length === 0 || failedOses.length === oses.size) return [];
  return failedOses.map(os => ({ os, testIds: failedByOs.get(os) }));
}

// Field lesson 154/156: a test file that shells out to a host tool needs either a documented
// binary, or a fake/skip seam nearby; one that reads a swarm-exported env var (SWARM_PORT_BASE)
// needs a stub or unset hint instead of silently depending on the swarm runner's own port block.
const TEST_FILE_RE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$/i;
// Field lesson #179: `ps` is a documented POSIX binary (macOS/Linux); a test that spawns it on
// Windows still needs its own fake/skip seam or a `--exempt` — this allowlist never claims `ps`
// is available there.
export const DOCUMENTED_TEST_BINARIES = new Set(['node', 'npm', 'npx', 'git', 'gh', 'ps']);
const SPAWN_CALL_RE = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"]([^'"]+)['"]/g;
function seamNearby(text, index) {
  return /\b(skip|fake|stub)\b/i.test(text.slice(Math.max(0, index - 300), index + 300));
}
export function undocumentedBinaryWarnings(fileTexts) {
  const warnings = [];
  for (const [file, text] of fileTexts) {
    const seen = new Set();
    for (const match of text.matchAll(SPAWN_CALL_RE)) {
      const bin = path.basename(match[1].split(/\s+/)[0]);
      if (DOCUMENTED_TEST_BINARIES.has(bin) || seen.has(bin) || seamNearby(text, match.index)) continue;
      seen.add(bin);
      warnings.push({ file, bin });
    }
  }
  return warnings;
}

const SWARM_EXPORTED_ENV_VARS = ['SWARM_PORT_BASE'];
export function swarmEnvInTestWarnings(fileTexts) {
  const warnings = [];
  for (const [file, text] of fileTexts) {
    for (const name of SWARM_EXPORTED_ENV_VARS) if (text.includes(name)) warnings.push({ file, name });
  }
  return warnings;
}

// Field lesson #179: the guard used to scan a test file's whole, current content, so a `ps` call
// already on the base (untouched by this diff) refused a branch that only touched the file for an
// unrelated reason. It now judges only the lines this change ADDS to each test file: with a real
// base commit, `git diff <base>...HEAD -U0 -- <file>` and keep just the `+` lines (never the
// `+++ b/<file>` header). With no usable base (the merge-base lookup fails, or the diff call
// itself fails/errors — exactly the shape of every test written for the old whole-file scan, none
// of which sets up a real base commit) this falls back to the file's current whole-file content,
// so nothing already covered regresses just because a base could not be established. The
// merge-base lookup itself only runs when there is at least one test file to judge, so a ship with
// no integrated test files never pays for it.
async function readAddedTestFileLines(exec, root, payloadBase, integratedFiles) {
  const candidates = (integratedFiles ?? []).filter(file => TEST_FILE_RE.test(file));
  const files = new Map();
  if (!candidates.length) return files;
  let baseSha = null;
  try {
    const baseRes = await exec('git', ['merge-base', `origin/${payloadBase}`, 'HEAD'], { cwd: root });
    baseSha = baseRes && baseRes.code === 0 ? baseRes.stdout.trim() : null;
  } catch { baseSha = null; }
  for (const file of candidates) {
    let text = null;
    if (baseSha) {
      try {
        const res = await exec('git', ['diff', `${baseSha}...HEAD`, '-U0', '--', file], { cwd: root });
        if (res && res.code === 0) {
          text = res.stdout
            .split('\n')
            .filter(line => line.startsWith('+') && !line.startsWith('+++'))
            .map(line => line.slice(1))
            .join('\n');
        }
      } catch { /* fall back to a whole-file read below */ }
    }
    if (text === null) {
      try { text = await fs.readFile(path.join(root, file), 'utf8'); } catch { continue; /* removed or unreadable: nothing to scan */ }
    }
    files.set(file, text);
  }
  return files;
}

// Field lesson #179: `--exempt <guard>:<file>=<reason>` — an owner decision, so the reason is
// required and must say something real (trimmed, >= 10 characters). Give each diff guard a stable
// id so an exemption names exactly which one it excuses.
export const EXEMPTION_GUARD_IDS = ['undocumented-binary', 'env-var'];

export function parseExemptFlag(value) {
  const raw = String(value ?? '');
  const colon = raw.indexOf(':');
  const eq = colon === -1 ? -1 : raw.indexOf('=', colon + 1);
  if (colon === -1 || eq === -1) return { error: '--exempt requires <guard>:<file>=<reason>' };
  const guard = raw.slice(0, colon);
  const file = raw.slice(colon + 1, eq);
  const reason = raw.slice(eq + 1).trim();
  if (!EXEMPTION_GUARD_IDS.includes(guard)) {
    return { error: `--exempt: unknown guard "${guard}"; valid guard ids: ${EXEMPTION_GUARD_IDS.join(', ')}` };
  }
  if (!file) return { error: '--exempt requires <guard>:<file>=<reason>' };
  if (reason.length < 10) return { error: 'exemption-needs-reason: --exempt reason must be at least 10 characters' };
  return { guard, file, reason };
}

// Field lesson #179: a used exemption must never be missing from the shipped PR body — appended
// to an existing "## Exemptions" section (matched the same boundary-prefix way as
// --require-section) when the payload body already has one, or created fresh at the end otherwise.
export function appendExemptionsSection(body, usedExemptions) {
  if (!usedExemptions?.length) return body;
  const lines = usedExemptions.map(exemption => `- ${exemption.guard} · ${exemption.file} — ${exemption.reason}`);
  const bodyLines = String(body ?? '').split('\n');
  const headingIndex = bodyLines.findIndex(line => line.startsWith('## ') && headingMatchesName(line.slice(3).trim(), 'Exemptions'));
  if (headingIndex === -1) {
    const separator = bodyLines.length && bodyLines[bodyLines.length - 1].trim() !== '' ? '\n\n' : '\n';
    return `${body}${separator}## Exemptions\n${lines.join('\n')}\n`;
  }
  let end = bodyLines.length;
  for (let index = headingIndex + 1; index < bodyLines.length; index++) {
    if (bodyLines[index].startsWith('## ')) { end = index; break; }
  }
  return [...bodyLines.slice(0, end), ...lines, ...bodyLines.slice(end)].join('\n');
}

// Field lesson #179: one JSON line per used exemption, appended (never overwritten), so which
// guard was excused on which file — and why — stays auditable across ships. Same
// env-override-else-home-dir shape as every other toolchain/install path in this file
// (SWARM_TOOLCHAINS), so tests can point it at a temp dir instead of the real home directory.
function installLogsDirFor(env, home) {
  return env.SWARM_LOGS_DIR || path.join(home, '.project-swarm/logs');
}

export async function logExemption(entry, { env = process.env, home = os.homedir() } = {}) {
  const dir = installLogsDirFor(env, home);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'ship-exemptions.jsonl');
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return file;
}

function firstStderrLine(stderr) {
  const line = String(stderr ?? '').split('\n')[0] ?? '';
  return line.slice(0, 200);
}

function stepFailed(step, res, originRepo) {
  const output = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  return `${step} failed: ${firstStderrLine(res.stderr || res.stdout)}` +
    (originRepo && /HTTP 30[1278]\b/.test(output) ? ` (repo moved? origin is ${originRepo})` : '');
}

// Unlike stepFailed (which falls back to stdout so a non-gh, non-git step still shows something
// useful), a PR list failure always names its stderr, or the literal "(empty)" when there is none,
// so a JSON-parse failure never gets confused with the raw stdout it failed to parse.
function prListFailedReason(res, originRepo) {
  const output = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  const stderr = firstStderrLine(res.stderr);
  return `pr list failed: ${stderr || '(empty)'}` +
    (originRepo && /HTTP 30[1278]\b/.test(output) ? ` (repo moved? origin is ${originRepo})` : '');
}

// Resolve gh/git before doing any real work: a missing binary should refuse at once with a plain
// "<bin> not found on PATH", not surface as a confusing failure partway through a check or push.
// Not called automatically by ship() itself (which never issues exec calls beyond its documented
// sequence); callers that want this preflight run it first and refuse before calling ship().
export async function resolveGhAndGit(exec) {
  for (const bin of ['git', 'gh']) {
    let res;
    try {
      res = await exec(bin, ['--version']);
    } catch (err) {
      return { ok: false, bin, reason: err?.message || `${bin} not found on PATH` };
    }
    if (!res || res.code !== 0) {
      const detail = firstStderrLine(res?.stderr || res?.stdout);
      return { ok: false, bin, reason: detail || `${bin} not found on PATH` };
    }
  }
  return { ok: true };
}

function githubRepo(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/.exec(url);
  const repo = match?.[1].replace(/\.git$/, '');
  return repo && REPO_RE.test(repo) ? repo : null;
}

async function releaseVersion(exec, root, branch) {
  const ancestor = await exec('git', ['merge-base', `origin/${branch}`, 'HEAD'], { cwd: root });
  if (ancestor.code !== 0 || !ancestor.stdout.trim()) return null;
  const before = await exec('git', ['show', `${ancestor.stdout.trim()}:package.json`], { cwd: root });
  const after = await exec('git', ['show', 'HEAD:package.json'], { cwd: root });
  try {
    const version = JSON.parse(after.stdout).version;
    const oldVersion = before.code === 0 ? JSON.parse(before.stdout).version : null;
    return after.code === 0 && typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) && version !== oldVersion ? version : null;
  } catch { return null; }
}

// Field lesson #174: `ship --require-section 'Mutation check'` used to refuse a PR body whose
// heading was `## Mutation check (mutant -> killing test)` — a real section, just with more text
// in the heading than the required name. A required section now matches `## <name>` followed by
// end of line, a space, or `(` — a prefix match on a word boundary, so `## Mutation checks` (a
// different word, not a boundary character) still does not match `Mutation check`.
function headingMatchesName(title, name) {
  const normalizedTitle = title.toLowerCase();
  const normalizedName = name.toLowerCase();
  if (!normalizedTitle.startsWith(normalizedName)) return false;
  const boundary = normalizedTitle.charAt(normalizedName.length);
  return boundary === '' || boundary === ' ' || boundary === '(';
}

function getMarkerForSection(body, sectionName) {
  const lines = String(body ?? '').split('\n');
  const at = lines.findIndex(line => line.startsWith('## ') && headingMatchesName(line.slice(3).trim(), sectionName));
  if (at === -1) return null;
  const nextHeading = lines.slice(at + 1).findIndex(line => line.startsWith('## '));
  const end = nextHeading === -1 ? lines.length : at + 1 + nextHeading;
  const content = lines.slice(at + 1, end).join('\n');
  const matches = content.match(SWARM_MARKER_RE);
  if (!matches) return null;
  const markerMatch = matches[0].match(/swarm:([a-z0-9_-]+)/);
  return markerMatch ? markerMatch[1] : null;
}

// Field lesson #174: when a required section really is missing, name the nearest heading actually
// present (the one with the longest matching prefix against the required name) instead of refusing
// silently — a near-miss heading (a typo, an extra word before the boundary) is the most common
// real cause, and pointing at it saves a guess.
function nearestHeading(body, name) {
  const headings = String(body ?? '').split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3).trim());
  if (!headings.length) return null;
  const normalizedName = name.toLowerCase();
  let best = headings[0];
  let bestScore = -1;
  for (const title of headings) {
    const normalizedTitle = title.toLowerCase();
    let score = 0;
    while (score < normalizedTitle.length && score < normalizedName.length && normalizedTitle[score] === normalizedName[score]) score++;
    if (score > bestScore) { bestScore = score; best = title; }
  }
  return best;
}

export function parsePrPayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid PR payload JSON: ${err.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('PR payload must be a JSON object');
  for (const key of Object.keys(data)) {
    if (!REQUIRED_PAYLOAD_FIELDS.includes(key) && !ALLOWED_EXTRA_PAYLOAD_FIELDS.has(key)) throw new Error(`Unexpected field in PR payload: ${key}`);
  }
  for (const key of REQUIRED_PAYLOAD_FIELDS) {
    if (typeof data[key] !== 'string' || data[key].trim() === '') throw new Error(`Missing or blank PR payload field: ${key}`);
  }
  return { title: data.title, head: data.head, base: data.base, body: data.body };
}

export function isHeld(body) {
  for (const line of String(body ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    return trimmed.startsWith('**needs ');
  }
  return false;
}

export function missingSections(body, names) {
  const lines = String(body ?? '').split('\n');
  const headings = [];
  lines.forEach((line, index) => {
    if (line.startsWith('## ')) headings.push({ index, title: line.slice(3).trim() });
  });
  const missing = [];
  for (const name of names) {
    const at = headings.findIndex(heading => headingMatchesName(heading.title, name));
    if (at === -1) { missing.push(name); continue; }
    const end = at + 1 < headings.length ? headings[at + 1].index : lines.length;
    const content = lines.slice(headings[at].index + 1, end).join('\n');
    const withoutMarkers = content.replace(SWARM_MARKER_RE, '').trim();
    const markerMatches = content.match(SWARM_MARKER_RE);
    if (withoutMarkers === '' || markerMatches) missing.push(name);
  }
  return missing;
}

const INTEGRATED_PLACEHOLDER_RE = /^\{integrated(?::(\.[^}]+))?\}$/;
const NEW_PLACEHOLDER_RE = /^\{new(?::[^}]+)?\}$/;

// A reduced, ship-local copy of swarm.mjs's own check-argv expansion (kept separate rather than
// imported: swarm.mjs already imports from ship.mjs, and importing back would be circular). Only
// {root} and {integrated[:.ext]} are supported here; a check using {new[:.ext]} is left
// unverified (ship() is never given the run's "new files" set) rather than guessed at.
function expandArgvForRoot(argv, integratedFiles, root) {
  const expanded = [];
  for (const item of argv) {
    if (NEW_PLACEHOLDER_RE.test(item)) return null;
    const match = INTEGRATED_PLACEHOLDER_RE.exec(item);
    if (match) {
      const ext = match[1];
      const files = ext ? integratedFiles.filter(file => file.endsWith(ext)) : integratedFiles;
      if (!files.length) return null;
      expanded.push(...files);
      continue;
    }
    expanded.push(item.split('{root}').join(root));
  }
  return expanded;
}

// Field lesson #177(c): a check that already fails on the base commit's own tree (e.g. CI running
// a formatter check it never enforced before, so files were already unformatted) proves nothing
// about what this change broke, and blocking the ship on it just costs a wasted re-ship once the
// same failure is rediscovered by hand. Re-runs the check once against that tree — a throwaway
// `git worktree`, always cleaned up — through the same injected `exec` ship already uses for every
// other command, so this is exercised the same way in tests as the rest of ship().
export async function verifyPreExistingOnBase({ root, argv, integratedFiles, baseSha, exec }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-preexisting-'));
  const checkout = path.join(temporary, 'base');
  let added = false;
  try {
    const addRes = await exec('git', ['worktree', 'add', '--detach', checkout, baseSha], { cwd: root });
    if (addRes.code !== 0) return { checked: false };
    added = true;
    const expanded = expandArgvForRoot(argv, integratedFiles, checkout);
    if (!expanded || !expanded.length) return { checked: false };
    const result = await exec(expanded[0], expanded.slice(1), { cwd: checkout });
    return { checked: true, alsoFails: result.code !== 0 };
  } catch {
    return { checked: false };
  } finally {
    if (added) { try { await exec('git', ['worktree', 'remove', '--force', checkout], { cwd: root }); } catch { /* best-effort cleanup */ } }
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

// Field lesson #178: a `ci-failed` CI run whose failing tests are not in this ship's own diff (a
// flaky test elsewhere — Windows timing, say) is worth one automatic rerun before it blocks the
// ship; pytest's own failure line and vitest's own summary line each name the file plainly enough
// to check that without parsing full test output structure. A failing test that IS in the diff is
// never rerun this way — that is a real regression, not flake, and reruns cannot fix it.
export function extractFailingTestFiles(text) {
  const files = new Set();
  const source = String(text ?? '');
  for (const re of [/^FAILED\s+([^\s:]+)::/gm, /^\s*(?:✗\s*)?FAIL\s+(\S+)/gm]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) files.add(match[1]);
  }
  return [...files];
}

function runIdFromDetailsUrl(url) {
  const match = /\/actions\/runs\/(\d+)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

// The run ids behind the checks in `failedNames`, deduplicated — several failed check names can
// come from jobs in the same workflow run, and `gh run rerun` reruns a whole run's failed jobs.
export function failedRunIds(rollup, failedNames) {
  const items = Array.isArray(rollup) ? rollup : [];
  const wanted = new Set(failedNames);
  const ids = new Set();
  for (const item of items) {
    const name = item.name ?? item.context ?? 'unknown';
    if (!wanted.has(name)) continue;
    const id = runIdFromDetailsUrl(item.detailsUrl ?? item.target_url);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function renderChecks(results) {
  const lines = [];
  for (const result of results) {
    let line = `${result.name} -> ${result.status}`;
    if (result.status === 'failed' && result.exitCode != null) line += ` (exit ${result.exitCode})`;
    if (result.flakeOnBase) line += ` — flake on base: ${result.flakeOnBase.failed}/${result.flakeOnBase.runs} (${result.flakeOnBase.file})`;
    lines.push(line);
    if (result.status === 'failed' && result.tail) lines.push(...String(result.tail).split('\n').slice(-20));
  }
  return ['```', ...lines, '```'].join('\n');
}

export function fillChecks(body, results) {
  const text = String(body ?? '');
  if (!text.includes(CHECKS_PLACEHOLDER)) return text;
  return text.split(CHECKS_PLACEHOLDER).join(renderChecks(results));
}

export function summarizeRollup(rollup) {
  const items = Array.isArray(rollup) ? rollup : [];
  let pending = 0;
  let passed = 0;
  const failed = [];
  for (const item of items) {
    const name = item.name ?? item.context ?? 'unknown';
    if ('state' in item) {
      if (item.state === 'SUCCESS') passed += 1;
      else if (PENDING_STATES.has(item.state)) pending += 1;
      else failed.push(name);
    } else {
      if (item.status !== 'COMPLETED') { pending += 1; continue; }
      if (PASSING_CONCLUSIONS.has(item.conclusion)) passed += 1;
      else failed.push(name);
    }
  }
  return { total: items.length, pending, failed, passed };
}

export async function ship(options) {
  const {
    root, payloadPath,
    requireSections = [],
    merge = true,
    mergeMethod = SHIP_DEFAULTS.mergeMethod,
    pollMs = SHIP_DEFAULTS.pollMs,
    timeoutMs = SHIP_DEFAULTS.timeoutMs,
    noCiGraceMs = SHIP_DEFAULTS.noCiGraceMs,
    tagTimeoutMs = 180_000, manifest,
    mutantsSkippedRedBase = false,
    portBase = null, portWarnings = [],
    integratedFiles = [],
    packagingChanges = [], checkArgvs = [], extraWarnings = [],
    rerunFlaky = 0,
    exemptions = [],
    runChecks, exec, sleep, now = () => Date.now(),
    env = process.env,
    home = os.homedir(),
    resolveUv: resolveUvImpl = resolveUv,
  } = options;

  let repo = options.repo;
  const base = { warnings: [...portWarnings, ...extraWarnings], tag: { name: null, status: 'skipped', waitedSeconds: 0 }, status: null, repo, pr: null, url: null, sha: null, mergeSha: null, checks: null, ci: null, reason: null, portBase };

  if (!VALID_MERGE_METHODS.has(mergeMethod)) return { ...base, status: 'refused', reason: 'invalid merge method' };
  for (const [name, value] of [['pollMs', pollMs], ['timeoutMs', timeoutMs], ['noCiGraceMs', noCiGraceMs]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { ...base, status: 'refused', reason: `invalid ${name}` };
  }

  let payload;
  try {
    payload = parsePrPayload(await fs.readFile(payloadPath, 'utf8'));
  } catch (err) {
    return { ...base, status: 'refused', reason: err.message };
  }
  if (repo !== undefined && !REPO_RE.test(repo)) return { ...base, status: 'refused', reason: 'invalid repo' };
  if (!HEAD_RE.test(payload.head) || payload.head.startsWith('-')) return { ...base, status: 'refused', reason: 'invalid head' };

  if (!Number.isFinite(tagTimeoutMs) || tagTimeoutMs < 0) return { ...base, status: 'refused', reason: 'invalid tagTimeoutMs' };
  const origin = await exec('git', ['remote', 'get-url', 'origin'], { cwd: root });
  const originUrl = origin.stdout.trim();
  const originRepo = githubRepo(originUrl);
  if (!repo) {
    if (!originRepo) return { ...base, status: 'refused', reason: `cannot derive --repo from origin ${originUrl}; pass --repo OWNER/NAME` };
    repo = originRepo;
    base.repo = repo;
  } else if (originRepo && repo !== originRepo) base.warnings.push(`--repo ${repo} differs from origin ${originRepo}`);
  if (manifest && requireSections.some(name => name.toLowerCase() === 'mutation check') && !manifest.mutants?.length && !manifest.jobs?.some(job => job.mutants?.length)) {
    base.warnings.push('no manifest mutants: declare "mutants" in the manifest and run "integrate --mutants" (see docs/verification.md)');
  }
  // Field lesson 123: a red base's mutants proved nothing (every mutant is forced to
  // skipped-red-base); a required "Mutation check" section cannot be honestly filled from that,
  // so ship refuses before pushing or opening a PR instead of shipping an empty/misleading section.
  if (mutantsSkippedRedBase && requireSections.some(name => name.toLowerCase() === 'mutation check')) {
    return { ...base, status: 'refused', reason: 'mutants skipped: red base (checks failed); required Mutation check section cannot be satisfied' };
  }
  const statusRes = await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root });
  if (statusRes.code !== 0) return { ...base, status: 'refused', reason: 'git status failed' };
  if (statusRes.stdout.trim() !== '') return { ...base, status: 'refused', reason: 'commit first' };
  const shaRes = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (shaRes.code !== 0 || shaRes.stdout.trim() === '') return { ...base, status: 'refused', reason: stepFailed('rev-parse', shaRes) };
  const sha = shaRes.stdout.trim();
  base.sha = sha;

  // Field lesson 154/156/179: a static gate over the lines this change ADDS to its own test files,
  // before any check spawns them for real; an undocumented binary with no fake/skip seam refuses
  // outright, while a swarm-exported env var reference is only a warning (the test may already
  // handle it). A `--exempt <guard>:<file>=<reason>` (owner decision, required) excuses one file
  // from one guard; it never excuses other files or other guards. Only looks up a base commit
  // (another exec call) when there is at least one test file to judge, so a ship with no test
  // files integrated never pays for a merge-base lookup it has nothing to use.
  const integratedTestFiles = await readAddedTestFileLines(exec, root, payload.base, integratedFiles);
  const rawUndocumentedBinaries = undocumentedBinaryWarnings(integratedTestFiles);
  const rawEnvWarnings = swarmEnvInTestWarnings(integratedTestFiles);
  const usedExemptions = [];
  const findExemption = (guard, file) => exemptions.find(exemption => exemption.guard === guard && exemption.file === file);
  const noteExemptionUsed = exemption => {
    if (!usedExemptions.some(used => used.guard === exemption.guard && used.file === exemption.file)) usedExemptions.push(exemption);
  };

  const undocumentedBinaries = [];
  for (const warning of rawUndocumentedBinaries) {
    const exemption = findExemption('undocumented-binary', warning.file);
    if (exemption) { noteExemptionUsed(exemption); continue; }
    undocumentedBinaries.push(warning);
  }
  for (const warning of rawEnvWarnings) {
    const exemption = findExemption('env-var', warning.file);
    if (exemption) { noteExemptionUsed(exemption); continue; }
    base.warnings.push(`swarm-env-in-tests: ${warning.file}: references ${warning.name}; stub or unset it in this test (lesson #156)`);
  }
  for (const exemption of exemptions) {
    if (!usedExemptions.some(used => used.guard === exemption.guard && used.file === exemption.file)) {
      base.warnings.push(`unused-exemption: ${exemption.guard}:${exemption.file}`);
    }
  }
  // Field lesson #179: a used exemption is recorded (result field, log, later the PR body) as soon
  // as it is determined to be used — even when ship refuses anyway, for an unrelated file or an
  // unrelated reason, so a legitimately-excused file is never left off the record just because
  // something else also went wrong in the same ship.
  if (usedExemptions.length) {
    base.exemptions = usedExemptions;
    for (const exemption of usedExemptions) {
      await logExemption({ ts: new Date().toISOString(), repo, branch: payload.head, guard: exemption.guard, file: exemption.file, reason: exemption.reason }, { env, home });
    }
  }
  if (undocumentedBinaries.length) {
    return {
      ...base, status: 'refused',
      reason: `test file spawns undocumented binary with no fake/skip seam: ${undocumentedBinaries.map(w => `${w.file} -> ${w.bin}`).join(', ')}; fix the cause, or pass --exempt <guard>:<file>=<reason>`,
    };
  }

  // Field lesson #159: a shipped change to packaging keys needs a check that builds the package;
  // tests, lint and types all pass on a package that will not build.
  const packagingRefusals = packagingChangeWarnings(packagingChanges, checkArgvs);
  if (packagingRefusals.length) return { ...base, status: 'refused', reason: `${packagingRefusals.join('; ')}; add a check that builds the package (uv build --wheel, npm pack --dry-run)` };

  const checks = await runChecks();
  base.checks = checks;

  // Field lesson #177(c): before blocking on any failing check, verify it against the base
  // commit's own tree; one that fails there too is reported `pre-existing` (still listed, no
  // longer blocking) instead of costing a re-ship for something this change did not cause.
  if (checks.some(result => result.status === 'failed') && checkArgvs.length) {
    const argvForCheck = checkArgvs.slice(0, checks.length);
    const baseRes = await exec('git', ['merge-base', `origin/${payload.base}`, 'HEAD'], { cwd: root });
    const baseSha = baseRes.code === 0 ? baseRes.stdout.trim() : null;
    if (baseSha) {
      for (let index = 0; index < checks.length; index++) {
        if (checks[index].status !== 'failed') continue;
        const argv = argvForCheck[index];
        if (!argv) continue;
        const verified = await verifyPreExistingOnBase({ root, argv, integratedFiles, baseSha, exec });
        if (verified.checked && verified.alsoFails) checks[index] = { ...checks[index], status: 'pre-existing', preExisting: true };
      }
    }
  }

  let body = fillChecks(payload.body, checks);
  if (usedExemptions.length) body = appendExemptionsSection(body, usedExemptions);
  if (checks.some(result => result.status === 'failed')) return { ...base, status: 'checks-failed', reason: 'checks failed' };

  const missing = missingSections(body, requireSections);
  if (missing.length > 0) {
    const reasons = missing.map(section => {
      const marker = getMarkerForSection(body, section);
      if (marker) return `${section} (leftover: ${marker})`;
      const nearest = nearestHeading(body, section);
      return nearest ? `${section} (nearest heading: "${nearest}")` : section;
    });
    return { ...base, status: 'refused', reason: `missing sections: ${reasons.join(', ')}` };
  }

  // Field lesson 147: a run's outputs that touch a dependency manifest may leave its lockfile
  // stale; the matching project lock check runs once, right before push, so a bad lockfile never
  // reaches CI as a surprise.
  if (integratedFiles.length) {
    const lockCheck = selectLockCheck(integratedFiles);
    if (lockCheck) {
      // Field lesson #172: `uv` (unlike `npm`) is not reliably on a bare PATH; resolve it like
      // every other toolchain binary before ever spawning it, and refuse at once, naming every
      // path tried, when it cannot be found — instead of a spawn failure with an empty reason.
      let lockArgv0 = lockCheck.argv[0];
      if (lockArgv0 === 'uv') {
        const resolved = await resolveUvImpl({ env });
        if (!resolved.path) return { ...base, status: 'refused', reason: `lock-check-cannot-run: uv not found (tried ${resolved.tried.join(', ')})` };
        lockArgv0 = resolved.path;
      }
      const lockRes = await exec(lockArgv0, lockCheck.argv.slice(1), { cwd: root });
      if (lockRes.code !== 0) {
        // Field lesson #181: a resolved path that still fails to even spawn (e.g. a toolchains
        // package directory picked before this lesson's own `resolveToolchainBin` fix, or any
        // other spawn-level failure) must never surface as the empty `<name> failed: ` this used
        // to produce when the exec wrapper never ran and so had no stderr/stdout to report;
        // `exec`'s own spawnError (set by shipExec on a real spawn failure) names the path and
        // errno directly instead.
        if (lockRes.spawnError) return { ...base, status: 'refused', reason: `lock-check-cannot-run: ${lockArgv0} (${lockRes.spawnError})` };
        return { ...base, status: 'refused', reason: `${lockCheck.name} failed: ${firstStderrLine(lockRes.stderr || lockRes.stdout)}` };
      }
    }
  }

  let pushRes = await exec('git', ['push', 'origin', `HEAD:refs/heads/${payload.head}`], { cwd: root });
  if (pushRes.code !== 0) {
    // Field lesson 150: only a non-fast-forward-shaped rejection is a candidate for a lease push;
    // every other push failure (auth, permissions, branch protection) keeps today's plain reason.
    const lease = NON_FAST_FORWARD_RE.test(`${pushRes.stderr ?? ''}\n${pushRes.stdout ?? ''}`) ? await resolveLeasePush(exec, root, repo, payload.head) : null;
    if (!lease) return { ...base, status: 'refused', reason: stepFailed('push', pushRes) };
    if (!lease.ok) return { ...base, status: 'refused', reason: `push refused: remote head of ${payload.head} was moved by ${lease.remoteAuthor ?? 'someone else'}, not the coordinator (${lease.me ?? 'unknown identity'})` };
    pushRes = await exec('git', ['push', `--force-with-lease=${payload.head}:${lease.remoteSha}`, 'origin', `HEAD:refs/heads/${payload.head}`], { cwd: root });
    if (pushRes.code !== 0) return { ...base, status: 'refused', reason: stepFailed('push', pushRes) };
  }

  const [owner] = repo.split('/');
  const listRes = await exec('gh', ['api', `repos/${repo}/pulls?head=${owner}:${payload.head}&state=open`], { cwd: root });
  let existing;
  if (listRes.code !== 0) return { ...base, status: 'refused', reason: prListFailedReason(listRes, originRepo) };
  try {
    existing = JSON.parse(listRes.stdout || '[]');
  } catch {
    return { ...base, status: 'refused', reason: prListFailedReason(listRes, originRepo) };
  }
  let pr;
  if (existing.length > 0) {
    const patchRes = await exec('gh', ['api', '-X', 'PATCH', `repos/${repo}/pulls/${existing[0].number}`, '--input', '-'], {
      cwd: root, input: JSON.stringify({ title: payload.title, body }),
    });
    if (patchRes.code !== 0) return { ...base, status: 'refused', reason: stepFailed('pr update', patchRes, originRepo) };
    try {
      pr = JSON.parse(patchRes.stdout);
    } catch {
      return { ...base, status: 'refused', reason: stepFailed('pr update', patchRes, originRepo) };
    }
  } else {
    const createRes = await exec('gh', ['api', `repos/${repo}/pulls`, '--input', '-'], {
      cwd: root, input: JSON.stringify({ title: payload.title, head: payload.head, base: payload.base, body }),
    });
    if (createRes.code !== 0) return { ...base, status: 'refused', reason: stepFailed('pr create', createRes, originRepo) };
    try {
      pr = JSON.parse(createRes.stdout);
    } catch {
      return { ...base, status: 'refused', reason: stepFailed('pr create', createRes, originRepo) };
    }
  }
  base.pr = pr.number;
  base.url = pr.html_url;

  // One poll-to-settle pass; called again after a flaky rerun (field lesson #178) to re-check the
  // same PR/sha without repeating the push/PR-create steps above. Returns either a terminal ship()
  // result (refused/no-ci/timeout) or the settled { ci, ciRollup }.
  async function waitForCi() {
    const start = now();
    for (;;) {
      const viewRes = await exec('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,headRefOid,mergeStateStatus,statusCheckRollup'], { cwd: root });
      if (viewRes.code !== 0 && /HTTP 30[1278]\b/.test(`${viewRes.stderr} ${viewRes.stdout}`)) return { terminal: { ...base, status: 'refused', reason: stepFailed('pr view', viewRes, originRepo) } };
      let view = null;
      if (viewRes.code === 0) {
        try {
          view = JSON.parse(viewRes.stdout);
        } catch {
          view = null;
        }
      }
      if (view) {
        const summary = summarizeRollup(view.statusCheckRollup);
        const headMatches = view.headRefOid === sha;
        if (headMatches && summary.total > 0 && summary.pending === 0) return { ci: summary, ciRollup: view.statusCheckRollup };
        const elapsed = now() - start;
        if (headMatches && summary.total === 0 && elapsed >= noCiGraceMs) return { terminal: { ...base, status: 'no-ci', reason: 'no CI detected', ci: summary } };
        if (elapsed >= timeoutMs) return { terminal: { ...base, status: 'timeout', reason: 'timed out waiting for checks', ci: summary } };
      } else if (now() - start >= timeoutMs) {
        return { terminal: { ...base, status: 'timeout', reason: 'timed out waiting for checks', ci: null } };
      }
      await sleep(pollMs);
    }
  }

  let ci, ciRollup;
  {
    const settled = await waitForCi();
    if (settled.terminal) return settled.terminal;
    ({ ci, ciRollup } = settled);
  }
  base.ci = ci;

  // Field lesson #178: a ci-failed run whose failing tests are not in this ship's own diff (a
  // flaky test elsewhere) gets up to `rerunFlaky` automatic reruns of just the failed jobs before
  // it blocks the ship; a failing test that IS in the diff is never rerun (a real regression).
  let rerunAttempts = 0, rerunTests = null;
  while (ci.failed.length > 0) {
    // Field lesson 151: named up front so the next job starts from "this OS only", not a guess.
    for (const entry of platformOnlyFailures(ciRollup)) base.warnings.push(`platform-only failure: ${entry.os}: ${entry.testIds.join(', ')}`);
    if (!(rerunFlaky > 0 && rerunAttempts < rerunFlaky)) {
      return { ...base, status: 'ci-failed', reason: `failed checks: ${ci.failed.join(', ')}`, ...(rerunTests ? { flakyRerun: { attempts: rerunAttempts, result: 'failed', tests: rerunTests } } : {}) };
    }
    const runIds = failedRunIds(ciRollup, ci.failed);
    const logs = [];
    for (const id of runIds) {
      const logRes = await exec('gh', ['run', 'view', id, '--repo', repo, '--log-failed'], { cwd: root });
      if (logRes.code === 0) logs.push(logRes.stdout);
    }
    rerunTests = [...new Set(logs.flatMap(extractFailingTestFiles))];
    const inDiff = rerunTests.some(test => integratedFiles.some(file => file === test || file.endsWith(`/${test}`) || test.endsWith(`/${file}`)));
    if (inDiff) {
      base.warnings.push(`rerun-flaky-skipped: failing test is in this PR's diff: ${rerunTests.join(', ')}`);
      return { ...base, status: 'ci-failed', reason: `failed checks: ${ci.failed.join(', ')}` };
    }
    rerunAttempts++;
    for (const id of runIds) await exec('gh', ['run', 'rerun', id, '--failed', '--repo', repo], { cwd: root });
    await sleep(pollMs);
    const settled = await waitForCi();
    if (settled.terminal) return settled.terminal;
    ({ ci, ciRollup } = settled);
    base.ci = ci;
  }
  if (rerunAttempts > 0) base.flakyRerun = { attempts: rerunAttempts, result: 'passed', tests: rerunTests ?? [] };

  if (isHeld(body)) return { ...base, status: 'held', reason: 'PR body requests manual review' };
  if (merge === false) return { ...base, status: 'ready' };

  const version = await releaseVersion(exec, root, payload.base);
  if (version) base.tag.name = `v${version}`;
  const mergeRes = await exec('gh', ['pr', 'merge', String(pr.number), '--repo', repo, `--${mergeMethod}`, '--match-head-commit', sha], { cwd: root });
  if (mergeRes.code !== 0) return { ...base, status: 'merge-failed', reason: stepFailed('merge', mergeRes, originRepo).replace(/^merge failed: /, '') };
  const mergedRes = await exec('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergeCommit'], { cwd: root });
  let merged = null;
  if (mergedRes.code === 0) {
    try {
      merged = JSON.parse(mergedRes.stdout);
    } catch {
      merged = null;
    }
  }
  if (!merged) return { ...base, status: 'merge-failed', reason: stepFailed('post-merge view', mergedRes, originRepo) };
  if (merged.state === 'MERGED') {
    if (version && tagTimeoutMs > 0) {
      const start = now();
      let waitedMs = 0;
      for (;;) {
        const tag = await exec('git', ['ls-remote', '--tags', 'origin', `v${version}`], { cwd: root });
        waitedMs = Math.max(waitedMs, now() - start);
        if (tag.code === 0 && tag.stdout.trim()) { base.tag.status = 'found'; break; }
        if (waitedMs >= tagTimeoutMs) { base.tag.status = 'missing'; break; }
        const pause = Math.min(10_000, tagTimeoutMs - waitedMs);
        await sleep(pause);
        waitedMs = Math.max(waitedMs + pause, now() - start);
      }
      base.tag.waitedSeconds = waitedMs / 1000;
      if (base.tag.status === 'missing') base.warnings.push(`release tag v${version} not on origin after ${base.tag.waitedSeconds}s`);
    }
    return { ...base, status: 'merged', mergeSha: merged.mergeCommit?.oid ?? null };
  }
  return { ...base, status: 'merge-failed', reason: 'PR not merged' };
}
