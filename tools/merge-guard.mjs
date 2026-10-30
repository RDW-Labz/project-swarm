import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirtyFiles, formatDirtyListing } from './generated-state.mjs';
import { holdsSwarmState } from './state-guard.mjs';
import { projectsFile } from './projects.mjs';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const execFileP = promisify(execFile);
const USAGE = 'usage: merge PR [--repo OWNER/NAME]';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_FIELDS =
  'state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup,isCrossRepository,title,body';
const RELEASE_TITLE_RE = /^(?:release\s+)?v?\d+\.\d+\.\d+/i;
const REVIEWS_HEADING_RE = /^##\s+Reviews\s*$/i;
const ANY_HEADING_RE = /^##\s/;
const HEAD_SHA40_RE = /^[0-9a-f]{40}$/i;
const isSha = (value) => typeof value === 'string' && HEAD_SHA40_RE.test(value);

// Strip fenced text before interpreting either headings or markers. A closing
// fence must use the opener's character and at least its delimiter length.
function extractReviewsSectionText(body) {
  const reviewLines = [];
  let inReviews = false;
  let fence = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.char &&
          delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (delimiter) {
      fence = { char: delimiter[1][0], length: delimiter[1].length };
      continue;
    }
    if (REVIEWS_HEADING_RE.test(line)) {
      inReviews = true;
      continue;
    }
    if (inReviews && ANY_HEADING_RE.test(line)) break;
    if (inReviews) reviewLines.push(line);
  }
  return reviewLines.join('\n');
}

function safeReviewPath(value) {
  if (typeof value !== 'string' || !value.startsWith('coordination/review/')) return false;
  return value.split('/').every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}

function decodeContents(response) {
  if (!isObj(response) || response.encoding !== 'base64' || typeof response.content !== 'string') {
    throw new Error('invalid contents response');
  }
  const encoded = response.content.replace(/\s/g, '');
  // Buffer.from silently discards invalid base64 characters; reject those first.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('invalid base64');
  }
  return Buffer.from(encoded, 'base64');
}

export async function releaseReviewGate(
  { title, body, headRefOid },
  { gh, repoName, root = '.', fs: fsImpl = fs } = {},
) {
  if (!RELEASE_TITLE_RE.test(String(title ?? '').trimStart())) return { required: false, ok: true };
  const refuse = (reason) => ({ required: true, ok: false, reason });
  const reviewsText = extractReviewsSectionText(body);
  const markers = [...reviewsText.matchAll(/<!--\s*swarm-review-run:\s*([^\r\n]*?)\s*-->/g)];
  if (!markers.length) return refuse('marker-missing');
  const recordPath = markers[0][1].trim();
  if (markers.length !== 1 || !safeReviewPath(recordPath) || !recordPath.endsWith('-review-run.json')) {
    return refuse('record-malformed');
  }
  if (!isSha(headRefOid)) return refuse('record-head-mismatch');

  // Every remote read is pinned to R, the PR head, so the mini's local run
  // directory is not needed on the machine performing the merge.
  const api = async (endpoint) => {
    try {
      const response = await gh(['api', 'repos/' + repoName + '/' + endpoint]);
      return response.code === 0 ? { ok: true, value: parseJson(response) } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
  const contents = (file) => api('contents/' + file + '?ref=' + headRefOid);
  const fetched = await contents(recordPath);
  if (!fetched.ok) return refuse('record-missing');
  let record;
  try {
    record = JSON.parse(decodeContents(fetched.value).toString('utf8'));
  } catch {
    return refuse('record-malformed');
  }
  if (!isObj(record) || !safeReviewPath(record.resultFile) ||
      typeof record.train !== 'string' || !record.train.trim() ||
      typeof record.manifest !== 'string' ||
      !/^coordination\/manifests\/[A-Za-z0-9_.-]+\.json$/.test(record.manifest) ||
      typeof record.at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(record.at) ||
      !Number.isFinite(Date.parse(record.at))) return refuse('record-malformed');

  const commit = await api('commits/' + headRefOid);
  const parents = commit.value?.parents;
  if (!commit.ok || !Array.isArray(parents) || parents.length !== 1 || !isSha(parents[0]?.sha)) {
    return refuse('record-not-metadata-commit');
  }
  const parent = parents[0].sha;
  const comparison = await api('compare/' + parent + '...' + headRefOid);
  const files = comparison.value?.files;
  if (!comparison.ok || !Array.isArray(files) || files.length !== 2 ||
      record.resultFile === recordPath ||
      new Set(files.map((file) => file?.filename)).size !== 2 ||
      !files.every((file) => isObj(file) &&
        [recordPath, record.resultFile].includes(file.filename) &&
        (!file.previous_filename || file.previous_filename === file.filename) &&
        !['renamed', 'removed', 'copied'].includes(file.status))) {
    return refuse('record-not-metadata-commit');
  }
  if (!isSha(record.head) || record.head.toLowerCase() !== parent.toLowerCase()) {
    return refuse('record-head-mismatch');
  }
  if (record.verdict !== 'pass') return refuse('record-verdict-not-pass');
  if (typeof record.model !== 'string' || !/opus/i.test(record.model)) return refuse('record-model-not-opus');
  if (record.agent !== 'claude' || typeof record.runId !== 'string' ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(record.runId)) return refuse('record-run-invalid');

  const resultResponse = await contents(record.resultFile);
  let resultBytes;
  try {
    if (!resultResponse.ok) throw new Error('result missing');
    resultBytes = decodeContents(resultResponse.value);
    if (typeof record.resultHash !== 'string' || !/^[0-9a-f]{64}$/i.test(record.resultHash) ||
        createHash('sha256').update(resultBytes).digest('hex') !== record.resultHash.toLowerCase()) {
      return refuse('record-result-hash-mismatch');
    }
  } catch {
    return refuse('record-result-hash-mismatch');
  }
  let result;
  try {
    result = JSON.parse(resultBytes.toString('utf8'));
  } catch {
    return refuse('record-result-verdict');
  }
  if (!isObj(result) || result.verdict !== 'pass' ||
      (Object.hasOwn(result, 'head') && (!isSha(result.head) || result.head.toLowerCase() !== parent.toLowerCase()))) {
    return refuse('record-result-verdict');
  }

  let localRun;
  try {
    localRun = JSON.parse(await fsImpl.readFile(path.join(root, '.swarm', 'runs', record.runId, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') return refuse('record-run-invalid');
    return { required: true, ok: true };
  }
  const jobs = isObj(localRun?.jobs) ? Object.values(localRun.jobs) : localRun?.jobs;
  if (!isObj(localRun) || localRun.status !== 'complete' || !Array.isArray(jobs) || !jobs.length ||
      !jobs.every((job) => isObj(job) && job.agent === record.agent && job.model === record.model)) {
    return refuse('record-run-invalid');
  }
  return { required: true, ok: true };
}

async function realExec(command, args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await execFileP(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
    };
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const parseJson = (r) => {
  try {
    return JSON.parse(String(r.stdout ?? ''));
  } catch {
    return undefined;
  }
};
const firstLine = (r, fallback) => String(r.stderr ?? '').trim().split('\n')[0] || fallback;

function ghApiDeleteNotFound(r) {
  const blob = `${String(r.stderr ?? '')}\n${String(r.stdout ?? '')}`;
  return /\b404\b/.test(blob) || /Reference does not exist/i.test(blob);
}

const GREEN_RUN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CTX = new Set(['PENDING', 'EXPECTED']);

function classify(it) {
  if (it.status === undefined && typeof it.state === 'string') {
    if (it.state === 'SUCCESS') return 'green';
    return PENDING_CTX.has(it.state) ? 'pending' : 'failing';
  }
  if (it.status !== 'COMPLETED') return 'pending';
  return GREEN_RUN.has(it.conclusion) ? 'green' : 'failing';
}

function label(it) {
  const name = String(it.name ?? it.context ?? '');
  if (!name) return null;
  const wf = typeof it.workflowName === 'string' && it.workflowName ? ` [${it.workflowName}]` : '';
  return name + wf;
}

export function checkRollup(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return { ok: false, total: 0, green: 0, failing: [], pending: [] };
  }
  let green = 0;
  const failing = [];
  const pending = [];
  for (const it of rollup) {
    const name = isObj(it) ? label(it) : null;
    if (name === null) {
      failing.push('invalid-item');
      continue;
    }
    const c = classify(it);
    if (c === 'green') green++;
    else if (c === 'pending') pending.push(name);
    else failing.push(name);
  }
  const total = rollup.length;
  return { ok: total > 0 && failing.length === 0 && pending.length === 0, total, green, failing, pending };
}

export function assertMergeable(view, { defaultBranch } = {}) {
  const v = isObj(view) ? view : {};
  const reasons = [];
  if (v.state !== 'OPEN') reasons.push('pr-not-open');
  if (v.mergeable === 'CONFLICTING') reasons.push('has-conflicts');
  else if (v.mergeable !== 'MERGEABLE') reasons.push('mergeable-unknown');
  if (!defaultBranch || v.baseRefName !== defaultBranch) reasons.push('not-default-branch');
  const r = checkRollup(v.statusCheckRollup);
  if (r.total === 0) reasons.push('no-checks');
  if (r.failing.length) reasons.push(`failing: ${r.failing.join(', ')}`);
  if (r.pending.length) reasons.push(`pending: ${r.pending.join(', ')}`);
  if (!v.headRefOid) reasons.push('no-head');
  return { ok: reasons.length === 0, reasons };
}

export function parsePrArgument(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  let m = /^#?(\d+)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 ? { number: n, repo: null } : null;
  }
  m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(s);
  if (m) {
    const n = Number(m[2]);
    return n >= 1 ? { number: n, repo: m[1] } : null;
  }
  return null;
}

function sameRepo(url, repoName) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/i.exec(String(url).trim());
  return Boolean(m) && `${m[1]}/${m[2]}`.toLowerCase() === String(repoName).toLowerCase();
}

export function parseGitWorktreeListPorcelain(text) {
  const worktrees = [];
  let current = {};
  for (const line of String(text ?? '').split('\n')) {
    if (!line) {
      if (current.path) worktrees.push(current);
      current = {};
      continue;
    }
    if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length);
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
  }
  if (current.path) worktrees.push(current);
  return worktrees;
}

export function worktreeListTrustworthy(stdout) {
  const text = String(stdout ?? '');
  if (!text.trim()) return false;
  const blocks = text.split('\n\n').filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const hasWorktree = lines.some((l) => l.startsWith('worktree '));
    if (!hasWorktree) return false;
  }
  return true;
}

function encodeRefPath(refName) {
  return String(refName).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

async function headBranchCheckedOutInStateHolder(root, headBranch, { exec, holdsSwarmStateFn = holdsSwarmState, registryFile, fs: fsImpl } = {}) {
  const listed = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  if (listed.code !== 0) return true;
  if (!worktreeListTrustworthy(listed.stdout)) return true;
  const ref = `refs/heads/${headBranch}`;
  for (const wt of parseGitWorktreeListPorcelain(listed.stdout)) {
    if (wt.branch !== ref || !wt.path) continue;
    if (await holdsSwarmStateFn(wt.path, { fs: fsImpl, registryFile })) return true;
  }
  return false;
}

async function localUpdate(root, branch, repoName, exec) {
  const opts = { cwd: root };
  const inside = await exec('git', ['rev-parse', '--is-inside-work-tree'], opts);
  if (inside.code !== 0 || String(inside.stdout ?? '').trim() !== 'true') {
    return 'skipped: not a git work tree';
  }
  const remote = await exec('git', ['remote', 'get-url', 'origin'], opts);
  if (remote.code !== 0 || !sameRepo(remote.stdout, repoName)) {
    return 'skipped: this folder is another repository';
  }
  let dirty;
  try {
    dirty = await dirtyFiles(root, {
      runStatus: async () => {
        const st = await exec('git', ['status', '--porcelain'], opts);
        if (st.code !== 0) throw new Error('git status failed');
        return String(st.stdout ?? '');
      },
    });
  } catch {
    return 'skipped: git status failed';
  }
  if (dirty.length) return `skipped: uncommitted changes${formatDirtyListing(dirty)}`;
  const steps = [
    [['fetch', 'origin'], 'fetch'],
    [['checkout', branch, '--'], 'checkout'],
    [['pull', '--ff-only', 'origin', branch], 'pull'],
  ];
  for (const [a, label] of steps) {
    const r = await exec('git', a, opts);
    if (r.code !== 0) return `skipped: ${label} failed`;
  }
  return 'pulled';
}

export async function runMerge(root, args, { exec = realExec, sleep = defaultSleep, holdsSwarmState: holdsSwarmStateFn = holdsSwarmState, registryFile, fs: fsImpl, home = os.homedir(), env = process.env } = {}) {
  const refuse = (reason) => ({ status: 'refused', reasons: [reason] });
  const list = Array.isArray(args) ? args.map(String) : [];
  let prArg = null;
  let repoFlag = null;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--repo') {
      const v = list[++i];
      if (!v || !REPO_RE.test(v)) return refuse('bad-repo');
      repoFlag = v;
    } else if (a.startsWith('--')) {
      return refuse(`merge-flag-refused: ${a}`);
    } else if (prArg === null) {
      prArg = a;
    } else {
      return refuse(USAGE);
    }
  }
  const parsed = parsePrArgument(prArg ?? '');
  if (!parsed) return refuse(USAGE);
  if (repoFlag && parsed.repo && repoFlag !== parsed.repo) return refuse('repo-mismatch');
  const repo = repoFlag ?? parsed.repo;
  const repoArgs = repo ? ['--repo', repo] : [];
  const n = String(parsed.number);
  const gh = (ghArgs) => exec('gh', ghArgs, { cwd: root });

  const rv = await gh(['repo', 'view', ...repoArgs, '--json', 'defaultBranchRef,nameWithOwner']);
  if (rv.code !== 0) return refuse(`repo-view-failed: ${firstLine(rv, 'gh repo view failed')}`);
  const info = parseJson(rv);
  if (!isObj(info)) return refuse('repo-view-unparseable');
  const defaultBranch = info.defaultBranchRef?.name;
  const repoName = repo ?? info.nameWithOwner;
  if (!defaultBranch) return refuse('no-default-branch');
  if (typeof repoName !== 'string' || !REPO_RE.test(repoName)) return refuse('repo-view-unparseable');

  let view;
  for (let attempt = 0; ; attempt++) {
    const pv = await gh(['pr', 'view', n, ...repoArgs, '--json', PR_FIELDS]);
    if (pv.code !== 0) return refuse(`pr-view-failed: ${firstLine(pv, 'gh pr view failed')}`);
    view = parseJson(pv);
    if (!isObj(view)) return refuse('pr-view-unparseable');
    if (view.mergeable !== 'UNKNOWN') break;
    if (attempt >= 4) return refuse('mergeable-unknown');
    await sleep(2000);
  }

  const verdict = assertMergeable(view, { defaultBranch });
  const rollup = checkRollup(view.statusCheckRollup);
  const bare = new Set(
    (Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : [])
      .filter(isObj)
      .map((it) => String(it.name ?? it.context ?? '')),
  );

  let requiredChecks = 'unknown';
  const missing = [];
  if (typeof view.baseRefName === 'string' && view.baseRefName) {
    const rq = await gh([
      'api',
      `repos/${repoName}/branches/${encodeURIComponent(view.baseRefName)}/protection/required_status_checks`,
    ]);
    const body = rq.code === 0 ? parseJson(rq) : undefined;
    if (isObj(body)) {
      requiredChecks = 'checked';
      const req = new Set();
      if (Array.isArray(body.contexts)) {
        for (const c of body.contexts) if (typeof c === 'string') req.add(c);
      }
      if (Array.isArray(body.checks)) {
        for (const c of body.checks) if (isObj(c) && typeof c.context === 'string') req.add(c.context);
      }
      for (const c of req) if (!bare.has(c)) missing.push(c);
    }
  }

  const reasons = [...verdict.reasons];
  if (missing.length) reasons.push(`missing-required: ${missing.join(', ')}`);
  const reviewGate = await releaseReviewGate({
    title: view.title,
    body: view.body,
    headRefOid: view.headRefOid,
  }, { gh, repoName, root, fs: fsImpl });
  if (reviewGate.required && !reviewGate.ok) reasons.push(reviewGate.reason);
  const checks = {
    failing: rollup.failing,
    pending: [...rollup.pending, ...missing],
    green: rollup.green,
    total: rollup.total,
  };
  if (reasons.length) return { status: 'refused', reasons, checks, requiredChecks };
  if (!view.headRefName) return refuse('no-head-branch');

  const pl = await gh(['pr', 'list', '--repo', repoName, '--base', String(view.headRefName), '--state', 'open', '--json', 'number']);
  if (pl.code !== 0) return refuse(`pr-list-failed: ${firstLine(pl, 'gh pr list failed')}`);
  const listed = parseJson(pl);
  if (!Array.isArray(listed)) return refuse('pr-list-unparseable');
  const stacked = listed
    .filter(isObj)
    .map((p) => Number(p.number))
    .filter((x) => Number.isFinite(x) && x !== parsed.number);
  if (stacked.length > 0) {
    return refuse(`stacked-prs-open: ${stacked.map((x) => `#${x}`).join(',')}`);
  }

  const mergeFailed = (reason) => ({ status: 'merge-failed', reason, reasons: [reason] });
  const registry = registryFile ?? projectsFile(env, home);
  const keepLocalHeadBranch = await headBranchCheckedOutInStateHolder(root, view.headRefName, {
    exec,
    holdsSwarmStateFn,
    registryFile: registry,
    fs: fsImpl,
  });
  const mergeArgs = ['pr', 'merge', n, ...repoArgs, '--squash'];
  if (!keepLocalHeadBranch) mergeArgs.push('--delete-branch');
  mergeArgs.push('--match-head-commit', String(view.headRefOid));
  const mg = await gh(mergeArgs);
  if (mg.code !== 0) return mergeFailed(firstLine(mg, 'gh pr merge failed'));

  let remoteBranchDeleteWarning;
  if (keepLocalHeadBranch && view.isCrossRepository === false) {
    const refPath = `repos/${repoName}/git/refs/heads/${encodeRefPath(view.headRefName)}`;
    const del = await gh(['api', '-X', 'DELETE', refPath]);
    if (del.code !== 0 && !ghApiDeleteNotFound(del)) {
      remoteBranchDeleteWarning = firstLine(del, 'remote branch delete failed');
    }
  }

  const after = await gh(['pr', 'view', n, ...repoArgs, '--json', 'state']);
  if (after.code !== 0) return mergeFailed('post-merge state check failed');
  const state = parseJson(after)?.state;
  if (state === undefined) return mergeFailed('post-merge state unparseable');
  if (state !== 'MERGED') return mergeFailed(`not-merged: state ${state}`);

  const local = await localUpdate(root, defaultBranch, repoName, exec);
  return {
    status: 'merged',
    pr: parsed.number,
    repo: repoName,
    sha: view.headRefOid,
    checks: { total: rollup.total, green: rollup.green },
    requiredChecks,
    localUpdate: local,
    ...(keepLocalHeadBranch ? { localBranch: 'kept' } : {}),
    ...(remoteBranchDeleteWarning ? { warning: remoteBranchDeleteWarning } : {}),
  };
}

async function runTests() {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });

  test('rollup counts every item, a failed rerun still blocks', () => {
    const r = checkRollup([
      { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.failing, ['ci']);
  });

  test('rollup: pending regardless of times, invalid items fail', () => {
    const r = checkRollup([
      { name: 'a', status: 'IN_PROGRESS', completedAt: '0001-01-01T00:00:00Z' },
      null,
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    assert.deepEqual(r.pending, ['a']);
    assert.deepEqual(r.failing, ['invalid-item']);
    assert.equal(r.ok, false);
  });

  test('parsePrArgument accepts number, hash and URL', () => {
    assert.deepEqual(parsePrArgument('#7'), { number: 7, repo: null });
    assert.deepEqual(parsePrArgument('https://github.com/o/r/pull/9'), { number: 9, repo: 'o/r' });
    assert.equal(parsePrArgument('abc'), null);
  });

  test('runMerge refuses skip flags without touching gh', async () => {
    const r = await runMerge('.', ['7', '--force'], {
      exec: async () => {
        throw new Error('exec must not run');
      },
    });
    assert.equal(r.status, 'refused');
    assert.match(r.reasons[0], /merge-flag-refused/);
  });

  test('mergeable UNKNOWN is retried 4 times then refused', async () => {
    let views = 0;
    const sleeps = [];
    const exec = async (cmd, args) => {
      if (args[0] === 'repo') return ok({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'o/r' });
      if (args[0] === 'pr' && args[1] === 'view') {
        views++;
        return ok({ state: 'OPEN', mergeable: 'UNKNOWN', baseRefName: 'main', headRefOid: 'x', statusCheckRollup: [] });
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const r = await runMerge('.', ['7', '--repo', 'o/r'], { exec, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(r.status, 'refused');
    assert.deepEqual(r.reasons, ['mergeable-unknown']);
    assert.equal(views, 5);
    assert.deepEqual(sleeps, [2000, 2000, 2000, 2000]);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'test') {
    await runTests();
  } else {
    const out = await runMerge(process.cwd(), argv[0] === 'merge' ? argv.slice(1) : argv);
    console.log(JSON.stringify(out));
    process.exitCode = out.status === 'merged' ? 0 : 1;
  }
}
