# Job types

Set the optional job field `type` to choose a preset. Jobs without a type behave as before. A type adds prompt guidance, default timeout, skill, and automatic routing preferences. It also limits declared outputs.

## Presets

Routes list agents in candidate order. Timeouts are in milliseconds.

| Type | Writes | Route | timeoutMs | Skill |
|---|---|---|---:|---|
| `build` | any | cursor, codex | 1800000 | none |
| `fix` | any | cursor, codex | 1800000 | `diagnosing-bugs` |
| `test` | tests | codex, cursor | 1200000 | `tdd` |
| `review` | none | hermes, codex | 900000 | `code-review` |
| `research` | none | hermes, openrouter | 900000 | none |
| `docs` | docs | hermes | 900000 | none |
| `merge` | any | codex, claude | 1800000 | `resolving-merge-conflicts` |
| `lead` | manifest | claude, codex | 900000 | none |

Explicit `timeoutMs` and `skills` win over preset defaults. A type never changes `agent`, `model`, `context`, or `outputs`.

## Write rules

- `any`: any declared output is allowed, subject to the usual path and ownership rules.
- `tests`: every output must pass the runner's `isTestFile` check.
- `docs`: every output must have a `.md`, `.mdx`, `.rst`, `.txt`, or `.adoc` extension, or be under `docs/`.
- `none`: `outputs` must be `[]`. Review and research jobs do not edit files.
- `manifest`: exactly one output is required, ending in `.json`. Lead jobs write only that child manifest. Child jobs must stay inside the assigned area.

Invalid outputs refuse with `job-type-output`: `Job <id> (type <type>) may not write: <comma-separated paths>`. For a lead job with no outputs, the path is `(none)`. Unknown types refuse with `job-type-invalid`: `Job <id>: unknown type <value>`.

## Skills and prompts

When `skills` is omitted, a preset skill is attached only if a configured skills directory contains that non-broken skill. Otherwise, the runner leaves `skills` unset and reports `job-type-skill-unavailable`. Explicit `skills`, including `[]`, always win. Validation returns these warnings in its `warnings` array.

The runner appends `Job type <type>: <promptLine>` after two newlines in the prompt. Applying the preset again does not duplicate that exact suffix. Build jobs implement changes and tests. Fix jobs reproduce the failure first and keep a regression test. Test jobs edit tests only. Docs jobs use plain, short sentences. Merge jobs preserve both sides' intent and keep tests passing.

Review jobs finish with one JSON line:

```json
{"status":"complete","summary":"...","findings":[{"file":"...","line":0,"severity":"high|medium|low","issue":"...","fix":"..."}]}
```

Research jobs finish with one JSON line:

```json
{"status":"complete","summary":"...","sources":["..."],"findings":["..."]}
```

For GitHub prior art, the coordinator uses `swarm scout` or `sweep`.

## Routing

Type routes apply only to `agent: "auto"`. Omit `model` and configure lane models first. The router uses the preset candidate order and appends Claude if it is absent. Lanes without models, paused lanes, and lanes that cannot accept the job's fields are skipped. If all eligible lanes are paused, the router returns the first eligible lane with a pause reason.

`sensitive: true` removes OpenRouter. `tier: "expensive"` goes straight to Claude and still requires `tierReason`. Two failed or timed-out attempts move the job up the candidate order. Rate-limit retries do not count toward fallback. Explicit agents keep their named route. See [lanes and routing](lanes.md).

The applied job, including its prompt and defaults, is saved in the run's `manifest.json`.

## Examples

Each example uses `agent: "auto"` without a model. Configure available lane models before running it.

- [Build](../examples/type-build.json)
- [Fix](../examples/type-fix.json)
- [Test](../examples/type-test.json)
- [Review](../examples/type-review.json)
- [Research](../examples/type-research.json)
- [Docs](../examples/type-docs.json)
- [Merge](../examples/type-merge.json)
- [Lead](../examples/type-lead.json)
