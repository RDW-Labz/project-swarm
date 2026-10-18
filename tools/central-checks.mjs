// SPDX-License-Identifier: Apache-2.0
// Parts-app lesson 52: a worker wrote correct files but reported "blocked" because it could not run a check (no shell, tests not allowed,
// a tool missing from its sandbox), and the orchestrator copied the files by hand. A blocked report that is ONLY about not being able to
// run a check, with every declared output written, is a finished job whose checks the swarm runs centrally after the write (integrate runs the
// manifest's checks on the real checkout). A block about anything else (a needed file, a rule it cannot meet, a missing output) stays blocked.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CANNOT = /\b(?:cannot|can't|can not|could not|couldn't|unable to|not able to|no way to|not allowed to|not permitted to|no shell|without (?:a )?shell|(?:do(?:es)? not|don't|doesn't) have (?:a )?shell)\b/i;
const RUN = /\b(?:run|running|execute|executing|invoke|invoking|launch|start|starting|verify|verifying)\b|\bno shell\b|\bwithout (?:a )?shell\b|\bshell\b/i;
const CHECK = /\b(?:tests?|test suite|checks?|lint(?:er|ing)?|typecheck(?:ing)?|tsc|eslint|prettier|jest|vitest|pytest|mocha|npm|pnpm|yarn|node --test|build|compile|compiler|ci)\b/i;
// Anything that says the block is about something other than running a check. Tested on the ORIGINAL sentence (never after cutting words out),
// so "I need src/a.mjs" or "cannot write x" or "requires DATABASE_URL" keeps the job blocked even next to "cannot run the tests".
const SUBSTANTIVE = /\b(?:need|needs|needed|require|requires|required|missing|credentials?|secrets?|tokens?|api[ _-]?keys?|passwords?|env(?:ironment)?|DATABASE_URL|permissions?|denied|forbidden|conflicts?|conflicting|depends?|dependency|dependencies|blocked on|waiting for|outside|contract|rules?|spec|install|network|offline|database|server)\b|\b(?:cannot|can't|can not|could not|couldn't|unable to|not able to|not allowed to|not permitted to)\s+(?:\w+\s+){0,2}(?:write|edit|create|modify|change|read|access|find|open|delete)\b/i;
const PROGRESS = /\b(?:wrote|written|created|updated|done|complete|completed|finished|implemented|added|saved|ready)\b/i;
const NEGATED = /\b(?:not|never|no|nothing|none|nowhere|nobody|didn't|did not|wasn't|weren't|isn't|aren't|hasn't|haven't|couldn't|cannot|can't|unable)\b/i;

const sentences = text => text.split(/(?<=[.;!?])\s+|\n+/).map(part => part.trim()).filter(Boolean);
const cannotRunCheck = sentence => CANNOT.test(sentence) && RUN.test(sentence) && CHECK.test(sentence);

// reply: the worker's parsed {status:'blocked', summary, file}. True only for a check-only block: every sentence of the summary is either a
// "could not run a check" sentence or plain progress ("files written"); one substantive sentence of any other kind keeps the job blocked.
export function isCheckOnlyBlock(reply) {
  if (!reply || reply.status !== 'blocked') return false;
  if (typeof reply.file === 'string' && reply.file.trim()) return false; // it names a file it needs: a real block
  const text = typeof reply.summary === 'string' ? reply.summary : '';
  if (!text.trim() || text.length > 1500) return false;
  const parts = sentences(text);
  if (!parts.some(cannotRunCheck)) return false;
  return parts.every(sentence => {
    if (SUBSTANTIVE.test(sentence)) return false;
    return cannotRunCheck(sentence) || (PROGRESS.test(sentence) && !NEGATED.test(sentence.replace(/\bno shell\b/ig, '')));
  });
}

// Every declared output must be a real file (never a symlink), non-empty, and different from what the workspace started with: a worker that
// wrote nothing cannot be turned into "complete" by what it says about the tests. baseHashes: file -> sha256 of the file at the start, or null.
export async function allOutputsWritten(workspaceRoot, outputs, baseHashes = {}) {
  if (!Array.isArray(outputs) || !outputs.length) return false;
  for (const file of outputs) {
    try {
      const target = path.join(workspaceRoot, file);
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.size === 0) return false;
      const base = baseHashes?.[file];
      if (typeof base === 'string' && createHash('sha256').update(await fs.readFile(target)).digest('hex') === base) return false;
    } catch { return false; }
  }
  return true;
}

// Worker text is untrusted: no control or bidi characters reach a warning.
export const safeReason = text => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// Jobs of a run whose checks were deferred to the central run, for the integrate warning.
export function deferredCheckWarnings({ state, manifest, noChecks, jobs: only = null }) {
  const jobs = (state.jobs ?? []).filter(record => record.checksDeferred && (!only || only.includes(record.id)));
  if (!jobs.length) return [];
  const none = noChecks || !(manifest.checks ?? []).length;
  return jobs.map(record => none
    ? `checks-not-run: ${record.id} could not run its own checks (${record.checksDeferred.reason}) and the swarm is not running any either (${noChecks ? '--no-checks' : 'the manifest has no checks'}); nothing verified these files`
    : `checks-run-centrally: ${record.id} could not run its own checks (${record.checksDeferred.reason}); the swarm runs the manifest checks on the integrated files instead`);
}
