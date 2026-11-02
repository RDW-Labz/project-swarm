# Handoff docs (`swarm handoff generate | check | status | final`)

At the end of a stage, write the guides the client needs into the project's own `docs/handoff/`: a **user guide**, an **admin guide** and a **runbook**. (`swarm handoff --to codex|cursor|claude|gemini` is the older command that briefs another agent; it is unchanged.)

## What costs money and what does not

| Part | Written by | Cost |
|---|---|---|
| `runbook.md` | the swarm, from your profile | free |
| `inputs.md`, screenshots in `img/` | the swarm, from your approved scope and the screenshot gallery | free |
| `user-guide.md`, `admin-guide.md` | two workers (mid tier) in a normal manifest | worst case shown first, capped at **$2.00** by default (`--max-usd N`, at most $20) |

`swarm handoff generate --stage S3 --dry-run` prints the worst case and the cap and writes nothing. Without `--dry-run` it asks `Spend up to $2.00? [y/N]`; with no terminal it refuses unless you pass `--yes`.

## The runbook never invents facts

Fill the `handoff` block of the profile (`.project-swarm.json`, `profile.handoff`):

```json
{ "profile": { "handoff": {
  "deploy": ["vercel", "deploy", "--prod"],
  "rollback": ["vercel", "rollback"],
  "rotateKeys": [{ "service": "Supabase", "steps": "Dashboard, API settings, roll the service key." }],
  "logs": [{ "name": "Vercel logs", "url": "https://vercel.com/acme/portal/logs" }],
  "contacts": [{ "role": "Developer", "name": "Braden", "phone": "+1 555 0100" }],
  "previewUrl": "https://portal-preview.vercel.app",
  "previewHosts": ["*.vercel.app"]
} } }
```

Commands are lists of words, not one shell line. Names and phone numbers stay in your file. Anything missing is written as `TODO (owner)` and the handoff cannot be marked final while one is left. Running `generate` again rebuilds the runbook for free once you have filled the gaps.

## The guides, and how they are checked

The workers write from the **approved scope** (your own words: overview, the requirements up to this stage and how each is accepted, screens, external services), never from ticket titles. Each step that names a screen, an address or visible text carries a line like

```
<!-- check: route=/orders text="Order history" -->
```

`swarm handoff check --url https://PREVIEW` fetches each route (the page must answer 2xx on the same host, and the text must be on the page; scripts and styles do not count). Add `--propose` to file one **proposed** ticket per failing step (once; you read it, name its files and approve it like any proposal). The preview address must be https without credentials (or this computer). A `previewUrl` in the profile needs `previewHosts` and must be on them; redirects are followed by hand and only to the same host. `final` is tied to the exact guides that were checked: edit a guide and check again.

## Making it final

`swarm handoff final` succeeds only when all three files exist, no `TODO (owner)` is left, the guides were checked against a preview after they were last generated, and the last check had no failed step. `swarm handoff status` shows where it stands.

## What it never does

It sends nothing anywhere and spends nothing without your `y` or `--yes`. It does not put model-written text in the runbook, and a failing check never changes a guide: it only files a proposal.
