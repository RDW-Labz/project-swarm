# Lane comparison (2026-10-16)

| Lane | Passed | Pass rate | Cost | Cost per passing task | Tokens | Time |
|---|---|---|---|---|---|---|
| anthropic-haiku | 11/11 | 100.0% | $0.0253 | $0.0023 | 135,359 | 130.7 s |
| codex | 11/11 | 100.0% | subscription (not reported) | — | 171,796 | 445.5 s |
| Qwen3.6 NVFP4 (rented GPU, full load) | 8/11 | 72.7% | $0.0207 | $0.0026 | 153,416 | — |

The Qwen3.6 NVFP4 row is computed, not reported by a lane: all tokens of the 11 tasks are priced at the price of a token on a GPU kept fully busy, that is the hourly price divided by the measured output tokens per second at 128 agents, which gives $0.135 per million tokens. The lane rows (Haiku and Codex) are what the lanes reported.
