import { cruise } from "dependency-cruiser";
import * as fs from "node:fs/promises";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { ImpactGraph } from "./contracts.js";
import { ImpactGraphSchema } from "./contracts.js";

interface CruiserModule {
  source: string;
  dependencies?: Array<{
    resolved: string;
    dependencyTypes?: string[];
    circular?: boolean;
  }>;
}

interface CruiserResult {
  modules?: CruiserModule[];
}

/** Runs dependency-cruiser and shapes the result into the ImpactGraph contract. */
export async function analyzeImpact(root: string): Promise<ImpactGraph> {
  // dependency-cruiser emits module sources relative to the process cwd (or
  // absolute), not necessarily to the repo root. A repo outside the agent
  // checkout therefore produced ids like "../../private/var/.../src/app.ts"
  // that never matched repo-relative touched files, so the "direct dependents"
  // lookup always came up empty. Cruise the whole repo (reverse edges are what
  // dependents need — cruising only the seeds cannot see them) and normalize
  // every id back to a repo-relative path, symlink-aware.
  const tsConfigPath = path.join(root, "tsconfig.json");
  const options: Record<string, unknown> = {
    outputType: "json",
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
  };
  await stat(tsConfigPath)
    .then((s) => s.isFile())
    .catch(() => false)
    .then((exists) => {
      if (exists) options.tsConfig = { fileName: tsConfigPath };
    });

  const report = await cruise([root], options as Parameters<typeof cruise>[1]);

  const raw: unknown =
    typeof report.output === "string"
      ? JSON.parse(report.output)
      : report.output;
  const result = (raw ?? {}) as CruiserResult;

  const rootAbs = path.resolve(root);
  const rootReal = await fs.realpath(rootAbs).catch(() => rootAbs);
  const rel = (source: string) => {
    const clean = source.split("?")[0].replace(/\\/g, "/");
    const abs = path.isAbsolute(clean)
      ? path.normalize(clean)
      : path.resolve(process.cwd(), clean);
    for (const base of [rootAbs, rootReal]) {
      const candidate = path.relative(base, abs).replace(/\\/g, "/");
      if (
        candidate &&
        !candidate.startsWith("..") &&
        !path.isAbsolute(candidate)
      ) {
        return candidate;
      }
    }
    return clean.replace(/^\.\//, "");
  };

  const nodes = new Map<string, { id: string; path: string; kind: string }>();
  const edges: Array<{ from: string; to: string; kind: string }> = [];

  for (const module of result.modules ?? []) {
    const from = rel(module.source);
    nodes.set(from, { id: from, path: from, kind: "module" });
    for (const dep of module.dependencies ?? []) {
      const to = rel(dep.resolved);
      nodes.set(to, { id: to, path: to, kind: "module" });
      edges.push({
        from,
        to,
        kind: (dep.dependencyTypes ?? []).join("+") || "import",
      });
    }
  }

  const graph: ImpactGraph = ImpactGraphSchema.parse({
    nodes: [...nodes.values()],
    edges,
    cycles: findCycles(edges),
  });
  return graph;
}

/**
 * Normalize a user/model-supplied repo path to the form dependency-cruiser
 * emits (posix separators, no leading "./").
 */
export function repoRelative(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Tarjan-free cycle detection: DFS with a stack, capped at small node counts. */
export function findCycles(
  edges: Array<{ from: string; to: string }>,
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const set = adjacency.get(edge.from) ?? new Set<string>();
    set.add(edge.to);
    adjacency.set(edge.from, set);
  }

  const cycles: string[][] = [];
  const states = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycleKey = (cycle: string[]): string => [...cycle].sort().join("|");

  const seenCycles = new Set<string>();

  const visit = (node: string): void => {
    if (cycles.length >= 10) return; // cap reporting; full graph stays in artifacts
    states.set(node, "visiting");
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const state = states.get(next);
      if (state === "visiting") {
        const startIndex = stack.indexOf(next);
        const cycle = stack.slice(startIndex);
        const key = cycleKey(cycle);
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
          if (cycles.length >= 10) return;
        }
      } else if (state !== "done") {
        visit(next);
      }
    }
    stack.pop();
    states.set(node, "done");
  };

  for (const node of adjacency.keys()) {
    if (!states.has(node)) visit(node);
  }
  return cycles;
}
