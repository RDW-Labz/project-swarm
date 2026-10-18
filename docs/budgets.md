# Speed and accessibility budgets

Spec: A2 in [plans/swarm-more-upgrades-spec.md](plans/swarm-more-upgrades-spec.md). On a preview deploy, Lighthouse and axe run on the key screens and the scores are held against budgets. A failure becomes a fix ticket and blocks only the pull request that finishes the last stage.

## Set it up

Add a `budgets` block to the project profile (`.project-swarm.json`):

```json
"budgets": {
  "performance": 85,
  "accessibility": 95,
  "axeBlock": ["serious", "critical"],
  "previewHosts": ["*.vercel.app"],
  "screens": [{ "id": "home", "path": "/" }, { "id": "checkout", "path": "/checkout" }],
  "lighthouse": { "argv": ["npx", "lighthouse@12", "{url}", "--output=json", "--output-path={out}", "--quiet", "--chrome-flags=--headless"], "timeoutSec": 300 },
  "axe": { "argv": ["npx", "@axe-core/cli@4", "{url}", "--save", "{out}"], "timeoutSec": 300 }
}
```

- Scores are whole numbers 0 to 100 (`performance`, `accessibility`, `bestPractices`, `seo`); with none set the budgets are performance 85 and accessibility 95. `axeBlock` lists the axe impacts that fail a screen (default serious and critical). Up to 10 screens.
- The two commands are yours: each must contain `{url}` and `{out}` (the tool writes its JSON report there), must not be a shell or a production command, and any script they run becomes a protected path (a worker cannot edit what measures it). The defaults above are used when `lighthouse` or `axe` is left out; **they were not run against a real site when this was built**, so check them once with `swarm budgets check`.
- `previewHosts` (for example `*.vercel.app`) lists the hosts a preview address taken from the deploy log may have. The log is text that build code can write, so **without `previewHosts` the automatic run after a preview measures nothing** (it warns `budgets-skipped`); `swarm budgets check --url` always measures the address you give it.
- The address must be an `https` preview or a local `http://127.0.0.1` / `localhost` server, with no credentials in it.

## What happens

- **On a preview deploy:** when the `ci.preview` hook (see [ci-hooks.md](ci-hooks.md)) passes and prints its URL, the swarm runs both tools on every screen. A screen that fails, or whose tool could not run (no Chrome, a timeout), is recorded as failing: a tool that cannot run is never a pass. Each failing screen gets one fix ticket for the batch's files (not another while the first is open), and a `budgets-failed` warning.
- **By hand:** `swarm budgets check --url PREVIEW_URL [--screens home,cart]` runs the same check and records it (no ticket, because a hand check names no files). `swarm budgets status` shows the latest result per screen.
- **A tool that did not really measure is never a pass:** a missing or empty axe result, a Lighthouse runtime error, an error-status page, or a redirect to another host is `cannot-run`.
- **The block:** `swarm ship` refuses with `budgets-failing` only for the PR that finishes the last stage: every ticket of the highest stage is done or in review (fix tickets and proposals do not count) **and this run holds one of those tickets**. Earlier PRs, hotfixes and the fix-ticket PR pass. It refuses while a screen listed in the profile has a failing (or could-not-run) latest result, or was never measured. A screen that is no longer in the profile cannot block.
- **Ways out:** fix the screen and run `swarm budgets check` again (a passing run clears it), or accept a failure with a reason: `swarm budgets accept SCREEN --reason TEXT --yes` (logged; it lasts until the screen's next measurement).
- State is in `.swarm/project/budgets.json`; a result only replaces an older one.
