# 扩展路线图

基于 P1-P8 已完成的基础 agent，参考 [REFERENCE_PROJECTS.md](./REFERENCE_PROJECTS.md) 中 pi-agent 等项目的设计，规划的后续扩展方向（P9-P18）。

---

## 1. 当前状态 (P1-P8)

| Phase | 能力 | 状态 |
|-------|------|------|
| P1 | 基础对话（LLM API 调用） | ✅ |
| P2 | 多轮对话（消息管理 + token 裁剪） | ✅ |
| P3 | 工具定义与调用（Function Calling） | ✅ |
| P4 | Agent 推理循环（ReAct + max_iterations） | ✅ |
| P5 | 文件操作工具（write_file） | ✅ |
| P6 | 错误处理与日志（结构化 logger） | ✅ |
| P7 | Prompt 工程（System Prompt 模板） | ✅ |
| P8 | RAG 集成（知识库查询工具） | ✅ |

**现有工具**: `read_file`、`list_files`、`write_file`、`rag_query`

---

## 2. 差距分析

本项目与参考项目 pi-agent 的能力对比：

| 能力 | 本项目 (P1-P8) | pi-agent | 差距 |
|------|----------------|----------|------|
| LLM 调用 | ✅ DashScope/Qwen | ✅ 多 Provider | 仅单 Provider |
| 多轮对话 | ✅ MessageManager | ✅ transformContext | 缺上下文管道 |
| 工具调用 | ✅ 4 个工具 | ✅ MCP + 自定义工具 | 缺 MCP 支持 |
| Agent 循环 | ✅ ReAct + max_iter | ✅ ReAct + steering | 缺中途干预 |
| 流式输出 | ✅ SSE (LLM) | ✅ 事件流系统 | 缺事件系统 |
| 错误处理 | ✅ try-catch | ✅ 协作取消 | 缺 AbortSignal |
| 日志 | ✅ logger | ✅ 事件流 | 粒度不同 |
| RAG 集成 | ✅ HTTP 调用 | 无内置 | 本项目领先 |
| 会话持久化 | ❌ 内存 | ✅ SQLite | 缺失 |
| 多 Provider | ❌ 仅 DashScope | ✅ OpenAI/Anthropic/Google | 缺失 |
| 流式 UI | ❌ readline | ✅ TUI 差分渲染 | 缺失 |
| 任务计划 | ❌ | ✅ Planner + todos | 缺失 |
| 子 Agent | ❌ | ✅ Sub-agents | 缺失 |
| MCP 支持 | ❌ | ✅ MCP tools | 缺失 |
| 取消/中断 | ❌ | ✅ AbortSignal | 缺失 |
| 自定义消息 | ❌ | ✅ AgentMessage 扩展 | 缺失 |

---

## 3. 扩展计划 (P9-P18)

### 3.1 Phase 9: 多 Provider 支持

**参考**: pi-ai 的统一 Provider 抽象

**目标**: 支持多个 LLM Provider，可配置切换

**实现**:
```
src/
├── llm/
│   ├── index.ts          # 统一接口 + Provider 工厂
│   ├── base.ts           # LLMProvider 抽象
│   ├── dashscope.ts      # DashScope/Qwen (现有)
│   ├── openai.ts         # OpenAI
│   └── ollama.ts         # Ollama 本地
```

**API 设计**:
```typescript
interface LLMProvider {
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<LLMChunk>;
}

function createProvider(config: ProviderConfig): LLMProvider;
```

**验收标准**:
- 通过 `.env` 切换 Provider
- 新增 Provider 只需实现接口
- 现有 DashScope 不受影响

**工作量**: ~200 行代码

---

### 3.2 Phase 10: 事件流系统

**参考**: pi-agent-core 的两级事件系统

**目标**: Agent 运行过程中发出结构化事件，支持流式 UI 和进度通知

**事件类型**:
```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; iteration: number }
  | { type: "message_start"; role: MessageRole }
  | { type: "message_update"; content: string }
  | { type: "message_end"; role: MessageRole }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_end"; name: string; result: string }
  | { type: "turn_end" }
  | { type: "agent_end"; result: AgentRunResult };
```

**实现**:
```typescript
class Agent {
  private listeners: Array<(event: AgentEvent) => void> = [];

  subscribe(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: AgentEvent): void {
    this.listeners.forEach(fn => fn(event));
  }
}
```

**验收标准**:
- CLI 可实时显示工具调用进度
- 可订阅事件流用于 UI 渲染

**工作量**: ~150 行代码

---

### 3.3 Phase 11: 上下文转换管道

**参考**: pi-agent 的 transformContext + convertToLlm

**目标**: 实现 AgentMessage + transformContext + convertToLlm 管道

**实现**:
```typescript
// 1. 扩展消息类型
type AgentMessage = Message | CustomMessage;

// 2. 上下文转换
interface AgentConfig {
  transformContext?(messages: AgentMessage[]): Promise<AgentMessage[]>;
  convertToLlm(messages: AgentMessage[]): Message[];
}

// 3. 管道
// AgentMessage[] → transformContext() → convertToLlm() → Message[] → LLM
```

**功能**:
- `transformContext`: 可插入摘要压缩、外部上下文注入
- `convertToLlm`: 过滤自定义消息，转换为 LLM 格式

**验收标准**:
- 支持自定义消息类型（如 UI 通知）
- 上下文裁剪逻辑可配置

**工作量**: ~200 行代码

---

### 3.4 Phase 12: 会话持久化

**参考**: pi-agent 的 SQLite session backend

**目标**: 会话可保存和恢复

**实现**:
```
src/
├── session/
│   ├── index.ts           # SessionManager
│   ├── sqlite.ts          # SQLite 后端
│   └── types.ts           # Session 类型
```

**功能**:
- `saveSession()` → SQLite
- `loadSession(id)` → 恢复历史
- `listSessions()` → 列出所有会话
- CLI 命令: `/save`, `/load <id>`, `/sessions`

**验收标准**:
- 退出后可恢复对话
- 支持多个命名会话

**工作量**: ~250 行代码 + `better-sqlite3` 依赖

---

### 3.5 Phase 13: 中途干预 (Steering)

**参考**: pi-agent 的 steering queue

**目标**: Agent 执行过程中可注入新指令

**实现**:
```typescript
class Agent {
  private steeringQueue: Message[] = [];

  steer(message: string): void {
    this.steeringQueue.push({ role: "user", content: message });
  }

  async run(userMessage: string): Promise<AgentRunResult> {
    // ... 循环中检查队列
    if (this.steeringQueue.length > 0) {
      const steering = this.steeringQueue.shift()!;
      this.history.add(steering);
      // 继续循环，LLM 会看到新指令
    }
  }
}
```

**验收标准**:
- 工具执行期间可注入指令
- 指令在下一轮 LLM 调用中生效

**工作量**: ~100 行代码

---

### 3.6 Phase 14: 取消与超时 (AbortSignal)

**目标**: 支持用户取消正在进行的任务

**实现**:
```typescript
class Agent {
  private abortController?: AbortController;

  abort(): void {
    this.abortController?.abort();
  }

  async run(userMessage: string, signal?: AbortSignal): Promise<AgentRunResult> {
    this.abortController = new AbortController();
    // 传递 signal 到 fetch 和 LLM 调用
  }
}
```

**验收标准**:
- Ctrl+C 可取消当前任务
- 工具执行有超时控制
- LLM 调用支持 AbortSignal

**工作量**: ~100 行代码

---

### 3.7 Phase 15: 任务计划 (Planner)

**参考**: pi-agent 的 update_plan 工具

**目标**: Agent 能将复杂任务分解为可执行计划

**实现**:
```typescript
const updatePlanTool: Tool = {
  name: "update_plan",
  description: "Update the current task plan. Use this to break down complex tasks.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: { type: "string" },
        description: "List of plan steps",
      },
      completed: {
        type: "number",
        description: "Number of completed steps",
      },
    },
    required: ["steps", "completed"],
  },
  // ...
};
```

**System Prompt 扩展**:
```
For complex tasks, create a plan first:
1. Call update_plan to declare your plan
2. Execute each step
3. Update the plan as you progress
```

**验收标准**:
- 复杂任务自动创建计划
- CLI 显示进度清单 ⬜→⏳→✅

**工作量**: ~150 行代码

---

### 3.8 Phase 16: 子 Agent (Sub-agents)

**参考**: pi-agent 的 sub-agent 委派

**目标**: 支持将子任务委托给子 agent

**实现**:
```typescript
const subAgentTool: Tool = {
  name: "delegate_task",
  description: "Delegate a focused subtask to a sub-agent.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "The subtask description" },
      system_prompt: { type: "string", description: "System prompt for sub-agent" },
    },
    required: ["task"],
  },
  async execute(args) {
    const subAgent = new Agent(args.system_prompt || SYSTEM_PROMPT);
    const result = await subAgent.run(args.task);
    return result.answer;
  },
};
```

**验收标准**:
- 复杂任务可分解并行执行
- 子 agent 有独立的上下文和工具

**工作量**: ~200 行代码

---

### 3.9 Phase 17: MCP 支持 (Model Context Protocol)

**目标**: 支持通过 MCP 协议接入外部工具

**实现**:
```
src/
├── mcp/
│   ├── index.ts           # MCP 客户端
│   ├── client.ts          # MCP 连接管理
│   └── tools.ts           # MCP 工具转换为 Tool 接口
```

**功能**:
- 连接 MCP server（stdio / SSE）
- 发现可用工具
- 将 MCP 工具转换为本项目的 `Tool` 接口

**验收标准**:
- 可连接标准 MCP server
- MCP 工具与本地工具统一管理

**工作量**: ~300 行代码 + `@modelcontextprotocol/sdk` 依赖

---

### 3.10 Phase 18: 流式 CLI UI

**参考**: pi-tui 的差分渲染

**目标**: 替换 readline，实现更好的终端交互体验

**实现选项**:
1. **简单方案**: 保留 readline，增强输出格式
2. **进阶方案**: 使用 `ink` (React for CLI) 或 `@earendil-works/pi-tui`
3. **完整方案**: 实现自定义 TUI（差分渲染）

**功能**:
- 流式输出打字机效果
- 实时显示工具调用状态
- Markdown 渲染
- 命令面板（/help, /save, /load）

**工作量**: ~400 行代码（完整方案）

---

## 4. 路线图总览

```
当前状态 (P1-P18 全部完成)
├── 多轮对话 ✅
├── 工具调用 ✅
├── ReAct 循环 ✅
├── 错误处理 ✅
├── 日志系统 ✅
├── Prompt 工程 ✅
└── RAG 集成 ✅

P9  多 Provider      ✅ 可切换 LLM
P10 事件流系统       ✅ 实时 UI 支持
P11 上下文管道       ✅ 灵活的消息处理
P12 会话持久化       ✅ 退出不丢失
P13 中途干预         ✅ 用户可修正方向
P14 取消与超时       ✅ 安全控制
P15 任务计划         ✅ 复杂任务分解
P16 子 Agent         ✅ 并行处理
P17 MCP 支持         ✅ 生态工具接入
P18 流式 CLI UI      ✅ 更好的交互
```

### 优先级矩阵

| 优先级 | Phase | 理由 |
|--------|-------|------|
| **高** | P9 多 Provider | 解除 Vendor Lock-in |
| **高** | P12 会话持久化 | 实用价值最高 |
| **高** | P10 事件流系统 | 后续 Phase 的基础设施 |
| **中** | P11 上下文管道 | 架构改进 |
| **中** | P14 取消与超时 | 稳定性 |
| **中** | P15 任务计划 | 提升复杂任务能力 |
| **低** | P13 中途干预 | 依赖事件流 |
| **低** | P16 子 Agent | 高级功能 |
| **低** | P17 MCP 支持 | 生态整合 |
| **低** | P18 流式 UI | 体验优化 |

---

## 5. 后续可选方向

P9-P18 已全部实现。后续如需继续演进，可考虑：

| 方向 | 说明 |
|------|------|
| ~~Tool 接口透传 AbortSignal~~ | ✅ 已在 P19 完成：工具执行支持 signal + 超时竞速，dangerous 工具需审批 |
| 结构化输出校验 | 对 LLM 工具参数做 JSON Schema 校验 |
| 流式 Markdown 渲染 | 引入终端 Markdown 渲染库 |
| 会话分支与回滚 | 基于 SQLite 会话快照做对话分叉 |
| 上下文摘要压缩 | transformContext 管道已就绪，补一个 summary compaction 实现 |
| TUI 差分渲染 | 流式输出与 readline 输入行的重绘冲突 |

---

## 6. P19：工程化强化（2026-10）

针对架构评审结论（去全局化、协议深度、工程质量）的一轮改造。参考 [REFERENCE_PROJECTS.md](./REFERENCE_PROJECTS.md)。

### 6.1 架构去全局化

- **ToolRegistry**（`src/tools/registry.ts`）：每个 Agent 持有独立工具集，默认注册内置工具；全局 `registerTool` 仅保留给 CLI/MCP 场景。
- **AgentOptions**（`src/agent.ts`）：provider / registry / approval / delegationDepth 均可注入，主/子 Agent 可用不同模型与工具集。
- **delegate_task**：delegation depth 改为经 `ToolContext` 传递，移除模块级全局计数器。
- **消息管道**：`MessageManager.trim()` 保护 system prompt 与首条 user 消息（原任务不被裁掉）。
- **会话**：`sessions` 表增加 `message_count` 列（含旧库自动迁移），`list()` 不再全量解析 JSON。

### 6.2 事件与流式

- tool_call delta 拼装逻辑从 `agent.ts` 下沉到 provider（`StreamToolCallAssembler`），Agent 只消费完整的 `LLMChunk.tool_calls`。
- 事件流补齐：取消路径也发 `turn_end`；`message_end` / `agent_end` 携带 `TokenUsage`；`AgentRunResult` 聚合整个 run 的 token 用量。
- OpenAI-compatible 流式请求带 `stream_options.include_usage`。

### 6.3 协议深度与弹性

- **错误分类**（`src/llm/errors.ts`）：`LLMError` 按 rate_limit / timeout / network / overloaded / auth / unknown 分类，`retryable` 决定重试。
- **重试退避**（`src/llm/retry.ts`）：`withRetry` 指数退避 + Retry-After 头，流式仅在建立连接阶段重试。配置：`LLM_MAX_RETRIES`、`LLM_RETRY_BASE_MS`。
- **Anthropic 原生 provider**（`src/llm/anthropic.ts`）：原生 Messages API（system 独立、tool_use/tool_result block、SSE 流式拼装），验证 `LLMProvider` 抽象不绑定 OpenAI 形状。
- **工具审批**：`Tool.dangerous` + `ApprovalHandler`；`write_file` 为 dangerous，CLI 在 `TOOL_APPROVAL=on` 时 y/N 确认，子 Agent 继承审批策略。

### 6.4 工程质量

- Biome 接管格式化（`npm run lint` / `npm run format`）。
- GitHub Actions CI：`npm ci && typecheck && lint && test`（Node 20）。
- 测试从 13 个增至 29 个：错误分类、重试策略、registry 隔离、dangerous 工具审批、Anthropic 消息转换与 SSE 解析、trim 保护首条 user 消息。

---

## 7. P20：CodeReview 修复（2026-10）

按 [CodeReview.md](./CodeReview.md) 的 20 条发现逐项修复。回归测试见 `tests/code_review.test.ts`。

### 7.1 高严重度

| # | 问题 | 修复 |
|---|------|------|
| 1 | MCP 工具对 CLI agent 不可见（全局 registry 与 agent registry 是两个实例） | CLI 创建共享 `createDefaultRegistry()`，同时传给 Agent 与 `connectMcpServers` |
| 2 | Anthropic provider 抛 `LLMError("unknown")` 导致 429/5xx 永不重试 | 新增 `kindFromStatus()`，`apiError()` 按 status 分类 |
| 3 | `Retry-After` 解析不支持 `Headers` 实例（undici 只能 `.get()`） | `getHeader()` 兼容 `Headers` 实例与普通对象 |
| 4 | Anthropic 消息转换产生不合规/冗余 user 消息（steer 场景） | tool_result 块保证在 text 之前（unshift）；user 文本无条件并入末尾 user 消息，连续同角色不再出现 |

### 7.2 中严重度

| # | 问题 | 修复 |
|---|------|------|
| 5 | 同轮工具并行执行的文件竞争 | 仅白名单（read_file/list_files/rag_query）并行，其余按调用顺序串行 |
| 6 | read_file 无大小限制撑爆上下文 | 256KB 截断 + 明确提示；配合 trim 保护不再死锁 |
| 7 | `StreamToolCallAssembler` 对 name 用 `+=` 重复拼接 | 仅首次设置 name（兼容 dashscope/vLLM 每 delta 重发全名） |
| 8 | `MessageManager.replace()` 不保证 system prompt | 缺失时自动补回 |
| 9 | rag_query 非 2xx 丢失错误体 | 附带 body 前 300 字符 |
| 10 | retry sleep 正常到期不移除 abort listener | resolve 时手动 removeEventListener |
| 11 | 请求超时被分类为 unknown 不可重试 | `AbortError` / "operation was aborted" 归类为 timeout（用户取消仍由 `signal.aborted` 短路） |

### 7.3 低严重度 / 一致性

- #12 `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` 环境变量化。
- #13 `Agent.run()` 防重入（活动 run 未结束时抛错）。
- #14 run 结束清空残留 steering 队列，不泄漏到下一次任务。
- #15 Anthropic `requestBody` 不再重复计算 tools。
- #16 `list_files` 结果排序（LLM 每次看到稳定结构）。
- #17 MCP `inputSchema` 仅在 `type === "object"` 时透传，否则回退空 schema。
- #18 子 Agent 事件冒泡：`AgentOptions.onSubAgentEvent` → `ToolContext` → delegate_task 订阅；CLI 显示 `[sub-tool]` / `[sub-done]`。
- #19 CLI 审批期间 Ctrl+C 仅拒绝当前审批，不取消整个任务。
- #20 logger 统一输出到 stderr，与 readline prompt 同流，不污染 stdout 的答案流。

测试：39 个（新增 10 个回归测试）。

---

**相关文档**: [PROJECT_SPEC.md](./PROJECT_SPEC.md)（P1-P8 已完成规格）· [REFERENCE_PROJECTS.md](./REFERENCE_PROJECTS.md)（参考项目分析）
