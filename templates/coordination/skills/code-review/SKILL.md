---
name: code-review
description: Review a diff against repository standards and its requested behavior.
paths:
  - "src/**"
  - "tests/**"
checks:
  resultKeys:
    - status
    - findings
---
Adapted from mattpocock/skills (MIT), commit 6fd947921b935b7e1e69293a200400f0fdd5c15f; trimmed.

# Code Review

Review the diff between `HEAD` and the fixed point across two axes:

- **Standards**: does the code follow the repository's documented standards?
- **Spec**: does it faithfully implement the originating issue or specification?

## Process

1. **Pin the fixed point.** Use the supplied commit, branch, tag, or merge-base. Capture `git diff <fixed-point>...HEAD` and `git log <fixed-point>..HEAD --oneline`. Confirm the ref resolves and the diff is non-empty.
2. **Identify the spec.** Use issue references in commit messages, a supplied path, or a relevant specification file. If none exists, report “no spec available” and skip spec findings.
3. **Review standards.** Read repository standards that apply to the changed files. The repository overrides heuristics. Also consider possible Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, and Refused Bequest. These are judgement calls, not hard violations.
4. **Check behavior.** Look for missing edge and error paths, dead code, duplicated logic, leaked feature logic, security issues, and unbounded work. A finding needs a concrete failing input or should be a question.

## Report

Lead with correctness and security, then structural issues and nits. For each finding write `<file>:L<line>: <severity> <problem>. <fix>.` Use `critical` for data loss, broken behavior, or security holes; no prefix for required fixes; `nit` for optional items; `q` for genuine questions. Return `findings` as an array of one-line findings and `status` as `approve` or `changes-requested`.
