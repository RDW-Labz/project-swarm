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
export async function resolveToolchainBin(prog, { env = process.env, home = os.homedir(), access = file => fs.access(file, fs.constants.X_OK) } = {}) {
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
export const DOCUMENTED_TEST_BINARIES = new Set(['node', 'npm', 'npx', 'git', 'gh']);
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

async function readIntegratedTestFiles(root, integratedFiles) {
  const files = new Map();
  for (const file of integratedFiles ?? []) {
    if (!TEST_FILE_RE.test(file)) continue;
    try { files.set(file, await fs.readFile(path.join(root, file), 'utf8')); } catch { /* removed or unreadable: nothing to scan */ }
  }
  return files;
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
    runChecks, exec, sleep, now = () => Date.now(),
    env = process.env,
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

  // Field lesson 154/156: a static gate over the run's own test file outputs, before any check
  // spawns them for real; an undocumented binary with no fake/skip seam refuses outright, while a
  // swarm-exported env var reference is only a warning (the test may already handle it).
  const integratedTestFiles = integratedFiles.length ? await readIntegratedTestFiles(root, integratedFiles) : new Map();
  const undocumentedBinaries = undocumentedBinaryWarnings(integratedTestFiles);
  if (undocumentedBinaries.length) {
    return { ...base, status: 'refused', reason: `test file spawns undocumented binary with no fake/skip seam: ${undocumentedBinaries.map(w => `${w.file} -> ${w.bin}`).join(', ')}` };
  }
  for (const warning of swarmEnvInTestWarnings(integratedTestFiles)) base.warnings.push(`swarm-env-in-tests: ${warning.file}: references ${warning.name}; stub or unset it in this test (lesson #156)`);

  // Field lesson #159: a shipped change to packaging keys needs a check that builds the package;
  // tests, lint and types all pass on a package that will not build.
  const packagingRefusals = packagingChangeWarnings(packagingChanges, checkArgvs);
  if (packagingRefusals.length) return { ...base, status: 'refused', reason: `${packagingRefusals.join('; ')}; add a check that builds the package (uv build --wheel, npm pack --dry-run)` };

  const checks = await runChecks();
  base.checks = checks;
  const body = fillChecks(payload.body, checks);
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
      if (lockRes.code !== 0) return { ...base, status: 'refused', reason: `${lockCheck.name} failed: ${firstStderrLine(lockRes.stderr || lockRes.stdout)}` };
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

  const start = now();
  let ci = null;
  let ciRollup = null;
  for (;;) {
    const viewRes = await exec('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,headRefOid,mergeStateStatus,statusCheckRollup'], { cwd: root });
    if (viewRes.code !== 0 && /HTTP 30[1278]\b/.test(`${viewRes.stderr} ${viewRes.stdout}`)) return { ...base, status: 'refused', reason: stepFailed('pr view', viewRes, originRepo) };
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
      if (headMatches && summary.total > 0 && summary.pending === 0) { ci = summary; ciRollup = view.statusCheckRollup; break; }
      const elapsed = now() - start;
      if (headMatches && summary.total === 0 && elapsed >= noCiGraceMs) return { ...base, status: 'no-ci', reason: 'no CI detected', ci: summary };
      if (elapsed >= timeoutMs) return { ...base, status: 'timeout', reason: 'timed out waiting for checks', ci: summary };
    } else if (now() - start >= timeoutMs) {
      return { ...base, status: 'timeout', reason: 'timed out waiting for checks', ci: null };
    }
    await sleep(pollMs);
  }
  base.ci = ci;
  if (ci.failed.length > 0) {
    // Field lesson 151: named up front so the next job starts from "this OS only", not a guess.
    for (const entry of platformOnlyFailures(ciRollup)) base.warnings.push(`platform-only failure: ${entry.os}: ${entry.testIds.join(', ')}`);
    return { ...base, status: 'ci-failed', reason: `failed checks: ${ci.failed.join(', ')}` };
  }

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
