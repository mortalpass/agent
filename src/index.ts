import * as readline from "node:readline";
import { Agent } from "./agent.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { SYSTEM_PROMPT } from "./prompts/system.js";
import { SessionManager } from "./session/index.js";
import { closeMcpConnections, connectMcpServers } from "./mcp/index.js";
import { createDefaultRegistry } from "./tools/registry.js";
import { formatPlan } from "./planner.js";
import type { AgentEvent } from "./events.js";
import type {
  ApprovalHandler,
  PathAccessDecision,
  PathAccessRequest,
} from "./types.js";
import { createPathAccessHandler, PathPermissionStore } from "./permissions.js";

let answerDisplayed = false;

function handleEvent(agent: Agent, event: AgentEvent): void {
  switch (event.type) {
    case "agent_start":
      agent.resetPlan();
      break;
    case "message_start":
      if (event.role === "assistant") {
        process.stdout.write("\nAssistant > ");
      }
      break;
    case "message_update":
      process.stdout.write(event.content);
      break;
    case "message_end":
      if (event.role === "assistant") {
        process.stdout.write("\n\n");
        answerDisplayed = true;
      }
      break;
    case "turn_start":
      console.log(
        `  [turn ${event.iteration}/${event.maxIterations}] thinking...`,
      );
      break;
    case "tool_execution_start": {
      const preview =
        event.args.length > 80 ? event.args.slice(0, 80) + "..." : event.args;
      console.log(`  [tool] ${event.name}(${preview})`);
      break;
    }
    case "tool_execution_end": {
      if (event.name === "update_plan") {
        const plan = agent.getPlan();
        if (plan) {
          console.log(`  Plan:\n${formatPlan(plan)}`);
        }
        break;
      }
      const preview =
        event.result.content.length > 120
          ? event.result.content.slice(0, 120) + "..."
          : event.result.content;
      console.log(`  [done] ${preview}`);
      break;
    }
    case "agent_error":
      console.error(`  [error] ${event.message}`);
      break;
    case "agent_end":
      logger.debug(
        `[agent_end] iterations=${event.iterations}, tools=${event.toolCalls.length}`,
      );
      break;
    default:
      break;
  }
}

const SYNTHETIC_ANSWER_PREFIXES: readonly string[] = [
  "(reached maximum iterations)",
  "(LLM error:",
  "(token budget exhausted:",
];

function isSyntheticAnswer(answer: string): boolean {
  return SYNTHETIC_ANSWER_PREFIXES.some((prefix) => answer.startsWith(prefix));
}

interface CommandState {
  /** Session that /load restored the current history from; /save updates it. */
  loadedSessionId: string | null;
  /** Session-scoped path grants; present only when PATH_APPROVAL is on. */
  pathPermissions?: PathPermissionStore;
}

function handleCommand(
  input: string,
  agent: Agent,
  sessions: SessionManager,
  state: CommandState,
): boolean {
  const [cmd, ...rest] = input.split(/\s+/);

  switch (cmd) {
    case "/save": {
      const name = rest.join(" ") || undefined;
      // With an explicitly loaded session and no new name, overwrite that
      // session instead of creating an unbounded number of copies.
      if (state.loadedSessionId) {
        const updated = sessions.update(
          state.loadedSessionId,
          agent.getMessages(),
          name,
        );
        if (updated) {
          console.log(`Updated session: ${updated.id}`);
          console.log(
            `  name: ${updated.name}, messages: ${updated.messageCount}`,
          );
          return true;
        }
        console.log(
          `Loaded session ${state.loadedSessionId} no longer exists; saving a new one.`,
        );
        state.loadedSessionId = null;
      }
      const meta = sessions.save(agent.getMessages(), name);
      state.loadedSessionId = meta.id;
      console.log(`Saved session: ${meta.id}`);
      console.log(`  name: ${meta.name}, messages: ${meta.messageCount}`);
      return true;
    }
    case "/load": {
      const id = rest[0];
      if (!id) {
        console.log("Usage: /load <session-id>");
        return true;
      }
      const messages = sessions.load(id);
      if (!messages) {
        console.log(`Session not found: ${id}`);
        return true;
      }
      agent.restore(messages);
      state.loadedSessionId = id;
      console.log(`Loaded session ${id} (${messages.length} messages)`);
      return true;
    }
    case "/sessions": {
      const list = sessions.list();
      if (list.length === 0) {
        console.log("No saved sessions.");
        return true;
      }
      for (const s of list) {
        console.log(
          `${s.id}  ${s.name}  [${s.messageCount} msgs, ${s.updatedAt}]`,
        );
      }
      return true;
    }
    case "/permissions": {
      const store = state.pathPermissions;
      if (!store) {
        console.log("Path approval is off (PATH_APPROVAL).");
        return true;
      }
      if (rest[0] === "clear") {
        store.clear();
        console.log("Cleared session path permissions.");
        return true;
      }
      const allowed = store.list();
      if (allowed.length === 0) {
        console.log("No session path permissions granted.");
        return true;
      }
      console.log("Session-allowed paths:");
      for (const p of allowed) console.log(`  ${p}`);
      return true;
    }
    case "/clear": {
      agent.clear();
      state.loadedSessionId = null;
      console.log("Cleared conversation history; starting a fresh session.");
      return true;
    }
    case "/help": {
      console.log("Commands:");
      console.log(
        "  /save [name]   save conversation; overwrites the loaded session by default",
      );
      console.log("  /load <id>     restore a saved conversation");
      console.log("  /sessions      list saved conversations");
      console.log("  /permissions   show [/clear] session path permissions");
      console.log("  /clear         drop history and start a fresh session");
      console.log("  /help          show this help");
      console.log("  exit           quit");
      console.log(
        "While the agent runs, type plain text to steer it; Ctrl+C cancels.",
      );
      return true;
    }
    default:
      console.log(
        `Unknown command: ${cmd} (available: /help /save /load /sessions /permissions /clear)`,
      );
      return true;
  }
}

async function main(): Promise<void> {
  // One shared registry for both the agent and MCP tools, so MCP tools are
  // visible to the agent's tool loop.
  const registry = createDefaultRegistry();
  const agent = new Agent(SYSTEM_PROMPT, config.llm.contextTokens, {
    registry,
    onSubAgentEvent: (event) => {
      if (event.type === "tool_execution_start") {
        const preview =
          event.args.length > 80 ? event.args.slice(0, 80) + "..." : event.args;
        console.log(`  [sub-tool] ${event.name}(${preview})`);
      } else if (event.type === "tool_execution_end") {
        const preview =
          event.result.content.length > 120
            ? event.result.content.slice(0, 120) + "..."
            : event.result.content;
        console.log(`  [sub-done] ${preview}`);
      }
    },
  });
  agent.setStreaming(true);
  const sessions = new SessionManager();
  const mcpConnections = await connectMcpServers(undefined, registry);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "\nYou > ",
  });
  let running = false;
  let approving = false;
  let denyApproval: (() => void) | undefined;
  const commandState: CommandState = { loadedSessionId: null };

  // --- Path access permissions (PATH_APPROVAL) ----------------------------
  // Serializes interactive prompts: parallel-safe tools (read_file,
  // list_files) may fire queries concurrently, and overlapping readline
  // questions would clobber each other.
  let promptChain: Promise<void> = Promise.resolve();
  const enqueuePrompt = <T>(job: () => Promise<T>): Promise<T> => {
    const run = promptChain.then(job, job);
    promptChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  let denyCurrentPrompt: (() => void) | undefined;

  const askPathAccess = (
    request: PathAccessRequest,
  ): Promise<PathAccessDecision> =>
    enqueuePrompt(
      () =>
        new Promise<PathAccessDecision>((resolve) => {
          const verbs: Record<string, string> = {
            read: "READ",
            list: "LIST",
            write: "WRITE",
          };
          const ask = (): void => {
            approving = true;
            rl.question(
              `\n  [access] ${verbs[request.operation]} ${request.path}\n  allow? [o] once  [s] this path (session)  [n] deny (N) `,
              (answer) => {
                const raw = answer.trim().toLowerCase();
                approving = false;
                denyCurrentPrompt = undefined;
                if (raw === "o" || raw === "once") {
                  resolve("once");
                  return;
                }
                if (raw === "s" || raw === "session") {
                  resolve("session");
                  return;
                }
                if (raw === "" || raw === "n" || raw === "no") {
                  resolve("deny");
                  return;
                }
                console.log("  [access] invalid input; enter o, s, or n.");
                ask();
              },
            );
            // Ctrl+C during a pending question denies only this access.
            denyCurrentPrompt = () => {
              approving = false;
              denyCurrentPrompt = undefined;
              resolve("deny");
            };
          };
          ask();
        }),
    );

  if (config.agent.pathApproval !== "off") {
    const store = new PathPermissionStore();
    commandState.pathPermissions = store;
    agent.setPathAccess(
      createPathAccessHandler({ store, prompt: askPathAccess }),
    );
  }

  let approval: ApprovalHandler | undefined;
  if (config.agent.approval === "on") {
    approval = (request) =>
      new Promise<boolean>((resolve) => {
        approving = true;
        const preview = JSON.stringify(request.args).slice(0, 200);
        rl.question(
          `\n  [approval] allow ${request.tool}(${preview})? (y/N) `,
          (answer) => {
            approving = false;
            denyCurrentPrompt = undefined;
            resolve(/^y(es)?$/i.test(answer.trim()));
          },
        );
        // Ctrl+C during a pending approval denies only this tool call.
        denyCurrentPrompt = () => {
          approving = false;
          denyCurrentPrompt = undefined;
          resolve(false);
        };
      });
    denyApproval = () => denyCurrentPrompt?.();
    agent.setApproval(approval);
  }

  agent.subscribe((event) => handleEvent(agent, event));

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    sessions.close();
    await Promise.race([
      closeMcpConnections(mcpConnections),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]).catch(() => {});
    process.exit(0);
  };

  logger.info("agent (Phase 18: Streaming CLI)");
  logger.info(
    `Context: ${config.llm.contextTokens} tokens (safety ${config.llm.contextSafety}), ` +
      `completion cap ${config.llm.maxTokens}` +
      (config.llm.runTokenBudget > 0
        ? `, run budget ${config.llm.runTokenBudget}`
        : ""),
  );
  logger.info(
    `Tools: ${registry
      .definitions()
      .map((d) => d.function.name)
      .join(", ")}`,
  );
  logger.info(
    "Commands: /help, /save [name], /load <id>, /sessions, /permissions, /clear, exit. Ctrl+C cancels a running task.",
  );
  logger.info(
    "Type your message and press Enter. While agent runs, type to inject instructions.",
  );
  if (config.agent.approval !== "on") {
    logger.info(
      "Generic tool approval is off (TOOL_APPROVAL); file access is governed by PATH_APPROVAL.",
    );
  }
  if (config.agent.pathApproval === "off") {
    logger.info(
      "Path approval is off: read_file/list_files/write_file run without confirmation. Set PATH_APPROVAL=on to be asked.",
    );
  }

  rl.prompt();

  rl.on("SIGINT", () => {
    if (approving) {
      // Covers both tool approval and path access questions.
      console.log("\n  [denied]");
      denyApproval?.();
      return;
    }
    if (running) {
      console.log("\n  [cancel] aborting current task...");
      agent.abort();
      return;
    }
    logger.info("Bye!");
    void shutdown();
  });

  rl.on("line", (line: string) => {
    const input = line.trim();
    if (approving) {
      // The line belongs to the approval prompt's rl.question.
      return;
    }
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "exit" || input === "quit") {
      logger.info("Bye!");
      void shutdown();
      return;
    }

    if (running) {
      if (input.startsWith("/")) {
        console.log("  [busy] commands unavailable while agent is running");
      } else {
        agent.steer(input);
        console.log(`  [steer] queued: ${input}`);
      }
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      handleCommand(input, agent, sessions, commandState);
      rl.prompt();
      return;
    }

    void runTurn(input);
  });

  async function runTurn(input: string): Promise<void> {
    running = true;
    answerDisplayed = false;
    try {
      const result = await agent.run(input);
      if (result.aborted) {
        process.stdout.write("\n[cancelled]\n\n");
      } else if (!answerDisplayed) {
        console.log(`\nAssistant > ${result.answer}\n`);
      } else if (isSyntheticAnswer(result.answer)) {
        // Earlier turns already streamed text; make truncation/LLM errors
        // visible even though the final answer was never streamed.
        console.log(`\n${result.answer}\n`);
      }
      logger.debug(
        `[iterations: ${result.iterations}, tools: ${result.toolCalls.length}]`,
      );
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }

    logger.debug(
      `[History: ${agent.historyCount()} msgs, ~${agent.historyTokens()} tokens]`,
    );
    rl.prompt();
  }

  rl.on("close", () => {
    logger.info("Session ended");
    void shutdown();
  });
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
