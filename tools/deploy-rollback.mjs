// SPDX-License-Identifier: Apache-2.0
// Rollback guidance when a post-merge deploy watch fails (R-031, T-0148).

const SAFE_ARG = /^[A-Za-z0-9_@%./+=:,~-]+$/;

/** Render a validated handoff rollback argv for display (not for shell execution). */
export function formatRollbackCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return '';
  return argv
    .map((part) => {
      const s = String(part);
      if (SAFE_ARG.test(s)) return s;
      return `'${s.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

export function rollbackOffer(handoffConfig, reason) {
  const argv = handoffConfig?.rollback;
  const offered = Array.isArray(argv) && argv.length > 0;
  const guidance = offered
    ? `Deploy watch failed (${reason}). Roll back from the project folder: ${formatRollbackCommand(argv)}`
    : `Deploy watch failed (${reason}). Set profile.handoff.rollback with the command that rolls production back.`;
  return { offered, argv: offered ? [...argv] : null, reason, guidance };
}
