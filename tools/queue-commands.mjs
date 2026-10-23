// SPDX-License-Identifier: Apache-2.0
// `swarm queue claim|release`: single-machine lease claim and expired-lease sweep (cluster queue CLI).
import { claim, sweepExpiredLeases } from './ledger-lease.mjs';
import { getNodeId } from './node-identity.mjs';

const USAGE = 'Usage: swarm queue claim TICKET | swarm queue release --expired\n';

export async function runQueueCommand(root, args, { env = process.env, home, now = Date.now } = {}) {
  const at = () => (typeof now === 'function' ? now() : now);
  try {
    if (args[0] === 'claim') {
      if (args.length !== 2 || args[1].startsWith('-')) return { stdout: USAGE, exitCode: 1 };
      const ticketId = args[1];
      const holderId = await getNodeId({ env, home: home ?? env.HOME });
      const result = await claim(root, ticketId, holderId, { now: at() });
      return { stdout: `claimed ${result.ticketId} for ${result.holderId}\n`, exitCode: 0 };
    }
    if (args[0] === 'release') {
      if (args.length !== 2 || args[1] !== '--expired') return { stdout: USAGE, exitCode: 1 };
      const { swept } = await sweepExpiredLeases(root, { now: at() });
      if (!swept.length) return { stdout: 'no expired leases to release\n', exitCode: 0 };
      return { stdout: `released expired: ${swept.join(', ')}\n`, exitCode: 0 };
    }
    return { stdout: USAGE, exitCode: 1 };
  } catch (error) {
    if (error.code === 'lease-held') {
      return { stdout: `claim rejected: ${error.message}\n`, exitCode: 1 };
    }
    return { stdout: `${String(error.message ?? error).split('\n')[0]}\n`, exitCode: 1 };
  }
}
