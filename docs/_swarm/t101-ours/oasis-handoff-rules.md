## Handoff — do this before you get expensive

**Also hand off when switching topics** (Braden, 2026-09-26; tuned by decision #138): hand off only when the next work is a new topic that is a real build (a new ticket, or ≥2 build dispatches). A follow-up that fits in one dispatch or less (a ship/merge of already-built work, a one-button fix, bookkeeping) stays in the current chat, even in another repo.

Count your build dispatches (jobs that write code, tests, docs or art; PR bodies and bookkeeping do not count; Braden, 2026-09-24). **Hand off at 120k context or on the 15th build dispatch, whichever comes first (Braden, 2026-09-29, decision #282; was the 10th).** Do not wait to feel full; by then every turn already costs double.

**Keep the handoff current (Braden, 2026-09-24):** after every dispatch report, rewrite `coordination/HANDOFF.md` (done / in flight / next) and the TASK.md status. Then the handoff is only step 3, with no pause to write it.

Handoff is three steps:

1. Update `coordination/TASK.md` so it stands alone — someone who has read nothing else can pick it up.
2. Write `coordination/HANDOFF.md` with what is done, what is in flight, and what is next. Also refresh the README "Repos" table's "On Braden's Mac" column from `coordination/mac-checks.md` (decision #240).
3. Give Braden the three speed lines (decision #143: idle min · jobs in parallel · wall time per merged PR), then this block, and nothing else:

```
You are orchestrator. Read coordination/ORCHESTRATOR.md, then coordination/HANDOFF.md,
then coordination/TASK.md. Confirm the done-when in one line, then continue.
```

Then say: "Paste that into a fresh terminal. This chat is done." Stop working.

