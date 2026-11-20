# AGENTS.md

## Quick Facts

- **TypeScript + Node.js 20 LTS.** Package manager: npm.
- **Lint/format: Biome** (not ESLint, not Prettier).
- **LLM Providers (selectable via `LLM_PROVIDER`):** `dashscope` (default), `openai`, `anthropic` (`@anthropic-ai/sdk`), `ollama`.
- **RAG backend:** Python FastAPI service at `http://localhost:8000` (optional, started separately).
- **Core runtime reference:** [pi-agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core`, MIT). We follow its runtime *pattern*; we do not depend on it (it requires Node `>=22.19.0`).
- **Main repo is read-only for the agent.** All writes happen inside a sandbox (Docker by default; worktree fallback requires explicit `--unsafe-host-tests`).
- **`DASHSCOPE_API_KEY` required for the default provider.** Copy `.env.example` to `.env` and fill in.
- **No web search tools in the agent.** Internal data confidentiality requirement.

## Commands

```bash
# Install dependencies
npm install

# Run agent (single-turn CLI)
npm start

# Run agent (multi-turn CLI, streaming, steering)
npm run dev

# Type check
npm run typecheck

# Build
npm run build

# Lint / format (Biome)
npm run lint
npm run format

# Tests
npm test

# Unused code / dependency detection (blocking; must stay at zero findings)
npm run knip

# Change-impact investigation (read-only MVP; requires .env with a provider key)
npm run investigate -- --repo /path/to/repo --intent "rename util.formatName"

# CLI commands (interactive): /help /save /load /sessions /permissions /clear

# Acceptance fixtures (batch 7): real fixture repos + deterministic pipeline tests (no LLM)
#   fixtures/scenario-a — moment→dayjs migration (TS; import cycle on purpose; jest/ts-jest)
#   fixtures/scenario-b — tenant isolation (TS + Python; pytest listed in requirements.txt)
npx tsx --test tests/acceptance.test.ts   # scenario A/B case subset
npm test                                  # full suite incl. the gated container E2E
```

### Acceptance fixtures

- `fixtures/scenario-a|b` are real fixture repos committed to the main repo; tests copy them into temp dirs and `git init`/commit there, so the fixtures themselves stay pristine. `"packageManager": "npm@10.2.0"` in scenario-a is load-bearing for whitelist derivation — do not delete it.
- `tests/acceptance.test.ts` executes the deterministic tools directly (`repo_profile`/`search_code`/`find_symbol`/`impact_analyze`/`test_select`/`update_plan` + `SandboxManager`); patches are produced with real `git diff` from the fixture repo (never hand-written hunks). Scenario A additionally runs a gated container E2E (npm install with network on → native test selection → jest → risk report); scenario B intentionally has no container E2E (default image has no Python — disclosed in `PROJECT_SPEC.md` §14).

## Architecture

### Runtime (pi-agent pattern)

```
Agent (stateful wrapper: subscribe / steer / followUp / abort / clear)
  └── agentLoop()                ← core orchestration per run
        ├── context pipeline:    AgentMessage[] → transformContext() → AgentMessage[]
        │                                 → convertToLlm() → Message[] → LLM
        ├── streamFn (provider)  ← per-provider chat/stream behind LLMProvider
        ├── tool execution       ← registry + executionMode (parallel/sequential)
        ├── hooks                ← beforeToolCall / afterToolCall / prepareRequest / finishTurn
        └── events               ← agent_start / turn_start / message_* / tool_execution_* / turn_end / agent_end
```

Status: `Implemented` — `src/runtime/agent_loop.ts` hosts the orchestration loop (hooks, executionMode, followUp); `src/agent.ts` is the stateful wrapper; `src/messages.ts` owns the context pipeline; `src/events.ts` the event bus.

### Core Modules

| Module | File | Responsibility |
|--------|------|----------------|
| CLI | `src/index.ts` | User interaction entry point (streaming, commands, Ctrl+C) |
| Agent runtime | `src/agent.ts` | Stateful wrapper (history, steering, followUp, abort) |
| Agent loop | `src/runtime/agent_loop.ts` | `agentLoop()` orchestration + runtime hooks + parallel execution |
| Events | `src/events.ts` | `AgentEvent` types + EventBus |
| Messages | `src/messages.ts` | `MessageManager` + transformContext/convertToLlm + trimming |
| Planner | `src/planner.ts` | Plan state + checklist rendering |
| LLM | `src/llm/` | Provider interface + dashscope/openai/anthropic/ollama presets |
| Tools | `src/tools/` | Tool registry + tool implementations |
| MCP | `src/mcp/` | MCP config parsing, stdio/SSE client, tool adapter |
| Permissions | `src/permissions.ts` | Path access approval (once/session/deny) |
| Session | `src/session/` | SQLite-backed conversation persistence |
| Config | `src/config.ts` | Environment + configuration |
| Types | `src/types.ts` | Shared types incl. `AgentMessage` custom-message extension |
| Artifacts | `src/context/artifacts.ts` | `ArtifactStore`: run dirs, sha256 refs, index.json (Implemented) |
| Usage meter | `src/context/usage_meter.ts` | Absolute run token budget: synchronous reserve → settle/release, hard-fail (Implemented) |
| Repo profile | `src/repo/profile.ts` | `detectRepoProfile`: languages/PM/workspaces/runners/commands (Implemented) |
| Investigation | `src/investigate/` | Schema contracts (zod) + search/symbol/impact/test-map analysis + 5 tools (Implemented, read-only MVP) |
| Investigation access | `src/investigate/access.ts` | Path policy for investigate sessions: `--repo` read/list-only, `write` only under `--out` (Implemented) |
| Investigate CLI | `src/cli/investigate.ts` | Commander entry: `--repo --intent --sandbox --unsafe-host-tests --out --format --dry-run` (Implemented) |
| Sandbox | `src/sandbox/` | Provider detection (devcontainer → docker → worktree-host), command whitelist, copy/isolation, patch, risk aggregation + 4 tools (Implemented) |

### Change Impact Workflow (see PROJECT_SPEC.md v2; operator steps in `docs/RUNBOOK.md`)

```
Intent → RepoProfile → Touchpoints → Impact/Coverage → Plan → Sandbox → Patch
       → Verify (tests) → RiskReport → artifacts on disk
```

- Deterministic analysis tools (`search_code`, `find_symbol`, `impact_analyze`, `test_select`, `repo_profile`) are executed by the agent via tools (Implemented; registered in the default registry).
- Large tool outputs are persisted as **artifacts** (`ArtifactStore`); the LLM context keeps a summary + reference (Implemented).
- Phase gates are enforced in `beforeToolCall` / `finishTurn` hooks.
- Stage status: the full workflow `RepoProfile → Touchpoints → Impact/Coverage → Sandbox → Patch → Verify (tests) → RiskReport` is `Implemented` (`npm run investigate` + real runs; sandbox execution requires `--sandbox docker|devcontainer|worktree-host`; Docker integration is gate-tested and runs when a daemon and image are available).

### Language support

- **TypeScript/JavaScript:** first-class (ripgrep when installed, Node glob-scan fallback, ts-morph, dependency-cruiser; ast-grep not yet adopted).
- **Python:** supported (text/regex search now; pytest native selection requires pytest on PATH; AST-level caller analysis is best-effort and reported with confidence, not completeness).

### Sandbox behavior (M6, `Implemented`)

- `src/sandbox/`: provider detection order devcontainer.json+devcontainers/cli → Docker/Podman → git worktree+host (worktree **only** with `--unsafe-host-tests`).
- `worktree-host` requires `repoRoot` to be the **top level** of its own git working tree (`rev-parse --show-toplevel` compared realpath-to-realpath). A repo nested inside another checkout (e.g. `fixtures/scenario-a` inside this repository) is rejected instead of adding a worktree of the parent.
- Docker runs use `--network none` (default; `SANDBOX_NETWORK=on` for installs that need the network), `--cpus/--memory/--memory-swap/--pids-limit` caps, repo mounted `:ro` at `/repo` and the writable copy at `/workspace`.
- Command whitelist only (`install/build/test/lint` derived from the repo profile); `sandbox_run` extra args are plain tokens — shell metacharacters are rejected, and an extra token equal to the kind is dropped (models like to send `{kind:"build", args:["build"]}`, which would otherwise corrupt the argv).
- Patches apply via `git apply` inside the sandbox copy/worktree only (path-safety pre-check: relative, no `..`, no `.git` targets); the main repo is never modified.
- devcontainers/cli and worktree-host providers cannot enforce Docker network/resource caps; the SandboxSpec records `network: "on"` there and tool results disclose it.
- The environment shown to sandboxed processes is fixed and container-internal (`CI=1`; docker additionally sets a fixed `PATH` starting with `/workspace/node_modules/.bin` so installed binaries resolve — never the host environment, no passthrough). Host execution (worktree provider) prepends `<worktree>/node_modules/.bin` to the inherited host `PATH` for the same reason.
- A command that cannot be spawned reports exit code `127` with the spawn error as `stderr` (persisted as an artifact) instead of a silent `exitCode=1` with empty logs.

## Coding Conventions

- **TypeScript strict mode.** No `any` types unless unavoidable.
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/interfaces.
- **Tool naming:** `snake_case` (matches LLM function naming convention).
- **Error handling:** tools do not crash the agent; failures surface as error results in tool messages. Prefer throwing inside tools only when `executeTool` is expected to convert it to an error result.
- **Async by default:** use `async/await` for all I/O.
- **No comments** unless the logic is genuinely non-obvious.

## Reuse-First Policy

1. **npm dependency** (preferred)
2. **External CLI / binary** (for standalone or GPL/LGPL tools)
3. **Copy source** (last resort; requires LICENSE/NOTICE attribution in `THIRD_PARTY_NOTICES.md` + entry in `REFERENCE_PROJECTS.md` with source URL and commit)

License tiers:

| License | Policy |
|---------|--------|
| MIT / ISC / Unlicense / Apache-2.0 | Use as dependency or external CLI |
| LGPL / GPL | External process invocation only; never copy or link source |
| AGPL / NOASSERTION / unclear | Do not adopt without explicit review |

- Do not introduce abstractions "for later".
- Every adopted dependency is recorded in `REFERENCE_PROJECTS.md`.

## Deletion / Cleanup Policy

- Run `npm run knip` before deleting anything.
- Runtime extension points (`CustomAgentMessages`, `transformContext`/`convertToLlm`, `AgentOptions.messages`) are **not dead code even when unused** — they are pi-agent seams and get wired into features instead of deleted.
- Deleting a public API requires updating dependent tests and docs in the same change.
- knip is **blocking** (zero findings required for every PR).

## Sandbox & Security

- Main repository is treated as **read-only**; nothing is ever auto-committed or pushed. All writes land in the sandbox copy at `<out>/sandbox/<run>/` (colocated with that run's artifacts for end-to-end auditability).
- Untrusted code (tests, builds) executes inside a Docker/Podman container with:
  - repo mounted read-only at `/repo`, sandbox copy writable at `/workspace`
  - network disabled by default (`SANDBOX_NETWORK=off`; `on` only for networked installs), CPU/memory/pids/time limits
- `devcontainer.json` in the target repo is used automatically when present (`devcontainers/cli`; its Docker-level caps/network enforcement is disclosed, not silent).
- `git worktree` + host execution is allowed **only** with explicit `--unsafe-host-tests`.
- Commands run in the sandbox are whitelist-only (install/build/test/lint); there is no arbitrary shell tool.
- Secrets/`.env`/certificates are excluded from search results, never copied into the sandbox, and redacted from logs/artifacts.

## Gotchas

- **`DASHSCOPE_API_KEY` must be set.** Agent fails without a configured key for the selected provider.
- **RAG service must be started separately.** `uvicorn app.api.app:app` in the rag project directory.
- **Agent loop must have `max_iterations` limit.** Implemented via `MAX_ITERATIONS` (default 10).
- **LLM output format is not guaranteed.** Always parse defensively.
- **Tool descriptions directly affect call accuracy.** Invest time in clear descriptions.
- **`LLM_MAX_TOKENS` is the completion cap, not the context window.** History is trimmed by `MessageManager` against `LLM_CONTEXT_TOKENS × LLM_CONTEXT_SAFETY − LLM_MAX_TOKENS − tool-schema estimate`; a single tool result is capped by `MAX_TOOL_RESULT_CHARS` (16KB default). Investigation flows must use artifact references for large outputs instead of relying on full results surviving context.
- **Token estimates self-calibrate from `usage.prompt_tokens`.** The estimate adds per-message/tool-call overhead and the tool-schema size, then keeps the worst observed actual/estimated ratio per model (clamped at 1.6x). Do not replace it with a third-party tokenizer: Qwen/GLM tokenizers differ from tiktoken. `recordUsage()` must be compared against the full request estimate (history + tools), never history alone.
- **`MAX_RUN_TOKENS` is a hard-fail budget shared by the parent and sub-agents.** `agent_loop` reserves synchronously before each request (so parallel sub-agents cannot all pass the same check), then settles with the provider's usage. `delegate_task` pre-checks the spawn cost and refuses before the child makes any LLM call. There is no queue: an absolute budget never replenishes. Rate-limit bursts stay with `src/llm/retry.ts`, not budget waiting.
- **Sub-agents inherit the window, not a shared context budget.** Each `delegate_task` child gets its own `MessageManager` with the same `LLM_CONTEXT_TOKENS`; only the spend meter is shared. `MAX_PARALLEL_SUBAGENTS` (default 2) bounds concurrency because a 1M-token prompt is also a TPM event.
- **Path permission prompts are serialized** by design (parallel read tools would clobber overlapping readline prompts).
- **`WORKSPACE_ROOT`** confines relative file paths; absolute paths outside it are rejected (read/write/list).
- **Investigation tools need `repoRoot`/`artifacts` in `ToolContext`.** Only `npm run investigate` wires them today; elsewhere the tools return `no investigation root configured`. `find_symbol` tries ts-morph first and falls back to Python scanning when TS finds nothing — a pure-Python symbol intentionally reports `confidence=0.7`.
- **Investigation path permissions anchor at `--repo`, not the agent checkout.** `Tool.accessRequests(args, context)` receives the same `ToolContext` as `execute`, so relative tool paths (`read_file("src/app.ts")`, `list_files(".")`) resolve inside the repository under investigation; the repo is read/list-only and `write` is allowed only under `--out` (`src/investigate/access.ts`). Using `process.cwd()` there made every investigation tool fail its own permission check.
- **`fixtures/scenario-a|b` are nested inside this repository.** They are not standalone git repositories, so `--sandbox worktree-host` refuses them (it would otherwise create a worktree of the *agent* repo). Copy the fixture to its own `git init`'d directory, or use `--sandbox docker`.
- **`impact_analyze` ids are repo-relative and the graph covers the whole repo.** dependency-cruiser emits cwd-relative paths, so the graph is normalized (symlink-aware) before matching touched files; cruising the whole repo is what makes reverse edges (dependents) exist. `Cycles` in the tool result and the `import-cycle` risk factor only include cycles that touch the given files; unrelated cycles stay in the graph artifact. Regression-covered in `tests/investigate.test.ts`.
- **Sandbox tools need `sandbox` in `ToolContext`** (wired when the investigate CLI runs with `--sandbox *` or `SANDBOX_PROVIDER`); without it they return `no sandbox configured` instead of throwing. `sandbox_run` on the docker provider needs the daemon up and the default image (`node:20-bookworm-slim`, override via `SANDBOX_IMAGE`) available; installs need `SANDBOX_NETWORK=on` because node_modules are not copied into the sandbox. `worktree-host` runs on the host, so `node_modules` installed into the worktree are resolved via a PATH prefix, not copied.
- **Docs drift** is a known failure mode: any behavior change updates `AGENTS.md`, `PROJECT_SPEC.md`, and `REFERENCE_PROJECTS.md` in the same PR.

## Maintenance

- Behavior changes update all three docs (`AGENTS.md`, `PROJECT_SPEC.md`, `REFERENCE_PROJECTS.md`) in the same change.
- Every PR passes: `npm run typecheck`, `npm run lint`, `npm test`, `npm run knip` (blocking, zero findings), `git diff --check`.
- Mark doc status truthfully: `Implemented`, `Wired`, `Planned`, `Rejected`. Never claim a feature is implemented when it is not.
