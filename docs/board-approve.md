# Board approve and deny

This document describes how a project owner can approve or deny work from the swarm board and from a paired phone. It reflects the server-side core in `tools/board-approve.mjs`. **Only that core module exists today.** Board UI buttons and HTTP/server wiring are planned, not shipped.

## What you can answer from the board or phone

Board and phone share the same fixed action list: `choose`, `approve-ticket`, `decline`, and `stop-all`. An action is allowed only when it matches the item kind and is not blocked as elevated (see below).

| Action | When it applies |
|--------|-----------------|
| `choose` | Hand-build items: `approve` or `deny`. Decision items: one of the choices listed on the item. |
| `approve-ticket` | Items whose kind is `ticket` or `proposed-ticket`. |
| `decline` | Any non-elevated item. |
| `stop-all` | Items whose kind is `stop`, or the panic item (`id` is `panic`). |

Each successful commit records `channel: 'board'` in the payload passed to the apply hook, along with `itemId`, `action`, optional `choice`, `projectId`, and `machineId`.

## What you can never answer there

These operations are **never** allowed from the board or phone, even as a decline or choice:

- merge
- deploy
- publish
- cap raise
- force-push
- branch `-D` (listed as `branch-D` in code)
- override
- accept unmet acceptance

If an item is **elevated**, every board action is refused. Elevation is detected from the item’s `kind`, `git` entries, or `elevated` field (string or array). Any signal that matches those forbidden tokens (with flexible normalization) blocks the item. Unknown actions outside the four allowed names are also refused.

## Pairing a phone or tablet

1. The server creates a **one-time pairing word**: three lowercase words joined by hyphens (for example `amber-otter-cloud`).
2. The word is shown once to the owner. Only a SHA-256 hash is stored; the plain word is not kept after redemption.
3. The word is valid for **10 minutes** (`PAIRING_VALID_MS`).
4. The owner enters the word and a **device name** (required, up to 80 characters). On success the pairing is consumed and cannot be reused.
5. Wrong guesses increment a counter. After **3** failed attempts, pairing is **locked for 15 minutes** (`PAIRING_LOCK_MS`). While locked, new pairing or redemption fails with `pairing-locked`.

## Device tokens

On successful pairing the server returns a **device token** once. The token is never stored in clear text. Only `sha256("board-device:" + token)` is saved per device, along with name and timestamps. Later requests authenticate by presenting the token; the server looks up the hash. Device IDs are derived from the token hash prefix.

## One-time decision IDs

For each board item the server can issue **decision IDs** tied to:

- a snapshot of the item (`id`, `kind`, `projectId`, `machineId`, title, choices, git),
- the **device** that requested the IDs,
- the **machine** on the item or store,
- an **expiry** (at most 24 hours from issue, or sooner if the item has `expiresAt` / `expiresAtMs`).

Each decision ID is single-use. After a successful commit it is marked consumed.

## Two-step confirm and CSRF

Approving or denying is always **prepare**, then **commit**:

1. **Prepare** — Owner (or UI) sends the decision ID, action, optional choice, and device token. If allowed, the server returns human-readable **confirm text** (for example “Approve hand-build hb-xyz on my-proj?”) and a **CSRF** value. The decision is marked prepared; the CSRF is stored as a hash bound to the decision ID and device ID.
2. **Commit** — Owner confirms with the same decision ID, the CSRF from prepare, and the device token. The server verifies CSRF, re-checks allow rules, marks the decision consumed, and calls the apply hook.

Commit without a prior prepare fails with `not-prepared`. A CSRF from a different prepare on another decision fails with `invalid-csrf`.

## Refusals: replay, expiry, wrong device

| Result | Meaning |
|--------|---------|
| `replayed` | Decision already consumed. |
| `expired` | Current time is past the decision’s `expiresAt`. |
| `wrong-device` | Token belongs to a different device than the one bound at issue time. |
| `disallowed-action` | Elevated item or action/choice not allowed for that item. |
| `unknown-decision` | No such decision ID. |
| `no-device` | Missing or unknown device token. |

Failed attempts are audited (see below). Pairing has its own errors: `pairing-expired`, `pairing-wrong`, `pairing-invalid`, `pairing-locked`, `device-name-required`.

## Audit log

Every prepare and commit attempt appends one JSON line per event. Fields include time (`at`), `who` (caller identity string), `device` name, `action`, `itemId`, `projectId`, `machineId`, and `result` (for example `prepared`, `ok`, `replayed`, `expired`, `invalid-csrf`).

The log must **not** contain device tokens, pairing words, or private item fields such as internal reasons. When configured, lines are appended to a file under a restricted directory mode; otherwise an in-memory buffer is used for tests.

## Implementation status

- **Shipped:** pairing, hashed device storage, decision ID issuance, prepare/commit with CSRF, allow/deny rules, elevated blocking, and audit append/list in `tools/board-approve.mjs`.
- **Planned:** board buttons, API routes, and wiring that call these functions and run the apply hook against real swarm actions.

Owners should assume elevated and forbidden operations still require the normal elevated channels (CLI, merge guard, deploy pipeline, etc.), not the board.
