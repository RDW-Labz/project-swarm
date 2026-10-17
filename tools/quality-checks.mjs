// SPDX-License-Identifier: Apache-2.0

export function deriveQualityChecks({ pkg, hasTsconfig, manager = 'npm', config = {} } = {}) {
  const scripts = (pkg && pkg.scripts) || {};
  const cfg = config || {};
  const run = (script) => [manager, 'run', script];
  const out = [];

  let typecheck = null;
  if (cfg.typecheck === false) {
    typecheck = null;
  } else if (Array.isArray(cfg.typecheck)) {
    typecheck = cfg.typecheck.slice();
  } else if (scripts.typecheck) {
    typecheck = run('typecheck');
  } else if (scripts['type-check']) {
    typecheck = run('type-check');
  } else if (hasTsconfig) {
    typecheck = ['npx', 'tsc', '--noEmit'];
  }
  if (typecheck) out.push({ name: 'typecheck', argv: typecheck });

  let lint = null;
  if (cfg.lint === false) {
    lint = null;
  } else if (Array.isArray(cfg.lint)) {
    lint = cfg.lint.slice();
  } else if (scripts.lint) {
    lint = run('lint');
  }
  if (lint) out.push({ name: 'lint', argv: lint });

  let build = null;
  if (Array.isArray(cfg.build)) {
    build = cfg.build.slice();
  } else if (cfg.build === true && scripts.build) {
    build = run('build');
  }
  if (build) out.push({ name: 'build', argv: build });

  return out;
}

export function qualityChecksForJobs(jobs, derived, { timeoutMs = 600000 } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.some((job) => job && job.type === 'build')) return [];
  return (derived || []).map((check) => ({
    name: check.name,
    argv: [...check.argv],
    timeoutMs,
  }));
}

function jobIdOf(entry) {
  if (entry && typeof entry === 'object') return entry.id;
  return entry;
}

function findCheckResult(results, name) {
  if (Array.isArray(results)) {
    return results.find((r) => r && r.name === name);
  }
  if (results && typeof results === 'object') {
    return results[name];
  }
  return undefined;
}

export function qualityEvidence(state, jobId, names) {
  const list = Array.isArray(names) ? names : [];
  if (list.length === 0) {
    return { ok: true, reason: 'no quality checks configured' };
  }

  const mq = (state && state.mergeQueue) || {};
  const batches = Array.isArray(mq.batches) ? mq.batches : [];
  const integratedIn = mq.integratedIn || {};

  let batch;
  if (integratedIn[jobId] !== undefined && integratedIn[jobId] !== null) {
    const batchId = integratedIn[jobId];
    batch = batches.find((b) => b && b.id === batchId);
  } else {
    for (let i = batches.length - 1; i >= 0; i -= 1) {
      const b = batches[i];
      const jobs = (b && Array.isArray(b.jobs)) ? b.jobs : (b && Array.isArray(b.jobIds)) ? b.jobIds : [];
      if (jobs.some((entry) => jobIdOf(entry) === jobId)) {
        batch = b;
        break;
      }
    }
  }

  if (!batch) {
    return { ok: false, reason: `no merge batch for job ${jobId}` };
  }

  const batchId = batch.id;
  if (batch.security === 'blocked') {
    return { ok: false, reason: `batch ${batch.id} was blocked by the security gate` };
  }
  if (batch.checks !== 'passed') {
    return { ok: false, reason: `batch ${batchId} checks are ${batch.checks}` };
  }

  for (const name of list) {
    const result = findCheckResult(batch.checkResults, name);
    if (!result) {
      return { ok: false, reason: `no ${name} check ran in batch ${batchId}` };
    }
    if (result.status !== 'passed') {
      return { ok: false, reason: `${name} check is ${result.status} in batch ${batchId}` };
    }
  }

  return { ok: true, reason: `quality checks passed in batch ${batchId}` };
}
