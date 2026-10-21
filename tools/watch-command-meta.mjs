// SPDX-License-Identifier: Apache-2.0

export const COMMAND_META = {
  doctor: { what: 'Checks that each model provider is set up and answering.', when: 'Before a first run, or when a provider starts failing.', example: 'swarm doctor claude --probe-local', cost: 'local', approval: false },
  validate: { what: 'Checks a job manifest for missing fields and bad values.', when: 'After writing or editing a manifest, before running it.', example: 'swarm validate jobs/fix-login.json --evidence', cost: 'free', approval: false },
  preflight: { what: 'Dry-checks a manifest and reports cost and risks before any run.', when: 'Right before running a manifest you have not run yet.', example: 'swarm preflight jobs/fix-login.json', cost: 'local', approval: false },
  board: { what: 'Shows the active project runs in one table.', when: 'When you want to see what is running right now.', example: 'swarm board', cost: 'free', approval: false },
  orphans: { what: 'Lists scratch directories that have no run state behind them.', when: 'When disk use grows or after a crashed run.', example: 'swarm orphans', cost: 'free', approval: false },
  run: { what: 'Runs a job manifest, starting the model jobs it lists.', when: 'When a validated manifest is ready and you accept the cost.', example: 'swarm run jobs/fix-login.json --jobs 4 --evidence', cost: 'spends', approval: true },
  status: { what: 'Shows the status of one run: jobs done, running and failed.', when: 'To check progress on a run you started.', example: 'swarm status 20250311-login', cost: 'free', approval: false },
  monitor: { what: 'Follows a run live in the terminal or the monitor view.', when: 'While a run is in progress and you want live updates.', example: 'swarm monitor 20250311-login --view', cost: 'free', approval: false },
  wait: { what: 'Blocks until a run finishes, then exits with its result.', when: 'In a script that needs to wait for a run before the next step.', example: 'swarm wait 20250311-login --timeout 3600', cost: 'free', approval: false },
  inspect: { what: 'Shows full details for one run, including each job and its result.', when: 'When a run finished with failures and you need the details.', example: 'swarm inspect 20250311-login --results', cost: 'free', approval: false },
  rollup: { what: 'Summarizes the results of a run in a short report.', when: 'After a run ends, to see what landed and what did not.', example: 'swarm rollup 20250311-login --text --top 5', cost: 'free', approval: false },
  integrate: { what: 'Merges completed job outputs into the working branch, with checks.', when: 'After a run completes and you are ready to land its changes.', example: 'swarm integrate 20250311-login --queue', cost: 'local', approval: true },
  mutants: { what: 'Runs mutation checks to see whether the tests catch planted bugs.', when: 'When you want proof that the tests would catch a real regression.', example: 'swarm mutants --mutants-file mutants.json --dry-run', cost: 'local', approval: false },
  env: { what: 'Shows the swarm environment: paths, versions and settings.', when: 'When something behaves differently on one machine.', example: 'swarm env --print', cost: 'free', approval: false },
  redcheck: { what: 'Checks whether a failing test also fails on a baseline commit.', when: 'When a test is red and you need to know if it was already broken.', example: 'swarm redcheck 20250311-login --base main --test test/login.test.js', cost: 'local', approval: false },
  cancel: { what: 'Stops a run and marks its unfinished jobs as cancelled.', when: 'When a run is going the wrong way or is no longer needed.', example: 'swarm cancel 20250311-login', cost: 'free', approval: true },
  ship: { what: 'Ships a run or branch: pushes, opens the PR and merges once checks are green.', when: 'When the branch is ready and you want it on the main line.', example: 'swarm ship 20250311-login --repo acme/app --pr 412', cost: 'local', approval: true },
  think: { what: 'Asks the local brain for a short top-3 list with reasons.', when: 'When you are stuck choosing between options and want a quick view.', example: 'swarm think --rounds 2 which-bug-to-fix-first', cost: 'local', approval: false },
  digest: { what: 'Condenses a log, diff, test output or run into 15 lines.', when: 'When a long output is too big to read in full.', example: 'swarm digest --kind log build.log', cost: 'local', approval: false },
  draft: { what: 'Drafts docs, PR text or a plan with the local brain, then polishes it.', when: 'When you need a first draft of text without paying for a model.', example: 'swarm draft --context notes.md --out docs/login-plan.md', cost: 'local', approval: false },
  brain: { what: 'Shows local brain status, stats or runs a test call.', when: 'To check the local brain is up or see how it has been used.', example: 'swarm brain --markdown', cost: 'local', approval: false },
  budget: { what: 'Sets or shows the project daily spend limit and ceiling.', when: 'When you need to raise or inspect the billed daily cap before more paid runs.', example: 'swarm budget show', cost: 'local', approval: false },
  gpu: { what: 'Manages a rented GPU session: models, up, down, status and bake-off. Never rents by itself.', when: 'When you want to run a local model on rented hardware.', example: 'swarm gpu up --target lambda --model qwen-32b --hourly-usd 1.2 --max-usd 20 --yes', cost: 'spends', approval: true },
  init: { what: 'Sets up a project: profile, base check and repo map.', when: 'Once, when you first point the swarm at a project.', example: 'swarm init --check --json', cost: 'local', approval: false },
  map: { what: 'Builds or refreshes the repo map the agents read.', when: 'After large changes to the code so agents see the new layout.', example: 'swarm map --json', cost: 'local', approval: false },
  scale: { what: 'Runs stub jobs to measure how many jobs the machine handles.', when: 'When you are sizing concurrency for a new machine.', example: 'swarm scale --jobs 50 --concurrency 8', cost: 'local', approval: false },
  go: { what: 'Completes a manifest or goal end to end: plans, runs, checks and merges.', when: 'When you want the swarm to finish a goal from start to end.', example: 'swarm go login-rate-limit --max-usd 15 --yes', cost: 'spends', approval: true },
  plan: { what: 'Previews a goal: leads, cost, time and risks. Nothing runs.', when: 'Before go, to see what it would cost and do.', example: 'swarm plan login-rate-limit --max-usd 15', cost: 'free', approval: false },
  policy: { what: 'Shows, validates, or runs the machine auto-approve policy.', when: 'When you need to inspect rules or dry-run policy decisions.', example: 'swarm policy show', cost: 'local', approval: false },
  note: { what: 'Adds a note to the task or handoff file.', when: 'When you want to record a decision or fact for the next agent.', example: 'swarm note login-tests-use-staging-key --file HANDOFF.md', cost: 'free', approval: false },
  ask: { what: 'Asks one agent a question and returns its answer.', when: 'When you need a quick answer from a model about the code.', example: 'swarm ask where-is-the-session-token-refreshed --model claude', cost: 'spends', approval: true },
  scout: { what: 'Looks for libraries or resources that could help with a goal.', when: 'Before starting a goal, to see if something already exists.', example: 'swarm scout rate-limiting-middleware-express --max-picks 5', cost: 'spends', approval: true },
  verify: { what: 'Runs an orb verification scenario and reports pass or fail.', when: 'After a change to an orb, to confirm its scenario still holds.', example: 'swarm verify --orb checkout --scenario happy-path', cost: 'local', approval: false },
  'check-pins': { what: 'Checks that pinned project dependencies are current and safe.', when: 'Before a release, or when a dependency update is due.', example: 'swarm check-pins --root . --json', cost: 'local', approval: false },
  sweep: { what: 'Scans a list of goals for prior art, using a model, within a budget.', when: 'When you want to know if other projects already solved your goals.', example: 'swarm sweep --goals goals.txt --max-usd 5 --top 3', cost: 'spends', approval: true },
  version: { what: 'Shows the installed swarm version.', when: 'When you report a bug or check for updates.', example: 'swarm version --check', cost: 'free', approval: false },
  update: { what: 'Updates the shared swarm installation and optionally the projects.', when: 'When a new release is out and you want it installed.', example: 'swarm update --projects --yes', cost: 'local', approval: false },
  pin: { what: 'Pins a registered project to a specific swarm release (or lists pins).', when: 'When one project must stay on an older swarm while the install updates.', example: 'swarm pin marketing 1.47.0', cost: 'local', approval: false },
  unpin: { what: 'Removes the version pin so the next update can bump the project pointer.', when: 'When a pinned project is ready to track the shared install again.', example: 'swarm unpin marketing', cost: 'local', approval: false },
  squash: { what: 'Squashes the commits of a branch into one.', when: 'Before opening a PR, to keep history clean.', example: 'swarm squash --branch feature/login --base main', cost: 'local', approval: false },
  'clean-branch': { what: 'Removes unwanted changes from a branch.', when: 'When a branch picked up files that should not be in the PR.', example: 'swarm clean-branch --from main --exclude secrets.env', cost: 'local', approval: false },
  scope: { what: 'Manages the scope file: writes a template, checks it, splits it into tickets, syncs.', when: 'When a project starts or the scope changes.', example: 'swarm scope --check docs/scope.md', cost: 'local', approval: false },
  tickets: { what: 'Lists scope tickets and their status, or shows one ticket.', when: 'To see what is left to do on the project scope.', example: 'swarm tickets --status blocked --json', cost: 'free', approval: false },
  change: { what: 'Records a scope change order with its reason.', when: 'When the scope changes on purpose and the record must show why.', example: 'swarm change --yes', cost: 'free', approval: false },
  watch: { what: 'Opens a read-only dashboard for a run: live map, Build Plan, commands and screens.', when: 'While a run is going, or to look at a finished one.', example: 'swarm watch --open', cost: 'free', approval: false },
  gallery: { what: 'Lists screens from the UI check and records your approval or comments.', when: 'When you review the design screens in one sitting.', example: 'swarm gallery approve form-contact', cost: 'free', approval: false },
  ui: { what: 'Renders design screens and compares them with the mockups.', when: 'After UI changes, to check the screens still match the approved mockups.', example: 'swarm ui --base-url http://localhost:3000 --json', cost: 'local', approval: false },
  merge: { what: 'Squash-merges a PR only when every check is green.', when: 'When a PR is reviewed and all checks pass, to land it.', example: 'swarm merge --repo acme/app', cost: 'local', approval: true },
  lessons: { what: 'Lists, adds and checks structured lessons from past runs.', when: 'After a failure, to record the lesson so it is not repeated.', example: 'swarm lessons add --what tests-ran-before-deps --fix install-first', cost: 'local', approval: false },
  eval: { what: 'Runs the golden eval set: list, validate, score and gate.', when: 'Before a model or prompt change, to check quality did not drop.', example: 'swarm eval score --agent claude --model sonnet --all', cost: 'spends', approval: true },
  onboard: { what: 'Sets up onboarding for a new project or contributor.', when: 'When a new person or agent joins the project.', example: 'swarm onboard', cost: 'local', approval: false },
  lesson: { what: 'Manages recorded project lessons: list, add, check and retire them.', when: 'When lessons need review, or after a release that changed them.', example: 'swarm lesson --stale-days 90 --dry-run', cost: 'local', approval: false },
  resume: { what: 'Resumes a paused run with a stated reason.', when: 'After a pause, when the cause is fixed and the run should continue.', example: 'swarm resume 20250311-login --reason rate-limit-cleared', cost: 'spends', approval: true },
  ledger: { what: 'Shows recorded spend across runs.', when: 'To see what the project has cost so far.', example: 'swarm ledger', cost: 'free', approval: false },
  idle: { what: 'Picks zero-quota work to do while waiting on a limit.', when: 'When providers are out of quota and you want useful local work.', example: 'swarm idle', cost: 'local', approval: false },
  ticket: { what: 'Runs one ticket through the full pipeline: job, PR, checks and merge.', when: 'When a scope ticket is ready to be built and shipped.', example: 'swarm ticket jobs/tkt-042.json --pr --repo acme/app', cost: 'spends', approval: true },
  scaffold: { what: 'Writes a job or PR manifest file from flags.', when: 'Before a run, when you want a manifest without writing JSON by hand.', example: 'swarm scaffold --id login-fix --agent claude --out jobs/login-fix.json', cost: 'free', approval: false },
  brief: { what: 'Prints a short briefing so any agent can take over the work.', when: 'When a new agent or person starts on the project.', example: 'swarm brief --json', cost: 'free', approval: false },
  handoff: { what: 'Prints a paste-ready handoff message for another agent.', when: 'When you pass work to another agent or tool.', example: 'swarm handoff --to codex', cost: 'free', approval: false },
  checkpoint: { what: 'Saves a snapshot of the project state.', when: 'Before risky changes, so you can compare later.', example: 'swarm checkpoint --quiet', cost: 'local', approval: false },
  inbox: { what: 'Lists what is waiting on you, most blocking first.', when: 'At the start of a session, to see what needs your decision.', example: 'swarm inbox --json', cost: 'free', approval: false },
  done: { what: 'Marks a human item as done.', when: 'After you finish a task that the swarm listed for you.', example: 'swarm done rotate-staging-key', cost: 'free', approval: false },
  decide: { what: 'Confirms or changes a decision the swarm recorded.', when: 'When the inbox shows a decision waiting on you.', example: 'swarm decide use-postgres-for-sessions', cost: 'free', approval: false },
  decision: { what: 'Records a default the swarm picked, for you to confirm.', when: 'When the swarm had to choose and you want to be able to review it.', example: 'swarm decision --choice redis --option redis,postgres --id session-store', cost: 'free', approval: false },
  backlog: { what: 'Queues goals to start when a run is waiting on quota or review.', when: 'When you have goals lined up and nothing is running.', example: 'swarm backlog --paths goals/ --max-usd 10', cost: 'spends', approval: true },
  autopilot: { what: 'Drives the project forward with no model, one step at a time.', when: 'When you want routine steps done while you are away.', example: 'swarm autopilot --once --max-steps 3', cost: 'local', approval: false },
  completion: { what: 'Prints the zsh completion script.', when: 'Once, when you install shell completion.', example: 'swarm completion > ~/.zfunc/_swarm', cost: 'free', approval: false },
  help: { what: 'Shows command usage.', when: 'When you forget a command or flag.', example: 'swarm help ship', cost: 'free', approval: false }
};

export function buildCommandList(commands, meta = COMMAND_META) {
  const list = (commands || []).map((command) => {
    const entry = Object.prototype.hasOwnProperty.call(meta, command.name) ? meta[command.name] : null;
    return {
      name: command.name,
      summary: command.summary,
      what: entry ? entry.what : command.summary,
      when: entry ? entry.when : '',
      example: entry ? entry.example : `swarm ${command.name}`,
      cost: entry ? entry.cost : 'free',
      approval: entry ? entry.approval === true : false,
      flags: Array.isArray(command.flags) ? [...command.flags] : []
    };
  });
  return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function searchCommands(list, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return list;
  return list.filter((item) => {
    const haystack = [item.name, item.summary, item.what, item.when].join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function contextCommands(snapshot, plan) {
  const out = [];
  const runId = snapshot && typeof snapshot.runId === 'string' && SAFE_ID.test(snapshot.runId) ? snapshot.runId : null;
  if (runId) {
    out.push({ label: 'Inspect run', command: `swarm inspect ${runId}` });
    out.push({ label: 'Open monitor view', command: `swarm monitor ${runId} --view` });
    if (snapshot.status === 'live' || snapshot.status === 'paused') {
      out.push({ label: 'Cancel run', command: `swarm cancel ${runId}` });
    }
    if (snapshot.status === 'paused') {
      out.push({ label: 'Resume run', command: `swarm resume ${runId}` });
    }
    if (snapshot.status === 'complete') {
      out.push({ label: 'Queue integration', command: `swarm integrate ${runId} --queue` });
    }
    const failed = (snapshot.jobs || []).some((job) => job.status === 'failed' || job.status === 'timeout');
    if (failed) {
      out.push({ label: 'See why jobs failed', command: `swarm inspect ${runId} --results` });
    }
  }
  if (plan && plan.present) {
    out.push({ label: 'List tickets', command: 'swarm tickets' });
    if (runId) {
      out.push({ label: 'Sync scope after integration', command: `swarm scope sync ${runId} --integrated` });
    }
  }
  return out;
}
