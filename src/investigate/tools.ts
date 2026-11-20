import * as path from "node:path";
import type { Tool, ToolResult } from "../types.js";
import type { ArtifactStore } from "../context/artifacts.js";
import { detectRepoProfile } from "../repo/profile.js";
import { searchSource } from "./scan.js";
import { analyzeSymbolPython, analyzeSymbolTs } from "./symbols.js";
import { analyzeImpact, repoRelative } from "./analyze.js";
import { selectTests } from "./testmap.js";

const INLINE_LINES = 60;

interface InvestigateContext {
  root: string;
  artifacts?: ArtifactStore;
}

function requireContext(context?: {
  repoRoot?: string;
  artifacts?: ArtifactStore;
}): ToolResult | InvestigateContext {
  if (!context?.repoRoot) {
    return {
      content:
        "Error: no investigation root configured. Provide repoRoot " +
        "(the investigate CLI sets it) or pass a `path` argument.",
      isError: true,
    };
  }
  return { root: context.repoRoot, artifacts: context.artifacts };
}

function resolveRoot(context: InvestigateContext, argsPath?: string): string {
  if (typeof argsPath === "string" && argsPath.trim()) {
    return path.resolve(context.root, argsPath);
  }
  return context.root;
}

function capLines(lines: string[], label: string): string {
  const shown = lines.slice(0, INLINE_LINES);
  const hidden = lines.length - shown.length;
  return (
    shown.join("\n") + (hidden > 0 ? `\n(${hidden} more ${label} omitted)` : "")
  );
}

async function maybePersist(
  context: InvestigateContext,
  kind: string,
  name: string,
  content: string,
): Promise<string> {
  if (!context.artifacts) return "";
  const ref = await context.artifacts.add(kind, name, content);
  return `\nFull result artifact: ${ref.path} (kind=${ref.kind}, sha256=${ref.sha256})`;
}

function accessReqsFor(
  args: Record<string, unknown>,
  context?: { repoRoot?: string },
) {
  // Resolve exactly like resolveRoot in execute(): relative to the configured
  // repo root, defaulting to the repo root itself. process.cwd() is the agent
  // checkout, not the repository under investigation, so using it here made
  // every investigation-tool call fail its own path-permission check.
  const root = context?.repoRoot
    ? path.resolve(context.repoRoot)
    : process.cwd();
  const requested =
    typeof args.path === "string" && args.path.trim()
      ? path.resolve(root, args.path as string)
      : root;
  return [{ path: requested, operation: "read" as const }];
}

export const repoProfileTool: Tool = {
  name: "repo_profile",
  description:
    "Detect the repository profile: languages, package manager, workspaces, frameworks, test runners and build/test/lint commands. Run this first in any change-impact investigation.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Repo root (absolute, or relative to the configured repo root). Defaults to the configured root.",
      },
    },
    required: [],
  },
  accessRequests: accessReqsFor,

  async execute(args, context): Promise<ToolResult> {
    const ctx = requireContext(context);
    if ("content" in ctx) return ctx;
    try {
      const profile = await detectRepoProfile(
        resolveRoot(ctx, typeof args.path === "string" ? args.path : undefined),
      );
      return { content: JSON.stringify(profile, null, 2) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `repo_profile failed: ${msg}`, isError: true };
    }
  },
};

export const searchCodeTool: Tool = {
  name: "search_code",
  description:
    "Search the repository for a text/regex pattern across source files (ripgrep when installed, deterministic Node scan otherwise). Results are capped; the full list is stored as an artifact.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex or plain text to find" },
      glob: {
        type: "string",
        description:
          "Optional filename glob filter, e.g. '**/*.py' or '**/*.ts'",
      },
      max: { type: "number", description: "Max matches (default 200)" },
    },
    required: ["pattern"],
  },
  accessRequests: accessReqsFor,

  async execute(args, context): Promise<ToolResult> {
    const ctx = requireContext(context);
    if ("content" in ctx) return ctx;
    try {
      const pattern = String(args.pattern ?? "");
      if (!pattern.trim()) {
        return {
          content: "search_code requires a non-empty pattern",
          isError: true,
        };
      }
      const max = Number.isFinite(Number(args.max))
        ? Math.trunc(Number(args.max))
        : 200;
      const hits = await searchSource(
        resolveRoot(ctx, typeof args.path === "string" ? args.path : undefined),
        pattern,
        {
          glob: typeof args.glob === "string" ? args.glob : undefined,
          maxMatches: max,
        },
      );
      if (hits.length === 0) {
        return { content: `No matches for pattern: ${pattern}` };
      }
      const lines = hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
      const body =
        `Matched ${hits.length} location(s)${hits.length >= max ? " (hit the match cap)" : ""}:\n` +
        capLines(lines, "matches");
      const artifact = await maybePersist(
        ctx,
        "search",
        `search-${Date.now()}.json`,
        JSON.stringify(hits, null, 2),
      );
      return { content: `${body}${artifact}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `search_code failed: ${msg}`, isError: true };
    }
  },
};

export const findSymbolTool: Tool = {
  name: "find_symbol",
  description:
    "Find the definition and callers/references of a symbol. TypeScript/JavaScript are analyzed structurally (exact); Python is text-heuristic and reports a confidence value. Full details are stored as an artifact.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name to analyze" },
    },
    required: ["symbol"],
  },
  accessRequests: accessReqsFor,

  async execute(args, context): Promise<ToolResult> {
    const ctx = requireContext(context);
    if ("content" in ctx) return ctx;
    try {
      const symbol = String(args.symbol ?? "").trim();
      if (!symbol) {
        return {
          content: "find_symbol requires a non-empty symbol",
          isError: true,
        };
      }
      // TS/JS first when it actually found something; Python report is the
      // best-effort branch and wins when the symbol lives only in .py files.
      const tsReport = await analyzeSymbolTs(resolveRoot(ctx), symbol);
      const pyReport = await analyzeSymbolPython(resolveRoot(ctx), symbol);
      const tsUsable =
        tsReport !== null &&
        (tsReport.definitions.length > 0 || tsReport.references.length > 0);
      const pyUsable =
        pyReport.definitions.length > 0 || pyReport.references.length > 0;
      const report = tsUsable
        ? (tsReport as NonNullable<typeof tsReport>)
        : pyUsable
          ? pyReport
          : (tsReport ?? pyReport);

      const defs = report.definitions.map(
        (d) => `${d.path}:${d.line} ${d.text}`,
      );
      const refs = report.references.map(
        (r) => `${r.path}:${r.line} ${r.text}`,
      );
      const confidenceNote = report.note ? `\nNote: ${report.note}` : "";
      const body =
        `Symbol "${symbol}" (${report.language}, confidence=${report.confidence})\n` +
        `Definitions (${defs.length}):\n${defLengthOrNone(defs)}\n` +
        `References (${refs.length}):\n${capLines(refs, "references")}` +
        confidenceNote;
      const artifact = await maybePersist(
        ctx,
        "search",
        `symbol-${symbol}.json`,
        JSON.stringify(report, null, 2),
      );
      return { content: `${body}${artifact}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `find_symbol failed: ${msg}`, isError: true };
    }
  },
};

function defLengthOrNone(defs: string[]): string {
  const shown = defs.slice(0, 10);
  const hidden = defs.length - shown.length;
  const body = shown.length > 0 ? shown.join("\n") : "(none)";
  return hidden > 0 ? `${body}\n(${hidden} more definitions omitted)` : body;
}

export const impactAnalyzeTool: Tool = {
  name: "impact_analyze",
  description:
    "Build the repository import/dependency graph with dependency-cruiser (whole repo, node_modules excluded): nodes, edges, import cycles, and the direct dependents of the given touched files (files are repo-relative). Full graph is stored as an artifact.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Touched files (relative to repo root) to focus the graph on; omitted = whole repo",
      },
    },
    required: [],
  },
  accessRequests: accessReqsFor,

  async execute(args, context): Promise<ToolResult> {
    const ctx = requireContext(context);
    if ("content" in ctx) return ctx;
    try {
      const files = Array.isArray(args.files)
        ? args.files.filter((f): f is string => typeof f === "string")
        : [];
      const graph = await analyzeImpact(resolveRoot(ctx));

      const touched = new Set(files.map(repoRelative));
      // Repo-wide cycles are only a risk for this change when the change
      // touches a member; unrelated cycles stay in the artifact graph.
      const cycles = graph.cycles.filter(
        (cycle) =>
          touched.size === 0 || cycle.some((n) => touched.has(repoRelative(n))),
      );
      const cycleText =
        cycles.length > 0
          ? cycles.map((c) => `  ↻ ${c.join(" → ")}`).join("\n")
          : touched.size > 0
            ? "  (none among touched files)"
            : "  (none)";
      const dependents = new Map<string, number>();
      for (const edge of graph.edges) {
        if (touched.has(edge.to)) {
          dependents.set(edge.from, (dependents.get(edge.from) ?? 0) + 1);
        }
      }
      const dependentLines =
        dependents.size > 0
          ? [...dependents.keys()].slice(0, 20).join(", ")
          : "";
      const body =
        `Impact graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges\n` +
        `Cycles:\n${cycleText}` +
        (files.length > 0
          ? `\nDirect dependents of touched files: ${dependentLines || "(none found)"}`
          : "");
      const artifact = await maybePersist(
        ctx,
        "graph",
        `impact-${Date.now()}.json`,
        JSON.stringify(graph, null, 2),
      );
      return { content: `${body}${artifact}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `impact_analyze failed: ${msg}`, isError: true };
    }
  },
};

export const testSelectTool: Tool = {
  name: "test_select",
  description:
    "Map touched files to the tests that cover them, preferring the repo's native runner (jest --findRelatedTests / vitest related / pytest package mapping); falls back to a documented content heuristic. Full map is stored as an artifact.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "string" },
        description: "Touched files (relative to repo root)",
      },
    },
    required: ["files"],
  },
  accessRequests: accessReqsFor,

  async execute(args, context): Promise<ToolResult> {
    const ctx = requireContext(context);
    if ("content" in ctx) return ctx;
    try {
      const files = Array.isArray(args.files)
        ? args.files.filter((f): f is string => typeof f === "string")
        : [];
      if (files.length === 0) {
        return {
          content: "test_select requires a non-empty files array",
          isError: true,
        };
      }
      const coverage = await selectTests(resolveRoot(ctx), files);
      const body =
        `Selected tests (${coverage.selectedTests.length}):\n` +
        (coverage.selectedTests.length > 0
          ? capLines(coverage.selectedTests, "tests")
          : "(none)") +
        `\nUncovered touched files: ${coverage.uncovered.join(", ") || "(none)"}` +
        `\nRationale: ${coverage.rationale}`;
      const artifact = await maybePersist(
        ctx,
        "test",
        `coverage-${Date.now()}.json`,
        JSON.stringify(coverage, null, 2),
      );
      return { content: `${body}${artifact}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `test_select failed: ${msg}`, isError: true };
    }
  },
};
