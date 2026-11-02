# Rendered check for UI tickets

A UI ticket can pass every text test and still be wrong on screen: fonts named but never loaded, a stylesheet never imported, Tailwind not active. `swarm ui check` renders the real page and the design mockup in a browser, takes screenshots, and compares them. Design: [ui-check-design.md](plans/ui-check-design.md).

## Setup (profile in `.project-swarm.json`)

```json
"ui": {
  "baseUrl": "http://127.0.0.1:3000",
  "start": ["npm", "run", "dev"],
  "screens": [
    { "id": "form-contact", "route": "/r/tennison", "mockup": "docs/design/screens/FormContact.dc.html" },
    { "id": "dashboard", "route": "/dashboard", "mockup": "docs/design/screens/Dashboard.dc.html", "minScore": 0.65 }
  ]
}
```

The project needs its own Playwright (`npm install -D @playwright/test`, `npx playwright install chromium`); the swarm has no browser dependency. If nothing answers at `baseUrl`, the profile's `start` command is run (detached, minimal environment) and stopped afterwards. `baseUrl` must be on this machine (http, 127.0.0.1, localhost or [::1]); the mockup must be a plain project file (no symlink, not a secret or protected path). The script a `start` command runs is protected like a hook's files, and the gate blocks changes to the `package.json` script it runs.

## Use

`swarm ui check [SCREEN_ID...] [--base-url URL] [--json]` renders each screen (all, or the ids given) at the viewport (default 390 x 844), writes `.swarm/ui/<id>/mockup.png`, `page.png` and `report.json`, and `.swarm/ui/results.json`, prints a line per screen and exits 1 when one fails. `swarm ui list` shows the configured screens. Screenshots are for you to look at; the verdict comes from these rules:

- **fonts:** every font the mockup uses (generic ones like Arial or system-ui excluded) must appear on the page (a font-loader hash in the name is ignored): catches font variables that are named but never loaded;
- **unstyled:** the page must not look like browser defaults while the mockup is styled;
- **horizontal overflow** at the viewport width;
- **text:** at least 50 percent of the mockup's words appear on the page (`text` per screen to change);
- **colors:** at least 40 percent of the mockup's text and background colors appear on the page;
- **visual:** a coarse comparison of the two screenshots (where the text and boxes are, and the colors) must reach `minScore` (default 0.7). On the parts app's own mockups: the same layout in another font scores about 0.85, another screen of the same app about 0.66, an unstyled copy about 0.31, a blank page about 0.19.

On the parts app today (real run): both screens fail with font-missing (the page uses `displayFont`, `bodyFont`, `monoFont`, not the design's families), text-mismatch and missing colors, which is exactly lesson 27.

## In tickets

A UI ticket lists `screens: [ids]`. Its worker gets the mockup files of those screens as context and the line "Import your styles in the app entry and use the design tokens; the runner renders the page and compares it with the mockup". `swarm scope sync RUN --integrated` marks a ticket with `screens` done only when `swarm ui check` passed for each of its screens after the run was integrated (otherwise it stays in review and the message says to run the check). Run the check from your smoke hook (`ci.smoke`: `["swarm", "ui", "check"]`) to get it after every green batch, with a fix ticket when it fails.

## What the verdict is bound to

`.swarm/ui/results.json` records, per screen, the verdict, the time, a fingerprint of the code state (HEAD plus every changed or untracked file, generated folders left out) and whether the check started the dev server itself. `scope sync --integrated` accepts a screen only when the verdict is a pass made after the integration, not dated in the future, about exactly the code that is there now, and (when the profile has a `start` command) from a server the check started: a server that was already running may be serving other code. Any change to the project after the check makes the evidence stale: run the check again. The design mockups are protected paths (a ticket cannot edit what a page is compared with); only jobs that render those screens may read them. The browser only loads documents from this machine and the mockup file (a page cannot navigate away); images and fonts a page references are fetched like in any browser. The page's own JavaScript is project code and runs with the project's trust: a page that overrides browser functions can fake its own measurements, so look at the screenshots too.

## Own server, free port, more than one state (lesson 31)

- With `ui.start` set, the check always starts its **own** server on a free port: write `{port}` in the argv (or read the `PORT` variable) and the check uses that address. A server already running at `baseUrl` (yours, maybe with other code) is never used, so the evidence `scope sync` needs (`serverStarted: true`) is always honest. `--base-url URL` still means "use what answers there".
- A page with several states is several screens: give each the same `mockup`, a `route` that shows the state (`/wizard?step=2` or a test route), and `mockupQuery` for the matching state of the mockup file (`"mockupQuery": "step=2"`, letters, digits and `_ = & . -`). `waitFor` is a CSS selector awaited (15 seconds) before each screenshot (`"waitFor": "#ready"`).
