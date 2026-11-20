# PROJECT_SPEC.md — agent v2

> Status legend: `Implemented` · `Wired` · `Planned` · `Rejected`.
> This document supersedes the historical P1–P8 spec (kept in the Appendix).
> P9–P18 phases live in `ROADMAP.md`; operator steps live in `docs/RUNBOOK.md`.

## 1. Overview

agent is a CLI agent that investigates **change impact** in a mixed (TypeScript/JavaScript + Python) monorepo: given a change intent, it discovers touchpoints and callers, maps relevant tests, drafts a plan and diff, runs relevant tests in a sandbox, and produces a risk report.

The agent runtime follows the [pi-agent](https://github.com/earendil-works/pi) pattern (`Implemented`): a stateful `Agent` around an orchestration loop, an `AgentMessage` context pipeline (`transformContext` → `convertToLlm`), an event stream, steering, abort, per-tool execution modes, runtime hooks, sessions, MCP, and sub-agents.

```
agent (TypeScript)                rag (Python, optional)
        │                               │
   "Brain" via pi-agent           "Memory" (document retrieval)
    runtime pattern
        │                               │
        └──────── HTTP SSE API ────────┘
```

## 2. Goals / Non-goals

### Goals

1. Accept a natural-language change intent and produce a complete, auditable change-impact report.
2. Support TypeScript/JavaScript first-class and Python (best-effort at AST level).
3. Draft diffs **only inside a sandbox**; the main repo stays read-only.
4. Execute only a whitelist of commands inside the sandbox; tests run in Docker by default.
5. Persist every large intermediate result as an artifact; LLM context carries summaries and references only.
6. OSS reuse first: npm dependency > external CLI > copying source (with attribution).

### Non-goals

- No auto commit/push/merge. Diffs are proposals.
- No guarantee of 100% caller coverage for dynamic-language (Python) code — results carry confidence instead.
- No agent-side web search (internal data confidentiality).
- No general-purpose arbitrary shell tool.

## 3. Users & scenarios

| User | Scenario |
|------|----------|
| Developer | "把 moment 替换为 dayjs" in a TS monorepo → touchpoints, callers, tests to update, plan, diff draft, test run, risk report |
| Reviewer | Assist a review: "给 UserService 增加租户隔离" in a TS+Python monorepo → cross-language impact map (Python side reported with confidence) |
| CI bot | Post-merge regression probe: select and run only affected tests per phase |

## 4. Functional requirements

### 4.1 Intent parsing (`Planned`)

Input: natural-language intent (CLI arg or stdin).

Output: `ChangeIntent` validated by zod.

Failure: unparseable → ask the user a targeted clarifying question (max 2 rounds), then fail with a structured error artifact.

### 4.2 Repo profile (`Implemented`)

Detect languages, package managers, workspaces, frameworks, test runners, build/install/test/lint commands, entry points.

- JS/TS: `package.json` workspaces, npm/pnpm/yarn/bun detection.
- Python: `pyproject.toml`, `requirements*.txt`, `setup.cfg`, pytest presence (incl. `pytest-testmon` availability).

Implemented by `src/repo/profile.ts` (`detectRepoProfile`), exposed as the `repo_profile` tool.

### 4.3 Touchpoint discovery (`Implemented`, ASCII/regex scope)

Text + structural search across the repo, parallelizable, results truncated at source and stored as artifacts.

- ripgrep (when installed on PATH) with a deterministic Node glob-scan fallback for text search; ts-morph for TS/JS symbols/definitions/references (exact, confidence 1).
- Python: text/regex search with import-line detection; results carry `confidence` (0.7 definition-bearing, 0.4 without) and a disclosure note.
- ast-grep structural patterns: not yet adopted (`Planned`).

Implemented by `src/investigate/scan.ts` + `src/investigate/symbols.ts`, exposed as `search_code` / `find_symbol`.

### 4.4 Impact & caller analysis (`Implemented`)

- dependency-cruiser for JS/TS import graph (also detects cycles, reported capped).
- ts-morph for symbol-level references.
- Output `ImpactGraph` with nodes/edges/cycles; ids are normalized to repo-relative paths regardless of where the repo lives (dependency-cruiser emits cwd-relative paths, which used to break the dependents lookup for repos outside the agent checkout). The whole repo is cruised so reverse edges (dependents) exist; cycles are reported per touched file when the caller supplies `files` (the artifact keeps the full graph).

Implemented by `src/investigate/analyze.ts`, exposed as `impact_analyze`.

### 4.5 Test coverage mapping (`Implemented` for Jest/Vitest/pytest; `Planned` Nx/Turborepo)

Use each repo's **native** test-impact capability:

| Stack | Command | Status |
|-------|---------|--------|
| Jest | `npx jest --findRelatedTests <files> --listTests` | `Implemented` |
| Vitest | `npx vitest related <files>` | `Implemented` |
| Nx | `npx nx affected -t test --files=<files>` | `Planned` |
| Turborepo | `npx turbo run test --filter=...[<files>]` | `Planned` |
| pytest | package-dir mapping of touched `.py` files (pytest on PATH) | `Implemented` |

Brand-new tests (previous run failed to collect) fall back to a documented content heuristic (test files mentioning touched basenames, word-boundary matched) with `rationale` and per-file `uncovered` disclosure.

### 4.6 Change plan (`Implemented` mechanism, `Planned` workflow)

Agent composes a checklist via `update_plan`; `PlanStore` + renderer already exist.

### 4.7 Sandbox (`Implemented`)

Provider order:
1. `devcontainer.json` present + devcontainers CLI probe ok → `devcontainers/cli`.
2. Docker/Podman available → container: repo mounted read-only (`/repo:ro`), sandbox copy writable (`/workspace`), `--network none` by default, `--cpus/--memory/--memory-swap/--pids-limit` caps, per-command timeout.
3. Fallback: git worktree + host execution — allowed **only** with explicit `--unsafe-host-tests` flag (worktree isolates files, not processes; network/resource caps are not Docker-enforced). The provider requires `--repo` to be the **top level** of its own git working tree; a repository nested inside another checkout is rejected instead of silently driving a worktree of the parent.

The writable copy lives at `<out>/sandbox/<run>/` (excludes `.git`, `node_modules`, caches and secrets); dependency installation happens inside the sandbox (needs `SANDBOX_NETWORK=on`) instead of copying host `node_modules`. Host execution (worktree provider) prepends `<worktree>/node_modules/.bin` to `PATH` so sandbox-installed binaries resolve exactly like the container PATH used by the docker provider.

Called via the `sandbox_create` / `sandbox_run` tools.

### 4.8 Patch draft (`Implemented`)

Unified diff validated and applied **in the sandbox only**: relative paths required; absolute paths, `..` escapes and `.git` targets are rejected before `git apply --check` → `git apply` runs against the copy/worktree (`git init` inside the copy when the repo has no git context). The diff is persisted as a `diff` artifact and returned as a `PatchDraft`. Never touches the main repo; never auto-committed.

Called via the `write_patch` tool (`dryRun` validates only).

### 4.9 Verification (`Implemented`)

Whitelisted commands only — `sandbox_run` takes `kind install|build|test|lint` (base command derived from the repo profile) plus plain extra tokens (shell metacharacters rejected during composition; an extra token equal to the kind is dropped so `{kind:"build", args:["build"]}` cannot corrupt the argv). Runs with timeout and abort; stdout/stderr persist as `log` artifacts; returns `VerificationResult` (exit code + duration + artifact refs + `passed`). A binary that cannot be spawned reports exit code `127` with the spawn error in `stderr` (artifacts included) instead of a silent `exitCode=1`.

### 4.10 Risk report (`Implemented`)

Deterministic aggregation over: sandbox verification results (failed runs, missing evidence), test selection of the touched files (uncovered tests), import cycles **that include a touched file** (unrelated repo cycles stay in the graph artifact), direct dependents (uncovered callers), Python-side `limited-confidence` disclosure. Levels: `high` when a run failed or evidence is missing, `medium` for coverage/scope risks, `low` otherwise. Output: Markdown + JSON artifacts (`risk-report.md` / `risk-report.json`) plus a capped inline summary. Dependency-scan factors (osv-scanner) remain `Planned`.

## 5. Architecture

```
CLI (src/index.ts; src/cli/investigate.ts Implemented)
  └── Agent runtime (src/agent.ts)            [pi-agent pattern]
        ├── MessageManager (src/messages.ts)  [transformContext/convertToLlm]
        ├── Event bus (src/events.ts)
        ├── Tool registry (src/tools/registry.ts)
        ├── Hooks (before/afterToolCall, prepareRequest, finishTurn)  [Implemented in src/runtime/agent_loop.ts]
        └── Providers (src/llm/: dashscope/openai via OpenAI-compatible, anthropic via @anthropic-ai/sdk, ollama)

Implemented modules:
  src/context/artifacts.ts    artifact store (run dirs, files + index.json, sha256)
  src/repo/profile.ts         monorepo/workspace/language detection
  src/investigate/            workflow analysis + investigation tools + zod data contracts
  src/cli/investigate.ts      commander entry for investigations (incl. sandbox flags)
  src/sandbox/                provider detection + execution + command whitelist + patch + risk

Planned modules:
  src/context/ (redaction)    redaction + extended default transformContext pipeline
```

## 6. Data contracts (zod-validated)

Implemented today (`src/investigate/contracts.ts`):

```ts
RepoProfile    { root; packageManager?; languages: "typescript"|"javascript"|"python"[];
                 workspaces: string[]; frameworks: string[];
                 testRunners: string[]; commands: { install?; build?; test?; lint? } }
ImpactGraph    { nodes: { id; path; kind }[]; edges: { from; to; kind }[]; cycles: string[][] }
CoverageMap    { touchedFiles: string[]; selectedTests: string[]; uncovered: string[]; rationale: string }
```

`ImpactGraph` and `CoverageMap` are re-validated with `parse*` at phase boundaries; tool JSON output is untrusted.

Implemented with M6 (`SandboxSpec` in `src/investigate/contracts.ts`, validated via `parseSandboxSpec`):

```ts
SandboxSpec  { provider: "devcontainer"|"docker"|"worktree-host"; worktreePath; repoRoot;
               mounts: { source; target; readOnly }[]; env: Record<string,string>;
               allowedCommands: string[]; image?; network: "off"|"on";
               limits: { cpus; memory } }
// worktreePath is the writable sandbox root for every provider (a git worktree
// for worktree-host). mounts/env/allowedCommands are the single source of truth:
// docker argv is generated from mounts, env is a fixed allowlist (no host-env
// passthrough; docker gets CI=1 and a container-internal PATH that starts with
// /workspace/node_modules/.bin so sandbox-installed binaries resolve — without
// it the node image entrypoint prefixes `node` onto unknown commands), and
// allowedCommands is derived from the repo profile.
PatchDraft         { format: "unified"|"files"; diff: ArtifactRefData; files: string[]; baseCommit: string }
VerificationResult { command; exitCode; durationMs; stdout: ArtifactRefData; stderr: ArtifactRefData; passed }
RiskReport         { level: "low"|"medium"|"high"; summary; factors: RiskFactor[]; recommendations: string[] }
                   RiskFactor { kind: "failed-test"|"uncovered-test"|"uncovered-caller"|"import-cycle"|
                                "limited-confidence"|"missing-evidence"; detail; source? }
```

Still `Planned`:

```ts
ChangeIntent   { raw; summary; changeType: "migration"|"feature"|"bugfix"|"refactor"|...;
                 targetHints: string[]; constraints: string[] }
Touchpoint     { id; path; symbol?; kind; reason; confidence: number; evidence: ArtifactRef[] }
ChangePlan     { steps: string[]; files: string[]; risks: string[]; verification: string[] }
```

## 7. Tool contracts (`Implemented` foundation, `Planned` additions)

Existing (`Implemented`): `read_file`, `list_files`, `write_file` (sandbox-gated), `rag_query`, `update_plan`, `delegate_task`, MCP adapter.

Investigation tools (`Implemented`, registry + `repoRoot`/`artifacts` in `ToolContext`): `repo_profile`, `search_code`, `find_symbol`, `impact_analyze`, `test_select`. Without wiring they fail gracefully with "no investigation root configured" instead of throwing.

Sandbox tools (`Implemented`, M6; wired via `sandbox` in `ToolContext` when the investigate CLI runs with `--sandbox *`): `sandbox_create`, `sandbox_run`, `write_patch`, `risk_report`. `risk_report` degrades to explicit `missing-evidence` factors when no sandbox was created; `sandbox_run` carries its own timeout (SANDBOX_TIMEOUT_MS) overriding the generic tool timeout. Without wiring they fail gracefully with "no sandbox configured" instead of throwing.

Tool errors: results carry `isError` semantics (`ToolResult { content, isError }`) — `Implemented`; all built-in tools return it and `executeTool` never throws.

## 8. CLI & configuration

### CLI (interactive)

- Streaming output, steering during runs, Ctrl+C cancels a run / denies a prompt.
- Commands: `/help`, `/save [name]`, `/load <id>`, `/sessions`, `/permissions [clear]`, `/clear` (`Implemented`), `exit`.

### CLI (investigation, `Implemented`; `--dry-run` vetoes sandbox/patch tools via the beforeToolCall hook)

```
npm run investigate -- --repo <path> --intent "<text>" \
  [--sandbox docker|devcontainer|worktree-host] [--unsafe-host-tests] \
  [--out <dir>] [--format markdown|json] [--dry-run]
```

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER` | `dashscope` | dashscope/openai/anthropic/ollama |
| `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | provider keys (key matches provider) |
| `LLM_MODEL` / `LLM_BASE_URL` / `LLM_TEMPERATURE` | preset | LLM tuning |
| `LLM_MAX_TOKENS` | 2048 | completion cap (output only; never the context window) |
| `LLM_CONTEXT_TOKENS` | 131072 | advertised model window; history budget = `window × safety − output − tool schemas` |
| `LLM_CONTEXT_SAFETY` | 0.85 | headroom for estimator error (CJK/dense code) |
| `MAX_TOOL_RESULT_CHARS` | 16384 | per-tool-result truncation, decoupled from the window |
| `MAX_RUN_TOKENS` | 0 | absolute prompt+completion budget per run (0 = unlimited, hard-fail when exhausted) |
| `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` / `LLM_RETRY_BASE_MS` | 120000 / 2 / 500 | resilience |
| `LLM_STREAM_OPTIONS` | `on` | omit `stream_options` for gateways that reject it |
| `RAG_API_URL` | `http://localhost:8000` | RAG service |
| `MAX_ITERATIONS` | 10 | agent safety valve |
| `MAX_PARALLEL_SUBAGENTS` | 2 | concurrent `delegate_task` sub-agents |
| `TOOL_TIMEOUT_MS` | 30000 | per-tool timeout (0 disables) |
| `TOOL_APPROVAL` | `off` | generic dangerous-tool approval |
| `PATH_APPROVAL` | `on` | path access prompts (once/session/deny) |
| `WORKSPACE_ROOT` | — | extra file confinement |
| `SESSION_DB_PATH` | `./.sessions.db` | SQLite sessions |
| `MCP_SERVERS` | — | JSON array of stdio/SSE servers |
| `LOG_LEVEL` | `info` | logging |
| `SANDBOX_PROVIDER` | — | default provider when `--sandbox` is not passed |
| `SANDBOX_IMAGE` | `node:20-bookworm-slim` | docker provider image (pulled when missing) |
| `SANDBOX_NETWORK` | `off` | `on` allows networked commands (e.g. dependency installs) inside the sandbox |
| `SANDBOX_CPU` / `SANDBOX_MEMORY` | 2 / `2g` | docker `--cpus` / `--memory` caps |
| `SANDBOX_TIMEOUT_MS` | 600000 | per-`sandbox_run` command timeout (also the tool timeout) |

Planned investigation vars: `MAX_ARTIFACT_BYTES`, `REDACT_PATTERNS` (the redaction module is `Planned`; `--out` covers the output directory today).

## 9. Artifacts (`Implemented` store + sandbox kinds, `Planned` redaction + streaming)

- Location: `<out>/artifacts/run-<ts>/` with `index.json` (id, kind, path, size, sha256, summary).
- Kinds: `search`, `graph`, `test`, `diff`, `log` (sandbox stdout/stderr), `report` (risk markdown + JSON) — all `Implemented`.
- Investigation tools persist oversized results automatically and append a `Full result artifact: <path>` reference to the tool result; every artifact ref carries its sha256. Sandbox run dirs live at `<out>/sandbox/<run>/` next to the artifacts (auditable working copies). `artifact` AgentMessage streaming stays `Planned`.

## 10. Security & sandbox

- Main repo read-only; all writes in the sandbox copy (`<out>/sandbox/<run>/`); no auto commit/push.
- Investigation sessions resolve path permissions against the `--repo` root, not the agent's own checkout: relative tool paths (`read_file("src/app.ts")`, `list_files(".")`) are anchored at the repository under investigation, that repository is `read`/`list`-only, and `write` is granted only under `--out` (`src/investigate/access.ts`). No sibling directories, no home directory.
- Sandbox: Docker/Podman (defaults: `--network none`, cpus/memory/pids/time caps), devcontainer via `devcontainers/cli`, or worktree+host with explicit `--unsafe-host-tests`; Docker-level enforcement exists only on the docker provider and is disclosed otherwise. `worktree-host` additionally requires `--repo` to be its own git top-level (nested repos are rejected).
- Command whitelist only (install/build/test/lint); no arbitrary shell tool; plain-token args with shell-metachar rejection.
- Main repo mounted read-only in the container (`/repo:ro`); the container never sees `proc/self` writes into the repo.
- Secrets/`.env`/certificates excluded from search and copy; `redaction` custom messages for logs/artifacts remain `Planned`.

## 11. OSS reuse & licensing

See `REFERENCE_PROJECTS.md` for the full decision record. Rules:

1. npm dependency > external CLI > copy source (with NOTICE + source commit).
2. MIT/ISC/Unlicense/Apache-2.0 → allowed. LGPL/GPL → external process only. AGPL/NOASSERTION → review before adoption.
3. Adopted so far: `@modelcontextprotocol/sdk` (MIT), `better-sqlite3`, `dotenv`, `openai` (Apache-2.0), `@anthropic-ai/sdk` (Apache-2.0), `zod`, `execa`, `tinyglobby`, `commander`, `p-limit`, `eventsource-parser` (MIT), `dependency-cruiser` (MIT), `ts-morph` (MIT), `knip` (ISC).

## 12. Quality gates

- `npm run typecheck`, `npm run lint` (Biome), `npm test`, `npm run knip` (blocking: zero findings), `git diff --check`.
- 109 tests must stay green: baseline suites, 14 investigation tests (incl. 3 investigation path-access regressions in `tests/investigate_access.test.ts`), 17 sandbox tests (incl. a real-container Docker integration test gating on daemon + local image, and the worktree-host git-top-level/PATH regressions), and 5 acceptance fixture tests (scenario A/B in `tests/acceptance.test.ts`; the scenario-A container E2E additionally gates on daemon + image). New features ship with tests.

## 13. Milestones

| # | Milestone | Status |
|---|-----------|--------|
| M1 | Docs v2 (this rewrite) | `Implemented` |
| M2 | Dead-code cleanup + `/clear` + knip gate | `Implemented` |
| M3 | Runtime alignment (agent_loop extraction, hooks, executionMode, followUp, ToolResult) | `Implemented` |
| M4 | OSS foundation deps + @anthropic-ai/sdk swap | `Implemented` for `@anthropic-ai/sdk` + `eventsource-parser`; remaining M4 deps landed with M5 |
| M5 | Investigation MVP (read-only: intent → profile → touchpoints → impact → coverage → plan → risk draft) | `Implemented` (read-only MVP; sandbox/patch/verify stages move to M6) |
| M6 | Sandbox + patch + verify + risk | `Implemented` (docker validated in a real container; devcontainer/worktree providers unit-covered; py-side factors disclosed) |
| M7 | Fixtures + acceptance + docs final | `Implemented` (`fixtures/scenario-a|b` + `tests/acceptance.test.ts`, 5 cases, all green; scenario-A pipeline verified end-to-end in a real container) |

## 14. Acceptance criteria

Both scenarios are `Verified` by `tests/acceptance.test.ts` (deterministic, tool-level pipeline: real fixture repos, real git diffs, mock-free analysis + sandbox calls; no LLM in the loop).

**Scenario A — dependency migration (TS monorepo), `fixtures/scenario-a`**
Given a repo using `moment`, intent "replace moment with dayjs" produces:
1. touchpoints listing all `moment` imports/usages (artifact-backed),
2. impact graph with callers and import cycle detection (`a.ts ↔ b.ts` on purpose),
3. test selection using the repo's native runner (jest),
4. plan checklist, 5. diff draft applied **in sandbox** only, 6. verification log (selected tests) as artifact, 7. risk report with uncovered risk factors. Main repo untouched; PASS when `git status` is clean in the main repo and the report is produced.

Covered by: read-only pipeline case, worktree-host patch+risk case, and a container E2E (npm install with `SANDBOX_NETWORK=on` → native selection → jest pass → risk report; gated on daemon + image). Manual agent-driven verification uses `npm run investigate -- --repo fixtures/scenario-a --intent "replace moment with dayjs" --sandbox docker`. For `--sandbox worktree-host`, copy the fixture into a standalone git repository first (`cp -R fixtures/scenario-a /tmp/demo && git -C /tmp/demo init && git -C /tmp/demo add -A && git -C /tmp/demo commit -m base`): the fixture is nested inside this repo's checkout, and a nested repo is rejected by design.

**Scenario B — feature change (TS+Python monorepo), `fixtures/scenario-b`**
Intent "给 UserService 增加租户隔离" produces: TS-side symbol/caller map (exact, confidence 1), Python-side callers with disclosed confidence (0.7, text-heuristic), coverage map, plan, sandbox diff, verification, risk report carrying `limited-confidence`. Python AST limitations are explicitly disclosed rather than silently omitted.

Covered by: symbol/confidence case and patch+risk-report case. No container E2E: the default image (`node:20-bookworm-slim`) has no Python, and jest/ts side is already covered in scenario A — this limitation is disclosed here and in the tool descriptions rather than hidden. Manual agent-driven verification uses `npm run investigate -- --repo fixtures/scenario-b --intent "给 UserService 增加租户隔离" --sandbox docker` (pytest verification would need a Python-enabled image, e.g. via `SANDBOX_IMAGE`).

## Appendix: historical P1–P8 (supersceded)

Phases 1–8 (basic conversation → multi-turn → tools → ReAct loop → file ops → robustness → prompt engineering → RAG integration) are fully implemented and described in git history and `ROADMAP.md`. Details in this file were replaced by the v2 spec above;istorical module references (`src/llm.ts`, ESLint/Prettier, ts-node) no longer apply — see `AGENTS.md` for current reality.
