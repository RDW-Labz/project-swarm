# Phone approvals

Answer the swarm from your phone, with the GitHub app you may already have. No server, no webhook, no tunnel and no new service: the swarm opens an **issue** in one **private** repo you name, GitHub notifies your phone, you reply with one word, and `swarm phone sync` (run on your computer, by hand or in a loop) reads the reply with the `gh` login already there.

## Set up (once)

1. `swarm phone setup --repo OWNER/NAME` uses that repo, creates it (private) if it does not exist, and **refuses a public repo**. It records your own GitHub login, from `gh`; add other logins that are also you with `--owner LOGIN` (repeatable). Replies from those logins, and no others, count. Whichever of them can see the repo can run `swarm phone sync`. (The login must be allowed to create repos where you name one; or create the private repo yourself first.)
2. On the phone: install the GitHub app, sign in, open the repo and choose Watch > All activity.
3. `swarm phone sync` opens a question for each waiting decision (and each proposed ticket that already names its files), plus one **panic button**.

`swarm phone status` shows what is open. `swarm phone off` stops it. `swarm phone sync --dry-run` shows what it would do and changes nothing.

## What you can answer

| Question | Reply | What happens |
|---|---|---|
| A decision with choices | `1`, `2`, ... (the numbered choice) | `swarm decide ID CHOICE`; any choice other than the decision's current default adds a change to the backlog, so it needs the confirmation word |
| A proposed ticket (files already named by you) | `approve` | `swarm tickets ID --approve --yes` |
| Any question | `decline` | nothing is changed; answer at the computer |
| Panic button | `stop` | `swarm stop --all` (after the word below) |

One word only, nothing else.

## What it will never do from a phone

Merge, deploy, raise a spend cap, accept a security or migration override, accept an unmet acceptance line. These are not offered; the code has no path to them (a test reads the source), and if you ask for one the question says to do it at your computer.

## The rules that make it safe

- A reply counts only if it is from **one of your logins**, on an issue the swarm opened (kept in a local record, not read from the issue), **once**, within **24 hours**, **unedited**, one plain word, and one of the replies **that question** offered. Anything else is ignored; `~/.project-swarm/phone/ignored.ndjson` records who, which issue and why (never what they wrote).
- **Second step** for anything touching money, sign-in, secrets, deletion, migrations or production, a ticket marked sensitive or high risk, a ticket whose files look like those, and always for the panic button: after your answer the swarm posts a one-time word; reply with it within an hour. Three wrong words lock the question. `decline` cancels.
- An answer is recorded **before** it runs, so a crash or a second reply cannot run it twice. A failing command is reported on the issue and not retried.
- A question you handled at your computer is closed on the next sync. Expired ones are closed with "Nothing was done".
- The text of a question is fixed words plus sanitised data (markup, links and secret-looking strings removed). At most 10 new questions per sync, 30 open.

## Files

`~/.project-swarm/phone/` (override with `SWARM_PHONE_DIR`): `config.json` (repo, your login, on/off), `state.json` (open and answered questions), `ignored.ndjson`. All 0600.
