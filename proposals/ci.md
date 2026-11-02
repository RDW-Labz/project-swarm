# Guard for "ci" (5 lessons)

Proposed guard: lint
Why this kind: no other rule matched; a mechanical check is the default

Add a lint check for "ci". Lessons: "Externally validated values need an accepting rule."; "A retry needs evidence and a fresh result."; "CI checks must match shell expansion.".

Comes from lessons:
- L-0345: Externally validated values need an accepting rule.
- L-0354: A retry needs evidence and a fresh result.
- L-0378: CI checks must match shell expansion.
- L-0381: Checks must ignore swarm scratch copies.
- L-0382: Test summaries can precede timeouts.

Where to build it: a check in tools/security-rules or a project lint rule

Done when:
- a test fails without the guard
- the eval set still passes
- the lessons' guard status is set to built

Proposed by swarm lessons mine on 2026-10-16. Not merged automatically.
