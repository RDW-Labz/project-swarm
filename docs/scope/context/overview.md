# Project Swarm roadmap (audit 2026-10-20): overview

Project Swarm builds software with many cheap AI workers, planned and checked by an orchestrator. The audit of 2026-10-20 (parts-request-app, atlas-seafloor, marketing agency, project-swarm) found that the main bottlenecks are bad ticket splitting, owner approvals, workers seeing only committed files, one giant swarm.mjs, idle slots, and serial version bumps. This scope is the checklist to fix them. It is also the first real test of the Swarm Watch "Build progress" view: every requirement below should show up there as progress toward a finished build.

Already merged before this scope (mark their tickets done with the PR as evidence): guard D+E (#208), autopilot P (#209), board hang fix (#212), CI timeouts + push-only-main (#213), executors flake fix (#217), flat-rate $0 reserve E9 (#204), base-check placeholders (#205).

Out of scope: building the 8 managers as separate long-running agents (S6 defines their first version only), GPU lane rental, any project's app features.
