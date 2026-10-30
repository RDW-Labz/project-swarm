# Measured failures (2026-10-27, real Chromium, real board, SWARM_COMMAND_CENTER=1, own board server)

## failures

1. Direct load of /command-center/project/<id> (Cockpit): every asset 404s or is refused, page stays blank for 120 s.
   - `Refused to apply style from 'http://127.0.0.1:60585/command-center/project/assets/swarm-ui.css' because its MIME type ('text/plain') is not a supported stylesheet MIME type`
   - same for `assets/cc-phone.css` and `assets/command-center.css`
   - `HTTP 404 http://127.0.0.1:60585/command-center/project/assets/command-center-boot.js`
   - Cause: tools/watch-assets/command-center.html uses relative `assets/...` URLs, which resolve under /command-center/project/.
2. tests/browser/command-center.smoke.mjs hides two real Cockpit crashes:
   - It rewrites the served cc-cockpit-mount.js via page.route so `withGlobalDocument` becomes `return fn();`. The real function assigns `globalThis.document = doc`, which throws in a browser (window.document is read-only).
   - It installs `HTMLCollection.prototype.find` before load. cc-cockpit-mount.js line ~96 calls `blocks.find(...)` on an HTMLCollection, which has no find in browsers.
   - It reaches Cockpit only by clicking a Hive card (client-side route), never by loading the Cockpit URL directly, so failure 1 is never seen.
3. The commit titled "CI job browser-smoke and test:browser script" added no CI job: .github/workflows/ci.yml has no browser job.
