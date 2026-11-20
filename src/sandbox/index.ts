import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ArtifactRef, ArtifactStore } from "../context/artifacts.js";
import {
  parsePatchDraft,
  parseSandboxSpec,
  parseVerificationResult,
  type ArtifactRefData,
  type PatchDraft,
  type SandboxProvider,
  type SandboxSpec,
  type VerificationResult,
} from "../investigate/contracts.js";
import { detectRepoProfile } from "../repo/profile.js";
import { logger } from "../logger.js";
import {
  COMMAND_KINDS,
  composeCommand,
  commandString,
  deriveAllowedCommands,
  type AllowedCommands,
  type CommandKind,
} from "./commands.js";
import { copyRepo } from "./copy.js";
import {
  buildDockerRunArgs,
  DEFAULT_IMAGE_JS,
  SANDBOX_CONTAINER_PATH,
} from "./docker.js";
import { buildDevcontainerExecArgs } from "./devcontainer.js";
import { execRunner, type CommandRunner } from "./exec.js";
import { extractPatchFiles, validatePatchPaths } from "./patch.js";
import { createWorktree, removeWorktree } from "./worktree.js";

export interface SandboxManagerConfig {
  image?: string;
  network: "off" | "on";
  cpus: number;
  memory: string;
  timeoutMs: number;
}

export interface SandboxManagerOptions {
  repoRoot: string;
  artifacts: ArtifactStore;
  /** Base directory the sandbox run dir is created in (<out>/sandbox). */
  sandboxBase: string;
  /** Requested provider; undefined = auto-detect (devcontainer → docker → worktree). */
  provider?: SandboxProvider;
  /** git worktree fallback requires --unsafe-host-tests. */
  unsafeHostTests?: boolean;
  runner?: CommandRunner;
  config?: Partial<SandboxManagerConfig>;
}

const DEVCONTAINER_PATHS = [
  "devcontainer.json",
  ".devcontainer/devcontainer.json",
];

function toRefData(ref: ArtifactRef): ArtifactRefData {
  return {
    id: ref.id,
    kind: ref.kind,
    path: ref.path,
    size: ref.size,
    sha256: ref.sha256,
  };
}

function runDirName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SandboxManager {
  private readonly runner: CommandRunner;
  private readonly repoRoot: string;
  private readonly artifacts: ArtifactStore;
  private readonly sandboxBase: string;
  private readonly providerRequested?: SandboxProvider;
  private readonly unsafeHostTests: boolean;
  private readonly settings: SandboxManagerConfig;

  private provider?: SandboxProvider;
  private specInstance?: SandboxSpec;
  private baseCommit = "no-git";
  private gitTopLevelProbe?: Promise<boolean>;
  private allowed: AllowedCommands = {};
  private dockerCli = "docker";
  private runSeq = 0;
  readonly verificationResults: VerificationResult[] = [];

  constructor(options: SandboxManagerOptions) {
    this.runner = options.runner ?? execRunner;
    this.repoRoot = path.resolve(options.repoRoot);
    this.artifacts = options.artifacts;
    this.sandboxBase = path.resolve(options.sandboxBase);
    this.providerRequested = options.provider;
    this.unsafeHostTests = options.unsafeHostTests === true;
    this.settings = {
      image: options.config?.image,
      network: options.config?.network ?? "off",
      cpus: options.config?.cpus ?? 2,
      memory: options.config?.memory ?? "2g",
      timeoutMs: options.config?.timeoutMs ?? 600_000,
    };
  }

  /** True between create() and dispose(); read after awaiting create(). */
  get created(): boolean {
    return this.provider !== undefined;
  }

  get providerName(): SandboxProvider | undefined {
    return this.provider;
  }

  get spec(): SandboxSpec | undefined {
    return this.specInstance;
  }

  get base(): string {
    return this.baseCommit;
  }

  /** Whitelisted commands for display: "kind: command" lines. */
  commandList(): string[] {
    return COMMAND_KINDS.filter((kind) => this.allowed[kind]).map(
      (kind) => `${kind}: ${commandString(this.allowed[kind]!)}`,
    );
  }

  /** Plain whitelist strings kept in SandboxSpec.allowedCommands. */
  allowedCommandStrings(): string[] {
    return COMMAND_KINDS.filter((kind) => this.allowed[kind]).map((kind) =>
      commandString(this.allowed[kind]!),
    );
  }

  private async get(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) {
    return this.runner(command, args, { cwd, timeoutMs });
  }

  /**
   * True only when repoRoot is itself the top level of a git working tree.
   * `rev-parse --git-dir` succeeds inside any subdirectory of another
   * repository (it resolves to the parent's .git), which would silently drive
   * a worktree of the parent checkout — e.g. investigating fixtures/scenario-a
   * inside the agent repo. Compare --show-toplevel instead (realpath-aware, so
   * symlinked temp dirs still match).
   */
  private isGitTopLevel(): Promise<boolean> {
    this.gitTopLevelProbe ??= this.probeGitTopLevel();
    return this.gitTopLevelProbe;
  }

  private async probeGitTopLevel(): Promise<boolean> {
    const result = await this.get(
      "git",
      ["-C", this.repoRoot, "rev-parse", "--show-toplevel"],
      this.repoRoot,
      10_000,
    );
    if (result.exitCode !== 0) return false;
    const reported = result.stdout.trim();
    if (!reported) return false;
    const [reportedReal, repoReal] = await Promise.all([
      fs.realpath(reported).catch(() => path.resolve(reported)),
      fs.realpath(this.repoRoot).catch(() => this.repoRoot),
    ]);
    return reportedReal === repoReal;
  }

  private async devcontainerPathExists(): Promise<boolean> {
    for (const rel of DEVCONTAINER_PATHS) {
      const info = await fs
        .stat(path.join(this.repoRoot, rel))
        .catch(() => null);
      if (info?.isFile()) return true;
    }
    return false;
  }

  private async devcontainersCliAvailable(): Promise<boolean> {
    const probe = await this.get(
      "npx",
      ["--yes", "@devcontainers/cli", "--version"],
      this.repoRoot,
      30_000,
    );
    return probe.exitCode === 0;
  }

  private async dockerProbe(cli: string): Promise<boolean> {
    try {
      const probe = await this.get(
        cli,
        ["version", "--format", "json"],
        this.repoRoot,
        10_000,
      );
      return probe.exitCode === 0;
    } catch {
      return false;
    }
  }

  async detectProvider(): Promise<SandboxProvider> {
    if (this.providerRequested) {
      const requested = this.providerRequested;
      if (requested === "devcontainer") {
        if (!(await this.devcontainerPathExists())) {
          throw new Error(
            "Requested provider devcontainer but no devcontainer.json found in the repo",
          );
        }
        if (!(await this.devcontainersCliAvailable())) {
          throw new Error(
            "Requested provider devcontainer but the devcontainers CLI is unavailable",
          );
        }
        return "devcontainer";
      }
      if (requested === "docker") {
        if (await this.dockerProbe("docker")) {
          this.dockerCli = "docker";
          return "docker";
        }
        if (await this.dockerProbe("podman")) {
          this.dockerCli = "podman";
          return "docker";
        }
        throw new Error(
          "Requested provider docker but neither docker nor podman is available",
        );
      }
      if (!this.unsafeHostTests) {
        throw new Error(
          "worktree-host execution requires --unsafe-host-tests (process isolation is not provided)",
        );
      }
      if (!(await this.isGitTopLevel())) {
        throw new Error(
          "worktree-host requires the repository root to be its own git working tree " +
            "(a repository nested inside another git checkout does not qualify; " +
            "git init the target or point --repo at a standalone clone)",
        );
      }
      return "worktree-host";
    }

    if (
      (await this.devcontainerPathExists()) &&
      (await this.devcontainersCliAvailable())
    ) {
      return "devcontainer";
    }
    if (await this.dockerProbe("docker")) {
      this.dockerCli = "docker";
      return "docker";
    }
    if (await this.dockerProbe("podman")) {
      this.dockerCli = "podman";
      return "docker";
    }
    if (this.unsafeHostTests && (await this.isGitTopLevel())) {
      return "worktree-host";
    }
    throw new Error(
      "No sandbox provider available: install Docker/Podman, add a devcontainer.json, " +
        "or pass --unsafe-host-tests with a git repository for the worktree fallback",
    );
  }

  private async ensureImage(image: string): Promise<void> {
    const inspect = await this.get(
      this.dockerCli,
      ["image", "inspect", image],
      this.repoRoot,
      30_000,
    );
    if (inspect.exitCode === 0) return;
    logger.info(`Pulling sandbox image ${image}`);
    const pull = await this.get(
      this.dockerCli,
      ["pull", image],
      this.repoRoot,
      300_000,
    );
    if (pull.exitCode !== 0) {
      throw new Error(
        `Sandbox image ${image} unavailable: ${pull.stderr.trim() || pull.stdout.trim()}`,
      );
    }
  }

  /** Resolve HEAD (or "no-git") before anything mutates the copy. */
  private async resolveBaseCommit(): Promise<string> {
    if (!(await this.isGitTopLevel())) return "no-git";
    const result = await this.get(
      "git",
      ["-C", this.repoRoot, "rev-parse", "HEAD"],
      this.repoRoot,
      10_000,
    );
    return result.exitCode === 0 ? result.stdout.trim() : "no-git";
  }

  async create(): Promise<SandboxSpec> {
    if (this.specInstance) return this.specInstance;
    const provider = await this.detectProvider();
    this.provider = provider;
    this.baseCommit = await this.resolveBaseCommit();
    const profile = await detectRepoProfile(this.repoRoot);
    this.allowed = deriveAllowedCommands(profile);

    const worktreePath = path.join(this.sandboxBase, runDirName());
    await fs.mkdir(this.sandboxBase, { recursive: true });
    if (provider === "worktree-host") {
      if (this.baseCommit === "no-git") {
        this.provider = undefined;
        throw new Error(
          "worktree-host requires a git repository with at least one commit",
        );
      }
      await createWorktree(
        this.runner,
        this.repoRoot,
        worktreePath,
        this.baseCommit,
      );
    } else {
      const copied = await copyRepo(this.repoRoot, worktreePath);
      logger.debug(`Sandbox copy: ${copied} entries (${worktreePath})`);
      const gitInit = await this.get(
        "git",
        ["init", "-q"],
        worktreePath,
        15_000,
      );
      if (gitInit.exitCode !== 0) {
        this.provider = undefined;
        throw new Error(
          `git init in sandbox copy failed: ${gitInit.stderr.trim()}`,
        );
      }
      if (provider === "docker") {
        await this.ensureImage(this.settings.image ?? DEFAULT_IMAGE_JS);
      }
    }

    const mounts =
      provider === "docker"
        ? [
            { source: this.repoRoot, target: "/repo", readOnly: true },
            { source: worktreePath, target: "/workspace", readOnly: false },
          ]
        : [];
    const image =
      provider === "docker" ? (this.settings.image ?? DEFAULT_IMAGE_JS) : null;
    // Docker enforce network/resource caps; devcontainers/cli manages its own
    // mounts and network, and the worktree fallback runs on the host: the spec
    // records what is actually enforced so audits cannot be fooled.
    const network = provider === "docker" ? this.settings.network : "on";
    // Fixed env allowlist, built inside the container semantics (CI plus the
    // container PATH that resolves sandbox-installed binaries). Never passes
    // through the host process environment.
    const env =
      provider === "docker"
        ? { CI: "1", PATH: SANDBOX_CONTAINER_PATH }
        : { CI: "1" };

    const spec = parseSandboxSpec({
      provider,
      worktreePath,
      repoRoot: this.repoRoot,
      mounts,
      env,
      allowedCommands: this.allowedCommandStrings(),
      image,
      network,
      limits: { cpus: this.settings.cpus, memory: this.settings.memory },
    });
    this.specInstance = spec;
    return spec;
  }

  async run(
    commandKind: string,
    extraTokens: string[],
  ): Promise<VerificationResult> {
    if (!this.specInstance || !this.provider) {
      throw new Error("sandbox not created yet (call sandbox_create first)");
    }
    const kind = commandKind as CommandKind;
    const composed = composeCommand(kind, extraTokens, this.allowed);
    let command = "";
    let args: string[] = [];
    let cwd = this.repoRoot;
    if (this.provider === "docker") {
      command = this.dockerCli;
      args = buildDockerRunArgs({
        image: this.specInstance.image!,
        mounts: this.specInstance.mounts,
        env: this.specInstance.env,
        network: this.specInstance.network,
        cpus: this.specInstance.limits.cpus,
        memory: this.specInstance.limits.memory,
        workdir: "/workspace",
        commandTokens: composed.tokens,
      });
    } else if (this.provider === "devcontainer") {
      command = "npx";
      args = buildDevcontainerExecArgs(
        this.specInstance.worktreePath,
        composed.tokens,
      );
    } else {
      command = composed.tokens[0];
      args = composed.tokens.slice(1);
      cwd = this.specInstance.worktreePath;
    }

    const started = Date.now();
    const output = await this.runner(command, args, {
      cwd,
      timeoutMs: this.settings.timeoutMs,
      // Host execution only: resolve binaries installed into the worktree (the
      // worktree has no node_modules until install runs) before the inherited
      // host PATH, mirroring the container PATH used for docker runs.
      env:
        this.provider === "worktree-host"
          ? {
              PATH: [
                path.join(
                  this.specInstance.worktreePath,
                  "node_modules",
                  ".bin",
                ),
                process.env.PATH ?? "",
              ].join(path.delimiter),
            }
          : undefined,
    });
    const durationMs = Date.now() - started;
    this.runSeq += 1;
    const stdoutRef = await this.artifacts.add(
      "log",
      `run-${this.runSeq}-${kind}-stdout.log`,
      output.stdout,
    );
    const stderrRef = await this.artifacts.add(
      "log",
      `run-${this.runSeq}-${kind}-stderr.log`,
      output.stderr,
    );
    const result = parseVerificationResult({
      command: composed.display,
      exitCode: output.exitCode,
      durationMs,
      stdout: toRefData(stdoutRef),
      stderr: toRefData(stderrRef),
      passed: output.exitCode === 0,
    });
    this.verificationResults.push(result);
    return result;
  }

  async applyPatch(
    diffTextInput: string,
    dryRun: boolean,
  ): Promise<{ draft?: PatchDraft; files: string[] }> {
    if (!this.specInstance) {
      throw new Error("sandbox not created yet (call sandbox_create first)");
    }
    // git apply requires every patch to end with a newline; agent-produced
    // diffs regularly lose the trailing one in transport.
    const diffText = diffTextInput.endsWith("\n")
      ? diffTextInput
      : `${diffTextInput}\n`;
    const files = extractPatchFiles(diffText);
    if (files.length === 0) {
      throw new Error(
        "Patch must target at least one file via ---/+++ headers",
      );
    }
    validatePatchPaths(diffText);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const patchFile = path.join(this.sandboxBase, `incoming-${stamp}.patch`);
    await fs.writeFile(patchFile, diffText, "utf-8");

    const applyArgs = [patchFile];
    const check = await this.get(
      "git",
      ["apply", "--check", "--whitespace=nowarn", ...applyArgs],
      this.specInstance.worktreePath,
      30_000,
    );
    if (check.exitCode !== 0) {
      await fs.rm(patchFile, { force: true });
      throw new Error(
        `git apply --check failed: ${(check.stderr || check.stdout).trim() || "unknown error"}`,
      );
    }
    if (dryRun) {
      await fs.rm(patchFile, { force: true });
      return { files };
    }
    const apply = await this.get(
      "git",
      ["apply", "--whitespace=nowarn", ...applyArgs],
      this.specInstance.worktreePath,
      30_000,
    );
    await fs.rm(patchFile, { force: true });
    if (apply.exitCode !== 0) {
      throw new Error(
        `git apply failed: ${(apply.stderr || apply.stdout).trim() || "unknown error"}`,
      );
    }
    const diffRef = await this.artifacts.add(
      "diff",
      `patch-${stamp}.diff`,
      diffText,
    );
    const draft = parsePatchDraft({
      format: "unified",
      diff: toRefData(diffRef),
      files,
      baseCommit: this.baseCommit,
    });
    return { draft, files };
  }

  /** Best-effort cleanup (worktree only); sandbox copies stay on disk as evidence. */
  async dispose(): Promise<void> {
    if (this.provider === "worktree-host" && this.specInstance) {
      try {
        await removeWorktree(
          this.runner,
          this.repoRoot,
          this.specInstance.worktreePath,
        );
      } catch (error) {
        logger.debug(
          `Worktree cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
