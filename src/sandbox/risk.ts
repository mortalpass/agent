import type { ArtifactStore } from "../context/artifacts.js";
import type {
  RiskFactor,
  RiskFactorKind,
  RiskReport,
  VerificationResult,
} from "../investigate/contracts.js";
import { parseRiskReport } from "../investigate/contracts.js";
import { analyzeImpact, repoRelative } from "../investigate/analyze.js";
import { selectTests } from "../investigate/testmap.js";

export interface RiskInput {
  repoRoot: string;
  touchedFiles: string[];
  verifications: VerificationResult[];
}

const RECOMMENDATIONS: Record<RiskFactorKind, string> = {
  "failed-test":
    "Fix and rerun the failing sandbox command before proposing the patch beyond the sandbox.",
  "missing-evidence":
    "Run the selected tests in the sandbox to close the verification gap.",
  "uncovered-test":
    "Manually inspect uncovered touched files; add targeted tests where risk is high.",
  "uncovered-caller":
    "Search for dynamic callers (reflection, imports by string) the static graph cannot see.",
  "import-cycle":
    "Consider breaking the import cycle before merging; cycles make review uncertain.",
  "limited-confidence":
    "Spot-check the Python-side callers manually; the analysis is text-based best effort.",
};

/**
 * Deterministic aggregation (spec 4.10): impact size, uncovered callers/tests,
 * failed runs, cycles, language limitations. Evidence is never invented —
 * missing inputs surface as explicit missing-evidence factors.
 */
export async function buildRiskReport(input: RiskInput): Promise<RiskReport> {
  const factors: RiskFactor[] = [];
  const { repoRoot, touchedFiles, verifications } = input;

  const failed = verifications.filter((v) => !v.passed);
  for (const run of failed) {
    factors.push({
      kind: "failed-test",
      detail: `${run.command} exited ${run.exitCode} in ${run.durationMs}ms (stdout/stderr artifacts captured)`,
      source: "sandbox_run",
    });
  }
  if (verifications.length === 0) {
    factors.push({
      kind: "missing-evidence",
      detail: "No verification command ran in the sandbox this session.",
      source: "sandbox",
    });
  }

  let impactSummary = "";
  let uncoveredSummary = "";
  if (touchedFiles.length > 0) {
    try {
      const coverage = await selectTests(repoRoot, touchedFiles);
      if (coverage.uncovered.length > 0) {
        factors.push({
          kind: "uncovered-test",
          detail: `Uncovered touched files: ${coverage.uncovered.join(", ")}`,
          source: "test_select",
        });
      }
      uncoveredSummary =
        `${coverage.selectedTests.length} selected test(s), ` +
        `${coverage.uncovered.length} uncovered touched file(s)`;
    } catch (error) {
      factors.push({
        kind: "missing-evidence",
        detail: `Test selection failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "test_select",
      });
    }
    try {
      const graph = await analyzeImpact(repoRoot);
      const touched = new Set(touchedFiles.map(repoRelative));
      const relevantCycles = graph.cycles.filter((cycle) =>
        cycle.some((node) => touched.has(repoRelative(node))),
      );
      if (relevantCycles.length > 0) {
        factors.push({
          kind: "import-cycle",
          detail: relevantCycles
            .slice(0, 10)
            .map((cycle) => cycle.join(" -> "))
            .join("; "),
          source: "impact_analyze",
        });
      }
      const dependents = new Set(
        graph.edges
          .filter((edge) => touched.has(edge.to))
          .map((edge) => edge.from),
      );
      if (dependents.size === 0) {
        factors.push({
          kind: "uncovered-caller",
          detail: `No direct dependents found for ${touchedFiles.join(", ")}; confirm entry points manually.`,
          source: "impact_analyze",
        });
      }
      impactSummary = `${graph.nodes.length} node(s)/${graph.edges.length} edge(s) in the touched-file graph`;
    } catch (error) {
      factors.push({
        kind: "missing-evidence",
        detail: `Impact analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        source: "impact_analyze",
      });
    }
    if (touchedFiles.some((file) => file.endsWith(".py"))) {
      factors.push({
        kind: "limited-confidence",
        detail:
          "Sample touched files are Python; caller analysis is text-heuristic (confidence < 1), not exhaustive.",
        source: "limitation",
      });
    }
  } else {
    factors.push({
      kind: "missing-evidence",
      detail:
        "No touched files provided; scope relies on prior investigation artifacts only.",
      source: "investigation",
    });
  }

  // Unverified = high (missing evidence is not a clean bill of health);
  // any failed run is high; medium is reserved for scope/coverage risks.
  const level = hasRiskFactor(factors, "missing-evidence", "failed-test")
    ? "high"
    : factors.length > 0
      ? "medium"
      : "low";
  const passedCount = verifications.length - failed.length;
  const summary =
    `${impactSummary ? `${impactSummary}; ` : ""}` +
    `${uncoveredSummary ? `${uncoveredSummary}; ` : ""}` +
    `${verifications.length} sandbox run(s) (${passedCount} passed, ${failed.length} failed); ` +
    `${factors.length} risk factor(s).`;

  const recommendations = [
    ...new Set(
      factors.map((factor) => RECOMMENDATIONS[factor.kind]).filter(Boolean),
    ),
  ];

  return parseRiskReport({ level, summary, factors, recommendations });
}

function hasRiskFactor(factors: RiskFactor[], ...kinds: string[]): boolean {
  return factors.some((factor) => kinds.includes(factor.kind));
}

export function renderRiskMarkdown(report: RiskReport): string {
  const lines = [
    `# Risk report (level: ${report.level})`,
    "",
    report.summary,
    "",
    "## Factors",
    ...report.factors.map(
      (factor) =>
        `- [${factor.kind}] ${factor.detail}${factor.source ? ` (source: ${factor.source})` : ""}`,
    ),
    "",
    "## Recommendations",
    ...report.recommendations.map((item) => `- ${item}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function persistRiskArtifacts(
  artifacts: ArtifactStore,
  report: RiskReport,
): Promise<string[]> {
  const markdown = await artifacts.add(
    "report",
    "risk-report.md",
    renderRiskMarkdown(report),
  );
  const json = await artifacts.add(
    "report",
    "risk-report.json",
    JSON.stringify(report, null, 2),
  );
  return [markdown.path, json.path];
}
