# Rules for every agent working in this repo

## project-swarm is only for the swarm itself

Never build another project inside this repo.

- The parts request app dogfood runs in **its own repo** (use `swarm init` there like any normal project).
- The starter kit (`web-portal`) is **its own repo** too.
- Bake-off tasks and eval repros stay **small test fixtures under `evals/`**: no real app code.
- Lessons from other projects come back here **only as lesson files** (no copied app code, no secrets, no customer data).
- The plan ([docs/plans/swarm-scale-plan-v2.md](docs/plans/swarm-scale-plan-v2.md)) is frozen; new ideas go in [docs/plans/ideas.md](docs/plans/ideas.md).

If a task would put app code in this repo, stop and ask the owner for the project's own repo.
