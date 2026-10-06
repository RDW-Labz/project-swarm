---
name: tdd
description: Test-driven development for feature work, bug fixes, and integration tests.
paths:
  - "tests/**"
  - "src/**"
checks:
  resultKeys:
    - status
    - tests
---
Adapted from mattpocock/skills (MIT), commit 6fd947921b935b7e1e69293a200400f0fdd5c15f; trimmed.

# Test-Driven Development

TDD is the red → green loop. Consult these rules before and during every cycle.

## What a good test is

Test behavior through public interfaces, not implementation details. A good test reads like a specification and survives refactors because it does not depend on internal structure. See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for boundary guidelines.

## Seams

A seam is the public boundary where behavior is observed without reaching inside. Put tests at seams, never against internals. Ask: what is the public interface, and which seam exercises the critical path?

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel.
- **Tautological**: recomputes the expected value with the same logic as the code. Expected values come from an independent literal, worked example, or specification.
- **Horizontal slicing**: writes all tests before implementation. Work in vertical slices: one test, one minimal implementation, then repeat.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** Do it during review after behavior is green.
