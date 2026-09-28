# Automation integration study

This case used the project-swarm coordination workflow with three authorized
native workers and one coordinator in a CRM product. It did not run the toolkit's
restricted CLI adapters. Four native slots were available; no nested managers
were launched because there were only three independent implementation lanes.
The toolkit's adapter capability and isolation claims are unchanged.

## Task boundaries and checks

The first cohort separated execution reliability, unified history, and durable
task dispatch. The coordinator owned shared schema/interfaces and recurring
mission discovery. Explicit contracts connected `StartRunInput.commandId`,
instruction ancestry/source fields, and transactional `enqueueInstruction`.
The history worker then took the mission controls after those APIs stabilized.
This staged handoff reused a worker without assigning two writers to one file.

The implementation checks used disposable local database fixtures and fake
provider transports. History checks covered cursor precision and tenant scope;
executor checks covered replay, budgets, pause/cancellation, and provider
failures; dispatcher checks covered duplicate claims and bounded retry. A
subsequent worker independently reviewed mission discovery. A third pass
tested the full mission → manager → worker → review path using the real
execution functions and a controlled provider. Its 22 checks passed, including
a provider failure after a task write, replay without a duplicate task, an
approval wait, and a terminating manager review.

## What the review changed

- Separate task and schedule tests did not establish shared per-agent
  exclusion. Review identified overlap across entry points; admission now
  serializes on the agent row before inserting a running model loop.
- Limiting discovery before filtering enabled configurations allowed paused
  ventures to starve later ones. The query filters eligible settings first
  and rotates blocked settings through its bounded scan.
- Two tool names were insufficient evidence of orchestrator readiness.
  The readiness check now requires the tools used to discover workers and
  inspect actual CRM evidence.
- A model response does not prove the requested action happened. The product
  distinguishes a recorded response, a dry run, a pending approval, and a
  reviewer checking persisted tool results and CRM records.
- A later independent review identified a narrower crash window that the
  provider-failure test did not cover: the database write could commit before
  its replay log was saved. The release was held for an atomic receipt fix and
  a focused test that retries without the separate call log. Failure injection
  should target transaction boundaries as well as provider failures when a
  feature adds automatic retry.

These are concrete defects or contract gaps found during this implementation,
not a benchmark claiming a percentage speedup. No matched sequential baseline,
native-worker cost totals, or end-to-end latency distribution was collected.
More concurrent workers alone would not prove improved delivery.

## Reusable decision rule

When several workers implement different parts of an asynchronous workflow,
bind one independent integration acceptance job after their interfaces settle.
That check should cross the actual producer/claim/executor/completion boundary,
not replace each part with a stub. Mock only the external provider or service
when the aim is to avoid spending money or touching real customer data.

Record the actual acceptance command, exit status, and uncovered failures in
the consuming project's release evidence. A test plan or a worker's proposed
command is not a passing result. Installing a skill or publishing code is not
evidence that a live provider is configured or that production autonomy is on.

The user requested three passes for this project. This case does not impose
three passes on every task or authorize new production actions.

## Mission readiness follow-up

On 2026-09-17, the next CRM implementation used the same three-worker native
cohort: one worker owned team preparation and activation, another owned the
setup interface and model-check coverage, and the third owned a dedicated
worker prompt, dispatch eligibility, and independent lifecycle acceptance.
The coordinator owned shared discovery checks, provider verification, and
release integration. This remained native host delegation, not a toolkit CLI
adapter run or an experiment comparing delivery speed.

The earlier release could report a manager ready without an eligible worker.
Its existing research and monitoring prompts also did not establish a worker
for all three standing missions. Reviewing the bundled prompts exposed this
gap; broad tool lists on test fixtures would have hidden it. The follow-up
added a bounded CRM worker and checked the manager-to-worker chain using each
agent's effective permissions and configured route.

Preparation and activation were separate product operations. Preparation
installed two paused agents or refreshed their prompt metadata while preserving
existing levels, tool lists, model choices, budgets, and schedules. Explicit
owner activation refused custom access instead of overwriting it, kept the
write kill switch authoritative, and refused a ceiling increase that would
also expand another agent's access. Repeat-setup tests checked that these
controls and the discovery cursor survived reuse.

A configured key was not treated as a working model. The connection check
performed a synthetic tool call and consumed its result without sending CRM
records or invoking a CRM tool. Its proof was bound to the venture, credential
identity, and selected model, with an expiry. Tests rejected changed models,
rotated keys, wrong tools, wrong arguments, failed result handling, and copied
proof from another venture. Independent review also found the older settings
save path needed the same proof gate as the new activation button.

Observed focused checks in the consuming CRM at this stage were:

- `scripts/agent-mission-setup.test.ts`: 39 checks passed for preparation,
  preserved controls, verification-gated activation, and repeat activation.
- `scripts/agent-mission-model-check.test.ts`: 27 checks passed for synthetic
  provider verification and venture-scoped, content-free progress reporting.
- `scripts/agent-dispatch.test.ts`: 29 checks passed, including worker
  eligibility in the durable handoff.
- `scripts/agent-prompts.test.ts`: 99 checks passed against bundled prompt
  contracts, including the dedicated mission worker.
- `scripts/agent-mission-acceptance.test.ts`: 17 checks passed across all three
  mission signals, using actual preparation, verification, activation, durable
  queue, worker, and review functions with a controlled provider.

An independent forward-test applied the revised skill to a support-ticket
scenario with a configured manager and three specialist workers. The evaluator
identified the eligible worker, required checks against the bundled prompts
and effective permissions, selected a synthetic tool/result round trip, and
kept preparation, activation, and outcome claims separate. This observed the
intended decisions on a different scenario; it did not measure live support
outcomes or compare delivery speed against the previous skill.

These were local database fixtures and controlled provider transports. The
counts record executed checks, not proof of production credentials, successful
customer outcomes, or a measured speedup. Full release checks and production
verification belong in the consuming project's release evidence; publishing
this study does not imply they have passed. A paused team is
prepared; a saved enabled configuration is activated; recorded queue/run
events establish execution; the resulting CRM records establish the outcome.

## Operator pause/resume follow-up

The next CRM request added a prominent Autonomous mode switch and an in-app
operator guide. Three authorized native workers ran alongside the coordinator:
one owned pause/resume and durable-claim behavior, one owned the switch and
activity interface, and one owned the operator guide and its scope. After the
interface was implemented, the UI worker independently reviewed the backend;
then that worker moved to this skill study while the backend owner continued
its fixes and focused checks. These were staged ownership changes, not two
writers editing the same implementation file.

The agreed product boundary was more specific than stopping a scheduler:
OFF stops discovery and later claims of queued mission-origin work, including
its delegated tasks and completion reviews. Already claimed work may finish.
Manual instructions and independent schedules continue under their existing
controls. Queued work is retained for resume, with its attempt budget intact;
a mode change preserves mission choices, limits, and the discovery cursor.
The claim filter evaluates mission ancestry before limiting queue candidates,
so paused mission rows do not fill every candidate slot ahead of manual work.

Independent review found that the older settings save still accepted the
browser's `enabled` value. A tab opened while ON could later save an interval
after another tab switched OFF, thereby resuming autonomy without using the
new switch. The backend owner changed settings saves to preserve the current
database mode, and the focused regression check passed for an older ON form
saved after OFF. A hidden form field is still client state, not evidence of
the latest operator decision.

Review also identified a connection-pool risk in the proposed toggle: it held
a transaction connection and a venture lock, then issued readiness queries
through the global database pool. With eight pool connections, eight concurrent
requests could occupy the pool while the admitted transaction waited for a
ninth connection. This was a static review finding, not a reproduced deadlock
or measured outage. It justified checking resource acquisition across helper
boundaries, as well as SQL row-lock ordering. After the backend change, a
focused check with twelve concurrent ON requests passed. That is evidence
about the revised implementation under the tested load; it does not reproduce
the proposed deadlock in the earlier implementation or prove arbitrary load
capacity.

For the UI lane, the TypeScript check, scoped ESLint, and diff check passed.
The consuming project's 27 focused backend checks passed, including the
concurrent ON case, stale-form pause preservation, thirty paused queue entries
ahead of eligible work, manual-work descendants, and invalid ancestry with
cycles, foreign parents, or excessive depth. Browser checks found no overflow
at 320px or 390px on the controls and guide. A refused keyboard toggle stayed
OFF and preserved an unsaved 75-minute interval. Guide accordion interaction
and navigation back to controls also passed.

The broader CRM regression suite subsequently exposed a scan-cursor test
assumption; the backend owner was adjusting test clocks when these observations
were recorded. Full CRM release verification was therefore still pending.
These focused results do not claim that the whole suite or production release
passed. No real customer work, toolkit provider exchange, or production toggle
was performed to write this study.

An independent worker applied the revised skill to a billing-report pipeline
scenario. Its static forward-check derived pause boundaries, stale-UI checks,
and pool-concurrency testing requirements. This checks transfer of the guidance
to another workflow; it was not a live pipeline run or execution benchmark.

The narrow skill update now asks for an explicit pause boundary, stale-form
coverage, retained retry/cursor state, eligible-work fairness, and a review of
lock and pool usage. The value observed here was that an independent lane
found a second mutation path that could undo pause and a cross-helper resource
risk. No sequential baseline, cost comparison, or delivery-speed measurement
was collected, so this case makes no speedup claim.

## Completion capacity and turn-budget follow-up

CRM implementation and regression coverage: the consuming project's pull
request (external, not linked here), reviewed at commit
`0cb087e32f2d6a12854ca24664f175ff132eca6f`.

The next production observation exposed a different boundary: a manager could
successfully delegate a task, spend its remaining turns reading, and fail
before recording its own response. The CRM coordinator reported four manager
eight-turn-limit failures in the observed history: one rehearsal and three
live runs. A later parent retry completed, and two worker tasks had verified
CRM evidence by the 03:05 UTC observation. These are counts from one observed
state, not a controlled failure rate. A failed run did not imply that its
successful child assignment had been rolled back.

Three authorized native workers again had separate outputs alongside the
coordinator: runner/prompt and focused budget checks; a bounded synthetic
planning check and its controls; independent queue/receipt acceptance and
evidence. Local database test windows were passed between lanes so fixture
writers did not overlap. This was native host delegation; no toolkit CLI or
API worker exchange is claimed for the CRM implementation.

The first pass kept the existing eight-provider-turn and 24-tool-call caps,
deadlines, daily budgets, and permissions. A shared helper describes the
remaining capacity using those same enforced limits. The bundled manager
prompt was versioned to v2: inspect current task status first, reuse an
existing child on retry, batch independent reads, stop optional research,
and leave time for a receipt and completion response. The waiting instruction
inbox was not treated as a list of previously delegated children.

The second pass bound independent acceptance to actual preparation,
activation, mission discovery, bundled prompts, queue claims, runner, CRM
tools, write receipts, and manager review. Only model transport was controlled.
The acceptance deliberately used six reading turns, a successful assignment
on turn seven, and an unnecessary read on turn eight. It still failed at the
unchanged hard limit. Its child instruction and durable receipt remained.

After an OFF/ON pause, the retry read its real persisted task status and reused
the child rather than issuing another assignment. The parent completed its
response in two controlled provider turns. The original child produced one
task and one manager review, and all execution leases closed. Nineteen local
acceptance checks passed, including preserved queue attempts while paused,
one unchanged assignment receipt, unchanged daily budgets and permissions,
and no customer email. The two-turn recovery belongs to that fixture; it
does not predict every live retry's behavior.

The third pass independently reviewed the completion guard and provider-test
boundary. New delegation is absent from both the advertised and executable
tools on the final provider turn of an assigned task. Review also required
reserving a tool-call slot: assignment may use slot 23 and leave response
slot 24, but assignment in slot 24 is refused, including within a multi-call
provider response. The implementation's count convention is explicit: the
guard receives calls consumed before the attempted call. This avoids an
off-by-one disagreement between presentation and execution.

The optional planning check sends a fixed synthetic lead and simulated tool
results through the selected configured provider. Its tool contracts and
projections were checked against the real CRM shapes. It executes no real
CRM tool, reads no customer record, and creates no production fixture. The
check is bounded to eight model calls and 110 seconds, with a short lease to
prevent simultaneous probes; it can use provider credits. Its returned model,
prompt version/checksum, turn/tool counts, reason, and pass/fail are evidence
about that one synthetic planning handoff. They do not grant activation,
replace the separate connection proof, or verify a customer's outcome.

The coordinator subsequently reported that the CRM's full local `npm test`,
`npm run verify` (including its token check), and production build passed.
The final controlled planning-check suite passed 41 checks, alongside the
independent 19-check acceptance. These local results do not establish a live
served-model planning result. This study does not claim that a configured
model completed a live evaluation, that all production turn-limit failures
were eliminated, or that delivery speed improved. The deliberately inefficient
controlled run still failed. The improvement established here is the explicit
completion boundary, recovery using existing work, and regression coverage
that distinguishes failed orchestration from committed effects.

An independent worker then applied the guidance to a support-triage scenario
with different limits: six provider turns and twelve tool calls. It required
request-to-ticket identity, a defined write/receipt boundary, reserved
acknowledgement capacity, and a retry that inspects and reuses the existing
ticket. Its proposed checks included a committed ticket followed by a failed
parent, assignment in call 11 followed by acknowledgement in call 12, refused
last-slot delegation within a batch, concurrent retries, tenant isolation,
and preservation of unrelated operator tickets. It identified unknown
approval and transaction semantics before dispatch. This was a static
transfer review, not execution or a blinded comparison: the reviewer had
already read this study before receiving the fresh scenario.

The skill update's preflight passed all 76 toolkit tests, the 53-file package
check (including syntax and links), the skill-creator frontmatter validator,
and `git diff --check`. Those checks establish packaging and existing toolkit
regression coverage; the static review separately tests how the guidance is
applied. Neither establishes a live-provider speed or reliability improvement.
