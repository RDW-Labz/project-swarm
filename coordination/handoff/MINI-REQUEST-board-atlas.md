# Mini request: three Build progress bugs seen on atlas-seafloor (owner, 2026-10-21)

Board files are yours (tools/build-progress.mjs, tools/board-data.mjs, tools/watch-assets/*, tools/board-*.mjs). No own version bump: the MacBook bumps at merge time (batch it with your next board PR). Swarm jobs only, full local suite before pushing, one test per bug against the atlas ledger.

Fixture: the atlas ledger is on your machine. Make an anonymized copy with `node coordination/handoff/anon-ledger.mjs <atlas>/.swarm/project/tickets.json tests/fixtures/ledgers/atlas.anon.json atlas-fixture` (keeps ids, status, stage, dependsOn, type; replaces titles, acceptance text, paths with hashes) and use it in the tests. The PR state for bug 1 comes through an injected dependency (a fake gh result), never the network.

1. Milestone strip stops at "E2E green" but store-wrapper PR #5 is merged. The PR open and Merged milestones must light from the GitHub PR state for the scope's branch: take the scope's branch (the ledger or build plan records it; fall back to the branch of the ticket PRs), ask GitHub for the PRs with that head (gh pr list --head BRANCH --state all --json number,state,mergedAt,headRefName), light PR open when any PR for the branch exists, light Merged when one is merged (mergedAt set); keep the existing read-only, no-token behavior and show "not tracked" when GitHub cannot be read, never a false green. Test: atlas ledger plus a fake PR list with #5 merged lights all milestones through Merged; an open-only PR lights PR open but not Merged; an unreadable GitHub leaves them unlit with the not-tracked label.

2. S0 (9 human tickets) renders as a build stage row "0 done / 9 open". A stage that contains only human tickets must not render as a stage row. Show those tickets only in the Human tickets checklist (the owner checklist); stages with a mix show their build tickets only in the stage row and their human tickets in the checklist. Test: on the atlas ledger the stage rows do not include S0, the Human tickets checklist lists all 9, and a mixed stage counts build tickets only.

3. Header "100% · tickets 17/26" reads as a mismatch. Show "build 17/17 · human 0/9": percent and the build count use build tickets only, the human count is separate and never part of the percent. Test: the exact header string on the atlas ledger, and a ledger with no human tickets shows only "build N/N".

Report with the before/after screenshots or text of the Overview card for atlas-seafloor.
