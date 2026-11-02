export function toJob(ticket, inSet) {
  return { id: ticket.id, title: ticket.title, after: ticket.dependsOn.slice() };
}
