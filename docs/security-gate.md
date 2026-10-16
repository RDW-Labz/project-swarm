# Security gate

The security gate checks every batch before it can stay merged. It runs in the merge queue.

## What it is and where it runs

The gate runs on every batch in the merge queue. It runs after the batch's files are written. It runs before the batch can stay merged.

If the gate blocks a batch, the queue rolls the batch back. The queue then bisects the batch, the same way it handles a failed check.

## The five checks

### 1. Secret scan

The secret scan looks for secrets in the files a batch writes. It uses named rules. Any hit blocks the batch.

Findings never contain the secret. A finding shows only a 12 character fingerprint.

### 2. Package check

The package check looks at each new dependency. Every new dependency must:

- exist on the registry;
- be at least 30 days old;
- have real downloads, at least 100 in the last week;
- not look like a popular name.

This catches made-up names and look-alike names.

### 3. Known vulnerabilities

The vulnerability check uses npm audit, pip-audit or osv-scanner. High and critical findings block the batch.

This check runs only when a manifest or lockfile changed in the batch.

### 4. Code scan

The code scan uses Semgrep, when Semgrep is installed. High and medium findings become fix tickets. Code scan findings never block.

### 5. Licence check

GPL and AGPL licences block the batch, unless the policy allows them.

LGPL and permissive licences pass. An unknown licence only warns.

## What a block does

A block has these effects:

- The check name is security-gate in checkFailed.
- The queue state and the summary show securityBlocked.
- The inbox gets a blocker with the id security-<run>-<jobs>. The blocker contains no secret text.
- The gate writes one sanitized lesson line to .swarm/project/security-lessons.ndjson. The Phase 15 lessons loop reads this file.

## Policy

The policy lives in the optional security block in .project-swarm.json under profile. Every key has a default:

- enabled: true
- minAgeDays: 30
- minWeeklyDownloads: 100
- blockSeverities: high and critical
- allowCopyleft: false
- approvedLicenses: empty
- allowedSecretFingerprints: empty

The gate can only be turned off in this file. No flag can turn it off. The gate also runs with --no-checks.

## Allowing a known false positive

There are two ways to allow a secret finding:

- Put the marker swarm-secret-allow on the line.
- Add the fingerprint to allowedSecretFingerprints in the policy.

## Missing tools and network failures

If a tool is missing, the gate skips that tool and adds a note. This applies to npm, pip-audit, osv-scanner and semgrep.

If the registry cannot be reached, the package check fails closed for new dependencies. The batch is blocked.

## Known limits

- The gate scans only the files a batch writes. It does not scan git history.
- The registry checks need network access.
- A weekly download count is only a signal. It is not proof that a package is safe.
