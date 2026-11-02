# Case study: a website redesign

Project Swarm grew out of a real website redesign. This public account omits the client identity, business limits, source filenames, and application-specific findings. It preserves the useful workflow and observed concurrency results. The website's source, assets, customer data, private transcripts, and local run directories are not distributed with this package.

## Before the reusable runner

A fresh Claude Code process completed a scoped communication check. This was not a connection to an already-open terminal.

A later direct CLI assignment gave Claude ownership of a bounded set of interface components. The coordinator retained visual direction, shared components, integration, and verification. A separate tooling agent helped implement the reusable runner and its deterministic tests.

Those early assignments did not use Project Swarm. They informed the ownership model but are not evidence that the reusable runner built the entire website.

## From a smoke check to useful work

The first reusable-runner exchange launched two fresh workers in separate copied workspaces. One reviewed a brief; the other wrote a preflight suggestion. The coordinator inspected both responses and integrated the declared output.

Later assignments used different Claude model aliases for focused source reviews. Some findings led to changes; others were rejected after code inspection and browser checks contradicted them. An alias is not proof of the model that answered: the runner records provider-reported metadata when available.

The coordinator performed the rendered-page review, performance measurements, and test execution. Workers receiving only source text could suggest checks or write test code; they could not truthfully claim to have inspected a rendered page or run those checks.

## Concurrent work that was actually observed

Four fresh acknowledgment workers completed a concurrent connection check. That demonstrated scheduling, not the quality of a substantial coding task.

Subsequent work included an interface implementation proposal, a four-worker review, and two separate six-worker review batches. The coordinator observed six real Claude workers running simultaneously. All six jobs completed in each batch, and their declared outputs were reviewed before integration.

One batch produced a browser-test file and five focused reports covering interface accessibility, business-rule consistency, motion, rendering lifecycle, and the orchestration workflow. The worker wrote the tests; the coordinator ran them. Unsupported findings were rejected rather than counted as improvements.

The broader redesign included three visual refinement passes and application preflight checks. Those were coordinator-led activities, not capabilities automatically supplied by the runner.

## What to reuse

1. Give each worker one concrete task and only the files needed for it.
2. Assign one writer per output file; read-only reviewers can share context.
3. Ask for source evidence and a clear distinction between observations and hypotheses.
4. Keep independent work running while the coordinator makes product decisions and checks results.
5. Review proposed files, resolve conflicts, then integrate and run application checks.

Adapt `examples/parallel-review.json` or the other [workflow recipes](workflows.md) to your own project. These examples are starting points, not permission to inspect unrelated files or sessions.

## Evidence and limits

At the time, the runner accepted up to 32 concurrent jobs and 256 jobs per manifest. The limits have since been raised to 512 and 5000, with per-agent lane caps; concurrency still defaults to two. This case study demonstrates six simultaneous authenticated Claude workers, not 32. An eight-worker deterministic scheduling test uses fake workers and must not be presented as live provider evidence.

The package supports Claude, Hermes, Qwen, OpenAI, Gemini, Ollama, and Lambda adapters. The Claude evidence above does not verify the other providers. Follow the [provider guide](providers.md), check compatibility, and run a bounded exchange with your own account and selected model before assigning substantial work.

Copied workspaces and restricted tools reduce accidental scope expansion. They are not an operating-system security sandbox; see [the security boundary](../SECURITY.md).

For the later multi-repository production observations, costs, lessons and kickoff verification, see the [anonymized field report](field-report.md).
