// SPDX-License-Identifier: Apache-2.0
// Detect shell commands that try to record chat merge approvals or approve hand-build / guard state from an orchestrator session.

export const SELF_APPROVAL_REASON = 'Hand-build guard: approving or denying a hand-build, or switching the guard off, is the owner\'s alone (swarm handbuild approve, or the phone). An orchestrator session cannot approve its own request.';

const MARKERS = [
  /orchestrator-hook(?:\.mjs)?/i,
  /\brecordChatMerge\b/,
  /\bswarm\s+handbuild\s+approve\b/i,
  /\binbox-commands(?:\.mjs)?\b/i,
  /\.swarm\/handbuild\b/,
  /\bnode\b[^\n|;&]*\bswarm\.mjs\b[^\n|;&]*\bdecide\b[^\n|;&]*\bhandbuild-/i,
  /\bswarm\s+decide\s+handbuild-[^\s|;&]+[\s|;&]+approve\b/i,
  /\bswarm\s+decide\s+[^\s|;&]*handbuild-[^\s|;&]+[\s|;&]+approve\b/i,
];

/** Conservative check on raw command text (including nested bash -c / eval / pipes). */
export function isSelfApprovalCommand(commandText) {
  const text = String(commandText ?? '');
  if (!text) return false;
  return MARKERS.some(re => re.test(text));
}
