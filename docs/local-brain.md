# Local brain

dev2's model (the Strata API) as a free helper that keeps work away from the orchestrator and from paid models. It is reached the way `dev2chat` is: an ssh tunnel with the swarm key, the server's key read over ssh and kept in memory only. **Runner-side only: workers never call it, never see its address, key or tunnel.**

## Setup

In the machine config (`~/.config/project-swarm/config.json`):

```json
"localBrain": {
  "enabled": true,
  "sshTarget": "dev2@10.10.10.220",
  "sshKey": "~/.ssh/swarm_dev2",
  "remotePort": 8000,
  "keyCommand": "awk '/^model:/{m=1} m&&/api_key:/{print $2; exit}' ~/.hermes/config.yaml",
  "concurrency": 1
}
```

`swarm brain status` shows whether it is configured and up; `swarm brain test` sends one tiny request. Without the block (or with `enabled: false`) there is no local brain, only the Haiku fallback.

## Commands

| Command | What it does |
| --- | --- |
| `swarm think "QUESTION" [--rounds N]` | A proposer and critic loop (1 to 4 rounds, default 2). Prints a top 3, each with a reason, in about 10 lines. |
| `swarm digest <file\|run-id\|->` | Condenses a log, diff, test output or a run (its status and every job that did not complete) to 15 lines or fewer. `-` reads stdin (`git diff \| swarm digest -`). Long input is first cut deterministically (head, tail, and every error-looking line). |
| `swarm draft docs\|pr\|plan "BRIEF" [--context f1,f2] [--out FILE]` | The local model drafts; Haiku reviews and fixes the draft (only for a project that is not sensitive). `--out` writes a new file, never over an existing one. |
| `swarm brain status\|stats\|test` | Link status, savings totals (`--markdown` for the scoreboard line), a test call. |

Also automatic:
- **Failure triage.** Before autopilot retries a failed run it asks the local model for a verdict on each failed job: `retry`, `escalate` or `needs-human`. `needs-human` becomes a blocker (an inbox item) instead of a retry. A job that already failed twice is never `retry`. Only the verdict decides anything: the hint is shown to the owner and written to `.swarm/runs/<run>/<job>/triage.json`, and is never put into a prompt. A broken or unreachable brain never stops a retry.
- **Pre-flight before Claude or Opus.** `swarm run` of a manifest that has jobs for Claude, an Opus model or the expensive tier asks the local model for the usual mistakes (missing context, outputs not named as files, an ambiguous goal) and prints them as `brain-preflight` warnings. It never blocks.

## Rules

- One queue, concurrency 1 to 2 (the model server is shared). Requests time out; nothing waits forever.
- Everything it returns is untrusted text: sanitized (control characters, bidi, secrets redacted), length-capped, never executed, never used as instructions, and it can never approve, merge, raise a cap or change routing.
- **Sensitive material only goes to the local model.** A project marked sensitive (the default, see [init](init.md)) never has a request sent to Haiku: if dev2 is down the command says "local brain unavailable" and does nothing. A project marked not sensitive falls back to Haiku on the Anthropic lane under the machine-wide caps.
- Secret and protected paths (`.env`, keys, the profile's `protectedPaths`) are never read for digest or draft, and nothing outside the project (including through symlinks) is.
- Savings are measured: every call writes to `.swarm/project/brain-ledger.ndjson` the paid cost and an estimate of the orchestrator tokens it kept away (the input it digested, or the reasoning and drafting it replaced). `swarm brain stats` totals them; `swarm ledger RUN` includes the totals.
