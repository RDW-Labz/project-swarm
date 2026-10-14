# Managed feature plan

This is a coordinator recipe, not a manifest. Replace the illustrative names and checks after inspecting the target repository. The runner does not parse this file or automatically dispatch nested agents.

## Area manager assignment

Give an area manager a concrete outcome: for example, make shared account access safe across two ventures, including refresh, revocation, and archive behavior. Supply the current interface notes, explicit source context, relevant project instructions, known failing behavior, and the root coordinator's ownership ledger. Ask the manager to return a proposed job plan or review findings, not a speculative staffing chart.

A manager is useful when it owns an area that can be reviewed independently and has a concrete result to return. Keep product decisions, authorization, shared contracts, cross-area conflicts, dispatch, and final acceptance with the root coordinator. Do not create a manager whose only job is to relay every worker message.

Restricted CLI managers have Read/Glob/Grep and, for writing jobs, Write/Edit. They cannot run commands or spawn workers. They may write a proposed manifest as a declared output; the coordinator reviews it, checks every path and prompt, runs preflight, and dispatches it through a new execution call. A native host manager may delegate a bounded subtask when the user authorized delegation and the host supports it. Host delegation is separate from a runner capability and still consumes the host's available concurrency.

## Required task contract

Record each task in the manager's proposal with these fields:

- **Outcome:** one behavior or review result, including the observable before/after change.
- **Owner and outputs:** one writer, explicit relative file names, and whether new files are permitted. Read-only reviewers have no code outputs.
- **Inputs:** explicit context files and the exact interface revision or integrated stage the job depends on. State missing information instead of inventing source details.
- **Non-goals:** adjacent work this task must leave to its existing owner.
- **Acceptance:** named existing check commands, or precise assertions to add when no suitable check exists; identify who will execute them. CLI workers without shell access must not claim to have run them.
- **Handoff:** consumer jobs, public exports or data shapes they may rely on, and which outputs need integration before consumers start.
- **Stop condition:** unexpected shared-file changes, contract ambiguity, missing context, scope growth, security uncertainty, or failed checks that require a coordinator decision.
- **Evidence:** changed files, response/run IDs, known limitations, and validation results with actual exit status. Claims without a completed check remain unverified.

Use these fields in the prompt or a copied task-contract document. Do not add them as unknown manifest fields; version 1 manifests reject unsupported fields.

## Ownership and stage ledger

Keep one coordinator-owned ledger listing job ID, state, owned outputs, read dependencies, prerequisite integration, acceptance check, and run ID. Include every concurrently active run and native writer, not just the current manifest. Preflight checks a single manifest and does not reserve files across runs.

A concrete shared-account feature may use this staged shape, subject to source inspection:

1. **Inspect and establish contracts.** A read-only manager identifies the current storage and authentication paths, proposes the canonical-access interface, and maps the tests. The coordinator reviews the contract and assigns any shared test file to one writer. Read-only reviewers may concurrently inspect threat cases or runtime callers because they do not mutate those interfaces.
2. **Build the canonical boundary.** One writer owns the tightly coupled persistence and credential-resolution files. Its checks cover correct venture binding, invalid/revoked grants, refresh identity, and concurrency. Do not split several writers across the same store merely to increase worker count. If persistence and grant policy can safely use separate files against a settled contract, dispatch those distinct jobs; otherwise keep the coherent boundary together.
3. **Integrate and verify the boundary.** Review the whole completed run, inspect proposed files and conflicts, integrate, and execute the relevant checks. Record the actual integrated contract. A completed sibling cannot be copied out of an unfinished run.
4. **Dispatch independent consumers.** On fresh snapshots, separate workers can own provider adapters, runtime callers, and archive/status behavior where their file sets are disjoint. Do not group unrelated work in a single cohort if it will hold a ready change behind the whole-run integration gate. Overlapping runs are allowed only with a global ownership and provider-capacity check.
5. **Verify the feature across boundaries.** A dedicated test owner adds any remaining end-to-end assertions from the integrated implementation; an independent reviewer checks the stated invariants. The coordinator executes the tests, build, and relevant user flows. Follow-up defects become new bounded tasks from current source.

A single shared test file cannot have several concurrent writers. Either let one owner maintain it after its inputs integrate, or inspect the test runner and approve separate discovered test files before dispatch. Worker-authored prose assertions are useful review input but are not executed regression tests.

## Review, feedback, and escalation

Managers return findings with severity, file/behavior, reproduction or evidence, and the smallest corrective task. They may recommend acceptance, but the root coordinator accepts only after reviewing the actual changes and checks. An author cannot validate a claim merely by repeating it in their response.

If a worker needs another owner's file, stop that dependent edit and report the proposed contract change. The coordinator can serialize the change, transfer ownership after the active run settles, or create a fresh follow-up. Do not silently expand outputs, edit active worker targets, reuse stale snapshots, or start a competing writer. A failure or timeout requires a fresh task from current state; do not bypass the integration gate.

Managers should identify ready independent work while dependencies settle. Idle workers do not improve throughput. Count all active providers and native agents when reporting concurrency, and distinguish running, completed, queued, and reviewing work.

## Backlog

- Tier escalation after two failures: not built. Config `tiers` (for example `mid` → `cursor`/`composer-2.5`, `expensive` → `codex`) is routing metadata for the coordinator only; no runner logic re-dispatches a failed job to a higher tier.

## Acceptance and measurement

Before calling the feature complete, verify that every requested behavior maps to an owner and a passed check, all full runs integrated safely, unresolved findings are explicit, and required project tests/build/user flows have actually passed. Check schema or migration requirements when the source shows they apply. Deployment remains a separate authorized action.

Measure dispatch-to-verified-integration time, completion-to-integration waiting, retries, rework, observed peak concurrency, check failures, and remaining defects. A smaller job count or faster first response does not establish faster delivery. Compare similar work with input differences disclosed; a planning evaluation can establish clearer ownership, but cannot demonstrate runtime speedup or implementation correctness.
