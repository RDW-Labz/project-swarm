// SPDX-License-Identifier: Apache-2.0
// Visual QA (T-0218): attach captured screenshot artifacts to the active pull request.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePrArgument } from '../../merge-guard.mjs';

const execFileAsync = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });

export const VISUAL_QA_PR_MARKER = '<!-- swarm-visual-qa-screenshots -->';

async function ghExec(args, { cwd, execFileImpl = execFileAsync }) {
  try {
    const { stdout, stderr } = await execFileImpl('gh', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
    };
  }
}

function rawGitHubImageUrl(repo, sha, relPath) {
  const encoded = relPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `https://raw.githubusercontent.com/${repo}/${sha}/${encoded}`;
}

/**
 * @param {string} repo
 * @param {string} sha
 * @param {{ screenId: string, captureKey: string, viewport: string, path: string }[]} artifacts
 */
export function buildPrCommentBody(repo, sha, artifacts) {
  const lines = [VISUAL_QA_PR_MARKER, '### Visual QA screenshots', ''];
  const byScreen = new Map();
  for (const item of artifacts) {
    if (!byScreen.has(item.screenId)) byScreen.set(item.screenId, []);
    byScreen.get(item.screenId).push(item);
  }
  for (const [screenId, items] of byScreen) {
    lines.push(`#### ${screenId}`);
    for (const item of items) {
      const label = `${item.captureKey} (${item.viewport})`;
      const url = rawGitHubImageUrl(repo, sha, item.path);
      lines.push(`<details><summary>${label}</summary>`, '', `![${screenId} ${label}](${url})`, '', '</details>');
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

/**
 * Attach captured screenshots to the active pull request (markdown images on the PR head commit).
 *
 * @param {string} root
 * @param {{ pr?: string|number, artifacts?: object[], repo?: string, deps?: object }} [options]
 */
export async function attachScreenshotsToPullRequest(root, { pr, artifacts = [], repo: repoOption, deps = {} } = {}) {
  const events = [];
  const record = (kind, detail) => { events.push({ at: new Date().toISOString(), kind, ...detail }); };
  const flushOnFailure = (error) => {
    if (error) {
      process.stderr.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    }
  };

  try {
    if (!artifacts.length) throw fail('visual-qa-attach', 'no screenshot artifacts to attach');
    const execFileImpl = deps.execFile ?? execFileAsync;
    const gh = deps.gh ?? ((args) => ghExec(args, { cwd: root, execFileImpl }));

    let prNumber = null;
    let repo = deps.repo ?? repoOption ?? null;
    if (pr !== undefined && pr !== null) {
      const parsed = parsePrArgument(String(pr));
      if (!parsed) throw fail('visual-qa-attach', 'invalid pr argument');
      prNumber = parsed.number;
      repo = parsed.repo ?? repo;
    }

    const viewArgs = ['pr', 'view'];
    if (prNumber) viewArgs.push(String(prNumber));
    if (repo) viewArgs.push('--repo', repo);
    viewArgs.push('--json', 'number,headRefOid,headRepository');
    const view = await gh(viewArgs);
    if (view.code !== 0) throw fail('visual-qa-attach', `gh pr view failed: ${view.stderr.trim().split('\n')[0] || 'error'}`);
    let prJson;
    try { prJson = JSON.parse(view.stdout); } catch {
      throw fail('visual-qa-attach', 'gh pr view returned unreadable json');
    }
    prNumber = prNumber ?? prJson.number;
    const sha = prJson.headRefOid;
    const fullRepo = repo ?? prJson.headRepository?.nameWithOwner;
    if (!prNumber || !sha || !fullRepo) throw fail('visual-qa-attach', 'could not resolve pr number, head sha or repository');

    const body = buildPrCommentBody(fullRepo, sha, artifacts);
    record('attach', { pr: prNumber, repo: fullRepo, sha, count: artifacts.length });
    const comment = await gh(['pr', 'comment', String(prNumber), '--repo', fullRepo, '--body', body]);
    if (comment.code !== 0) {
      throw fail('visual-qa-attach', `gh pr comment failed: ${comment.stderr.trim().split('\n')[0] || 'error'}`);
    }
    return { ok: true, pr: prNumber, repo: fullRepo, sha, artifactCount: artifacts.length };
  } catch (error) {
    flushOnFailure(error);
    throw error;
  }
}
