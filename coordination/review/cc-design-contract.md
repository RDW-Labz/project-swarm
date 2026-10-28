# Command Center design port: shared names (coordinator-owned)

- Stylesheets, all root-absolute, linked from `tools/watch-assets/command-center.html` in this order:
  1. `/assets/swarm-ui.css` (existing)
  2. `/assets/cc-phone.css` (existing)
  3. `/assets/command-center.css` (existing, page-level only: body background, root container)
  4. `/assets/cc-hive.css` (new, Hive job): every selector scoped under `.hive-body` or `.hive-shell`
  5. `/assets/cc-cockpit.css` (new, Cockpit job): every selector scoped under `.cc-cockpit-shell`
- The Hive job writes `command-center.html` (adds links 4 and 5). The Cockpit job never edits it.
- Shared design tokens: each job copies the CSS custom properties it needs from `docs/design/command-center-mockup/shared.css` into its own file, under its own scope. Neither job edits `command-center.css`, `swarm-ui.css` or `cc-phone.css`.
- Existing hooks other code and tests depend on stay unchanged: `#command-center-root`, `.hive-shell`, `[data-project-id]` on each Hive project card, `.cc-cockpit-shell`, `#cc-cockpit-main`.
- Real browser rule: no array methods directly on `.children`, `.childNodes`, `getElementsByTagName`/`getElementsByClassName` or `querySelectorAll` results; wrap with `Array.from`.
