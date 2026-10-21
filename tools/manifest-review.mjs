// SPDX-License-Identifier: Apache-2.0
// Autonomous manifest/workflow review: deterministic safe rules plus an injectable model reviewer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { budgetSetActor } from './budget-set-commands.mjs';
import {
  decide,
  autoDecisionEvent,
  loadPolicy,
  policyPath,
  policyInitializedMarkerPath,
} from './policy.mjs';
import { appendAutoDecision } from './policy-run.mjs';
import { unparsedEcosystem } from './security-gate.mjs';

export const MANIFEST_REVIEWS_REL = '.swarm/project/manifest-reviews.ndjson';
export const DEFAULT_REVIEW_MODEL = 'claude-opus';

let pendingIntegrateManifestReview = null;

export function setIntegrateManifestReviewContext(opts) {
  pendingIntegrateManifestReview = opts ?? null;
}

export function peekIntegrateManifestReviewContext() {
  return pendingIntegrateManifestReview;
}

const WORKFLOW_PREFIX = '.github/workflows/';
const PKG = 'package.json';
const LIFECYCLE_INSTALL = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const NON_REGISTRY =
  /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|https?:|file:|link:|workspace:|portal:|patch:|ssh:)/i;

function normPath(file) {
  return String(file ?? '').replace(/^\.\//, '').replace(/\\/g, '/');
}

function isWorkflowFile(file) {
  const p = normPath(file).toLowerCase();
  return p.startsWith(WORKFLOW_PREFIX) && (p.endsWith('.yml') || p.endsWith('.yaml'));
}

function isDependencyManifest(file) {
  const base = path.posix.basename(normPath(file).toLowerCase());
  return base === PKG;
}

export function isReviewableManifestFile(file) {
  return isWorkflowFile(file) || isDependencyManifest(file);
}

function finding(rule, message) {
  return { rule, message: String(message).slice(0, 300) };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function usesRefUnpinned(ref) {
  const r = String(ref ?? '').trim();
  if (!r) return true;
  const at = r.lastIndexOf('@');
  if (at <= 0) return true;
  const pin = r.slice(at + 1);
  if (/^[0-9a-f]{40}$/i.test(pin)) return false;
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pin)) return false;
  return true;
}

function checkWorkflowRules(text) {
  const findings = [];
  const s = String(text ?? '');
  if (/\bpull_request_target\b/.test(s)) {
    findings.push(finding('pull-request-target', 'workflow uses pull_request_target'));
  }
  if (/\bruns-on:\s*self-hosted\b/i.test(s)) {
    findings.push(finding('self-hosted-runner', 'workflow uses a self-hosted runner'));
  }
  if (/\benvironment:\s*production\b/i.test(s)) {
    findings.push(finding('deploy-step', 'workflow targets production environment'));
  }
  const deployRe =
    /\b(?:vercel|aws|gcloud|kubectl|docker\s+push|npm\s+publish|gh\s+release)\b/i;
  if (deployRe.test(s)) {
    findings.push(finding('deploy-step', 'workflow contains a deploy or publish step'));
  }
  if (/\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/i.test(s)) {
    findings.push(finding('secret-reference', 'workflow references a secret other than GITHUB_TOKEN'));
  }
  for (const line of s.split('\n')) {
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
    if (uses && usesRefUnpinned(uses[1])) {
      findings.push(finding('unpinned-action', `unpinned action reference: ${uses[1].slice(0, 80)}`));
    }
    const run = /^\s*run:\s*(.*)$/.exec(line);
    if (run && /\b(?:curl|wget)\b[^|\n]*\|\s*(?:ba)?sh\b/i.test(run[1])) {
      findings.push(finding('curl-wget-shell', 'run step pipes curl or wget into a shell'));
    }
  }
  return findings;
}

function semverMajor(version) {
  const m = /^(\d+)/.exec(String(version ?? '').trim());
  return m ? Number(m[1]) : null;
}

function depSpecs(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = obj[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, spec] of Object.entries(block)) {
      out.push({ name, spec: String(spec), section });
    }
  }
  return out;
}

function checkDependencyRules(text, { previousText } = {}) {
  const findings = [];
  const next = parseJson(text);
  const prev = previousText != null ? parseJson(previousText) : null;
  if (!next) return [finding('invalid-json', 'package.json is not valid JSON')];

  for (const { name, spec } of depSpecs(next)) {
    if (NON_REGISTRY.test(spec.trim())) {
      findings.push(finding('non-registry-url', `dependency ${name} uses a non-registry spec`));
    }
  }

  const prevScripts = prev?.scripts && typeof prev.scripts === 'object' ? prev.scripts : {};
  const nextScripts = next.scripts && typeof next.scripts === 'object' ? next.scripts : {};
  for (const key of LIFECYCLE_INSTALL) {
    if (nextScripts[key] != null && nextScripts[key] !== prevScripts[key]) {
      findings.push(finding('install-script', `lifecycle script ${key} was added or changed`));
    }
  }

  const prevDeps = new Map(depSpecs(prev ?? {}).map(d => [d.name, d]));
  for (const dep of depSpecs(next)) {
    const before = prevDeps.get(dep.name);
    if (!before) {
      if (dep.section !== 'devDependencies') {
        findings.push(finding('new-dependency', `new runtime dependency ${dep.name}`));
      }
      continue;
    }
    const mPrev = semverMajor(before.spec.replace(/^[\^~>=<]*/, ''));
    const mNext = semverMajor(dep.spec.replace(/^[\^~>=<]*/, ''));
    if (mPrev != null && mNext != null && mNext > mPrev) {
      findings.push(finding('major-bump', `major version bump for ${dep.name}`));
    }
  }

  if (prev && typeof next.version === 'string' && typeof prev.version === 'string') {
    const mPrev = semverMajor(prev.version);
    const mNext = semverMajor(next.version);
    if (mPrev != null && mNext != null && mNext > mPrev) {
      findings.push(finding('major-bump', 'package version major bump'));
    }
  }

  return findings;
}

export function checkManifestRules(file, text, options = {}) {
  const f = normPath(file);
  if (isWorkflowFile(f)) return checkWorkflowRules(text);
  if (isDependencyManifest(f)) {
    return checkDependencyRules(text, { previousText: options.previousText });
  }
  return [finding('unsupported-file', 'file type is outside autonomous manifest review')];
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

export function agentManifestApproveRefusalMessage() {
  return 'integrate --approve-manifest is owner-terminal only. From an agent session use: swarm manifest review <run-id> --file <path> (autonomous review when policy is initialized), or ask the owner to approve from their terminal.';
}

export function manifestApproveActor(env = process.env, tty = {}) {
  return budgetSetActor(env, tty);
}

export function machinePolicyFileReady(env, home, fsImpl = fs) {
  const file = policyPath(env, home);
  try {
    fsImpl.accessSync(file);
    return true;
  } catch {
    try {
      fsImpl.accessSync(policyInitializedMarkerPath(file));
    } catch {
      return false;
    }
    return false;
  }
}

export async function readManifestReviewRecords(root, fsImpl = fs.promises) {
  const file = path.join(root, MANIFEST_REVIEWS_REL);
  try {
    const text = await fsImpl.readFile(file, 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* drop malformed */
      }
    }
    return records;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendManifestReviewRecord(root, record, fsImpl = fs.promises) {
  const file = path.join(root, MANIFEST_REVIEWS_REL);
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  await fsImpl.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function parseReviewerJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.pass !== true && parsed.pass !== false) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function runManifestReview({
  file,
  text,
  runId,
  reviewerRunId,
  previousText,
  reviewer,
  model = DEFAULT_REVIEW_MODEL,
  now = Date.now,
} = {}) {
  const hash = sha256Text(text);
  const pre = checkManifestRules(file, text, { previousText });
  if (pre.length) {
    return {
      status: 'fail',
      pass: false,
      hash,
      file: normPath(file),
      runId,
      reviewerRunId,
      model,
      phase: 'precheck',
      findings: pre,
    };
  }
  if (typeof reviewer !== 'function') {
    return {
      status: 'fail',
      pass: false,
      hash,
      file: normPath(file),
      runId,
      reviewerRunId,
      model,
      phase: 'reviewer-missing',
      findings: [finding('reviewer', 'model reviewer not configured')],
    };
  }
  const raw = await reviewer({ file, text, runId, hash });
  const parsed = parseReviewerJson(raw);
  if (!parsed) {
    return {
      status: 'fail',
      pass: false,
      hash,
      file: normPath(file),
      runId,
      reviewerRunId,
      model,
      phase: 'reviewer-json',
      findings: [finding('reviewer-json', 'reviewer answer was not strict JSON with pass boolean')],
    };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const pass = parsed.pass === true && findings.length === 0;
  const at = new Date(typeof now === 'function' ? now() : now).toISOString();
  return {
    status: pass ? 'pass' : 'fail',
    pass,
    hash,
    file: normPath(file),
    runId,
    reviewerRunId,
    model,
    at,
    phase: 'model',
    findings,
  };
}

export function reviewPassForHash(records, file, hash) {
  const f = normPath(file);
  return (records ?? []).find(
    r =>
      r?.pass === true
      && normPath(r.file) === f
      && r.sha256 === hash
      && typeof r.reviewerRunId === 'string',
  );
}

export async function recordManifestReviewPass(root, result, fsImpl = fs.promises) {
  if (!result?.pass) return null;
  const record = {
    pass: true,
    file: result.file,
    sha256: result.hash,
    runId: result.runId,
    reviewerRunId: result.reviewerRunId,
    model: result.model,
    at: result.at ?? new Date().toISOString(),
  };
  await appendManifestReviewRecord(root, record, fsImpl);
  return record;
}

export async function createManifestReviewInboxItem(root, result, { appendEvent } = {}) {
  const append =
    appendEvent
    ?? (async (r, ev) => {
      const { appendEvent: journalAppend } = await import('./journal.mjs');
      return journalAppend(r, ev, { best: true });
    });
  const lines = (result.findings ?? []).map(f => `${f.rule}: ${f.message}`).join('; ');
  const text = `manifest review failed for ${result.file} (${result.hash.slice(0, 12)}): ${lines || result.phase}`;
  await append(root, { kind: 'human', text }, { best: true });
}

export function manifestApprovalFacts(file, sha256, records) {
  const rec = reviewPassForHash(records, file, sha256);
  return {
    file: normPath(file),
    sha256,
    manifestReviewPassed: Boolean(rec),
    reviewerRunId: rec?.reviewerRunId ?? null,
    reviewAt: rec?.at ?? null,
  };
}

export async function tryPolicyManifestApproval({
  root,
  file,
  sha256,
  project,
  env,
  home,
  fsImpl = fs,
  now = Date.now,
  machine = '',
  persistAutoDecision,
  records,
} = {}) {
  if (!machinePolicyFileReady(env, home, fsImpl)) {
    return { approved: false, reason: 'policy-not-initialized' };
  }
  const policyFile = policyPath(env, home);
  const { rules, error } = loadPolicy(policyFile, { fs: fsImpl });
  if (error || !rules?.length) {
    return { approved: false, reason: 'policy-inert' };
  }
  const passRecord = reviewPassForHash(records, file, sha256);
  if (!passRecord) {
    return { approved: false, reason: 'no-pass-record' };
  }
  const facts = manifestApprovalFacts(file, sha256, records);
  const request = {
    id: `manifest-approval-${sha256.slice(0, 12)}-${normPath(file).replace(/\//g, '_')}`,
    kind: 'manifest-approval',
    project,
    facts,
  };
  const result = decide(request, { rules, now });
  if (result.decision !== 'auto-approve' || result.rule !== 'manifest-reviewed') {
    return { approved: false, reason: result.reason ?? 'needs-owner' };
  }
  const event = autoDecisionEvent(request, result, { now, machine });
  event.file = facts.file;
  event.sha256 = sha256;
  event.reviewerRunId = passRecord.reviewerRunId;
  const persist =
    persistAutoDecision
    ?? (async (r, ev, n) => appendAutoDecision({ root: r, entry: ev, deps: { now: n } }));
  await persist(root, event, now);
  return { approved: true, rule: result.rule, event, approveEntry: { file: facts.file, sha256 } };
}

const MANIFEST_BLOCK_CHECKS = new Set([
  'unsupported-manifest',
  'install-script',
  'manifest-delete',
]);

export function securityBlocksEligibleForReview(blocks, file) {
  if (!isReviewableManifestFile(file)) return false;
  return (blocks ?? []).some(b => MANIFEST_BLOCK_CHECKS.has(b.check) && (!b.path || normPath(b.path) === normPath(file)));
}

export async function attemptManifestReviewForGate({
  root,
  changes,
  blocks,
  policy,
  runId,
  reviewer,
  reviewerRunId,
  env,
  home,
  fsImpl = fs,
  now = Date.now,
  machine = '',
  readPrevious,
  appendEvent,
  persistAutoDecision,
} = {}) {
  if (!machinePolicyFileReady(env, home, fsImpl)) {
    return { policy: withApproved(policy, []), blocks, reviews: [] };
  }
  const records = await readManifestReviewRecords(root, fsImpl.promises);
  const extraApprovals = [];
  const reviews = [];
  let nextBlocks = [...(blocks ?? [])];

  for (const change of changes ?? []) {
    if (change.bytes == null) continue;
    const file = change.file;
    if (!securityBlocksEligibleForReview(nextBlocks, file)) continue;
    const text = Buffer.from(change.bytes).toString('utf8');
    const hash = sha256Text(text);
    if (reviewPassForHash(records, file, hash)) {
      const pol = await tryPolicyManifestApproval({
        root,
        file,
        sha256: hash,
        project: projectIdFromRoot(root),
        env,
        home,
        fsImpl,
        now,
        machine,
        records,
        persistAutoDecision,
      });
      if (pol.approved) {
        extraApprovals.push(pol.approveEntry);
        nextBlocks = nextBlocks.filter(
          b => normPath(b.path ?? '') !== normPath(file) || !MANIFEST_BLOCK_CHECKS.has(b.check),
        );
        continue;
      }
    }
    const previousText =
      typeof readPrevious === 'function'
        ? await readPrevious(file, change.previous)
        : change.previous != null
          ? Buffer.from(change.previous).toString('utf8')
          : undefined;
    const review = await runManifestReview({
      file,
      text,
      runId,
      reviewerRunId: reviewerRunId ?? `review-${runId}`,
      previousText,
      reviewer,
      now,
    });
    reviews.push(review);
    if (review.pass) {
      const stored = await recordManifestReviewPass(root, review, fsImpl.promises);
      records.push(stored);
      const pol = await tryPolicyManifestApproval({
        root,
        file,
        sha256: hash,
        project: projectIdFromRoot(root),
        env,
        home,
        fsImpl,
        now,
        machine,
        records,
        persistAutoDecision,
      });
      if (pol.approved) {
        extraApprovals.push(pol.approveEntry);
        nextBlocks = nextBlocks.filter(
          b => normPath(b.path ?? '') !== normPath(file) || !MANIFEST_BLOCK_CHECKS.has(b.check),
        );
      }
    } else {
      await createManifestReviewInboxItem(root, review, { appendEvent });
    }
  }

  return {
    policy: withApproved(policy, extraApprovals),
    blocks: nextBlocks,
    reviews,
    ok: nextBlocks.length === 0,
  };
}

function withApproved(policy, entries) {
  const base = policy && typeof policy === 'object' ? { ...policy } : {};
  const existing = Array.isArray(base.approvedManifests) ? [...base.approvedManifests] : [];
  for (const entry of entries ?? []) {
    if (entry?.file && entry?.sha256) existing.push({ file: entry.file, sha256: entry.sha256 });
  }
  base.approvedManifests = existing;
  return base;
}

function projectIdFromRoot(root) {
  return path.basename(String(root ?? 'project')).toLowerCase();
}

export async function runManifestReviewCommand(root, runId, file, options = {}) {
  const {
    env = {},
    reviewer,
    now = Date.now,
    fsImpl = fs,
    readBytes,
    appendEvent,
    stdinIsTTY = false,
    stdoutIsTTY = false,
  } = options;
  if (!runId || !file) {
    return { exitCode: 1, stdout: 'Usage: swarm manifest review RUN --file FILE\n' };
  }
  const realRoot = path.resolve(root);
  const rel = normPath(file);
  const read =
    readBytes
    ?? (async () => {
      const statePath = path.join(realRoot, '.swarm', 'runs', String(runId), 'state.json');
      const state = JSON.parse(await fsImpl.promises.readFile(statePath, 'utf8'));
      const jobs = (state.jobs ?? []).filter(j => Array.isArray(j.outputs) && j.outputs.includes(rel));
      if (!jobs.length) throw new Error(`run ${runId} does not change ${rel}`);
      const job = jobs[0];
      const p = path.join(realRoot, String(job.workspace ?? ''), rel);
      return { bytes: await fsImpl.promises.readFile(p), previous: null };
    });
  let payload;
  try {
    payload = await read(rel);
  } catch (error) {
    return { exitCode: 1, stdout: `${error.message ?? error}\n` };
  }
  const text = Buffer.from(payload.bytes).toString('utf8');
  const previousText =
    payload.previous != null ? Buffer.from(payload.previous).toString('utf8') : undefined;
  const review = await runManifestReview({
    file: rel,
    text,
    runId,
    reviewerRunId: options.reviewerRunId ?? `review-${runId}`,
    previousText,
    reviewer,
    now,
  });
  if (review.pass) {
    await recordManifestReviewPass(realRoot, review, fsImpl.promises);
    const records = await readManifestReviewRecords(realRoot, fsImpl.promises);
    await tryPolicyManifestApproval({
      root: realRoot,
      file: rel,
      sha256: review.hash,
      project: projectIdFromRoot(realRoot),
      env,
      home: env.HOME ?? process.env.HOME,
      fsImpl,
      now,
      records,
    });
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ status: 'pass', file: rel, sha256: review.hash, reviewerRunId: review.reviewerRunId })}\n`,
    };
  }
  await createManifestReviewInboxItem(realRoot, review, { appendEvent });
  return {
    exitCode: 1,
    stdout: `${JSON.stringify({ status: 'fail', file: rel, sha256: review.hash, findings: review.findings })}\n`,
  };
}

export function defaultReviewerForOpus() {
  return async () =>
    JSON.stringify({ pass: false, findings: [{ rule: 'reviewer', message: 'no model reviewer configured' }] });
}

export { unparsedEcosystem };
