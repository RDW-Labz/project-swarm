# Setting up a new project

The exact steps, in order. Each step says what to run and what you should see. Nothing here spends money until step 8 and the cap in step 4 is already in place. `P` is the project's folder.

## 0. Check first (once per machine)

```sh
swarm --version                     # the version you installed; swarm update refuses while work is running
swarm watch --all --text            # "No live runs" before you change anything machine-wide
swarm doctor all                    # every lane: claude, codex, cursor, anthropic... "compatible" or "configured"
```

- **The machine config** is `~/.config/project-swarm/config.json` (outside every git repo; the runner refuses a config inside one). It names a model for every lane you want used. A lane with no model string is never routed to. Example (no keys in it; keys live in the keychain or environment):

  ```json
  {
    "machineConcurrency": 4,
    "lanes": {
      "cursor":    { "model": "composer-2.5" },
      "codex":     { "model": "gpt-6.1-sol" },
      "anthropic": { "model": "claude-haiku-5-5" },
      "claude":    { "model": "sonnet", "midModel": "sonnet", "expensiveModel": "opus" }
    },
    "spend": { "lanes": { "anthropic": { "dailyUsd": 20 } } }
  }
  ```

  The order for code work is **Cursor, Codex, Anthropic Haiku** (the flat-rate subscriptions first, a job there costs nothing extra), with the **Claude subscription** last, after two failures, or for the expensive tier (`expensiveModel`, Opus: reviews and escalated tickets). A lane that is paused or failing hands work to the next. See [lanes](lanes.md).
- **Caps that always hold** (hard: reserved before a job starts): the per-run `--max-usd`, the per-project `budget.projectMaxUsd`, the lane daily caps (`spend.lanes.<lane>.dailyUsd`), and the machine-wide Anthropic caps. A cap is never raised for you. See [spend](spend.md).
- **Install state:** `swarm update` only moves the install when no swarm command is running from it (it names the run or process that blocks it; `--force` is yours alone).

## 1. Create the repo and link it

```sh
mkdir P && cd P && git init && git commit --allow-empty -m "start"
swarm init                                   # links the project to the install, detects the stack, writes the profile
```

Starting from the kit instead: `swarm init --kit web-portal --kit-source PATH_OR_GIT_URL --name "Name"` ([starter kit](starter-kit.md)).

`swarm init` writes `.project-swarm.json` (the pointer **and** the profile), `coordination/checks.json`, the agent pointers (`AGENTS.md`, `CLAUDE.md`), adds `.swarm/` to `.gitignore` and builds the repo map. Answer the one question: is the project sensitive (real customer data, auth, payments)? When in doubt, yes. See [init](init.md).

## 2. Make the checks real (`coordination/checks.json`)

This is the file that decides whether work is done. A ticket with tests is only done when a check saw them pass.

```json
{ "checks": [
  { "name": "tests", "argv": ["npm", "test"] },
  { "name": "typecheck", "argv": ["npx", "tsc", "--noEmit"] },
  { "name": "lint", "argv": ["npm", "run", "lint"] }
] }
```

`swarm init` fills it from `package.json` scripts and CI; **read it and fix it**. Then:

```sh
swarm init --check          # exit 1 with FAIL checks if the file is missing, empty or lists nothing runnable
swarm init --base-check     # runs the checks once on the untouched repo and records green or red
```

Do not start a scope run on a red base: fix it first, or the swarm cannot tell its own breakage from what was already broken.

## 3. The profile (`.project-swarm.json`, key `profile`)

Edit by hand, then re-run `swarm init --check`. The fields that matter:

| Field | Set it to |
|---|---|
| `sensitive` | `true` unless the repo holds nothing private (it decides which lanes may see the code) |
| `protectedPaths` | `.env*`, `secrets/`, keys, anything no worker may write (init adds the obvious ones; add more with `--protect PATH`) |
| `budget.maxUsd`, `budget.projectMaxUsd` | the **caps**: per run and for everything the project ever spends. Start small (for example 5 and 25). `swarm init --max-usd N` sets the run default |
| `verify` | `{ "command": ["npm","test","--","{tests}"], "agent": "claude", "model": "sonnet" }`: how one ticket's tests are run (the merge queue runs the managed check on every batch; a worker never has to run the test runner itself) |
| `acceptance` | `{ "enforce": true, "model": "sonnet" }`: the reviewer that checks acceptance lines no test covers |
| `handoff` | deploy, rollback, key rotation and contacts, for [handoff docs](handoff.md) |

## 4. Caps, concretely

```sh
swarm init --max-usd 5                       # default per-run cap
# profile.budget.projectMaxUsd = 25          # the whole project, ever (hard)
# ~/.config/project-swarm/config.json: spend.lanes.anthropic.dailyUsd = 20
```

Look at `swarm budgets status` after init: it must show a project cap, not "no cap".

## 5. Hooks and the hand-build guard

`swarm init` puts the Orchestrator-lane hooks (so the board shows the Claude Code session driving the project, its tokens at list value, and the swarm-built against hand-built share) in `.claude/settings.local.json` (personal, git-ignored), and for a project linked for the first time it also puts the hand-build guard there. Re-running init in an existing project never turns the guard on: use `swarm handbuild install`. Check:

```sh
python3 -c "import json;d=json.load(open('.claude/settings.local.json'));print(sorted(d['hooks']))"   # PreToolUse PostToolUse Stop UserPromptSubmit
swarm handbuild status                       # the guard: on where installed; no requests yet
```

- Hooks and guard apply to **new** Claude Code sessions in that folder: start a fresh session after `swarm init`.
- An existing project that did not get the guard: `swarm handbuild install`. To remove: `swarm handbuild uninstall` (init will not bring it back). Switch it off for a moment: `swarm handbuild off` / `on` (the owner's command; a session cannot run it).
- With the guard on, an orchestrator session cannot edit or shell-write the checkout outside `.swarm/` and `docs/plans/`. Build work goes through tickets. If a hand-build is truly needed the session runs `swarm handbuild request --kind swarm-cannot|emergency|secret|tiny --reason "..." --files "..." --minutes 30`; it shows in Needs you on the board and the phone and you approve or deny. See [the guard](handbuild-guard.md) and [the Orchestrator lane](orchestrator-lane.md).
- To turn the observer hooks off in a project: create `.swarm/orchestrator/off`.

## 6. Watch it (and the phone)

```sh
swarm watch --all            # the board: lanes, Cost, Agents, Events, Needs you, the Orchestrator bay
swarm remote on              # the board on your phone over Tailscale (tailnet only, never public); see remote.md
```

A board or `swarm remote` started before a `swarm update` keeps the old code and says so in a banner: stop it and start it again.

## 7. Write the scope and check it

```sh
swarm scope new                              # or: swarm scope template --out docs/scope/scope.md, then fill it in
swarm scope check                            # missing acceptance lines, vague words, outside services needing an owner on day 0
```

Each requirement is one testable sentence with an `Acceptance:` list that a reviewer or a test can actually check (a "no visual change" line goes to your checklist, not to a reviewer). After the split, `swarm scope check` also warns about tickets that gate many others and test files owned by later tickets: fix those before the run.

## 8. Split, approve, quote, run

```sh
swarm scope split                            # writes the split manifest; run it:  swarm run docs/scope/split/manifest.json
swarm scope split --ingest RUN               # ids, day-0 human tickets, integrity checks; writes the ledger (not approved)
swarm scope approve                          # summary: stages, waves, risks, estimate
swarm quote docs/scope/scope.md              # the range of cost and time, from real history (nothing is spent by asking)
swarm scope approve --yes                    # your approval, once
swarm go --scope --max-usd 5                 # builds wave after wave; stops at the cap, a human ticket, or when stuck
```

Merge only through `swarm merge PR`, never `gh pr merge` by hand. See [scope](scope.md) and [merge guard](merge-guard.md).

## 9. While it runs

- `swarm watch --all --text` (what is live), `swarm inbox` (what needs you), `swarm tickets --status blocked`.
- A ticket that failed three times goes to the expensive tier (`claude:opus`); one no lane can take is left out of its wave and blocked with the reason.
- Integration runs the checks first: if they fail, nothing is kept and the run stays un-integrated; fix and integrate again, or `swarm integrate RUN --accept-failed-checks`.
- Do not `swarm update` while it runs. When the machine is idle: `swarm update --yes`.

## Checklist before the first `go --scope`

- [ ] `swarm doctor all` shows the lanes you rely on; the machine config names their models.
- [ ] `swarm init --check` has no FAIL; `swarm init --base-check` is green.
- [ ] A project cap is set (`swarm budgets status`).
- [ ] `sensitive` is what you mean; `.env` and secrets are in `protectedPaths`.
- [ ] A fresh Claude Code session shows the hooks (and the guard if you want it).
- [ ] The board (`swarm watch --all`) shows the project; `swarm remote on` if you want it on the phone.
- [ ] `swarm scope check` is clean and `swarm quote` is a number you accept.
