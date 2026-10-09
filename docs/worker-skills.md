# Worker skills

For the experimental UI design loop skill (installed with `install.mjs --user`), see `skills/design-loop/SKILL.md` and `swarm design-loop`.

A skill is a small reusable chunk of instructions, kept as its own file instead of copied into
every manifest prompt by hand. This feature is off by default: with no `skillsDir` and no local
config `skills.dir`, every prompt is byte-identical to a release before it existed.

## Turning it on

Point at a directory of skills either in the manifest (`{ "skillsDir": "coordination/skills" }`)
or once, in local config, under a `skills` key (`{ "skills": { "dir": "/path/to/skills" } }`). The
manifest field wins when both are set. A relative `skillsDir` resolves against the project root;
`skills.dir` may be relative or absolute.

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
- `paths` (optional): glob patterns (`*` within a path segment, `**` across segments); a match
  against a job's own context or output paths auto-attaches the skill to that job.
- `checks` (optional), for an attached skill only: `filesMustChange` (globs a changed file must
  match) and `resultKeys` (keys required in the job's own structured result).

## Index-only vs. attached

Every job prompt gets one line per known skill. A skill is *attached* — its full body prepended —
only when named in that job's own manifest `skills: [...]` list, or matched by `paths:` (a
`skills` list, even `[]`, overrides `paths:` entirely). Otherwise it is *index-only*, and its line
ends with a pointer instead: `.swarm/skills/<name>/SKILL.md — read it if your job touches this`.
A tool-free API worker cannot read files, so it only ever sees an attached body — an index-only
pointer is useless to it; give such a job the skill via `paths:`/`skills:` instead.

## Size gate

`validate` warns `skill-over-800` and refuses `skill-over-1200` when a skill's own estimated token
count (`ceil(chars / 4)`) crosses those limits — a skill is warned about or refused, never trimmed.
