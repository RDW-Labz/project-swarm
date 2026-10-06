# Providers and setup

Project Swarm supports nine adapters. Configure only the providers your manifest uses. No SDK dependencies are required. The toolkit does not install provider accounts, purchase credits, pull model weights, or modify your global configuration.

## Choose the execution style

- **Hermes (`hermes`)** is the Nous Research Hermes Agent CLI. It receives copied text through stdin under safe mode, ignored user configuration/rules, an explicit `none` toolset, and one turn.
- **Qwen (`qwen`)** is Qwen Code (the best match for the requested “Quin”). It receives copied text through stdin under safe mode, default approval, a zero tool-call budget, and one turn. It never uses the synthetic JSON-schema tool exemption.


- **Claude (`claude`)** starts a fresh restricted CLI process with copied files and scoped file tools. Authentication belongs to the installed Claude Code CLI. The repository's website case study records real Claude exchanges.
- **OpenRouter (`openrouter`)** makes one OpenAI-compatible chat-completions request to `https://openrouter.ai/api/v1/chat/completions` with strict structured output and no tools. The coordinator reads the key from `OPENROUTER_API_KEY`, else from the macOS keychain item service `project-swarm` (or a project's own local config `keychain.service`), account `openrouter.api_key` (store it with `security add-generic-password -U -s project-swarm -a openrouter.api_key -w`, which prompts for it); workers never see it. Enforced before any request leaves: `provider.data_collection` is always `"deny"` (a body without it is refused); `anthropic/*` models pin `provider.order` to `["anthropic"]` with `allow_fallbacks: false`; `deepseek/*` models may only write bookkeeping outputs (PR payloads, `.pr-body.md`, `CHANGELOG.md`, mutants files, metrics), refused at `validate` and again at run; each request's worst case (every input character as a token, plus the full output budget, priced from OpenRouter's public model list) must fit under $5 for the job id and $25 for the UTC day, and pricing that cannot be fetched refuses the request. Every request, usable or not, is appended to `~/.project-swarm/logs/openrouter-spend.jsonl` (`SWARM_LOGS_DIR` overrides) with the provider-reported cost, or the worst case when none is reported.
- **OpenAI (`openai`)** makes one Responses API request with strict structured output and no tools. It reads `OPENAI_API_KEY` from the coordinator environment; a ChatGPT or Codex login is not automatically an API credential.
- **Gemini (`gemini`)** makes one `generateContent` request with JSON schema output and no tools. It reads `GEMINI_API_KEY`, falling back to `GOOGLE_API_KEY` when the first is absent.
- **Ollama (`ollama`)** makes one chat request to a server you already operate, using JSON schema output. Its default is `http://127.0.0.1:11434`. Select a model already available on that server. No Claude or cloud account is needed for an unauthenticated local server.
- **Lambda (`lambda`)** makes one OpenAI-compatible chat-completions request with a strict JSON schema and no tools. Its default is hosted Lambda Inference at `https://api.lambda.ai`, reading `LAMBDA_API_KEY`. Set `SWARM_LAMBDA_URL` to an origin you operate to use your own GPU host instead; the key is optional there. Each request carries a unique `X-Helm-Session` header (`${SWARM_LAMBDA_SESSION or "swarm"}-<request-nonce>-<job>`), including repeated runs with the same job ID in one process. The nonce uses cryptographic randomness and stays alphanumeric, preserving the header's separator format. A session-aware operator router can use it for replica selection and rate-limit buckets; actual distribution and hosted endpoint handling depend on the server and are not verified by local adapter tests. Set `SWARM_LAMBDA_SESSION` to a stable per-user value if your origin buckets fair-share by caller.

Lambda's [official inference page](https://lambda.ai/inference) says its hosted Inference API is winding down. For new setups, plan around an operator-owned endpoint with schema-constrained output. Hosted access remains unverified; the wind-down notice does not establish a shutdown date. The contributor reports a separate self-hosted vLLM exercise, which does not verify another account, host, or model.

API jobs receive only selected UTF-8 text files, including existing output files. They cannot browse your repository, execute tests, use MCP, view images, or call tools. They return a summary and complete file contents, which the runner validates before writing into the copied workspace. The coordinator still reviews and integrates them. UI review recipes evaluate supplied source or written flows, not rendered screenshots.

## Check setup without sending context

```sh
node tools/swarm.mjs doctor all
node tools/swarm.mjs doctor openai
node tools/swarm.mjs doctor gemini
node tools/swarm.mjs doctor ollama
node tools/swarm.mjs doctor lambda
```

`doctor` without an argument checks Claude for backward compatibility. `doctor all` reports each provider independently. API `configured` means an environment credential is present, or an Ollama or Lambda origin you operate has been selected. `liveVerified: false` is deliberate: Default API diagnostics do not contact endpoints or prove authentication, model access, server health, quota, or output-schema support. `--probe-local` opts into loopback HTTP health only, as detailed below. `run` checks only the providers its jobs actually select.

Configure credentials using your normal secure environment/secret manager, outside the worker. Never put real keys in a manifest, command example committed to Git, prompt, or copied context. The runner does not read `.env` automatically. If you choose Node's environment-file feature, keep that file outside version control and never include it as context. API account access and billing are separate from cloning this public repository.

For Claude installation, follow [Anthropic's setup guide](https://code.claude.com/docs/en/setup), authenticate through the CLI, and run the compatibility check. Required restrictions are never silently removed to support an older CLI.

## A bounded first exchange

Read and adapt one example before executing it. The example model names are starting points, not a claim of availability on your account. Use a model supported by your provider with structured JSON output; for Ollama, select an installed model capable of following the schema.

```sh
node tools/swarm.mjs validate examples/openai-smoke.json
node tools/swarm.mjs run examples/openai-smoke.json
# Alternatives: examples/gemini-smoke.json, examples/ollama-smoke.json, or examples/lambda-smoke.json
node tools/swarm.mjs status <run-id>
node tools/swarm.mjs inspect <run-id>
```

Each API smoke has empty context, one declared Markdown output, and a two-minute timeout. The output limit is 1,024 tokens except for Lambda's 2,048-token example. Increase it if your model needs additional reasoning allowance. Review the proposed file and summary, then integrate. For a read-only smoke, change `outputs` to `[]` and ask for an acknowledgment in the summary. Installed copies use `coordination/swarm-openai-smoke.json` (or the corresponding provider name).

The four API adapters have deterministic mocked-transport tests covering their contracts and failure handling. They have **not been verified against live cloud credentials, a live Ollama model, or a live Lambda endpoint as part of this release**. A passing test or doctor result is not such verification. Record your own observed resolved model and successful read-only/writing exchanges before assigning substantial work. Missing model metadata stays null rather than being inferred.

## Limits, cancellation, and errors

All API jobs must name `model`. `maxOutputTokens` defaults to 8,192 and accepts 256–32,768; choose a smaller value for simple tasks. Provider reasoning may consume output allowance. This is not a small effect on a reasoning model: an observed vLLM deployment with a reasoning parser returned `finish_reason: "length"` and null content on a trivial task at 512 tokens, intermittently, because the whole budget went to reasoning the model never emitted as content. The job fails closed rather than writing a partial file, but the cause looks like a schema or load fault and is neither. Budget for reasoning plus the envelope, and prefer a generous cap: an unused allowance costs nothing. Incomplete, refused, malformed, oversized, or wrongly scoped output fails the job; partial files are not accepted. There are no automatic retries.

Concurrency defaults to 2 and can be explicitly set from 1 to 32 across providers. More concurrent jobs can increase resource load and simultaneous charges. Tokens and timeouts are not dollar budgets. Cancellation aborts the local HTTP request and response reading, but remote work or charges may already have occurred. API cost is recorded as unavailable, not calculated from assumed prices.

HTTP failures record a status and omit the response body. Transport and response-stream exceptions are sanitized; request headers and raw API responses are not logged. Read-only summaries and generated files can still contain supplied source. Keep `.swarm/` private. For authentication errors, check the selected provider's account/environment setup outside the runner; for schema errors, verify the chosen model's structured-output capability. Do not weaken file validation as a workaround.

## Endpoints and local models

OpenAI and Gemini use fixed HTTPS endpoints. Arbitrary base-URL environment variables are intentionally ignored, and manifests cannot specify endpoints. Redirects are refused, including same-origin redirects, to avoid forwarding credentials to another destination.

Ollama accepts an optional **operator-controlled** `SWARM_OLLAMA_URL` containing only an origin, for example `http://127.0.0.1:11434` or an explicitly trusted `https://models.example.com`. HTTP is allowed only for the exact loopback hosts `127.0.0.1`, `[::1]`, and `localhost`; remote hosts require HTTPS. Credentials in URLs, query strings, paths, and fragments are rejected. `OLLAMA_API_KEY`, if present, is sent only to the selected Ollama origin. Setting a remote origin explicitly trusts it with your copied files and that key. DNS, machine policy, and remote service ownership are not authenticated by this toolkit.

Lambda applies the same origin rule to `SWARM_LAMBDA_URL`, defaulting to `https://api.lambda.ai` when unset. `LAMBDA_API_BASE` and other base-URL variables are intentionally ignored. A loopback origin such as `http://127.0.0.1:8000` is accepted so an SSH tunnel to a rented GPU host needs no certificate; any other host must be HTTPS. The adapter sends `response_format` with a strict JSON schema, so the selected model must support schema-constrained decoding. If it does not, choose a model that does or serve one that supports guided decoding; do not weaken envelope validation to compensate.

A self-hosted origin also receives `chat_template_kwargs: { enable_thinking: false }`. Reasoning-model chat templates default thinking on, and a reasoning model behind a strict `json_schema` envelope spends its whole output allowance on reasoning it never emits as content: the request returns `finish_reason: "length"` with null content and no files. Measured on a self-hosted vLLM origin serving a Qwen3-family model, one identical request returned 700 of 700 completion tokens and empty content with thinking on, and a complete envelope in 292 tokens with it off. The job fails closed either way, but the error looks like a schema or load fault and is neither. Instructing the model not to think in the prompt does not disable it. Set `SWARM_LAMBDA_THINKING=on` to opt back in for a model whose reasoning you want and whose budget you have raised. Hosted Lambda Inference is unaffected: the field is sent only when `SWARM_LAMBDA_URL` selects an origin you operate, since an unknown body field may be rejected elsewhere.

This is an Ollama chat/schema adapter, not a universal OpenAI-compatible proxy adapter. It does not assume every local model supports JSON schema reliably. If local inference is slow, first reduce input/output scope and concurrency rather than disabling validation.

## Official protocol references

Implementation references, reviewed for this release:

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): Responses `text.format` with a JSON schema; the adapter sets `store: false` and provides no tools.
- [Gemini generateContent reference](https://ai.google.dev/api/generate-content): model-scoped requests, `generationConfig.responseMimeType`, `responseJsonSchema`, candidate finish reason, and usage metadata.
- [Ollama chat API](https://docs.ollama.com/api/chat): `stream: false`, schema-valued `format`, message content, completion state, and token counts.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): fixed restricted CLI flags and structured result events.

Provider behavior, models, and account access can change. Keep compatibility checks and real smoke verification separate from mock unit tests.

## Hermes and Qwen Code installation and compatibility

Use the upstream installation steps for [Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/installation/) or [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/). Qwen's official npm package is `@qwen-code/qwen-code`; install it with your preferred project-local package setup and expose its `qwen` binary on PATH for the coordinator. Hermes requires its own upstream Python environment and `hermes` entrypoint. This toolkit does not modify global shell profiles, install gateways, or authenticate accounts automatically. Every job needs an explicit `model` field; replace the placeholder in the example (e.g., `set-your-hermes-model`) with a model your Hermes or Qwen account serves before running it.

```sh
node tools/swarm.mjs doctor hermes
node tools/swarm.mjs doctor qwen
node tools/swarm.mjs validate examples/hermes-smoke.json
node tools/swarm.mjs run examples/hermes-smoke.json
# Qwen equivalent: examples/qwen-smoke.json
```

The doctor checks executable version/help and all required flags, failing closed when restrictions are missing. It does not prove authentication or execute a model. Authenticate separately through each CLI's normal setup. New CLI adapters have deterministic subprocess contract tests; neither authenticated Hermes nor Qwen inference is claimed as live-verified in this release.

Hermes uses `chat --safe-mode --ignore-user-config --ignore-rules --toolsets none --query-file - --oneshot --format stream-json --max-turns 1`. The explicit `none` selection relies on the upstream resolver's empty result for an unrecognized named toolset; **an empty string is not equivalent**, because it enables default toolsets. Safe mode disables plugins/hooks/MCP and rule injection. The runner strips inherited dispatcher/task variables that could re-enable another task's lifecycle tools. This behavior is source-reviewed, not an OS sandbox guarantee; incompatible upstream changes require updating the adapter.

Qwen uses safe mode, default approval, `--max-tool-calls 0`, and one session turn. The upstream setting defines zero as aborting before the first tool call. No `--json-schema` is passed, because its synthetic completion tool is exempt from the tool-call budget. Safe mode ignores `--core-tools`, so this adapter never mistakes an empty core-tools value for a deny-all policy. Task data is serialized on stdin and the fixed prompt is not a slash command. Both adapters require exactly one successful terminal JSONL record, reject tool events, validate every output path/content, and let only the coordinator import files.

These CLIs may read their authentication stores. Hermes may retain its own host session logs; Qwen is launched with chat recording, telemetry, and OpenAI debug logging disabled although each invocation is fresh and never resumed. Review upstream retention settings; `.swarm/` is not necessarily the only copy of CLI transcript data. Their host process environment is not an OS isolation boundary.

Primary restriction references: [Hermes CLI flags and result events](https://hermes-agent.nousresearch.com/docs/reference/cli-commands), [Hermes tool selection source](https://github.com/NousResearch/hermes-agent/blob/main/model_tools.py), [Qwen headless mode](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/), and [Qwen tool-budget schema](https://github.com/QwenLM/qwen-code/blob/main/packages/vscode-ide-companion/schemas/settings.schema.json).

Local compatibility evidence: official npm Qwen Code 0.24.0 was installed into an ignored verification directory and its real version/help output confirmed the required flags, including the explicit zero-tool-call semantics. This did not authenticate or send an inference request. Hermes was not installed in the verification environment; its adapter remains source-reviewed and mock-process tested until an operator passes doctor and a bounded live exchange.

## Codex CLI (`codex`, macOS only)

Every Codex job must name `model`, matching `/^[A-Za-z0-9._:-]{1,80}$/`. The runner always passes `-m <job.model>` and never uses the Codex config default. Install and authenticate Codex separately, then run `node tools/swarm.mjs doctor codex`. Doctor checks macOS, `sandbox-exec`, `codex --version`, successful `codex login status`, and every required exec flag through file-backed help probes. It makes no model call. Other platforms report unsupported and refuse Codex jobs.

Codex runs in its own detached git worktree of the root repository's HEAD. Public runs place it outside the project root by default, under the configured scratch base (`<scratch>/worktrees/<repo>-<hash>/<run>/<job>`); `worktreesOutsideRoot: false` preserves the historical `.swarm/runs/<run-id>/worktrees/<job-id>` layout. The saved `worktreePath` is authoritative for inspect/integrate and recorded before checkout; older state without it uses the historical fallback. The full committed project is available, so the worker can run tests. Uncommitted root changes are not included; `validate` and `preflight` warn when declared context or output files have uncommitted changes. Context is the prompt's “read these first” list. Only declared output files become retained proposals for inspect/integrate/conflict checks. The runner removes the worktree after an ordinary success, failure, timeout, or cancellation; it keeps the worktree when the final envelope was invalid or only resolved through a fallback (see below). Timeouts and cancellation terminate the entire detached process group.

The OS seatbelt sandbox enforces file access; prompt text is not the boundary. The runner invokes `sandbox-exec -f <profile> codex exec -m <model> --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral -C <worktree> -o <last-message> <prompt>`. Codex's own sandbox is bypassed because the outer seatbelt is the boundary. Stdin is `/dev/null` (Node's `ignore` stdio); Codex otherwise waits for stdin. When `/etc/ssl/cert.pem` exists, the worker receives `SSL_CERT_FILE=/etc/ssl/cert.pem` because TLS cannot use the keychain-backed trust store inside this sandbox.

The profile starts with a home-directory read/write denial, then grants reads of the home literal and necessary ancestor literals, the job worktree, the repository git common directory, `~/.codex`, `~/.nvm`, `~/.cache`, `~/.npm`, `~/.local/share/uv`, `~/.gitconfig`, and `~/Library/Caches`. Writes are limited to the job worktree, its git worktree metadata directory, `~/.codex`, `~/.cache`, `~/.npm`, `/private/tmp`, `/private/var/folders`, `/dev/null`, and `/dev/tty*`. For a Vite or Vitest project, setup prepares exactly `node_modules/.vite-temp` and `node_modules/.vite` and grants only those two cache directories, including their validated shared dependency real paths; dependency files, sibling caches, the checkout root and secrets remain read-only or denied. The common git directory is otherwise read-only. System reads outside the home directory and network access remain available as in the reference profile.

If the prepared Vite cache cannot be safely created or written, dispatch refuses with
`vite-temp-not-writable: <path>; prepare writable Vite caches or use an isolated dependency
install`. Read-only preflight reports the same `vite-temp-not-writable` warning for missing,
unwritable or unsafe caches on Codex jobs; it does not create directories and does not warn
unrelated projects or agents. The two cache paths are intentionally shared and are not deleted
as cleanup.

The final rules re-deny reads/writes of `~/Library/Keychains`, `~/.ssh`, `~/.aws`, `~/.config`, and any directory a project's own local config adds to `deniedHomeDirs`, plus mach lookups of `com.apple.SecurityServer` and `com.apple.securityd.xpc`. Optional per-job `readPaths` grants extra absolute read-only toolchain paths. Paths under denied directories (including resolved aliases) are refused. Paths embedded in profiles cannot contain quotes, backslashes, or control characters. Do not place secrets in the committed project or granted toolchain paths.

The runner reads the final message from the `-o` file inside the job worktree (also inside the run directory), saves it as `response.txt`, and parses it as JSON: the reply's last fenced (```json or bare ```) block wins when it has one, otherwise its last top-level JSON object wins; any keys are accepted (there is no fixed `files_changed`/`notes` schema), since only declared outputs, never anything the JSON names, are ever collected. When that JSON is missing or does not parse, the runner falls back first to the `-o` file's own content if it alone parses as an object, then to the worktree's actual changes to declared outputs versus the job's base commit; either fallback still completes the job, keeps its worktree, and surfaces a `codex envelope fallback: result-file` or `codex envelope fallback: worktree` warning from `inspect`/`wait`. A worktree with no output changes and no parseable result file still fails the job and keeps the worktree for inspection. Parseable `tokens used` output is recorded as `total_tokens`, grouped under provider `codex`; missing usage and dollar cost remain unavailable. Unit tests inject fake workers and do not claim a live Codex or seatbelt smoke run.

## Local health diagnostics

`doctor all` makes no network requests by default. Add `--probe-local` to
probe loopback Ollama `/api/tags` or Lambda `/v1/models` with a 1.5-second
timeout. No credentials, code or model prompts are sent and redirects are
refused. Remote origins and cloud keys remain configuration-only. A successful
HTTP response means reachable, not authenticated or model-verified; a stopped
server is reported unreachable while its configuration remains present.
