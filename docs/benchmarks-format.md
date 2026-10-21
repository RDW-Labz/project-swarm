# Benchmark scorecards

The board's Benchmark scorecard reads the JSON files written by `swarm eval scorecard` in
`evals/scorecard/`: `latest.json`, `previous.json`, and any other weekly cards kept there,
such as `evals/scorecard/2026-W43.json`.

To show a weekly trend, keep one card per week in that folder. A card has this shape:

```json
{
  "week": "2026-W43",
  "generatedAt": "2026-10-20T15:30:00Z",
  "projects": [{
    "project": "example",
    "metrics": [{
      "name": "first_try_pass_rate",
      "value": 0.8,
      "status": "measured",
      "grade": "green",
      "trend": "up",
      "previous": 0.75
    }]
  }],
  "overall": {"green": 1, "amber": 0, "red": 0, "unknown": 0},
  "headline": "1 green, 0 amber, 0 red"
}
```

The source of truth for reading and shaping these cards is
`tools/bench-scorecard.mjs`.
