---
name: resolving-merge-conflicts
description: Resolve an in-progress merge or rebase conflict while preserving both intents.
paths:
  - "**/*"
checks:
  resultKeys:
    - status
    - conflicts
---
Adapted from mattpocock/skills (MIT), commit 153fc1b93de6584562765cdce299324e1ff9e661; trimmed.

1. **See the state.** Check whether a merge or rebase is in progress, inspect the history, and list conflicting files.
2. **Find primary sources.** Read the commits and surrounding code to understand why each change exists and what the merge is meant to achieve.
3. **Resolve each hunk.** Preserve both intents where possible. When incompatible, choose the intent matching the merge goal and record the trade-off. Do not invent behavior.
4. **Verify.** Discover the project's automated checks and run the relevant type, test, and format checks. Fix anything the resolution broke.
5. **Finish.** Resolve every conflict, confirm no conflict markers remain, and complete the merge or rebase through the project's normal workflow.
