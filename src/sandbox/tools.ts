import type { Tool, ToolResult, ToolContext } from "../types.js";
import { config } from "../config.js";
import { COMMAND_KINDS } from "./commands.js";
import { SandboxManager } from "./index.js";
import { buildRiskReport, persistRiskArtifacts } from "./risk.js";

interface SandboxContext {
  manager: SandboxManager;
  artifacts: NonNullable<ToolContext["artifacts"]>;
  repoRoot: string;
}

function requireSandboxContext(
  context?: ToolContext,
): ToolResult | SandboxContext {
  if (!context?.sandbox) {
    return {
      content:
        "Error: no sandbox configured for this session. Run the investigate CLI " +
        "with --sandbox docker|devcontainer|worktree-host (or set SANDBOX_PROVIDER).",
      isError: true,
    };
  }
  if (!context.artifacts) {
    return {
      content:
        "Error: sandbox tools require the investigation artifact store " +
        "(they are wired by the investigate CLI).",
      isError: true,
    };
  }
  return {
    manager: context.sandbox,
    artifacts: context.artifacts,
    repoRoot: context.repoRoot ?? "",
  };
}

function errorResult(label: string, error: unknown): ToolResult {
  const msg = error instanceof Error ? error.message : String(error);
  return { content: `${label} failed: ${msg}`, isError: true };
}

export const sandboxCreateTool: Tool = {
  name: "sandbox_create",
  description:
    "Create the writable sandbox for this investigation: copies the repo into an isolated dir " +
    "(secrets/node_modules/.git excluded), records baseCommit, mounts, network and resource " +
    "limits, and derives the command whitelist (install/build/test/lint) from the repo profile. " +
    "Returns the SandboxSpec, the single source of truth for later sandbox calls.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute(_args, context): Promise<ToolResult> {
    const ctx = requireSandboxContext(context);
    if ("content" in ctx) return ctx;
    try {
      const spec = await ctx.manager.create();
      const capNote =
        spec.provider === "docker"
          ? "Network and CPU/memory caps are Docker-enforced."
          : "Network and CPU/memory caps are NOT Docker-enforced for this provider (disclosed in the spec and report).";
      return {
        content:
          `Sandbox ready (provider=${spec.provider})\n` +
          `Writable root: ${spec.worktreePath}\n` +
          `Base commit: ${ctx.manager.base}\n` +
          `Image: ${spec.image ?? "(provider-managed)"}\n` +
          `Network: ${spec.network}\n` +
          `Limits: ${spec.limits.cpus} CPU(s), ${spec.limits.memory}\n` +
          capNote +
          `\nWhitelisted commands:\n- ${ctx.manager.commandList().join("\n- ")}` +
          `\nSandboxSpec JSON:\n${JSON.stringify(spec, null, 2)}`,
      };
    } catch (error) {
      return errorResult("sandbox_create", error);
    }
  },
};

export const sandboxRunTool: Tool = {
  name: "sandbox_run",
  description:
    "Run a whitelisted command (kind install|build|test|lint, e.g. selected test files as args) " +
    "inside the sandbox with the configured network/resource limits (Docker) and timeout; " +
    "persists stdout/stderr as artifacts and returns the VerificationResult. " +
    "args must be plain tokens: shell metacharacters are rejected.",
  timeoutMs: config.sandbox.timeoutMs,
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...COMMAND_KINDS],
        description: "Which whitelisted command to run (from the SandboxSpec)",
      },
      args: {
        type: "array",
        items: {
          type: "string",
          description: "Extra token (test file path, flag)",
        },
        description:
          'Plain extra tokens appended to the whitelisted base command (default: none). Do not repeat the kind (e.g. args:["test"]); such duplicates are ignored.',
      },
    },
    required: ["kind"],
  },

  async execute(args, context): Promise<ToolResult> {
    const ctx = requireSandboxContext(context);
    if ("content" in ctx) return ctx;
    try {
      const extras = Array.isArray(args.args)
        ? args.args.filter(
            (token): token is string => typeof token === "string",
          )
        : [];
      const result = await ctx.manager.run(String(args.kind ?? ""), extras);
      return {
        content:
          `${result.passed ? "PASS" : "FAIL"} (exitCode=${result.exitCode}, ${result.durationMs}ms)\n` +
          `command: ${result.command}\n` +
          `stdout artifact: ${result.stdout.path} (sha256=${result.stdout.sha256})\n` +
          `stderr artifact: ${result.stderr.path} (sha256=${result.stderr.sha256})`,
      };
    } catch (error) {
      return errorResult("sandbox_run", error);
    }
  },
};

export const writePatchTool: Tool = {
  name: "write_patch",
  description:
    "Validate and apply a unified diff inside the sandbox ONLY (the main repo is never touched). " +
    "Paths must be relative repo files; absolute paths, '..' escapes and .git targets are rejected. " +
    "Returns the PatchDraft with a diff artifact; dryRun true only validates.",
  parameters: {
    type: "object",
    properties: {
      diff: { type: "string", description: "Unified diff to apply" },
      dryRun: {
        type: "boolean",
        description:
          "Validate only; do not modify the sandbox (default: false)",
      },
    },
    required: ["diff"],
  },

  async execute(args, context): Promise<ToolResult> {
    const ctx = requireSandboxContext(context);
    if ("content" in ctx) return ctx;
    const diffText = typeof args.diff === "string" ? args.diff : "";
    if (!diffText.trim()) {
      return { content: "write_patch requires a unified diff", isError: true };
    }
    try {
      const dryRun = Boolean(args.dryRun) && args.dryRun !== "false";
      const applied = await ctx.manager.applyPatch(diffText, dryRun);
      if (dryRun || !applied.draft) {
        return {
          content:
            `Patch check passed; ${applied.files.length} file(s) would change in the sandbox:\n- ` +
            applied.files.join("\n- "),
        };
      }
      const draft = applied.draft;
      return {
        content:
          `Patch applied in sandbox only.\nFiles:\n- ${draft.files.join("\n- ")}\n` +
          `baseCommit: ${draft.baseCommit}\n` +
          `Diff artifact: ${draft.diff.path} (sha256=${draft.diff.sha256})`,
      };
    } catch (error) {
      return errorResult("write_patch", error);
    }
  },
};

export const riskReportTool: Tool = {
  name: "risk_report",
  description:
    "Aggregate an auditable risk report (Markdown + JSON artifacts): sandbox verification " +
    "results, uncovered tests of the touched files, import cycles and caller coverage " +
    "(JS/TS exact; Python heuristics are flagged as limited-confidence). Absent evidence is " +
    "reported as explicit missing-evidence factors instead of being hidden.",
  parameters: {
    type: "object",
    properties: {
      touchedFiles: {
        type: "array",
        items: {
          type: "string",
          description: "Touched file (relative to repo root)",
        },
        description:
          "Files this change touches (from earlier investigation steps)",
      },
    },
    required: [],
  },

  async execute(args, context): Promise<ToolResult> {
    if (!context?.artifacts || !context.repoRoot) {
      return {
        content:
          "risk_report requires the investigation artifact store and repo root " +
          "(they are wired by the investigate CLI).",
        isError: true,
      };
    }
    const touchedFiles = Array.isArray(args.touchedFiles)
      ? args.touchedFiles.filter(
          (file): file is string => typeof file === "string",
        )
      : [];
    try {
      const report = await buildRiskReport({
        repoRoot: context.repoRoot,
        touchedFiles,
        verifications: context.sandbox?.verificationResults ?? [],
      });
      const refs = await persistRiskArtifacts(context.artifacts, report);
      return {
        content:
          `Risk level: ${report.level.toUpperCase()}\n` +
          `${report.summary}\n` +
          `Factors:\n- ${
            report.factors.map((f) => `[${f.kind}] ${f.detail}`).join("\n- ") ||
            "(none)"
          }\n` +
          `Recommendations:\n- ${report.recommendations.join("\n- ") || "(none)"}\n` +
          `Artifacts: ${refs.join(", ")}`,
      };
    } catch (error) {
      return errorResult("risk_report", error);
    }
  },
};
