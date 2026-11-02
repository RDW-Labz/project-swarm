# Rendered check for UI tickets (lesson 27)

Lesson 27: workers wrote fonts and styles that were never wired into the app (the stylesheet was never imported, font variables shadowed the real ones, Tailwind was inactive), and every "done" UI ticket passed text-only tests. This adds a check that renders the page in a real browser, takes a screenshot, and compares the page with the design mockup.

## Profile block `ui`

```
ui: { baseUrl?: 'http://127.0.0.1:3000' (http only, host 127.0.0.1, localhost or [::1], default http://127.0.0.1:3000),
      start?: [argv] (starts the dev server when baseUrl does not answer; same rules as ci hook argv; its script files are protected paths and the package.json script it runs is guarded by the gate),
      readyPath?: '/' (default), timeoutSec?: 30 to 600 (default 120),
      viewport?: { width: 200 to 2000, height: 200 to 4000 } (default 390 x 844),
      screens: [{ id (kebab, 2 to 40), route ('/...' path, at most 200 chars, no '..' and no scheme), mockup (repo-relative path of the mockup HTML file), viewport?, minScore?: 0.3 to 0.99 (default 0.7), text?: 0 to 1 (min share of the mockup's words found, default 0.5) }] (1 to 60) }
```

Unknown keys, duplicate ids and absolute or `..` mockup paths are errors.

## Metrics (what the browser script reports for a page)

`{ viewportWidth, scrollWidth, bodyFont (first family of body), bodyMargin, fonts: [first family of every visible text element, unique], colors: [text colors, unique], backgrounds: [non-transparent background colors, unique], words: [lower-case words of 4 or more letters in the visible text, unique, at most 400], styled: boolean }`. `styled` is false when the page looks like browser defaults: body font family is a default serif (`Times`, `Times New Roman`, `serif`) with body margin `8px` and no non-transparent background anywhere.

## `tools/png-signature.mjs`

- `decodePng(buffer)` decodes 8-bit, non-interlaced PNG (color types 0, 2, 3 with PLTE and tRNS ignored for alpha, 4, 6) with zlib, filters 0 to 4; returns `{ width, height, data }` (`data` is a `Uint8Array` of RGBA); throws `Error` with `code: 'png-unsupported'` for anything else (interlaced, 16-bit), `png-invalid` for a bad signature, bad chunk or CRC, or too little pixel data; limits: width at most 4096, height at most 20000, input at most 20 MB.
- `gridSignature(image, { cols = 24, rows = 48 } = {})` returns `{ cols, rows, cells: Float32Array(cols * rows * 3) }`: the mean R, G, B (0 to 255) of each cell of an even grid over the image, with alpha composited on white.
- `compareSignatures(a, b)` throws `Error` (`code: 'signature-mismatch'`) when the grids differ in size; returns `{ score, meanDiff }` where `meanDiff` is the mean absolute difference over all cell channels and `score = 1 - meanDiff / 255` (1 means identical, a blank page against a full mockup is low).

## `tools/ui-compare.mjs`

- `UI_DEFAULTS` (frozen): `{ baseUrl, readyPath: '/', timeoutSec: 120, viewport: { width: 390, height: 844 }, minScore: 0.7, text: 0.5 }`.
- `validateUiConfig(raw)` returns `{ config, errors }` (`config` with defaults filled and screens copied; `{}` config when there are errors; `undefined` raw gives `{ config: null, errors: [] }`), rules above. The `start` argv follows these rules: 1 to 20 strings, argv[0] a program name or relative path (no absolute path), no empty items, no NUL.
- `compareScreen({ mockup, page, visual }, { minScore, text })` takes the two metrics objects and the visual `score` of `compareSignatures`, and returns `{ pass, score: visual, reasons: [string], parts }`. Hard failures (each adds a reason and makes `pass` false): `unstyled` (the page's `styled` is false while the mockup's is true), `font-missing: <names>` (the mockup's fonts, except generic ones: `Arial`, `Helvetica`, `Times`, `serif`, `sans-serif`, `monospace`, `system-ui`, `-apple-system`, `Segoe UI`, `Roboto`, `ui-sans-serif`, `ui-serif`, `ui-monospace`, that are not among the page's fonts; compare case-insensitively and ignore a font-loader hash in the page's names (a family like `__Figtree_a1b2c3` or `Figtree Fallback` counts as `Figtree`)), `horizontal-overflow` (the page's `scrollWidth` is more than 2 pixels above its `viewportWidth`), `text-mismatch: <share>` (the share of the mockup's words that also appear in the page's words is under `text`; skipped when the mockup has fewer than 5 words), `colors-missing: <share>` (fewer than 40 percent of the mockup's distinct background and text colors appear among the page's colors within a per-channel distance of 12; skipped when the mockup has fewer than 3 colors), `visual: <score>` (the visual score is under `minScore`). `parts` is `{ visual, text, colors, fonts: { missing: [...] } }` with the numbers that were computed (null when skipped).

## Command: `swarm ui check [SCREEN_ID...] [--base-url URL]` and `swarm ui list`

`tools/ui-check.mjs` runs the profile's screens (all, or the ids given): it starts the dev server when `baseUrl` does not answer (the profile's `start` argv, detached, a minimal environment, killed with its process group afterwards), writes a small browser script into a temporary folder and runs it with node and the project's own `playwright` package (resolved from the project, so the swarm itself has no dependency), which for each screen opens the mockup file and the page at `baseUrl + route` at the viewport, waits for load, takes both screenshots, reads the metrics, then compares. It writes `.swarm/ui/<id>/mockup.png`, `page.png`, `report.json` and `.swarm/ui/results.json` (`{ at, head, screens: { id: { pass, score, reasons, parts } } }`), prints one line per screen, and exits 1 when a screen fails or the check could not run. `--base-url` must be an http URL on 127.0.0.1, localhost or [::1]. The mockup path must stay inside the project (checked with the real path, no symlinks).

## Tickets

- A ticket may carry `screens: [ids]` (kebab ids, at most 5): the design screens it renders. `screens` is part of the ticket-set hash. The split prompt asks for it on UI tickets, and a UI ticket's job context gets the mockup files of its screens.
- A UI ticket's prompt says: `Import your styles in the app entry (the layout) and use the design tokens; the runner renders the page and compares it with the mockup: fonts, colors, text and layout must match.`
- `scope sync RUN --integrated` marks a ticket with `screens` done only when the profile has a `ui` block and `.swarm/ui/results.json` says every one of its screens passed at or after the run's `integratedAt`; otherwise it stays in review and the message says to run `swarm ui check`.
