// SPDX-License-Identifier: Apache-2.0
// T52b: a tiny stand-in for desktop-app's tests/fakeService.ts, just enough to back the scout's
// proved Home scenario. `setOrbState` is the fake service's own method a scenario's `setup` calls
// by name (`{"call":"setOrbState","args":[...]}`); `handleRequest` answers the fixture page's own
// `/orb` fetch, bearer-token-gated on exactly the token `verify-orb.mjs` generated for this run.
const ORB_STATES = {
  proposal_ready: { lampLook: 'ready', message: 'Something needs you' },
};

export function createFakeService({ token } = {}) {
  let lampLook = 'idle';
  let message = '';
  return {
    setOrbState(state) {
      const mapped = ORB_STATES[state] ?? { lampLook: 'idle', message: '' };
      lampLook = mapped.lampLook;
      message = mapped.message;
    },
    handleRequest(request, response) {
      if (request.url !== '/orb') { response.writeHead(404); response.end(); return; }
      if ((request.headers.authorization ?? '') !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ lampLook, message }));
    },
  };
}
