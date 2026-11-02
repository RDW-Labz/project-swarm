# Lane comparison (2026-10-16)

| Lane | Passed | Pass rate | Cost | Cost per passing task | Tokens | Time |
|---|---|---|---|---|---|---|
| anthropic-haiku | 11/11 | 100.0% | $0.0253 | $0.0023 | 135,359 | 130.7 s |
| codex | 11/11 | 100.0% | subscription (not reported) | — | 171,796 | 445.5 s |
| Qwen3.6 NVFP4 (rented GPU, full load) | 8/11 | 72.7% | $0.0207 | $0.0026 | 153,416 | — |

The Qwen3.6 NVFP4 row is computed, not reported by a lane: all tokens of the 11 tasks are priced at the price of a token on a GPU kept fully busy, that is the hourly price divided by the measured output tokens per second at 128 agents, which gives $0.135 per million tokens. The lane rows (Haiku and Codex) are what the lanes reported.

## When the router uses the GPU lane

Router decision, from the 11-task comparison.

| Lane | Pass rate | Cost per passing task |
|---|---|---|
| Haiku | 11/11 (100.0%) | $0.0023 |
| Codex | 11/11 (100.0%) | none (subscription, no dollars reported) |
| Qwen3.6-35B-A3B NVFP4 on rented GPU | 8/11 (72.7%) | $0.0026 at 100% GPU load; $0.0052 at 50% load |

Haiku passed 11/11 at $0.0023 per passing task. The 11 tasks cost $0.0253, used 135k tokens and took 131 s. An earlier run passed 10/11.

Codex passed 11/11 on the subscription. No dollars are reported. It used 172k tokens and took 446 s.

Qwen3.6-35B-A3B NVFP4 on the rented GPU passed 8/11. That is 7/10 lane tasks plus the hard task, with thinking on and best-of off. It costs $0.0026 per passing task only when the GPU is kept 100 percent busy at 128 agents.

At full load the lane uses about 14k tokens per task and 3718 output tokens per second. That is about 960 tasks and about 700 passing tasks per hour, for $1.807. This works out to $0.135 per million tokens.

At lower load the price per passing task rises in proportion. At 50 percent busy it is about $0.0052, more than twice Haiku.

A failed Qwen task escalates to Haiku, so each failure adds about $0.0023. At 27 percent failures the effective cost per ticket is about $0.0026 plus 0.27 times $0.0023.

Break-even with Haiku needs about 90 percent GPU utilization. Even then the pass rate is lower.

Decision rule for the router:

- Use Haiku by default.
- Use the rented GPU only for a large queue: about 700 or more tickets ready at once, enough to keep 128 agents busy for most of an hour.
- Use it only for work where escalation to Haiku on failure is acceptable.
- Never use it for sensitive jobs.
- Codex stays the free lane for hard tickets.
