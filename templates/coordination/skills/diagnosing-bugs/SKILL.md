---
name: diagnosing-bugs
description: Systematic diagnosis for failing tests, build breaks, unexpected behavior, and regressions.
paths:
  - "tests/**"
  - "src/**"
checks:
  resultKeys:
    - status
    - reproTest
---
Adapted from mattpocock/skills (MIT), commit 6fd947921b935b7e1e69293a200400f0fdd5c15f; trimmed.

# Diagnosing Bugs

Skip phases only with an explicit reason. Redact every secret before showing commands, output, or captured artifacts; use `<REDACTED>`.

## 1. Build a feedback loop

The loop is the skill. Build the tightest red-capable signal in this order: a failing test; a request against a running service; a CLI fixture with known-good output; a headless browser assertion; a captured trace replay; a minimal harness; a property or fuzz loop; a bisection or differential loop. Tighten it for speed, a sharp symptom assertion, and deterministic inputs.

Phase 1 is complete only when one command has been run and drives the actual bug, asserts the user's exact symptom, is deterministic, fast, and unattended. “Runs without error” is not enough. If no red-capable loop can be built, stop and record what access or artifact is missing.

## 2. Reproduce and minimise

Run the loop and capture the exact failure. Confirm it is the reported failure and repeat it across runs. Remove inputs, callers, configuration, data, and steps one at a time; keep only load-bearing elements. Do not proceed until the minimal scenario still goes red and every remaining element is necessary.

## 3. Hypothesise

Generate 3–5 ranked, falsifiable hypotheses before testing. State each prediction: “If X is the cause, changing Y will make the bug disappear or changing Z will make it worse.”

## 4. Instrument

Change one variable at a time. Prefer a debugger, then targeted logs at distinguishing boundaries. Tag temporary logs with a unique `[DEBUG-...]` prefix and remove them after diagnosis. For performance, measure a baseline before fixing.

## 5. Fix and regress

Write a regression test at the correct public seam before the fix. Watch it fail, apply the smallest fix, watch it pass, and rerun the original un-minimised loop. If no correct seam exists, record that architecture finding instead of creating false confidence.

## 6. Clean up

Rerun the original loop, keep the regression test, remove every debug tag and throwaway prototype, and state the confirmed cause in the change record.
