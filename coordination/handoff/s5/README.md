# S5 Operations handed to the Mac mini (end to end, except six tickets)

tickets.json: the 19 open S5 tickets that do not touch tools/swarm.mjs (T-0148 is still running on the MacBook: leave it until it reports done, then take any follow-up). Build in the modules the tickets name. The six S5 tickets that need tools/swarm.mjs (T-0145, T-0150, T-0154, T-0159, T-0164, T-0172) stay with the MacBook; write the exact hook you need into coordination/handoff/swarm-mjs-requests.md.
They are parked on the MacBook (blocked, note "handed to the Mac mini"). Sensitive tickets (T-0165 and any marked) go through their recorded review before --delivered. Same rules as MINI-BRIEF-tm2.md section 5: swarm jobs only, full local suite before a PR, no ambient state in tests, no token-shaped literals.
Note: ignoreTestsReason has landed in the 1.165.0 batch release; T-0040..T-0042 can be unparked once swarm update brings it.
