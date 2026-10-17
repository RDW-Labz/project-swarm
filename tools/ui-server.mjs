// SPDX-License-Identifier: Apache-2.0
import net from 'node:net';

const MOCKUP_QUERY_RE = /^[A-Za-z0-9_=&.-]{1,100}$/;
const WAIT_FOR_RE = /^[A-Za-z0-9_#.\[\]=" -]+$/;

// Returns a free TCP port on 127.0.0.1 by listening on port 0 and closing.
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Returns a copy of argv with every {port} replaced by the port as text.
export function expandStart(argv, port) {
  const text = String(port);
  return argv.map((item) =>
    typeof item === 'string' ? item.split('{port}').join(text) : item
  );
}

// Returns env plus PORT and SWARM_UI_PORT set to the port.
export function startEnv(port, env = {}) {
  return { ...env, PORT: String(port), SWARM_UI_PORT: String(port) };
}

// Returns the base url joined with the screen route.
export function screenUrl(base, screen) {
  return base + screen.route;
}

// Returns the query suffix for a screen's mockupQuery, or '' when absent.
export function mockupUrlSuffix(screen) {
  const query = screen ? screen.mockupQuery : undefined;
  if (query === undefined || query === null) return '';
  if (typeof query !== 'string' || query.includes('#') || !MOCKUP_QUERY_RE.test(query)) {
    throw new Error('invalid mockupQuery');
  }
  return '?' + query;
}

// True for a string of 1 to 100 characters made of allowed selector characters.
export function validWaitFor(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100 && WAIT_FOR_RE.test(value);
}
