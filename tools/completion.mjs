// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

const command = (name, summary, args = 'none', flags = '') => ({ name, summary, args, flags: flags.split(' ').filter(Boolean) });

export const PROVIDERS = ['claude', 'codex', 'cursor', 'hermes', 'qwen', 'openai', 'gemini', 'ollama', 'lambda', 'openrouter', 'rented', 'all'];

export const COMMANDS = [
  command('doctor', 'Check provider readiness.', 'provider', '--probe-local'),
  command('validate', 'Validate a job manifest.', 'manifest', '--evidence'),
  command('preflight', 'Check a manifest before running.', 'manifest'),
  command('board', 'Show active project runs.'),
  command('orphans', 'List scratch directories without run state.'),
  command('run', 'Run a job manifest.', 'manifest', '--jobs --sync --evidence --accept-red-base --reason'),
  command('status', 'Show run status.', 'run'),
  command('monitor', 'Monitor a run.', 'run', '--view --watch'),
  command('wait', 'Wait for a run to finish.', 'run', '--timeout'),
  command('inspect', 'Inspect run details.', 'run', '--results'),
  command('rollup', 'Summarize run results.', 'run', '--text --top'),
  command('integrate', 'Integrate completed job outputs.', 'run', '--queue --adaptive --batch-size --max-requeues --jobs --no-checks --require-checks --accept-failed-checks --mutants --mutants-file --mutant-check --no-flake-check --accept-blocked --salvage --accept-deviation --accept-result-shape'),
  command('mutants', 'Run mutation checks.', 'none', '--mutants-file --mutant-check --dry-run'),
  command('env', 'Show the swarm environment.', 'none', '--print'),
  command('redcheck', 'Check a failing test against a baseline.', 'run', '--base --commit --test'),
  command('cancel', 'Cancel a run.', 'run'),
  command('ship', 'Ship a run or branch.', 'run', '--wait-required-only --repo --pr --require-section --no-merge --merge-method --timeout --poll --tag-timeout --no-flake-check --accept-pre-existing --preflight --checks-from-ci --rerun-flaky --rerun-flaky-ci --per-test-timeout --exempt --private-names --branch --check'),
  command('think', 'Ask the local brain for a short top-3 with reasons.', 'none', '--rounds --json'),
  command('digest', 'Condense a log, diff, test output or run to 15 lines.', 'none', '--kind --json'),
  command('draft', 'Draft docs, PR text or a plan locally, then polish.', 'none', '--context --out --json'),
  command('brain', 'Local brain status, stats or a test call.', 'none', '--json --markdown'),
  command('gpu', 'Rented GPU session: models, up, down, status, bake-off (never rents).', 'none', '--target --key --model --models --hourly-usd --max-usd --max-hours --gpus --per-replica --max-model-len --image --levels --repo --yes --json --extra-quant --allow-no-poweroff --best-of --ssh-port --bench-ref --mode --probe-ports --local-port'),
  command('init', 'Initialize a project: profile, base check, repo map.', 'none', '--check --json --sensitive --not-sensitive --protect --max-usd --max-tokens --base-check --no-base-check --no-map'),
  command('map', 'Build or refresh the repo map.', 'none', '--json'),
  command('scale', 'Run stub jobs to measure scale.', 'none', '--jobs --concurrency'),
  command('go', 'Complete a manifest or goal.', 'goal', '--scope --wave --max-waves --allow-main-branch --skip-skeleton --leads --max-jobs --concurrency --max-usd --max-tokens --commit-message --repo --pr --require-section --mutants --merge-method --timeout --tag-timeout --no-flake-check --no-watch --exempt --yes --plan --accept-stale --batch'),
  command('plan', 'Preview a goal: leads, cost, time and risks. Nothing runs.', 'goal', '--leads --max-jobs --concurrency --max-usd --max-tokens --json --batch'),
  command('note', 'Add a note to the task or handoff file.', 'goal', '--file'),
  command('ask', 'Ask an agent a question.', 'goal', '--model --agent --tier --context --timeout --not-sensitive'),
  command('scout', 'Find resources for a goal.', 'goal', '--model --brief --context --timeout --max-picks --allow-license --licenses --kind'),
  command('verify', 'Run an orb verification scenario.', 'none', '--orb --scenario'),
  command('check-pins', 'Check pinned project dependencies.', 'none', '--root --json --core --app-prefix'),
  command('sweep', 'Scan a list of goals for prior art.', 'none', '--model --brief --goals --max-usd --concurrency --top --candidates --known --timeout'),
  command('version', 'Show the installed version.', 'none', '--check'),
  command('update', 'Update the shared installation.', 'none', '--projects --yes'),
  command('squash', 'Squash a branch.', 'none', '--branch --base'),
  command('clean-branch', 'Clean changes from a branch.', 'none', '--from --exclude'),
  command('scope', 'Scope file: template, check, split into tickets, approve, sync.', 'none', '--out --stage --ingest --merge --yes --integrated'),
  command('tickets', 'List or show scope tickets and their status.', 'none', '--stage --status --type --risk --lane --approve --set --note --json --mark-deps --yes'),
  command('change', 'Record a scope change order.', 'none', '--yes'),
  command('ui', 'Render design screens and compare them with the mockups.', 'none', '--base-url --json'),
  command('watch', 'Open the read-only dashboard for a run (Run, Build Plan, Commands, Gallery).', 'run', '--all --tui --open --json'),
  command('gallery', 'List, approve or comment on screens from swarm ui check.', 'none'),
  command('merge', 'Squash-merge a PR only when every check is green.', 'none', '--repo'),
  command('stop', 'Panic button: swarm stop --all cancels runs, stops autopilot and ends a rented GPU session.', 'none', '--all --status --clear --reason'),
  command('backup', 'Snapshot swarm state (no secrets): backup, backup list, backup verify ID.', 'none', '--reason --json'),
  command('restore', 'Restore swarm state from a backup (shows the plan until --yes).', 'none', '--yes'),
  command('projects', 'The projects on this machine (listed on the Swarm Watch board): list, add, remove.', 'none', ''),
  command('history', 'The machine-wide history of projects, stages, runs, PRs, merges, lessons and spend: filter, search, CSV.', 'none', '--project --kind --q --from --to --limit --csv --backfill'),
  command('models', 'Model watch: new open coding models that fit our GPUs and new API versions, into the inbox; compare models from eval runs.', 'none', '--force --json'),
  command('report', 'Weekly client progress report from the scope and the ticket progress (files only, a draft you approve).', 'none', '--client --since --preview --approve --status'),
  command('errors', 'Production errors become proposed tickets: pull (vercel logs), ingest, list, show, ignore, resolve, digest.', 'none', '--dry-run --status --reason --no-write'),
  command('budgets', 'Speed and accessibility budgets: check a preview with Lighthouse and axe, show status.', 'none', '--url --screens'),
  command('migrations', 'Check database migrations: down steps, destructive changes, up/down/up round trip.', 'none', '--yes --note'),
  command('lessons', 'Structured lessons: list, show, add, check, stats, backfill, mine, notes.', 'none', '--stage --tag --caught-by --text --what --rule --fix --lane-model --ticket --requirement --guard-kind --guard-text --retries --minutes --usd --file --project --json --dry-run --min --include-guarded --write'),
  command('eval', 'Golden eval set: list, validate, manifest, score, gate.', 'none', '--all --agent --model --out --record --update-baseline --reset-baseline'),
  command('onboard', 'Set up project onboarding.'),
  command('lesson', 'Manage recorded project lessons.', 'none', '--area --evidence --rule --fix --public --queued --shipped --older-than --status --version --test --agent --model --tier --stale-days --installed --from --dry-run --verbose --file --private-names'),
  command('resume', 'Resume a paused run.', 'run', '--wait --reason --raise'),
  command('ledger', 'Show recorded spend.'),
  command('idle', 'Pick zero-quota work while waiting.'),
  command('ticket', 'Run a ticket through the pipeline.', 'manifest', '--pr --check --repo --branch --commit-message --require-section --resume --wait-required-only'),
  command('scaffold', 'Write a job or PR manifest.', 'none', '--id --agent --model --tier --context --outputs --command --prompt-file --ticket --out --from --title --repo'),
  command('brief', 'Print a short briefing so any agent can take over.', 'none', '--json'),
  command('handoff', 'Print a paste-ready handoff message for another agent.', 'none', '--to'),
  command('checkpoint', 'Save a snapshot of the project state.', 'none', '--quiet'),
  command('inbox', 'List what is waiting on you, most-blocking first.', 'none', '--json --all'),
  command('done', 'Mark a human item done.', 'none'),
  command('decide', 'Confirm or change a decision.', 'none'),
  command('decision', 'Record a default the swarm picked, for you to confirm.', 'none', '--choice --option --id'),
  command('backlog', 'Queue goals to start when a run is waiting.', 'none', '--paths --max-usd'),
  command('autopilot', 'Drive the project forward with no model.', 'none', '--once --interval --max-steps'),
  command('completion', 'Print the zsh completion script.'),
  command('help', 'Show command usage.'),
];

export async function completeRuns(root, { readdir = fs.readdir } = {}) {
  let entries;
  try {
    entries = await readdir(path.join(root, '.swarm', 'runs'), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    .sort().reverse().slice(0, 200);
}

export function zshCompletion() {
  const descriptions = COMMANDS.map(({ name, summary }) => `    '${name}:${summary}'`).join('\n');
  const cases = COMMANDS.map(({ name, args, flags }) => `    ${name})
      flags=(${flags.map(flag => `'${flag}'`).join(' ')})
      argument='${args}'
      ;;`).join('\n');
  return `#compdef swarm

_swarm() {
  local -a commands flags roots runs providers
  local argument command_name
  local -i command_index=2
  commands=(
${descriptions}
  )
  providers=(${PROVIDERS.join(' ')})
  # Consume the global root option before identifying the command.
  while (( command_index < CURRENT )); do
    case "\${words[command_index]}" in
      --root)
        if (( CURRENT == command_index + 1 )); then
          _files -/
          return
        fi
        roots=(--root "\${words[command_index+1]}")
        (( command_index += 2 ))
        ;;
      --root=*)
        roots=(--root "\${words[command_index]#--root=}")
        (( command_index++ ))
        ;;
      *) break ;;
    esac
  done
  if (( CURRENT == command_index )); then
    if [[ "\${words[CURRENT]}" == -* ]]; then
      flags=(--root --help)
      _describe 'option' flags
    else
      _describe 'command' commands
    fi
    return
  fi
  command_name="\${words[command_index]}"
  case "$command_name" in
${cases}
    *) return ;;
  esac
  if [[ "\${words[CURRENT]}" == -* ]]; then
    _describe 'option' flags
    return
  fi
  case "$argument" in
    run)
      runs=("\${(@f)$(swarm __complete runs "\${roots[@]}" 2>/dev/null)}")
      # Preserve the newest-first order supplied by swarm.
      compadd -V runs -a runs
      ;;
    manifest) _files -g '*.json' ;;
    provider) _describe 'provider' providers ;;
  esac
}

_swarm "$@"
`;
}
