# Security gate

The security gate checks every batch before it can stay merged. It runs in the merge queue.

## What it is and where it runs

The gate runs on every batch in the merge queue. It runs before the project checks. So a blocked batch never runs its own code. Its tests, installs and postinstall scripts do not run. The gate also runs with --no-checks.

Each batch records whether security passed or blocked.

If the gate blocks a batch, the queue rolls the batch back. The queue then bisects the batch, the same way it handles a failed check.

The profile file is read once when the queue starts. This happens before any batch writes.

Plain integrate without --queue is not gated. Use the queue.

## The five checks

### 1. Secret scan

The secret scan looks for secrets in the files a batch writes. It uses named rules. Any hit blocks the batch. Every match on a line is reported.

The rules cover common AWS, GitHub, GitLab, npm, OpenAI, Anthropic, Slack, Stripe and Google keys. They also cover private key blocks, JSON Web Tokens, passwords in URLs, and generic or unquoted env-style secret assignments.

Files are read with care, so a secret cannot hide:

- NUL bytes become newlines.
- UTF-16 files are decoded too.
- Big files are scanned in windows. Only a file beyond 20 windows is blocked as too large to scan.
- Scan work per line is bounded.

Findings never contain the secret. A finding shows the rule, the path, the line and a 12 character fingerprint. The fingerprint is an HMAC with a random per-project key. The key is stored in .swarm/project/security-key with mode 600. So a low-entropy secret cannot be recovered from a fingerprint.

The scan stops after 200 findings. It keeps at most 3 findings per rule in each file.

The swarm-secret-allow marker only works on a line that already existed in the previous version of the file. Otherwise the marker is ignored. A worker cannot add the marker to silence the gate.

### 2. Package check

The package check looks for new dependencies. It reads manifests in any folder. These are package.json, including peerDependencies and overrides, and requirements text files. A version bump counts as new.

Every new dependency must:

- exist on the registry;
- be at least 30 days old;
- have at least 100 downloads in the last week, for npm packages;
- not look like a popular name, for npm packages.

This catches made-up names and look-alike names.

These specs are blocked as non-registry. Owner approval is needed. They are git, GitHub, GitLab, file, link, tarball and URL specs, and extra index URLs.

An npm alias is checked under its target name. Workspace specs pass.

An exact pinned version is checked by that version's age and licence.

PyPI names are normalized.

Registry calls have a 10 second timeout. Results are cached for each run.

A weekly download count is only a signal. It is not proof that a package is safe.

### 3. Known vulnerabilities

The vulnerability check uses npm audit, pip-audit or osv-scanner. npm audit is pinned to the public registry. pip-audit runs with --no-deps --disable-pip and a minimal environment.

This check runs only when a manifest or lockfile changed in the batch.

The check fails closed. If a dependency manifest or lockfile changed and no scanner gave a usable answer, the batch is blocked as could not verify. A block also applies when a scanner's output is unusable. This rule applies unless the profile sets requireVulnerabilityScan to false.

With changed manifests, only the vulnerabilities of the changed dependencies block. With only a lockfile change, every high or critical vulnerability blocks.

Limit: yarn.lock, pnpm-lock.yaml, pyproject.toml, Pipfile, go.mod and Cargo.toml changes trigger the vulnerability requirement. Their dependencies are not parsed for the new-package check.

### 4. Code scan

The code scan uses Semgrep, when Semgrep is installed. It runs with --metrics=off. File paths are passed after --.

The code scan is skipped for sensitive projects. This is the default. It runs only if the profile sets codeScan to auto and codeScanSensitive to true.

High and medium findings become fix tickets. A ticket carries only the rule id, path and line. Code scan findings never block.

Tickets are recorded only for a batch that stays merged.

### 5. Licence check

The licence check uses a real SPDX expression parser. It supports OR, AND, WITH and parentheses.

GPL and AGPL licences block the batch, unless the policy allows them. LGPL and permissive licences pass. An unknown licence only warns.

## What a block does

A block has these effects:

- The check name is security-gate in checkFailed.
- The queue state and the summary show securityBlocked.
- The inbox gets a blocker with the id security-<run>-<jobs>. The blocker contains no secret text.
- The gate writes one sanitized lesson line to .swarm/project/security-lessons.ndjson. The Phase 15 lessons loop reads this file.
- The queue state records which scanners were skipped in securityNotes.

## Policy

The policy lives in the optional security block in .project-swarm.json under profile. Every key has a default:

- enabled: true
- minAgeDays: 30
- minWeeklyDownloads: 100
- blockSeverities: high and critical
- allowCopyleft: false
- approvedLicenses: empty
- allowedSecretFingerprints: empty
- requireVulnerabilityScan: true
- codeScan: auto
- codeScanSensitive: false

The gate can only be turned off in this file. No flag can turn it off.

## Allowing a known false positive

There are two ways to allow a secret finding:

- Put the marker swarm-secret-allow on a line that already existed in the previous version of the file.
- Add the fingerprint to allowedSecretFingerprints in the policy.

## Missing tools and network failures

If a tool is missing, the gate skips that tool and adds a note. This applies to npm, pip-audit, osv-scanner and semgrep.

If the registry cannot be reached, the package check fails closed for new dependencies. The batch is blocked as could not verify.

## Known limits

- The gate scans only the files a batch writes. It does not scan git history.
- Plain integrate without --queue is not gated.
- The registry checks need network access.
- A weekly download count is only a signal. It is not proof that a package is safe.
- yarn.lock, pnpm-lock.yaml, pyproject.toml, Pipfile, go.mod and Cargo.toml changes trigger the vulnerability requirement, but their dependencies are not parsed for the new-package check.
- The profile file is read once when the queue starts, before any batch writes.
