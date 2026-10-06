---
name: writing-for-agents
description: Write predictable skills and agent-facing documents with clear triggers and steps.
paths:
  - "**/*.md"
  - "**/AGENTS.md"
checks:
  resultKeys:
    - status
    - findings
---
Adapted from mattpocock/skills (MIT), commit 6fd947921b935b7e1e69293a200400f0fdd5c15f; trimmed.

When writing a skill, read [mechanics.md](mechanics.md) for frontmatter and invocation rules.

## Context pointers

A context pointer names out-of-context material and states when to read it. Its wording controls triggering: state what the material is and list distinct branches that need it. Put the leading trigger word first, keep one trigger per branch, and cut identity the body already carries.

## Two loads

Always-loaded text spends context load; material reached through a pointer spends cognitive load. Keep the first compact. Spend cognitive load where human judgment matters, and disclose reference that only some branches need.

## Information hierarchy

Use this order: in-file steps, in-file reference, then disclosed reference. Inline what every branch needs. Push branch-specific material behind a pointer. Co-locate a concept's definition, rules, and caveats. Split only when a sequence or invocation boundary earns the extra document.

## Steps and completion

End every step with a checkable, exhaustive completion criterion. Clarity prevents premature completion; demand drives the legwork needed to prove the step. Make criteria strong enough to distinguish done from not done.

## Leading words and pruning

Use compact concepts the agent can think with, such as *lesson*, *tight*, and *red*, instead of repeating their explanations. Keep each meaning in one source of truth. Leave one-file lookups to the environment, remove stale or irrelevant lines, and delete no-op instructions. Prefer positive targets over prohibitions.
