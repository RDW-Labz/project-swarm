// SPDX-License-Identifier: Apache-2.0

export function warnUntrackedContext(contextPaths, trackedPaths) {
  const tracked = new Set(trackedPaths);
  const warnings = [];
  for (const contextPath of contextPaths) {
    if (tracked.has(contextPath)) continue;
    warnings.push(
      `${contextPath}: Cursor and Codex see the committed files only; this file must be committed first.`,
    );
  }
  return warnings;
}
