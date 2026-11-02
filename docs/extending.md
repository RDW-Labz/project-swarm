# Modify and extend Project Swarm

Start by adapting manifests and prompts. Most teams do not need to change the runner.

## Change an assignment

Choose a smaller context, make the task concrete, and declare every expected output. For a review, request source locations and a reproduction or verification method. For implementation, state the desired behavior and the interfaces that must remain compatible.

Avoid a prompt such as “improve everything.” A bounded alternative is:

> Add keyboard selection to the supplied tabs component using its current public props. Edit only the component and its existing unit test. Preserve the current visual styles. Explain the changed behavior and list the checks the coordinator should run.

The worker can edit a test file but cannot run it with this adapter. Run it yourself after reviewing and integrating.

## Choose a provider and model

Set `agent` to `claude`, `openai`, `gemini`, `ollama`, or `lambda`, and add or change `model` in the job. API jobs require a model; Claude can use its CLI default. Keep the rest of the manifest unchanged. Verify the resolved model through the recorded provider events or metadata. Model aliases can change and account access differs; do not hardcode an observed historical identifier into claims about every installation.

Changing models does not change the job's tools, file ownership, or integration requirements.

## Change concurrency or timeouts

The shipped runner accepts concurrency 1–2048 and 1–5000 jobs per manifest, with a default concurrency of 2 and separate [lane caps](lanes.md). Increasing a timeout can help a genuinely larger task, but smaller tasks are easier to review and recover. The maximum per-job timeout is one hour.

If changing these limits in code, update validation, tests, the skill, and this documentation together. Preserve conservative defaults and explain any new account-usage implications.

## Add a provider adapter

Claude Code and four HTTP adapters are implemented. The shared runner owns paths, copies, scheduling, and integration; `tools/api-adapters.mjs` owns fixed request construction, bounded responses, and strict file-envelope parsing. Another provider requires code and tests, not an arbitrary executable or URL in a manifest.

A provider contribution should include:

1. A fixed executable with `shell: false`, or a fixed HTTPS endpoint with redirects disabled and no model tools.
2. Documented authentication assumptions without copying credentials into the worker directory.
3. Explicit tool restrictions, disabled integrations and delegation where available, and no silent fallback to broader permissions.
4. A fresh-task execution model and a clear parser for success, errors, responses, model identity, and usage when available.
5. Bounded output, timeout, cancellation, process cleanup, and nonzero/error-result handling.
6. The same explicit file-copy, output-ownership, and conflict-checking integration contract.
7. Deterministic tests using a fake process or injected HTTP implementation, plus a separately authorized real read-only and writing smoke exchange.

Do not advertise an adapter as supported merely because its CLI can print a response. Establish its restrictions and test its failure behavior first. If a provider cannot enforce a restriction, document the limitation accurately rather than describing it as isolated.

## Change the security model

Copied workspaces reduce accidental cross-project edits; they are not an operating-system boundary. If you need stronger containment, design a separate container or OS-sandbox execution layer with explicit mounts, credential handling, network policy, and a tested lifecycle.

Do not claim that a prompt instruction prevents absolute-path reads. Do not add shell tools simply to let workers install dependencies or run tests without considering the expanded capability. Keep application testing with the coordinator unless a deliberate, documented capability change is made.

## Maintain the portable package

When adding files needed at runtime, update the installer's explicit file list and installer tests. Check an installation into a fresh temporary project and run the installed runner there. Verify that a repeated identical installation succeeds, changed destination files are refused before any overwrite, and no source-project paths or logs leak into the target.

Preserve existing file modes where relevant. A tool that rewrites a project script should not silently remove its executable bit. Integration tests should cover existing executable outputs as well as new files.

Keep examples self-contained and small. Never ship real `.swarm/` records, customer source files, local usernames, credentials, or provider transcripts as example content.

## Development checks

```sh
npm test
node tools/swarm.mjs validate examples/smoke.json
node tools/swarm.mjs validate examples/parallel-review.json
```

Deterministic tests must not require a Claude account or paid model calls. Keep real-provider smoke checks explicit and separate. Record the environment and observed result without publishing private prompts or full transcripts.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution expectations and [SECURITY.md](../SECURITY.md) for boundary and reporting guidance.

For an HTTP adapter, return proposed files to the runner; never let the adapter write arbitrary paths. Validate the complete exact output list and types before any write. Keep credentials out of prompts, raw logs, exceptions, and output artifacts. Reject malformed, refused, incomplete, tool-calling, oversized, and cancelled responses. Environment presence and passing mocks must never be described as live verification. See [provider setup](providers.md) for the current contract and primary API references.
