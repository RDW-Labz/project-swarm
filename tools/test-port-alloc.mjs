import net from 'node:net';

function listenOnFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('no TCP address assigned')));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Allocate `count` distinct free TCP ports. All ports are held open at the same
 * time while allocating so the OS cannot hand out the same port twice.
 * Returns { ok: true, ports } or { ok: false, reason, ports: [] }.
 */
export async function allocatePorts(count, options = {}) {
  const host = options.host ?? '127.0.0.1';
  const maxAttempts = options.maxAttempts ?? count * 4 + 4;
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, reason: `invalid port count: ${String(count)}`, ports: [] };
  }
  const held = [];
  const seen = new Set();
  let failure = null;
  try {
    for (let attempt = 0; attempt < maxAttempts && seen.size < count; attempt += 1) {
      let entry;
      try {
        entry = await listenOnFreePort(host);
      } catch (error) {
        failure = `port allocation failed: ${error && error.message ? error.message : String(error)}`;
        break;
      }
      if (seen.has(entry.port)) {
        await closeServer(entry.server);
        continue;
      }
      seen.add(entry.port);
      held.push(entry);
    }
    if (!failure && seen.size < count) {
      failure = `could not allocate ${count} distinct ports (got ${seen.size})`;
    }
    if (failure) return { ok: false, reason: failure, ports: [] };
    return { ok: true, ports: held.map((e) => e.port) };
  } finally {
    await Promise.all(held.map((e) => closeServer(e.server)));
  }
}
