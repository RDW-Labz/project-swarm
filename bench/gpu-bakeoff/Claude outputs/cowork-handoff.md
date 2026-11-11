# Cowork handoff: Braden's swarm reviewer chat (Oct 26, 2026)

## My role
I'm Braden's reviewer and dispatcher for his AI orchestrators. He pastes their output and screenshots. I reply short and step-by-step with paste-ready messages, say which session each one goes to, and give exact Terminal commands. Swarm builds everything; orchestrators only plan, route, check and report. Ask Braden only for money, live deploys or real decisions.

## Machines and sessions
- **MacBook (bean)**: project-swarm Claude Code session in the Cursor window "project-swarm" (ledger root /Users/bean/project-swarm, branch swarm/ledger-root). Board on 127.0.0.1:51058.
- **MacBook**: parts-request-app, now a **Claude Code** session (switched from opencode/DeepSeek, which got stuck). Repo /Users/bean/Documents/project-repos/parts-request-app, PR #68 (build/s18-confirmation).
- **Mac mini (prime)**: Claude Code "Mac mini seat" (project-swarm-1). S8/S9 are done; it now takes batches and goal-queue items from the MacBook. Atlas-seafloor repo lives here (/Users/prime/Documents/repos-projects/atlas-seafloor), run by an opencode (DeepSeek) orchestrator.
- dev2 (WireGuard, 10.10.10.220) is skipped for now. Lane health should mark it down or up automatically.
- Docker: the parts app needs it for local Supabase e2e (capped at 2 GB). Don't quit it. Cursor stays open.

## Swarm version and in-flight (project-swarm)
- Installed: 1.167.14 on both Macs.
- **Next release (pending):** note-fix (`tickets <ID> --set ready --note "..." --yes` silently dropped notes) plus a per-ticket check timeout (`--check-timeout`). I asked to ship these separately from the guard.
- **Guard hotfix:** the orchestrator-mode hook blocked the parts session's own swarm commands. Four Opus reviews have failed (real holes found); now on a simple rule: no code files in .swarm/ or docs/plans/, and bare test runs refused when code is there. Fifth review is pending.
- Other open goals: gate capture wiring for atlas (rerun with -rA, timeout dump, per-test timeout); faster integrate (affected tests plus smoke); stranded-commit fix (waves must not commit to ledger-root, g-93d36cd2); prompt-wildcard validator fix (g-952f7b08); lane-health routing wiring.
- S10 Command Center: nearly built. The /command-center mount (flag SWARM_COMMAND_CENTER=1) and grader loop are in progress. **Grade Hive and Cockpit screenshots against the 4.5 target when they arrive.**
- S11 self-managing swarm: approved (CO-002). Lane-health core (#377) and the lane modules (#392) are merged.

## Parts app (PR #68), next steps when "Hotfix is out, go"
1. Run swarm update in the parts session.
2. Add notes (with --note, set ready, --yes) to T-0592, T-0594 and T-0595 (exact text is in the earlier messages):
   - Workers must run `bash scripts/e2e-app.sh <spec>` in their own loop until green.
   - T-0592 :53: expect the new availability copy. :161: may wrap to 2 lines below 360px, 1 line at 360px+. :200: Bumper card after search; check whether it's an app bug.
   - T-0594 s13-final :86 :152 :201, and T-0595 s13-reply-status :135 :255 :269 :329 :369 (stale #used-/#aftermarket- locators).
3. New build ticket for hours: the E2E_NOW override applies on the first render. Server-only flag E2E_TEST_MODE=1, always off when VERCEL_ENV=production, with unit tests. Set the flag in ci.yml and e2e-app.sh. Then T-0590 updates hours-contact :68 :82 :92.
4. go --scope, then the full local e2e, push, merge #68 on green, and watch Vercel for 15 minutes.
- Owner decisions already made: button labels "Next: Request Your Parts" / "Next: Your Contact Information" / "Send Your Parts Request"; no "New" option; search-only parts; heading "Add Requested Parts"; staff can mark Used or Aftermarket unavailable separately; CI stays on local Supabase; the hosted DB is test-only until launch.
- Terminal shortcut for running swarm commands by hand (zsh):
  `s() { node /Users/bean/.project-swarm/current/tools/swarm.mjs --root /Users/bean/Documents/project-repos/parts-request-app "$@"; }`

## Atlas-seafloor (S5 God's Eye View)
- T-0087 and T-0088 are done. T-0089 and T-0091 are in review (on Opus). The gate failure was a 900 s timeout, suspected to be a leaked browser or Cesium viewer; a teardown plus pytest-timeout ticket is in progress. T-0092 (modes, pixel-diff) and T-0090 (grader) come after.
- The side-by-sides showed the globe mounted, but no tactical frame, all 7 modes identical, and bad bottom-bar chrome. **Nothing merges to main before Braden sees the new side-by-sides.**
- Relay "gate fixed, retry" to atlas when the gate capture wiring ships.

## Other
- Stage-1/stage-2 merge message: it was meant for some other project (it was wrongly applied to atlas and then cancelled). It still needs to go to the right project, along with the revert-of-revert, 9900201 Opus review and "personas" push questions.
- agent-data-business: done except for owner keys.
- Standing rules: never remove working features to get CI green; Opus review on anything that kills processes, routes or touches money; no secrets to workers; OpenRouter never gets sensitive code.
