# Command Center design port: shared names (coordinator-owned)

Design source of truth (owner, 2026-10-28): the owner-approved artifact in
`docs/design/reference/command-center-artifact/` (`index.html` slimmed copy plus
screenshots `hive-desktop.png`, `hive-full.png`, `hive-phone.png`, `cockpit-desktop.png`,
`cockpit-phone.png`). The owner's targets `docs/design/reference/hive-target.png` and
`cockpit-target.png` are the bar it was built against.

- Stylesheets, all root-absolute, linked from `tools/watch-assets/command-center.html` in this order:
  1. `/assets/cc-theme.css` (new, Hive job): `@font-face` for the vendored fonts and the shared `:root` tokens copied from the artifact (`--bg --panel --panel2 --line --fg --muted --dim --blue --green --red --amber --violet --cyan --gray --font-head --font-mono --font-serif --font-display --font-body`).
  2. `/assets/swarm-ui.css` (existing)
  3. `/assets/cc-phone.css` (existing)
  4. `/assets/command-center.css` (existing, page-level only)
  5. `/assets/cc-hive.css` (Hive job): every selector scoped under `.hive-body` or `.hive-shell`
  6. `/assets/cc-cockpit.css` (Cockpit job): every selector scoped under `.cc-cockpit-shell`
- The Hive job writes `command-center.html`, `cc-theme.css`, `tools/command-center-snapshot.mjs`, `tools/watch-assets/vendor/VENDOR.json` and `docs/third-party.md`. The Cockpit job never edits those; if it needs a snapshot field that does not exist, it derives it in the browser from the existing payload or names it in its summary.
- Fonts (vendored, CSP allows only 'self'): `tools/watch-assets/vendor/fonts/oxanium-latin-wght-normal.woff2` (Oxanium, variable), `geist-mono-latin-wght-normal.woff2` (Geist Mono, variable), `instrument-serif-latin-400-italic.woff2` (Instrument Serif italic 400), `playfair-display-latin-wght-italic.woff2` (Playfair Display italic, variable). Never link Google Fonts or any other origin.
- Animated status icons: the vendored Fluent Emoji files in `tools/watch-assets/vendor/fluent-emoji/` (the artifact's done/volt/think/sleep/wait icons are byte-identical to `party_popper_56`, `high_voltage_56`, `thinking_face_56`, `sleeping_face_56`, `hourglass_not_done_56`). The artifact's tiny speech-bubble badges (excl, sleep, cross, dots, stars) have no recorded source: draw them with CSS or inline SVG.
- Robot heads: `mountRobotHead` from `tools/watch-assets/robot-head.js` (identical to the artifact's `robot/robot-head.js`).
- CSP: `script-src 'self'` — no inline scripts or inline event handlers; all JS in `/assets/*.js` modules. `img-src 'self' data:`.
- Hooks other code and tests rely on stay: `#command-center-root`, `.hive-shell`, `[data-project-id]` on each Hive project card, `.cc-cockpit-shell`, `#cc-cockpit-main`.
- Real browser rule: no array methods directly on `.children`, `.childNodes`, `getElementsByTagName`/`getElementsByClassName` or `querySelectorAll` results; wrap with `Array.from`.
- Data: real board data only. Drop the artifact's Simulate buttons and its preview-only notes ("Mac mini projects are not connected in this preview"); show real machine and connection state instead.
