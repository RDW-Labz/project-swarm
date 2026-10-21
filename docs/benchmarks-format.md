# Benchmark files

Benchmark files live in `docs/state/benchmarks/`.

Use one file for each measurement. Do not rewrite a file.

The file name is:

`<YYYY-MM-DD>-<label>.json`

The label is `baseline` for the first measurement. Later labels can be short
words made of `a-z`, `0-9`, and `-`, such as `after` or `weekly`.

Each file has this shape:

```json
{
  "version": 1,
  "at": "2026-10-20T15:30:00Z",
  "label": "baseline",
  "source": "bench/throughput",
  "metrics": {
    "deploy-time": {
      "value": 18.5,
      "unit": "min",
      "better": "lower",
      "label": "Deploy time"
    },
    "success-rate": {
      "value": 97.2,
      "unit": "%",
      "better": "higher"
    },
    "cost": {
      "value": 12.4,
      "unit": "$",
      "better": "lower"
    }
  }
}
```

`at` is an ISO time. `source` is a short string. A metric key has 1 to 60
letters, numbers, dots, underscores, or dashes. A metric value is a number.
Its unit is a short string. `better` is either `lower` or `higher`.
`label` is optional and is only a display name.

The board reads only this folder. It ignores files whose names or contents do
not match this format. If a metric is missing from a week, that week has no
point for the metric.
