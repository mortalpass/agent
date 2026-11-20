import { Command } from "commander";
import * as path from "node:path";
import { Agent } from "../agent.js";
import { ArtifactStore } from "../context/artifacts.js";
import { buildInvestigationPathAccess } from "../investigate/access.js";
import { formatPlan } from "../planner.js";
import type { AgentEvent } from "../events.js";
import type { AgentHooks } from "../types.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { SandboxManager } from "../sandbox/index.js";
import { MEMORY_PATTERN } from "../sandbox/docker.js";
import type { SandboxProvider } from "../investigate/contracts.js";

const SANDBOX_PROVIDERS: SandboxProvider[] = [
  "docker",
  "devcontainer",
  "worktree-host",
];

const INVESTIGATION_SYSTEM_PROMPT = `You are a change-impact investigation agent. Given a change intent, you produce an auditable impact report for a mixed TypeScript/JavaScript + Python repository.

Workflow (use the investigation tools):
1. repo_profile — confirm languages, test runners and commands.
2. search_code / find_symbol — discover touchpoints (imports, definitions, references).
3. impact_analyze — build the dependency graph for touched files; note import cycles.
4. test_select — map touched files to tests (native runner first).
5. update_plan — maintain a visible checklist of your investigation steps.
Sandbox stages (when a sandbox is configured):
6. sandbox_create — create the writable sandbox; read the SandboxSpec it returns.
7. write_patch — draft diffs ONLY there (unified diff, relative paths); dryRun first when unsure.
8. sandbox_run — run whitelisted commands (install/build/test/lint) and read the VerificationResult.
9. risk_report — aggregate verification results, uncovered tests, cycles and limitations.

Rules:
- The repository under investigation is READ-ONLY. Never write outside the sandbox; writes go through write_patch into the sandbox copy only.
- sandbox_run accepts only whitelisted kinds (install/build/test/lint) with plain tokens — no shell syntax.
- Relative paths resolve against the repository under investigation (e.g. read_file("package.json") and list_files(".") mean inside it).
- rag_query is optional: if the RAG service is unavailable, note it once and continue with the local repository analysis.
- Report Python-side findings with their confidence (text-heuristic, not exact).
- Keep tool outputs summarized; full results are persisted as artifacts automatically.
- End with risk_report (or a risk draft if no sandbox is configured): impact size, uncovered callers/tests, cycles, verification status. State clearly if evidence is missing.`;

function buildDryRunHooks(): AgentHooks {
  const gated = new Set(["sandbox_create", "sandbox_run", "write_patch"]);
  return {
    beforeToolCall: (request) => {
      if (gated.has(request.tool)) {
        return {
          deny: true,
          reason:
            "--dry-run keeps this pass read-only (no sandbox writes or command execution)",
        };
      }
      return undefined;
    },
  };
}

function printEvent(agent: Agent, event: AgentEvent): void {
  switch (event.type) {
    case "message_update":
      process.stdout.write(event.content);
      break;
    case "tool_execution_start":
      console.log(`\n[tool] ${event.name}(${event.args.slice(0, 80)})`);
      break;
    case "tool_execution_end": {
      const preview =
        event.result.content.length > 200
          ? event.result.content.slice(0, 200) + "..."
          : event.result.content;
      console.log(preview);
      break;
    }
    case "agent_end": {
      const plan = agent.getPlan();
      if (plan) console.log(`\nPlan:\n${formatPlan(plan)}`);
      console.log(`\n${event.answer}`);
      break;
    }
    default:
      break;
  }
}

export async function runInvestigateCli(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const program = new Command();
  program
    .name("investigate")
    .description(
      "Change-impact investigation agent (sandbox, patch, verify, risk)",
    )
    .requiredOption("--repo <path>", "repository under investigation")
    .requiredOption("--intent <text>", "change intent to investigate")
    .option("--out <dir>", "artifact output directory", "investigations")
    .option("--sandbox <provider>", "docker|devcontainer|worktree-host")
    .option(
      "--unsafe-host-tests",
      "allow the git-worktree + host fallback (no process isolation)",
    )
    .option("--format <format>", "markdown|json", "markdown")
    .option(
      "--dry-run",
      "read-only pass: sandbox writes and command execution are vetoed",
    );

  const options = program.parse(argv, { from: "user" }).opts<{
    repo: string;
    intent: string;
    out: string;
    sandbox?: string;
    unsafeHostTests?: boolean;
    format: string;
    dryRun?: boolean;
  }>();

  const sandboxProvider = (options.sandbox ??
    config.sandbox.provider) as string;
  if (
    sandboxProvider &&
    !SANDBOX_PROVIDERS.includes(sandboxProvider as SandboxProvider)
  ) {
    throw new Error(
      `Invalid sandbox provider "${sandboxProvider}" (expected: ${SANDBOX_PROVIDERS.join("|")})`,
    );
  }
  if (sandboxProvider === "worktree-host" && !options.unsafeHostTests) {
    throw new Error(
      "--sandbox worktree-host requires --unsafe-host-tests (host execution is not isolated)",
    );
  }
  if (!MEMORY_PATTERN.test(config.sandbox.memory)) {
    throw new Error(
      `Invalid SANDBOX_MEMORY "${config.sandbox.memory}" (expected e.g. 2g)`,
    );
  }

  const repoRoot = path.resolve(options.repo);
  const outRoot = path.resolve(options.out);
  const artifacts = await ArtifactStore.create(outRoot);
  logger.info(`Investigating ${repoRoot}; artifacts in ${artifacts.root}`);

  let sandbox: SandboxManager | undefined;
  if (sandboxProvider) {
    sandbox = new SandboxManager({
      repoRoot,
      artifacts,
      sandboxBase: path.join(outRoot, "sandbox"),
      provider: sandboxProvider as SandboxProvider,
      unsafeHostTests: options.unsafeHostTests === true,
      config: {
        image: config.sandbox.image || undefined,
        network: config.sandbox.network as "on" | "off",
        cpus: config.sandbox.cpus,
        memory: config.sandbox.memory,
        timeoutMs: config.sandbox.timeoutMs,
      },
    });
  }

  const agent = new Agent(
    INVESTIGATION_SYSTEM_PROMPT,
    config.llm.contextTokens,
    {
      repoRoot,
      artifacts,
      sandbox,
      pathAccess: buildInvestigationPathAccess(repoRoot, outRoot),
      hooks: options.dryRun ? buildDryRunHooks() : undefined,
    },
  );
  agent.subscribe((event) => printEvent(agent, event));

  try {
    const result = await agent.run(options.intent, undefined);
    console.log(
      `\nInvestigation finished in ${result.iterations} iteration(s); ` +
        `${artifacts.list().length} artifact(s) written.`,
    );
  } finally {
    await sandbox?.dispose();
  }
}

const isMainModule = import.meta.url.endsWith(
  path.basename(process.argv[1] ?? ""),
);
if (isMainModule) {
  runInvestigateCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
