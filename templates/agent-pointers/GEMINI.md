<!-- project-swarm:start -->
## Project Swarm

Any agent may orchestrate this project. Read `{{SWARM_INSTALL}}/current/skills/project-swarm/SKILL.md`, then `{{SWARM_INSTALL}}/docs/kickoff.md` and `coordination/ORCHESTRATOR.md` before dispatching work.
Use `{{SWARM_INSTALL}}/current/tools/swarm.mjs` wherever the skill says `{{SWARM_RUNNER}}`; pass `--root` with this project's absolute path for project commands. Never pass `--root` to `update` or `version`.
At session start, run `swarm brief` and continue from its next actions. `coordination/HANDOFF.md` is generated from the project journal after every command, so do not edit it by hand; record decisions with `swarm note "text"`, and use `swarm handoff --to <agent>` to hand the project to another agent.
Maintain `coordination/TASK.md`. Ask which providers may receive project code and the spend ceiling before model calls. Never include secrets in worker context or commit `.swarm/`. Never stop a process by a loose pattern (`pkill -f`, `killall`): stop only a process you started, by its id.
<!-- project-swarm:end -->
