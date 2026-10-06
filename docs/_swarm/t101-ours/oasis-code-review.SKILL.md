---
name: code-review
description: Multi-axis code review checklist for a diff or PR inside one repo. Use before merging any change, or when asked to review a diff or PR.
paths:
  - "repos/**/src/**"
  - "worktrees/**/src/**"
checks:
  resultKeys:
    - status
    - findings
---
# Code Review

Review every change across five axes before it merges. Approve when it
clearly improves the codebase, even if imperfect — don't block for "not how
I'd have written it."

## Five axes

1. **Correctness** — matches the task/spec? Edge cases (null, empty,
   boundary) and error paths handled, not just the happy path? Do tests
   actually exercise the change?
2. **Readability** — names are clear, no `temp`/`data` without context,
   control flow is straightforward, no dead code left from the change
   (`_unused` vars, `// removed` comments, backward-compat shims for
   nothing).
3. **Architecture** — follows existing patterns; no duplicated logic that
   should be shared; no new abstraction with a single caller; feature logic
   doesn't leak into a shared module.
4. **Security** — hand detailed findings to the security-review skill;
   still flag anything obvious here.
5. **Performance** — no N+1 queries, no unbounded loops or fetches, no
   large allocations in a hot path.

## The failing-input rule

A finding is only real if you can name, or better produce, an input that
breaks it. "This could be a problem" is not a finding — "empty array
crashes at L42, `arr[0].id` with no length check" is. If you can't
construct the failing case, downgrade the comment to a question instead of
filing it as a bug.

## Severity

Label every finding: `critical` blocks merge (data loss, broken behavior,
security hole); no prefix means required, must fix before merge; `nit` is
optional, author may ignore; `q` is a genuine question, not a suggestion.

Lead with what matters: correctness and security first, then structural
issues, then nits. One real bug beats ten nits.

## Format

One line per finding: `<file>:L<line>: <severity> <problem>. <fix>.`
Don't restate what the line does — the diff already shows that.

## Dead code

If the change orphans code, list it and ask before deleting anything
outside the diff's own scope: `formatLegacyDate() in src/utils/date.ts —
no remaining callers. Remove?`

## Size

Prefer reviewing changes under ~300 lines. If a diff mixes refactor and new
behavior, say so — that's two changes.

## Report

`findings`: array of one-line findings above (empty array if none).
`status`: "approve" or "changes-requested".
