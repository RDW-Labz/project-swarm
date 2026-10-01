---
name: worker-rules
description: Minimal-change discipline for every build job — smallest diff that meets the contract, reuse before writing, no speculative abstractions or drive-by refactors. Use on any coding task in a repo or worktree: writing, fixing, or refactoring code.
paths:
  - "repos/**"
  - "worktrees/**"
checks:
  resultKeys:
    - status
    - filesChanged
---
# Worker Rules

Every build job gets the smallest change that satisfies the contract. Act
like a senior engineer who already saw every over-engineered codebase and
got paged for it: efficient, not careless.

## Before you write code

1. Does this need new code at all? A one-line config change or an existing
   flag beats a new file. If the task is speculative ("might need this
   later"), skip it and say so in one line.
2. Grep the repo for a helper, type, or pattern that already does this.
   Reuse it — reimplementing something a few files over is the most common
   mistake.
3. Standard library or language builtin covers it? Use that before writing
   custom code.
4. Only after 1-3 fail: write the minimum code that satisfies the contract.

## While you write

- No interface with one implementation, no factory for one product, no
  config knob for a value that never changes.
- No "for later" scaffolding — later can scaffold itself.
- Touch the fewest files possible. The shortest diff that is *correct*
  wins, not the shortest diff that happens to compile.
- A bug report names a symptom. Before editing, find every caller of the
  function you're about to change. Fix the shared function once, not each
  call site — a guard in the one shared place is both the smaller diff and
  the real fix.
- No drive-by refactors. Renaming a variable, reformatting an untouched
  block, or "cleaning up" code outside the task's contract is a separate
  change, not part of this one, even if it looks like an improvement.

## Cleanup

- If your change makes something dead (a helper, an import, a branch) that
  you created, or that only your change orphaned, delete it in the same
  diff. Don't leave `// removed` comments or unused exports behind.
- Don't delete or restructure code you did not touch for this task, even if
  it looks wrong — flag it instead (see below).

## When you see something you didn't fix

Name every file you noticed needs a change but didn't touch, with one line
why. Don't silently expand scope to fix it in this job.

## Boundaries

Never simplify away input validation at trust boundaries, error handling
that prevents data loss, security checks, or accessibility basics, even if
that means a bigger diff. If the task explicitly asks for a fuller version,
build that — don't re-argue for less.

## Report

`filesChanged`: paths actually modified or created, not files merely
inspected. `status`: e.g. "done" or "blocked". If blocked by a rule you
cannot meet inside your allowed outputs, say so instead of working around it.
