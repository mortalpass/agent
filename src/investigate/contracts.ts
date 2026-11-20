import { z } from "zod";

export const LanguageSchema = z.enum(["typescript", "javascript", "python"]);

export const RepoProfileSchema = z.object({
  root: z.string(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).nullish(),
  languages: z.array(LanguageSchema).nonempty(),
  workspaces: z.array(z.string()),
  frameworks: z.array(z.string()),
  testRunners: z.array(z.string()),
  commands: z.object({
    install: z.string().nullish(),
    build: z.string().nullish(),
    test: z.string().nullish(),
    lint: z.string().nullish(),
  }),
});

export type RepoProfile = z.infer<typeof RepoProfileSchema>;

export const ImpactGraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      kind: z.string(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: z.string(),
    }),
  ),
  cycles: z.array(z.array(z.string())),
});

export type ImpactGraph = z.infer<typeof ImpactGraphSchema>;

export const CoverageMapSchema = z.object({
  touchedFiles: z.array(z.string()),
  selectedTests: z.array(z.string()),
  uncovered: z.array(z.string()),
  rationale: z.string(),
});

export type CoverageMap = z.infer<typeof CoverageMapSchema>;

export const SandboxProviderSchema = z.enum([
  "devcontainer",
  "docker",
  "worktree-host",
]);

export type SandboxProvider = z.infer<typeof SandboxProviderSchema>;

/** Mirrors ArtifactRef from src/context/artifacts.ts (kept decoupled). */
export const ArtifactRefDataSchema = z.object({
  id: z.string(),
  kind: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

export type ArtifactRefData = z.infer<typeof ArtifactRefDataSchema>;

export const SandboxMountSchema = z.object({
  source: z.string(),
  target: z.string(),
  readOnly: z.boolean(),
});

export type SandboxMount = z.infer<typeof SandboxMountSchema>;

export const SandboxSpecSchema = z.object({
  provider: SandboxProviderSchema,
  /** Writable sandbox root on the host (copy dir, or a git worktree). */
  worktreePath: z.string().min(1),
  repoRoot: z.string(),
  mounts: z.array(SandboxMountSchema),
  env: z.record(z.string(), z.string()),
  allowedCommands: z.array(z.string()),
  image: z.string().nullish(),
  network: z.enum(["off", "on"]),
  limits: z.object({
    cpus: z.number().positive(),
    memory: z.string(),
  }),
});

export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

export const PatchDraftSchema = z.object({
  format: z.enum(["unified", "files"]),
  diff: ArtifactRefDataSchema,
  files: z.array(z.string()),
  baseCommit: z.string(),
});

export type PatchDraft = z.infer<typeof PatchDraftSchema>;

export const VerificationResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stdout: ArtifactRefDataSchema,
  stderr: ArtifactRefDataSchema,
  passed: z.boolean(),
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const RiskFactorKindSchema = z.enum([
  "failed-test",
  "uncovered-test",
  "uncovered-caller",
  "import-cycle",
  "limited-confidence",
  "missing-evidence",
]);

export type RiskFactorKind = z.infer<typeof RiskFactorKindSchema>;

export const RiskFactorSchema = z.object({
  kind: RiskFactorKindSchema,
  detail: z.string(),
  source: z.string().nullish(),
});

export type RiskFactor = z.infer<typeof RiskFactorSchema>;

export const RiskReportSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  factors: z.array(RiskFactorSchema),
  recommendations: z.array(z.string()),
});

export type RiskReport = z.infer<typeof RiskReportSchema>;

/**
 * LLM tool output is untrusted; every investigation tool result that feeds
 * another phase is re-validated via these helpers instead of cast blindly.
 */
export function parseRepoProfile(raw: unknown): RepoProfile {
  return RepoProfileSchema.parse(raw);
}

export function parseSandboxSpec(raw: unknown): SandboxSpec {
  return SandboxSpecSchema.parse(raw);
}

export function parsePatchDraft(raw: unknown): PatchDraft {
  return PatchDraftSchema.parse(raw);
}

export function parseVerificationResult(raw: unknown): VerificationResult {
  return VerificationResultSchema.parse(raw);
}

export function parseRiskReport(raw: unknown): RiskReport {
  return RiskReportSchema.parse(raw);
}
