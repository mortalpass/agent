# agent

A TypeScript CLI agent for **change-impact investigation**. Given a change
intent and a repository, it discovers touchpoints and callers, maps relevant
tests, drafts a plan and diff, verifies the change inside a sandbox, and
produces an auditable risk report.

The agent runtime follows the
[pi-agent](https://github.com/earendil-works/pi) pattern: a stateful `Agent`
around an orchestration loop with a context pipeline, runtime hooks, parallel
tool execution, steering, sessions, MCP, and sub-agents.

## What it does

```
Intent → RepoProfile → Touchpoints → Impact/Coverage → Plan → Sandbox
       → Patch → Verify (tests) → RiskReport → artifacts on disk
```

- `search_code`, `find_symbol`, `impact_analyze`, `test_select`, and
  `repo_profile` provide deterministic analysis (ripgrep, ts-morph,
  dependency-cruiser).
- Large tool outputs are stored as artifacts; the model context keeps a
  summary and a reference.
- Patches are applied with `git apply` only inside a sandbox copy. The target
  repository is never modified.

## Requirements

- Node.js 20.3+
- npm
- One LLM provider key (`DASHSCOPE_API_KEY` by default)
- Optional: Docker or Podman for sandboxed builds/tests
- Optional: `ripgrep`, `pytest`, `devcontainer` CLI depending on the target repo

## Quick start

```bash
npm install
cp .env.example .env          # set DASHSCOPE_API_KEY
npm run dev                    # interactive multi-turn CLI

# One-shot change-impact investigation (analysis only)
npm run investigate -- \
  --repo /path/to/repo \
  --intent "rename util.formatName"

# With sandboxed verification (Docker image: node:20-bookworm-slim)
SANDBOX_NETWORK=on npm run investigate -- \
  --repo /path/to/repo \
  --intent "rename util.formatName" \
  --sandbox docker
```

## Configuration

Copy `.env.example` to `.env`. The most relevant variables:

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `dashscope` | `dashscope` / `openai` / `anthropic` / `ollama` |
| `LLM_MODEL` | provider preset | model name, including large-context variants |
| `LLM_MAX_TOKENS` | `2048` | completion cap (output only) |
| `LLM_CONTEXT_TOKENS` | `131072` | model context window used for history trimming |
| `LLM_CONTEXT_SAFETY` | `0.85` | headroom for token-estimate error |
| `MAX_TOOL_RESULT_CHARS` | `16384` | per-tool-result truncation |
| `MAX_RUN_TOKENS` | `0` | absolute per-run budget; `0` disables |
| `MAX_ITERATIONS` | `10` | agent loop safety valve |
| `MAX_PARALLEL_SUBAGENTS` | `2` | concurrent `delegate_task` sub-agents |
| `PATH_APPROVAL` | `on` | prompt before file access |
| `SANDBOX_PROVIDER` | — | `docker` / `devcontainer` / `worktree-host` |
| `SANDBOX_NETWORK` | `off` | enable network only for dependency installs |

Provider keys are read from `DASHSCOPE_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, or the generic `LLM_API_KEY`.

## Security model

- The repository under investigation is **read-only** for file tools.
- Writes and test execution happen in a sandbox copy under
  `<out>/sandbox/<run>/`.
- Docker runs disable the network by default, mount the repo read-only, and
  enforce CPU/memory/pids/time limits.
- `git worktree` + host execution is allowed only with the explicit
  `--unsafe-host-tests` flag.
- Sandboxed commands are whitelist-only (`install` / `build` / `test` /
  `lint`); there is no arbitrary shell tool.
- `.env`, credentials, and certificates are excluded from search results and
  never copied into the sandbox.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run knip
npm run build
```

`npm run knip` is blocking: unused code and dependencies must stay at zero
findings.

## Project layout

```
src/agent.ts            stateful agent wrapper
src/runtime/            agent loop, hooks, parallel tool execution
src/messages.ts         context pipeline, trimming, token estimation
src/llm/                provider presets (dashscope/openai/anthropic/ollama)
src/tools/              tool registry and implementations
src/investigate/        change-impact analysis and investigation tools
src/sandbox/            provider detection, command whitelist, patch, risk
src/context/            artifact store and token budget meter
tests/                  unit, integration, and acceptance tests
fixtures/               real repositories used by acceptance tests
```

## Limitations

- TypeScript/JavaScript analysis is first-class; Python caller analysis is
  best-effort and reports confidence rather than completeness.
- Sandbox execution requires Docker/Podman or an explicit host fallback.
- Very large context windows increase latency and cost per tool iteration;
  set `MAX_RUN_TOKENS` when that matters.

## License

MIT
