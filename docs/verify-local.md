# Local verify mode

Local verify runs a ticket’s tests on the machine, without calling a model and without spending API tokens. You turn it on in project config with `verify.agent: local` and a `verify.command` argv list.

## Configuration

Set `verify.agent` to `local`. You must also set `verify.command` to a non-empty array of strings (argv), not a shell string.

For `local`, the first element of `command` (the program name) must not contain shell metacharacters. `verify.model` is not allowed with `local`; there is no model step.

Optional `verify.timeoutMs` applies only to `local`: an integer from 1000 to 1_800_000 milliseconds. If omitted, the default is 600_000 (10 minutes).

Other `verify` keys (`setup`, `testEnv`, `timeoutSec`, and agents like `claude` or `codex`) are validated by the same schema, but the local runner described here only spawns `command` in a scratch worktree (see below).

Put `{tests}` in `command` where you want ticket-specific test paths inserted. Each path becomes a `./…` argument. Test paths come from tickets whose type is `build`, `test`, or `migration`, from `ticket.tests` and from `ticket.files`, when they look like test files (for example under `test/` or `tests/`, or names ending in `.test.js`, `.spec.ts`, and similar patterns).

Example:

```yaml
verify:
  agent: local
  command: ["npm", "test", "{tests}"]
  timeoutMs: 600000
```

## What runs

`prepareScratchVerify` integrates the job’s declared outputs into a scratch git worktree, then runs the verify command there with `runLocalVerify`.

Integration is done by a callback (`integrateIntoScratch`). It returns the worktree path (or an object with `worktree` / `path`, plus optional `command`, `timeoutMs`, and `cleanup`). The runner executes `command` with `cwd` set to that worktree, stdout and stderr captured, and stdin ignored.

When finished, `cleanup` runs whether the command passed or failed.

There is no LLM agent, no `verify.model`, and no token use for this path.

## Results

The job gets a `verify` object with `mode: "local"` and:

| `verify.status` | Meaning |
|-----------------|--------|
| `pass` | Process exited with code 0. |
| `fail` | Process exited with a non-zero code. |
| `error` | Spawn failed, the process errored before exit, or the run hit `timeoutMs` (child is killed with SIGKILL). |

Each result includes `exitCode`, `durationMs`, and `tail`: the last 4000 bytes of combined output, passed through journal sanitization and secret redaction (token-like strings become `[redacted]`).

## Why this exists

Workers routed to Cursor, Hermes, or similar sandboxes are told not to run the full test runner or build themselves: those environments often cannot start the runner (cache, tokens, or repo secrets). The merge queue can still run tests on integrated batches.

Local verify closes the loop for tickets built by those workers: after outputs land in a scratch worktree, the swarm runs the same style of command you configured—using the ticket’s `{tests}` list—on the host. A passing local verify means the changed files were exercised by your command without an AI verify step.

## Not wired yet (planned)

These pieces exist in config or helpers but are not applied inside `runLocalVerify` / `prepareScratchVerify` as read here:

- Injecting `verify.testEnv` into the child process environment (the runner uses the current process environment only).
- Running `verify.setup` argv steps before the main command.
- End-to-end wiring from every job lifecycle entrypoint to `prepareScratchVerify` and scratch integration (this doc follows the tools layer; orchestration may still be rolling out).

Until those are connected, rely on what the scratch integrator and `command` already provide, and treat `setup` / `testEnv` as forward-looking config.
