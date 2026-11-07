// Ticket T-0269 (AC1): cloud burst runner registry with heartbeat leases.
// A lease whose runner has missed heartbeats for HEARTBEAT_TIMEOUT_MS is returned
// to the local queue so a local worker can dequeue the ticket.

export const HEARTBEAT_TIMEOUT_MS = 120000;
const BURST_TAG = "lane:burst";

/**
 * @typedef {{ id: string, tags: string[] }} Ticket
 * @typedef {{ enqueue: (ticket: Ticket) => void }} LocalQueue
 * @typedef {{ write: (event: object) => void }} EventSink
 */

/**
 * @param {{ localQueue: LocalQueue, events: EventSink, now?: () => number }} options
 */
export function createBurstRunner({ localQueue, events, now = () => Date.now() }) {
  /** @type {Map<string, { lastBeat: number, tickets: Map<string, Ticket> }>} */
  const runners = new Map();

  /** @param {string} runnerId */
  function register(runnerId) {
    if (typeof runnerId !== "string" || runnerId.length === 0) {
      throw new Error("runnerId must be a non-empty string");
    }
    runners.set(runnerId, { lastBeat: now(), tickets: new Map() });
  }

  /** @param {string} runnerId */
  function heartbeat(runnerId) {
    const runner = runners.get(runnerId);
    if (!runner) throw new Error(`unknown runner: ${runnerId}`);
    runner.lastBeat = now();
  }

  /**
   * @param {string} runnerId
   * @param {Ticket} ticket
   */
  function lease(runnerId, ticket) {
    const runner = runners.get(runnerId);
    if (!runner) throw new Error(`unknown runner: ${runnerId}`);
    if (!ticket.tags.includes(BURST_TAG)) {
      throw new Error(`ticket ${ticket.id} is not tagged ${BURST_TAG}`);
    }
    runner.tickets.set(ticket.id, ticket);
  }

  /**
   * Records completion for a leased ticket and releases the lease.
   * @param {string} runnerId
   * @param {string} ticketId
   * @param {object} outcome
   */
  function complete(runnerId, ticketId, outcome) {
    const runner = runners.get(runnerId);
    if (!runner || !runner.tickets.has(ticketId)) {
      throw new Error(`no lease for ${ticketId} on ${runnerId}`);
    }
    runner.tickets.delete(ticketId);
    events.write({ type: "burst.completed", ticketId, runnerId, outcome, at: now() });
  }

  /**
   * Returns leases of silent runners to the local queue.
   * @returns {number} number of tickets returned
   */
  function sweep() {
    const current = now();
    let returned = 0;
    for (const [runnerId, runner] of runners) {
      if (current - runner.lastBeat < HEARTBEAT_TIMEOUT_MS) continue;
      for (const ticket of runner.tickets.values()) {
        localQueue.enqueue({
          id: ticket.id,
          tags: ticket.tags.filter((tag) => tag !== BURST_TAG),
        });
        events.write({ type: "burst.lease_returned", ticketId: ticket.id, runnerId, at: current });
        returned += 1;
      }
      runners.delete(runnerId);
    }
    return returned;
  }

  return { register, heartbeat, lease, complete, sweep };
}
