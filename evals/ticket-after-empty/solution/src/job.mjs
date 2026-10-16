export function toJob(ticket, inSet) {
  const after = (ticket.dependsOn ?? []).filter((id) => inSet.has(id));
  const job = { id: ticket.id, title: ticket.title };
  if (after.length > 0) job.after = after;
  return job;
}
