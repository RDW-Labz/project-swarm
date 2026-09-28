# Worker skills

A skill is a small reusable chunk of instructions, kept as its own file instead of copied into
every manifest prompt by hand. This feature is off by default: with no `skillsDir` and no local
config `skills.dir`, every prompt is byte-identical to a release before it existed.

## Turning it on

Point at a directory of skills either in the manifest:

```json
{ "version": 1, "skillsDir": "coordination/skills", "jobs": [ ... ] }
```

or once, in local config (`SWARM_CONFIG`, or `~/.project-swarm/config.json`):

```json
{ "skills": { "dir": "/path/to/skills" } }
```

The manifest field wins when both are set. A relative `skillsDir` resolves against the project
root; `skills.dir` may be relative or absolute.

## The SKILL.md format

Each skill is its own directory, `<skillsDir>/<any-name>/SKILL.md`, with frontmatter then a body:

```markdown
---
name: pdf-forms
description: Fill a PDF form and validate every required field.
paths:
  - "forms/*.pdf"
checks:
  filesMustChange:
    - "forms/*.pdf"
  resultKeys:
    - filled
---
Full instructions a worker follows when this skill is prepended in full...
```

- `name` (required): lowercase, `-`-separated; must be unique across the directory.
- `description` (required): a one-line summary, shown in every job's index line.
- `paths` (optional): glob patterns (`*` within a path segment, `**` across segments). When any of
  a job's own context or output paths matches, the skill auto-attaches to that job.
- `checks` (optional), for an attached skill only:
  - `filesMustChange`: globs; `integrate` fails the job if none matched a file it actually changed.
  - `resultKeys`: keys that must appear in the job's own structured result (its `resultFile`, or
    the last JSON object in its final reply).

Frontmatter supports plain scalars, lists, and one level of nested map — enough for the shape
above, nothing fancier (no anchors, no multi-line strings).

## What a job gets

Every job prompt gets one line per known skill: `Skills in .swarm/skills/: <name> — <description>`.
A skill's full body is prepended only when it is *attached*: named in that job's own manifest
`skills: [...]` list, or matched by `paths:` (a `skills` list, even `[]`, overrides `paths:`
entirely for that job). The source directory is also copied into the job's own workspace or
worktree at `.swarm/skills/` — already git-ignored, never part of a diff, never integrated.

## The manifest record

Each job's saved record gains `skills: [{name, gitHash, attached}]`, one entry per known skill,
`attached` one of `"named"`, `"paths"`, or `"index-only"`. `gitHash` matches `git hash-object` on
that `SKILL.md`, so a later run can tell whether the skill itself has changed since.

`validate` warns `skill-over-800` and refuses `skill-over-1200` when a skill's own estimated token
count (`ceil(chars / 4)`) crosses those limits — a skill is warned about or refused, never trimmed.
An unknown name in a job's `skills` list refuses `unknown-skill`; invalid frontmatter refuses
`invalid-skill-frontmatter: <file>`; a symlink anywhere under `skillsDir` refuses instead of being
copied.
