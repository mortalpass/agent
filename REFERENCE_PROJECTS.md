# REFERENCE_PROJECTS.md — 复用决策记录（ADR）

本项目的开源复用决策记录：从"参考项目介绍"升级为可审计的 ADR。核心 runtime 参考 **pi-agent**；其余 OSS 按复用优先级 `npm 依赖 > 外部 CLI > 复制源码` 分类。

状态：`adopt`（已采用/采用中）· `evaluate`（评估中/条件采用）· `reject`（不采用）。

---

## 1. Reuse principles

1. **npm 依赖**（首选）：类型安全、可维护、供应链可控。
2. **外部 CLI / 二进制**：独立工具、GPL/LGPL 工具、原生工具链（ripgrep、ast-grep、Docker）。
3. **复制源码**（最后手段）：必须保留 LICENSE/NOTICE，在 `THIRD_PARTY_NOTICES.md` 登记来源 URL、commit、修改内容。

许可证分级：

| 许可证 | 策略 |
|--------|------|
| MIT / ISC / Unlicense / Apache-2.0 | 可依赖、可外部调用 |
| LGPL / GPL | 仅外部进程调用，禁止复制或链接源码 |
| AGPL / NOASSERTION / 不明 | 未经评审禁止采用 |

不为"以后可能用到"引入抽象；runtime 扩展点（pi-agent 缝）除外——它们会被接线使用而不是删除。

---

## 2. License compatibility matrix

| SPDX | 用法 | 说明 |
|------|------|------|
| MIT / ISC / Unlicense | dependency / external | 无附加条件 |
| Apache-2.0 | dependency / external | 保留 LICENSE/NOTICE；分发时注意 NOTICE 文件 |
| LGPL-2.1 | external process only | semgrep |
| GPL-2.0 | external process only | universal-ctags |
| AGPL-3.0 | reject | Renovate |
| NOASSERTION / 自定义 | review required | Vercel AI SDK、Mastra |

---

## 3. Core runtime reference: pi-agent（earendil-works/pi）

| 项目信息 | |
|----------|--|
| **GitHub** | https://github.com/earendil-works/pi |
| **包** | `@earendil-works/pi-agent-core` v1.5.0（依赖 `@earendil-works/pi-ai`、`pi-schema`） |
| **许可证** | MIT |
| **集成方式** | reference only · **Decision: 参考模式，不作为依赖** |
| **原因** | engines 要求 Node `>=22.19.0`（本项目 >=20.3）；引入会替换现有 runtime。按模式对齐而非按包接 |

### 3.1 包结构 ↔ 本项目对应

| pi 包 | 对应本项目 | 现状 |
|--------|-----------|------|
| `pi-ai`（统一 LLM API） | `src/llm/`（base + openai_compatible + anthropic + errors/retry） | `Implemented` |
| `pi-agent-core`（运行时） | `src/agent.ts` + `src/events.ts` + `src/messages.ts` + `src/tools/registry.ts` | `Implemented`（部分按模式对齐中） |
| `pi-coding-agent`（CLI） | `src/index.ts` | `Implemented` |
| `pi-tui`（终端 UI） | 无（readline） | — |

### 3.2 核心概念现状

```
Agent（有状态包装器：subscribe / steer / followUp / abort / clear）
  ↓
agent_loop()（核心编排）                    ← 本项目：Agent.runLoop() private，待提取
  ↓
StreamFn（用户提供的 LLM 流式集成）          ← 本项目：AgentOptions.provider
```

| # | 概念 | pi-agent | 本项目现状 | 动作 |
|---|------|----------|-----------|------|
| 1 | AgentMessage vs LLM Message | AgentMessage 支持自定义类型，LLM 调用边界经 convertToLlm 转换 | 类型与管道已实现（`Implemented`），但尚无真实自定义消息 | 接线：artifact / phase / redaction 消息 |
| 2 | transformContext → convertToLlm | 上下文裁剪 + 过滤 UI-only 消息 | 管道已实现；transform 从未配置 | 接线：artifact 摘要、旧结果压缩、repo profile 注入 |
| 3 | 事件流 | agent_start / turn_start / message_* / tool_execution_* / turn_end / agent_end | 简化版：tool_start/tool_end | 对齐：`tool_execution_*` |
| 4 | Steering | agent.steer() | 已实现 | 保留；补 followUp 队列 |
| 5 | 多 Provider | pi-ai 统一 API | LLMProvider 统一接口：dashscope/openai/ollama（OpenAI-compatible）+ anthropic | anthropic 已改用 `@anthropic-ai/sdk`（M4 完成） |
| 6 | 会话持久化 | SQLite | better-sqlite3 + CLI /save /load /sessions | 保留 |
| 7 | Planner | update_plan → ⬜⏳✅ 清单 | update_plan + PlanStore | 保留 |
| 8 | Sub-agents | delegate_task 子 Agent | 已实现（共享 registry、无全局状态） | 保留，用于并行调查分支 |
| 9 | 并行工具执行 | per-tool executionMode | 硬编码 PARALLEL_SAFE_TOOLS 白名单 | 改为 `Tool.executionMode` |
| 10 | beforeToolCall / afterToolCall | runtime hooks | 无 | 新增（沙箱策略、artifact 落盘、redaction） |
| 11 | prepareRequest / finishTurn | runtime hooks | 无 | 新增（阶段提示、验收门禁） |
| 12 | 工具错误 | 工具 throw，runtime 转 tool-error | 工具返回错误字符串 | 迁移：`ToolResult { content, isError }` |

---

## 4. Code search & indexing

| 项目 | License | Reuse | Integration | Decision | Phase | Risk |
|------|---------|-------|-------------|----------|-------|------|
| [ripgrep](https://github.com/BurntSushi/ripgrep) | Unlicense | 文本搜索内核（mean time to first match、rg 特性：glob/type/上下文） | external CLI | **adopt（功能已落地：PATH 探测到 rg 时走 `rg --json`，未装则用 Node glob 扫描兜底）** | MVP | 本机安装依赖（宿主机当前未装 rg，兜底已验证） |
| [ast-grep](https://github.com/ast-grep/ast-grep) | MIT | 多语言 AST 结构化搜索（覆盖 Python/TS/JS/Go/Java 等 tree-sitter 生态） | external CLI（或 `@ast-grep/napi`） | evaluate | M6+ | CLI 版本一致性；MVP 用 rg/ts-morph 已覆盖 |
| [ts-morph](https://github.com/dsherret/ts-morph) | MIT | TS/JS 符号定义/引用、AST 分析与修改 | npm dependency | **adopt（M5 已落地：`find_symbol` 导出符号 + 引用，confidence=1）** | MVP | 大仓库性能（按需 project 加载） |
| [zoekt](https://github.com/sourcegraph/zoekt) | Apache-2.0 | trigram 全文索引 | external | evaluate | later | 服务部署成本 |
| [SCIP](https://github.com/scip-code/scip) | Apache-2.0 | 精确跨文件符号索引 | external（需语言 indexer） | evaluate | later | 每语言独立 indexer |
| [tree-sitter](https://github.com/tree-sitter/tree-sitter) | MIT | 多语言 AST 基础 | via ast-grep | evaluate（经 ast-grep 覆盖） | — | 双份 AST 维护 |
| [tinyglobby](https://github.com/SuperchupuDev/tinyglobby) | MIT | 文件发现（glob 扫描兜底、repo profile、test 文件枚举） | npm dependency | **adopt（M5 已落地；注意 `GlobOptions` 只有 `cwd` 没有 `root`）** | MVP | — |

Python：文本/结构搜索用 ripgrep + ast-grep；AST 级调用方分析为 best-effort，输出 `confidence`（不承诺全覆盖）。

---

## 5. Impact / call graph

| 项目 | License | Reuse | Integration | Decision | Phase | Risk |
|------|---------|-------|-------------|----------|-------|------|
| [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | MIT | JS/TS import 图、循环依赖、规则校验 | npm dependency | **adopt（M5 已落地：`impact_analyze`，`cruise()` JSON 输出，循环报告封顶 10）** | MVP | 限定 JS/TS 生态 |
| [ts-morph](https://github.com/dsherret/ts-morph) | MIT | 符号级 reference 图 | npm dependency | **adopt（M5 已落地）** | MVP | 同上 |
| [universal-ctags](https://github.com/universal-ctags/ctags) | **GPL-2.0** | 多语言符号索引（tags 文件） | external CLI only | evaluate（可选兜底） | later | GPL：禁止复制/链接 |
| OpenRewrite | Apache-2.0 | Java/Kotlin 图与重构 | external | evaluate | later | 目标仓库有 JVM 时才考虑 |

---

## 6. Change & refactor

| 项目 | License | Reuse | Integration | Decision | Phase | Risk |
|------|---------|-------|-------------|----------|-------|------|
| [ast-grep](https://github.com/ast-grep/ast-grep) | MIT | 结构化改写（sg scan/rewrite） | external CLI | adopt | v1 | 同 §4 |
| [jscodeshift](https://github.com/meta/jscodeshift) | MIT | JS/TS codemod | external | evaluate | later | 简单场景 ast-grep/ts-morph 足够 |
| OpenRewrite | Apache-2.0 | 大规模配方化重构 | external | evaluate | later | — |

补丁本身用 git 原生能力（`git diff` / `git apply`）生成与落盘，不引入额外依赖。

---

## 7. Dependency & supply chain

| 项目 | License | Reuse | Integration | Decision | Phase | Risk |
|------|---------|-------|-------------|----------|-------|------|
| [knip](https://github.com/webpro-nl/knip) | ISC | 本项目自身的未使用文件/导出/依赖检测 | devDependency | adopt | cleanup | — |
| [osv-scanner](https://github.com/google/osv-scanner) | Apache-2.0 | 目标仓库依赖漏洞/许可证扫描 | external CLI | adopt | v1 | 本机安装 |
| [npm-check-updates](https://github.com/raineorshine/npm-check-updates) | Apache-2.0 | 依赖升级候选 | external CLI | evaluate | later | — |
| [changesets](https://github.com/changesets/changesets) | MIT | monorepo 版本/发布 | dependency | evaluate | later | — |
| [manypkg](https://github.com/Thinkmill/manypkg) | MIT | workspace 识别/一致性 | npm dependency | evaluate | later | 自研 `repo/` 检测可先用轻量实现 |
| [dependabot-core](https://github.com/dependabot/dependabot-core) | MIT | 依赖升级逻辑参考 | reference | evaluate | — | Ruby 服务不嵌入 |
| [Renovate](https://github.com/renovatebot/renovate) | **AGPL-3.0** | — | — | reject | — | AGPL 传染性 |

---

## 8. Test impact analysis

优先使用目标仓库的**原生**能力，不自研映射：

| 生态 | 工具 | License | Integration | Decision | Phase |
|------|------|---------|-------------|----------|-------|
| Jest | `--findRelatedTests` / `--listTests` | MIT | 仓库原生命令 | **adopt（M5 已落地，仅本机 node_modules 探测通过时触发）** | MVP |
| Vitest | `vitest related` | MIT | 仓库原生命令 | **adopt（M5 已落地，同上）** | MVP |
| Nx | `nx affected` | MIT | 仓库原生命令 | adopt | MVP |
| Turborepo | `turbo run test --filter` | MIT | 仓库原生命令 | adopt | MVP |
| pytest | [pytest-testmon](https://github.com/tarpas/pytest-testmon) | MIT | pytest 插件 | **adopt（M5：testmon 未要求；touched `.py` → 包目录映射，pytest 在 PATH 才启用；兜底为文档化的内容启发式）** | MVP |
| Go | `go test ./...` + 包映射 | BSD | 仓库原生命令 | evaluate | later |

[testcontainers](https://github.com/testcontainers/testcontainers-node)（MIT）：目标仓库测试依赖外部服务时，evaluate（later）。

---

## 9. Sandbox, execution & process/CLI utilities

| 项目 | License | Reuse | Integration | Decision | Phase | Risk |
|------|---------|-------|-------------|----------|-------|------|
| Docker / Podman | Apache-2.0 | 容器隔离（repo 只读挂载、禁网、限额） | external CLI | **adopt（M6 已落地：docker provider，`--network none` + cpus/memory/pids/time 限额，真实容器集成测试通过；podman 探测兜底）** | M6 | 守护进程/资源 |
| [devcontainers/cli](https://github.com/devcontainers/cli) | MIT | 存在 devcontainer.json 时复用其环境 | external CLI | **adopt（M6 已落地：探测优先级最高；注意其 exec 不能传 docker 级网络/资源限额——已在 SandboxSpec 与工具结果中如实披露）** | M6 | CLI 版本 |
| [execa](https://github.com/sindresorhus/execa) | MIT | 安全子进程（超时/kill/流；sandbox runner 可注入用于测试） | npm dependency | **adopt（M5 已落地：rg 探测 + 原生 test runner 探测；M6 全 sandbox 执行）** | M4 | — |
| [commander](https://github.com/tj/commander.js) | MIT | 调查 CLI 参数解析（替换调查入口手写 argv 解析） | npm dependency | **adopt（M5 已落地：`src/cli/investigate.ts`）** | M5 | — |
| [p-limit](https://github.com/sindresorhus/p-limit) | MIT | 批量扫描并发上限（Node 兜底搜索/符号扫描） | npm dependency | **adopt（M5 已落地）** | M5 | — |
| git worktree（原生） | — | 文件隔离降级 | node:child_process | **adopt（M6 已落地：仅 `--unsafe-host-tests`；可注入 runner 全覆盖测试；真实 git 用例通过）** | M6 | 不隔离进程 |
| [microsandbox](https://github.com/superradcompany/microsandbox) | Apache-2.0 | microVM 隔离 | external CLI | evaluate | later | 需要宿主内核支持 |
| [semgrep](https://github.com/semgrep/semgrep) | **LGPL-2.1** | 静态规则扫描 | external CLI only | evaluate（可选） | later | LGPL：禁止复制源码 |

---

## 10. Agent / LLM libraries

| 项目 | License | Reuse | Integration | Decision | Phase | Risk |
|------|---------|-------|-------------|----------|-------|------|
| pi-agent（§3） | MIT | runtime 模式参考 | reference | **adopt as pattern** | 已在进行 | Node >=22.19 |
| [zod](https://github.com/colinhacks/zod) | MIT | 数据契约校验（`RepoProfile`/`ImpactGraph`/`CoverageMap`），`z.toJSONSchema()` 生成工具参数 | npm dependency | **adopt（M5 已落地 contracts）** | M4 | — |
| [eventsource-parser](https://github.com/rexxars/eventsource-parser) | MIT | SSE 解析（`rag_query` 已换用，替换自写块解析） | npm dependency | **adopt（M4 已落地）** | M4 | 行修复流保留 RAG 服务无 `data:` 前缀续行语义 |
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | Apache-2.0 | 替换自写 Anthropic HTTP/SSE/重试（`maxRetries: 0`，重试归 `withRetry`） | npm dependency | **adopt（用户已确认，M4 已落地）** | M4 | 二进制类型边界用最小 `AnthropicClient` 接口注入 |
| openai | Apache-2.0 | OpenAI-compatible 客户端（dashscope/openai/ollama） | npm dependency | adopt | 已采用 | — |
| @modelcontextprotocol/sdk | MIT | MCP 客户端 | npm dependency | adopt | 已采用 | — |
| [LangGraph JS](https://github.com/langchain-ai/langgraphjs) | MIT | graph/checkpoint 编排 | — | evaluate（条件） | later | 与现有 runtime 冲突；需要 branching/checkpoint 时再评 |

---

## 11. Evaluated but not adopted

| 项目 | 原因 | 状态 |
|------|------|------|
| Vercel AI SDK | GitHub 许可证字段 `NOASSERTION`（需法务确认）；自写薄适配层 + openai/anthropic SDK 已覆盖 | reject（暂缓） |
| Mastra | 许可证字段不明确；引入完整框架与 pi-agent 模式冲突 | reject |
| Renovate | AGPL-3.0 | reject |
| LangChain / CrewAI | 框架过重，与现有 runtime 冲突 | reject |
| Sourcegraph Server | 部署/资源成本高；ripgrep + ast-grep 已足够 | reject（暂缓） |
| 复制 GPL/LGPL 源码 | 许可证传染 | reject（只允许外部进程） |
| langgraph/autogen 式固定 pipeline | 调查工作流走"Agent 循环 + 工具 + 阶段门禁"，不走硬编码 pipeline | reject |

---

## 12. Reuse roadmap by phase

| 里程碑 | 引入 |
|--------|------|
| M2 清理 | knip（devDependency + `npm run knip`） |
| M3 runtime 对齐 | 无新依赖（仅内部重构） |
| M4 OSS 基础 | `@anthropic-ai/sdk`、`eventsource-parser`（已落地）；zod、execa、tinyglobby、commander、p-limit、dependency-cruiser、ts-morph 已随 M5 功能一起引入并全部被使用（knip 零发现） |
| M5 调查 MVP | 上述 npm 依赖全部落地；ripgrep 保持可选（外部 CLI 检测 + 提示安装，未装走 Node 兜底）；ast-grep 未采纳（M6+ 再评） |
| M6 沙箱 | Docker/Podman、devcontainers/cli（外部 CLI，均零新 npm 依赖）；M6 未新增任何 npm 依赖，knip 保持零发现 |
| M7 验收 | fixtures（真实 fixture repo + 真实 `git diff` 产补丁）+ `tests/acceptance.test.ts` 5 用例全绿；零新依赖。过程中修复 execa `stripFinalNewline` 保真缺陷与 node 镜像 entrypoint 的 PATH 解析问题（`.env`/文档同步）；真实 CLI 运行后补充修复：调查路径授权锚定 `--repo`、worktree-host 要求独立 git 顶层 + 注入 `<worktree>/node_modules/.bin` PATH、spawn 失败显式报 127 与 ENOENT、`sandbox_run` 丢弃与 kind 同名的多余 token、`impact_analyze` 图 id 归一化到仓库相对路径并全仓巡航（修复 dependents 恒为空）、风险报告只归因触及文件的 import cycle、openai SDK 每请求独立 AbortSignal（修复第 11 轮的 MaxListeners 警告）（零新依赖） |
| v1 | osv-scanner、pytest-testmon |
| later | zoekt、SCIP、universal-ctags、semgrep、microsandbox、testcontainers、jscodeshift、OpenRewrite、LangGraph JS |

---

## 13. NOTICE / attribution checklist

复制/分发第三方代码时必须：

1. `THIRD_PARTY_NOTICES.md` 登记来源仓库 URL、commit SHA、许可证文本。
2. Apache-2.0 项目分发时保留其 NOTICE 要求（标明修改）。
3. 本项目自身的变更写入内容与"修改了什么/为什么"一并记录。
4. 每次新增依赖在 `REFERENCE_PROJECTS.md` 对应分类中登记（License / Integration / Decision / Phase / Risk）。
5. 清理时反向核对：删除依赖后同步移除对应 ADR 条目。

## 14. 内部参考

| | |
|--|--|
| **路径** | 本地 RAG 项目（通过 `RAG_API_URL` 配置） |
| **定位** | RAG 检索增强生成系统（Python FastAPI） |
| **集成** | Phase 8 起经 `POST /api/chat/stream`（SSE），`rag_query` 工具 |
| **说明** | 可选依赖；不可用时 `rag_query` 返回错误结果，Agent 继续其他流程 |
