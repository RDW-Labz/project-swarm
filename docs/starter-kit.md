# Starter kit and scope interview (Phase 18)

Two ways to start a project faster: begin from a kit where the basics already work, and write the scope by answering questions instead of a blank page.

## The kit lives in its own repo

The `web-portal` kit is **not** part of project-swarm (see CLAUDE.md). Today it is a local repo, `web-portal-kit` (Next.js 16, React 19, Tailwind, Supabase, zod, Vitest, Vercel): sign-in by email link, roles (admin, staff, customer), layout and design system (navy and lime), forms, tables, email (Resend), file upload, payments in test mode (Stripe), an admin panel, error tracking, CI and deploy. Its `kit.json` lists the slots (which files the kit owns and where the swarm builds), the services to set up on day 0, and the environment names.

## `swarm init --kit`

```
swarm init --kit web-portal --kit-source PATH_OR_GIT_URL [--name "Dealer Portal"] [--no-protect-kit]
```

Run it in a new repo (a git folder with nothing but a README). It:
1. copies the kit in (never secrets, dependencies, git history or links), replaces a bare README with the kit's (a README with real content stays and the kit's is added as `KIT-README.md`), merges its `.gitignore` without any line that un-ignores something;
2. names the project (`package.json` name and the title words the kit lists);
3. lists the **kit-owned files as read-only** in the profile (`readOnlyPaths`): a swarm ticket may read them as context (the helpers it should use) but cannot edit, create or delete them. The swarm builds only in `src/app/portal`, `src/features` and `src/config/project.ts` (extra navigation links and extra route rules; the kit's own route rules are checked first, so a project rule can add a page but never open `/admin`). `--no-protect-kit` turns that off. A kit may own at most 80 paths (list folders). The kit is all-or-nothing: it is read and checked first (no secrets or links, nothing over 2000 files, 20 MB or 2 MB a file, none of the owner's files such as `.project-swarm.json`), and a failure puts the folder back as it was;
4. adds one **Day 0** human task per service (required ones first), with its steps, to `swarm inbox`;
5. then runs the normal `swarm init`.

A git source is cloned shallowly into a temp folder that is removed afterwards. Nothing from the kit is run.

## `swarm scope new`

```
swarm scope new [--type web-portal] [--out FILE] [--answers FILE]
```

An interview in the terminal (or the same answers as JSON with `--answers`) that writes the scope file: the product, who signs in, up to 12 features written as "WHO can DO WHAT" with 1 to 4 checks each (a number where you can), whether it takes payments, sends email, takes uploads, uses other services, holds sensitive data. It builds requirement IDs (`R-001`...), stages of four, an Overview, **Provided by the kit** (so no ticket is made for what the kit already does), External, Sensitive and Protected. It uses **no model and costs nothing**; your words go in as typed (newlines flattened). It prints the scope checker's warnings (vague words such as "fast" or "easy" without a number), never overwrites a file, and keeps rejected answers in `.swarm/project/scope-answers.json` so you fix one line instead of answering again.

Then: `swarm scope check`, `swarm scope split`, `swarm scope approve --yes`.

## What is verified

A project made from the real kit (`swarm init --kit` then `npm ci && npm run check`) passes the kit's typecheck, lint, 36 tests, production build and a 14-check smoke run. The kit's sign-in, admin, upload, email and payment code is tested with fakes; nothing has talked to a real Supabase project, Resend or Stripe account yet: the first real project built from the kit is that test.
