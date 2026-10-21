// Field lesson #227: coordination/TASK.md's own ticket sections (`## <id>: <title>`, a `Status:
// ...` line, then a numbered/bulleted list of steps) name the next queued ticket's first step —
// a plain-text scan, never a real markdown parser, same restraint as every other reader here.
export function nextQueuedTicketHint(text) {
  const tickets = [];
  let current = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^##\s+(\S+):\s*(.*)$/.exec(line);
    if (heading) { current = { id: heading[1], title: heading[2].trim(), status: null, steps: [] }; tickets.push(current); continue; }
    if (!current) continue;
    const status = /^status:\s*(.+)$/i.exec(line);
    if (status) { current.status ??= status[1].trim(); continue; }
    const step = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    if (step) current.steps.push(step[1].trim());
  }
  const next = tickets.find(ticket => /queued/i.test(ticket.status ?? '') && ticket.steps.length);
  return next ? { id: next.id, title: next.title, step: next.steps[0] } : null;
}
