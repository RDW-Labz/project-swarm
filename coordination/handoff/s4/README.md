# S4 owner-action slice (R-029) handed to the Mac mini

Tickets: T-0102 (contract), T-0111 (tools/board-owner-actions.mjs), T-0112 (tools/board-action-guard.mjs), T-0114 (watch-server routes), T-0123 (watch-assets/board-owner-actions.js), T-0131 (tests), T-0138 (mount on board.js and orchestrator-view.js). tickets.json holds the full ticket text and acceptance lines; tickets.log the history.
All seven are sensitive: they go through their recorded review before `swarm tickets ID --delivered PR`. On the MacBook side they are parked (blocked, note "handed to the Mac mini"); do not build them there.
Security rules that hold for every one: Approve and Deny only for requests the policy leaves to the owner, tailnet sign-in required, merge, deploy and caps and spend refused server-side, no action reachable from an agent session, confirm step on the board.
