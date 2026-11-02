export function approve(ledger, now) {
  return { ...ledger, approved: { at: now } };
}

export function isApproved(ledger) {
  return Boolean(ledger && ledger.approved && ledger.approved.at);
}
