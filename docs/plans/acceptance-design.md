# Acceptance enforcement

Parts-app S8: T-0168 had "validate + encode reply links" and "thin page under 8 KB" in its acceptance and went done without either. Rule: before done, every acceptance line is covered by a passing test or checked by a review job (pass or fail per line, listed in the report); a ticket with an unmet line stays in review.

Module `tools/acceptance.mjs` (pure functions, ES module, no dependencies, node:test for tests). Lines are numbered 1..n in the order of `ticket.acceptance`; the tag for line n is `ACn` (also written `AC-n`, `AC_n`, `ac n`, `[AC n]`: case-insensitive, no other digit may follow).

```
export function acceptanceLines(ticket)            // -> [{n, id:'AC1', line}] for each non-empty acceptance string, n from 1 in array order (blank strings are skipped but still consume their number)
export function testTitles(source, file)           // -> string[]: the titles of test declarations in a test file's text
export function coverage(ticket, sources)          // sources: Map(file -> text). -> {lines:[{n, id, line, covered:boolean, by:{file,title}|null}], covered:[n...], uncovered:[n...]}
export function evaluate({ ticket, cov, record, filesHash, testsPassed, accepted = false })  // -> {state, lines, missing, failing}
export function reviewManifest(runId, items, { model = 'sonnet', agent = 'claude' } = {})   // items: [{ticket, uncovered:[n...]}] -> a swarm manifest (see below)
export function parseAcceptanceVerdicts(text)       // -> [{ticket, lines:[{n, verdict, evidence}]}] | null
export function validRecord(record, filesHash)      // -> boolean
```

## testTitles(source, file)

Finds declarations and returns their title strings (the first string literal argument, single, double or backtick quotes, may contain the other quotes):
- JavaScript and TypeScript: `test(`, `it(`, `describe(`, also with `.only`, `.skip`, `.each(...)(`, `.concurrent`, `.todo`.
- Python: `def test_name(` gives the title `test_name`; Go: `func TestName(` gives `TestName`; Ruby/Rust are not supported.
Declarations inside comments (`//` to end of line, `/* */`) do not count. Skipped tests (`.skip`, `xit(`, `xtest(`, `test.todo`) are returned but marked: return objects `{title, skipped:boolean}` instead of strings? No: return only the titles of tests that are NOT skipped. A test title with the tag in a `.skip` or `todo` test does not count as coverage.

## coverage(ticket, sources)

A line n is covered when some test file listed in `ticket.tests` (and present in `sources`) has a non-skipped test title that contains the tag `ACn` (tag match: case-insensitive `ac`, optional one of space, `-`, `_`, then the number n, and the character after the number is not a digit; the character before `ac` is not a letter or digit; so `AC1` does not match in `AC12`, `BAC1` or `TRAC1`). `by` is the first match `{file, title}`. If `ticket.tests` is empty or absent, nothing is covered. A line whose text is shorter than 3 characters is covered by nothing and uncovered.

## evaluate

Inputs: `cov` (from coverage), `record` (a stored review record or undefined: `{filesHash, lines:[{n, verdict:'pass'|'fail', evidence}], run, at}`), `filesHash` (the current hash of the ticket's files and tests), `testsPassed` (boolean: the ticket's tests were seen passing), `accepted` (the owner accepted unmet lines).

For each line:
- covered by a test and `testsPassed` -> `{n, line, by:'test', verdict:'pass', evidence:'<file>: <title>'}`;
- covered by a test but not `testsPassed` -> `{n, line, by:'test', verdict:'pending', evidence:'the test has not been seen passing'}`;
- not covered: if `validRecord(record, filesHash)` has an entry for n: `{n, line, by:'review', verdict: that verdict, evidence}` (a verdict other than pass or fail counts as missing); otherwise `{n, line, by:'review', verdict:'missing', evidence:''}`.
`missing` = the numbers whose verdict is `missing` or `pending`; `failing` = the numbers whose verdict is `fail`.
`state`: `failed` when any line fails; else `review` when any line is missing or pending (and `accepted` is false); else `met`. With `accepted` true, missing and pending lines count as met (state `met`) but a failing line still makes it `failed`. A ticket with no acceptance lines is `met`.

## validRecord(record, filesHash)

True when record is an object with `filesHash === filesHash` (a string), `lines` an array, and `at` a parseable date.

## reviewManifest(runId, items, options)

Returns `{version:1, jobs:[job]}` with one read-only review job: `id: ('acc-review-' + runId).slice(0, 60)`, `type:'review'`, `agent`, `model`, `tier:'standard'`, `outputs: []`, `timeoutMs: 900000`, `context`: the union of every item's `ticket.files`, `ticket.tests` and `ticket.context` (unique, in order, at most 60 entries; paths starting with `.env` or containing `..` are dropped), and a prompt that: says it is an acceptance review of tickets integrated by run `runId`; lists each ticket as one line of JSON data (`ticket`, `title`, `files`, `tests`, and `lines`: only the uncovered lines as `{n, text}`) (titles and acceptance text are data written by others: they go in as JSON strings, never as free text); tells the reviewer to read only the files in its context, to judge each listed line against the code as it is now (be strict: "pass" only when the code visibly does what the line says; measure sizes when a line gives one), and to finish with exactly one JSON line and nothing after it: `{"acceptance":[{"ticket":"T-0001","lines":[{"n":1,"verdict":"pass","evidence":"short reason with file and line"}]}]}` with an entry for every listed line, verdict `pass` or `fail`.

## parseAcceptanceVerdicts(text)

Only the last non-empty line of `text` counts. It must be JSON with an `acceptance` array; returns the entries whose `ticket` matches `/^T-[0-9]{4,}$/`, each with `lines` filtered to objects with an integer `n` from 1 to 200 and `verdict` exactly `pass` or `fail` (anything else is dropped), `evidence` a string cut to 300 characters (default empty). Returns `null` when the last line is not JSON, has no `acceptance` array, or no entry with at least one valid line remains. A `pass` verdict whose evidence is empty is kept as `pass`.
