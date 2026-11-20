# Runbook: change-impact investigation

Operator guide for `npm run investigate` (or `node dist/cli/investigate.js` after
`npm run build`). Everything below reflects the shipped behavior; where a
capability is missing it says so instead of implying it exists.

## 0. What the tool does and does not do

| Does | Does not |
|------|----------|
| Finds touchpoints, callers, import cycles and related tests for a stated intent | No web/search-network access (confidentiality rule) |
| Drafts and applies a patch **inside a sandbox copy only** | Never commits, pushes, merges, or edits the repository under investigation |
| Runs whitelisted commands (`install`/`build`/`test`/`lint`) and keeps stdout/stderr as artifacts | No arbitrary shell; `sandbox_run` accepts plain tokens only |
| Produces a risk report (Markdown + JSON) with confidence and missing-evidence disclosure | Python caller analysis is text-heuristic (`confidence=0.7`), not an AST proof |

Two entry points, do not mix them up:

- `npm run investigate` — the only entry point wired with `repoRoot`, `artifacts`, and `sandbox`.
- `npm start` / `npm run dev` — general chat agent; investigation tools answer `no investigation root configured` and sandbox tools `no sandbox configured`.

## 1. Prerequisites

| Requirement | Check |
|-------------|-------|
| Node.js >= 20.3 | `node -v` |
| Provider key in `.env` or the environment (`DASHSCOPE_API_KEY` by default) | `printenv DASHSCOPE_API_KEY` |
| Git (for `baseCommit` and the worktree provider) | `git -v` |
| Docker/Podman daemon, only for `--sandbox docker` | `docker version --format '{{.Server.Version}}'` |
| Optional: `rg` (fast search), `pytest` (native Python test selection) | `rg --version`, `pytest --version` |

Without `rg` search falls back to a Node scan; without `pytest`, Python test
selection is heuristic and says so. Neither is fatal.

## 2. Setup

```bash
npm install
cp .env.example .env          # fill in the provider key
npm run build                 # only needed if you run node dist/...
```

Recommended `.env` additions:

```dotenv
MAX_ITERATIONS=30         # default 10 is tight for the full 9-step flow
SANDBOX_NETWORK=off       # turn on only for installs
SANDBOX_TIMEOUT_MS=600000
SANDBOX_IMAGE=node:20-bookworm-slim
LOG_LEVEL=info            # debug when troubleshooting
```

## 3. Golden path (about five minutes)

Use a throwaway clone so you never dirty a real branch:

```bash
# 1) standalone git repo (copying a fixture out of this repo is required:
#    a repo nested inside another checkout is rejected by worktree-host)
rm -rf /tmp/demo-repo /tmp/inv-demo
cp -R fixtures/scenario-a /tmp/demo-repo
git -C /tmp/demo-repo init -q
git -C /tmp/demo-repo add -A
git -C /tmp/demo-repo -c user.email=demo@example.com -c user.name=demo commit -qm base

# 2) read-only reconnaissance
MAX_ITERATIONS=30 npm run investigate -- \
  --repo /tmp/demo-repo \
  --intent "replace moment with dayjs" \
  --out /tmp/inv-demo \
  --dry-run

# 3) full sandbox verification (worktree-host = host execution, see §7)
MAX_ITERATIONS=30 SANDBOX_NETWORK=on npm run investigate -- \
  --repo /tmp/demo-repo \
  --intent "replace moment with dayjs" \
  --out /tmp/inv-demo \
  --sandbox worktree-host --unsafe-host-tests

# 4) review evidence
RUN=$(ls -dt /tmp/inv-demo/artifacts/run-* | head -1)
cat "$RUN/index.json"
cat "$RUN"/*risk-report.json
git -C /tmp/demo-repo status --porcelain   # must stay empty
```

Success criteria: `index.json` lists search/graph/test/log/diff/report artifacts
with sha256; a `*risk-report.md`/`*risk-report.json` pair exists; every claim in
the report points at an artifact; the investigated repository is unchanged.

## 4. Stages

### Stage 0 — baseline (manual)

1. `git -C <repo> status --porcelain` must be empty, otherwise "the main repo was
   not modified" cannot be verified.
2. Install dependencies in the repo if you want native test selection
   (`jest --findRelatedTests`); otherwise selection degrades to a content
   heuristic and discloses it.
3. Pick an `--out` outside the repository when possible (default
   `investigations/`, already gitignored).
4. Make `--intent` specific: symbol names, target files, migration goal.

### Stage 1 — read-only reconnaissance (`--dry-run`)

`--dry-run` vetoes `sandbox_create`, `sandbox_run` and `write_patch`; analysis
tools still need a provider key (dry-run is not offline).

### Stage 2 — review the analysis

| Artifact kind | Produced by | What to check |
|---------------|-------------|---------------|
| `search` | `search_code` / `find_symbol` | every usage of the symbol is covered; Python hits carry a confidence note |
| `graph` | `impact_analyze` | callers, cycles, and "no direct dependents" claims |
| `test` | `test_select` | selected tests, `rationale` (native vs heuristic), `uncovered` list |
| `report` | `risk_report` | factors, level and recommendations |

If the model missed a file, rerun with the file name inside `--intent`.

### Stage 3 — sandbox verification

A sandbox only exists when you pass `--sandbox <provider>` or set
`SANDBOX_PROVIDER`; otherwise the sandbox tools are not wired at all.

```bash
# Docker: read-only /repo, writable /workspace copy, --network none by default
SANDBOX_NETWORK=on MAX_ITERATIONS=30 npm run investigate -- \
  --repo <repo> --intent "<intent>" --out <out> --sandbox docker

# devcontainer.json in the target repo (needs the devcontainers CLI via npx)
npm run investigate -- ... --sandbox devcontainer

# Emergency fallback: git worktree + host execution (no process isolation)
npm run investigate -- ... --sandbox worktree-host --unsafe-host-tests
```

Enforcement reality, recorded in the SandboxSpec and the tool output:

- `docker`: read-only `/repo`, writable `/workspace`, `--network none` unless
  `SANDBOX_NETWORK=on`, CPU/memory/pids/time caps.
- `devcontainer` / `worktree-host`: Docker-level network and resource caps are
  **not** enforced; the spec records `network: "on"` and the output says so.
- `node_modules` are never copied; run `sandbox_run kind=install` first (usually
  with `SANDBOX_NETWORK=on`).
- Host execution (`worktree-host`) prepends `<worktree>/node_modules/.bin` to
  `PATH`, so `jest`/`tsc` resolve after install just like inside the container.
- A binary that cannot be started reports exit code `127` with `ENOENT` in the
  stderr artifact instead of a silent `exitCode=1`.

### Stage 4 — review verification and risk

```bash
RUN=$(ls -dt <out>/artifacts/run-* | head -1)
ls "$RUN"
cat "$RUN"/*risk-report.md
cat "$RUN"/*risk-report.json
```

| Level | Condition |
|-------|-----------|
| `high` | a verification failed (`failed-test`) or evidence is missing (`missing-evidence`) |
| `medium` | no failure, but coverage/scope risks (`uncovered-test`, `uncovered-caller`, `import-cycle`, `limited-confidence`) |

`import-cycle` only fires for cycles that include a touched file; repo-wide cycles remain visible in the graph artifact but are not attributed to the change.
| `low` | no risk factors |

`uncovered-caller` means "no direct dependent was found", not "no risk": confirm
the real entry points by hand. All claims should be traceable to an artifact
(`index.json` + sha256).

### Stage 5 — move the patch to a branch (manual)

The patch lives in a `diff` artifact as a unified diff relative to the repo root.

```bash
git -C <repo> switch -c investigate/<ticket>
git -C <repo> apply --3way <out>/artifacts/run-*/NNN-patch-*.diff
git -C <repo> diff
```

Review every hunk. `write_patch` rejects absolute paths, `..` escapes and `.git`
targets, but it does not judge correctness.

### Stage 6 — regression and archive

Run the project's own install/build/test, confirm `git status` shows only the
intended changes, and archive `<out>/artifacts/run-*` as audit evidence. The
sandbox copies under `<out>/sandbox/run-*` are disposable.

## 5. Path permissions (investigate sessions)

- The repository passed via `--repo` is readable and listable, never writable.
- Writes are allowed only under `--out`.
- Relative tool paths resolve against `--repo`, so `list_files(".")` and
  `read_file("src/app.ts")` mean "inside the repository under investigation".
- Everything else (sibling repos, `$HOME`, the agent checkout) is denied; there
  is no interactive prompt in investigate mode.

## 6. Flags and environment

| Flag | Required | Meaning |
|------|----------|---------|
| `--repo <path>` | yes | repository under investigation (resolved to absolute) |
| `--intent <text>` | yes | change intent; be specific |
| `--out <dir>` | no | artifact root, default `investigations`; the only writable path |
| `--sandbox <provider>` | no | `docker` / `devcontainer` / `worktree-host`; omit for analysis only |
| `--unsafe-host-tests` | with `worktree-host` | acknowledges host process execution |
| `--dry-run` | no | veto sandbox writes and command execution |
| `--format markdown\|json` | no | parsed but currently has no effect; read `*risk-report.json` / `index.json` instead |

| Env var | Default | Meaning |
|---------|---------|---------|
| `LLM_PROVIDER` | `dashscope` | `dashscope` / `openai` / `anthropic` / `ollama` |
| `LLM_MODEL` | provider preset (`qwen-plus`) | use a stronger model for large repos |
| `LLM_MAX_TOKENS` | 2048 | completion cap only; this is not the context window |
| `LLM_CONTEXT_TOKENS` | 131072 | set to the model's window (e.g. `1000000` for 1M models) |
| `LLM_CONTEXT_SAFETY` | 0.85 | headroom for estimator error; lower for CJK-heavy repos |
| `MAX_TOOL_RESULT_CHARS` | 16384 | per-tool-result cap; larger outputs belong in artifacts |
| `MAX_RUN_TOKENS` | 0 | absolute prompt+completion cap per run, hard-fail when exhausted |
| `MAX_PARALLEL_SUBAGENTS` | 2 | concurrent `delegate_task` sub-agents |
| `MAX_ITERATIONS` | 10 | 30 is recommended for the full flow |
| `SANDBOX_PROVIDER` | empty | same as `--sandbox` |
| `SANDBOX_IMAGE` | `node:20-bookworm-slim` | Python verification needs an image with python3 |
| `SANDBOX_NETWORK` | `off` | `on` to install dependencies inside the sandbox |
| `SANDBOX_CPU` / `SANDBOX_MEMORY` | 2 / `2g` | docker caps; memory format like `2g`/`512m` |
| `SANDBOX_TIMEOUT_MS` | 600000 | per-command timeout |
| `LOG_LEVEL` | `info` | `debug` when troubleshooting |

## 7. Safety rules

1. The repository is read-only; all writes land in `<out>/sandbox/run-*/`.
2. Do not use `--unsafe-host-tests` on untrusted code: worktrees isolate files
   but tests run as your user on the host.
3. Keep `SANDBOX_NETWORK=off` except while installing dependencies.
4. Secrets (`.env`, keys, certificates) are excluded from search, copy and the
   sandbox environment.
5. `missing-evidence` is never "low risk".

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `no sandbox configured for this session` | no `--sandbox` / `SANDBOX_PROVIDER` | pass `--sandbox docker` (or the intended provider) |
| `no investigation root configured` | ran `npm start` / `npm run dev` | use `npm run investigate` |
| `Requested provider docker but neither docker nor podman is available` | daemon not running | start Docker Desktop, recheck `docker version` |
| `worktree-host requires the repository root to be its own git working tree` | `--repo` is nested in another checkout (e.g. `fixtures/scenario-a`) | copy the repo to its own `git init`'d directory, or use `--sandbox docker` |
| `worktree-host requires a git repository with at least one commit` | repo has no commit | make an initial commit (or use another provider) |
| `Access denied: ...` for the repository or a tool path | path is outside `--repo` and `--out` | pass the correct `--repo`; investigate mode grants nothing else |
| `FAIL (exitCode=127 ...)` with `ENOENT` | binary not installed in the sandbox | run `sandbox_run kind=install` first (`SANDBOX_NETWORK=on`) |
| `Command kind "lint" is not whitelisted ...` | the repo profile declares no lint command | add the script to `package.json` or skip lint |
| `Command kind "test" ... (none)` on a pure-Python repo | whitelist comes only from `package.json` scripts | wrap pytest in an npm script or stay analysis-only |
| `Max iterations ... reached` | intent too vague or budget too low | raise `MAX_ITERATIONS`, sharpen `--intent` |
| `Invalid SANDBOX_MEMORY` | bad format | use `2g` / `512m` |
| `Patch must target at least one file` / `Unsafe token` | empty diff or shell characters in a token | rerun that step; do not hand-edit tokens to bypass validation |
| RAG `503` / connection refused | optional RAG service not running | ignore for local analysis, or start the service |

## 9. Cost and tuning

- Read-only analysis is usually seconds to a couple of minutes; `npm install`
  dominates the full flow (bounded by `SANDBOX_TIMEOUT_MS`).
- Tool outputs are summarized in context and stored as artifacts; read the
  artifacts, not the terminal preview.
- Large multi-package repos benefit from a stronger `LLM_MODEL` and a precise
  `--intent`.

## 10. Known limitations

- `--format json` has no effect today.
- Python caller analysis is text-heuristic and flagged `limited-confidence`.
- The default Docker image has no Python, so Python verification needs a custom
  `SANDBOX_IMAGE` and an npm script exposing the command.
- Whitelisted commands come from the repo profile only
  (`package.json` scripts plus the lockfile/`packageManager`).
- The LLM decides tool order; two runs of the same intent can differ. Verify
  claims against artifacts.
