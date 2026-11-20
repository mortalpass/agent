import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../src/context/artifacts.js";
import type { RepoProfile } from "../src/investigate/contracts.js";
import { detectRepoProfile } from "../src/repo/profile.js";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import {
  COMMAND_KINDS,
  composeCommand,
  deriveAllowedCommands,
} from "../src/sandbox/commands.js";
import { buildDockerRunArgs, MEMORY_PATTERN } from "../src/sandbox/docker.js";
import { buildDevcontainerExecArgs } from "../src/sandbox/devcontainer.js";
import { SandboxManager } from "../src/sandbox/index.js";
import { extractPatchFiles, validatePatchPaths } from "../src/sandbox/patch.js";
import { buildRiskReport } from "../src/sandbox/risk.js";
import { execRunner } from "../src/sandbox/exec.js";
import type { CommandOutput, CommandRunner } from "../src/sandbox/exec.js";

const registry = createDefaultRegistry();

/**
 * Deterministic fake runner: every call is recorded as "cmd args";
 * the handler may override the default success. When `gitRoot` is given, a
 * `rev-parse --show-toplevel` probe reports that root so the sandbox treats
 * the fixture as a standalone git working tree.
 */
function fakeRunner(
  record: string[],
  handler?: (cmd: string, args: string[]) => CommandOutput | undefined,
  gitRoot?: string,
): CommandRunner {
  return async (cmd, args) => {
    record.push(`${cmd} ${args.join(" ")}`);
    const handled = handler?.(cmd, args);
    if (handled) return handled;
    if (gitRoot && cmd === "git" && args.includes("--show-toplevel")) {
      return { exitCode: 0, stdout: `${gitRoot}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

const failJest = (): CommandOutput => ({
  exitCode: 1,
  stdout: "3 failing",
  stderr: "boom",
});

async function makeRepo(withDevcontainer = false): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sbox-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        devDependencies: { jest: "^29.0.0" },
        scripts: { test: "jest", build: "tsc", lint: "_biome" },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, name: "fixture", version: "1.0.0" }),
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "util.ts"),
    "export function formatName(name: string): string {\n  return name.trim();\n}\n",
  );
  await fs.writeFile(
    path.join(root, "src", "util.test.ts"),
    'import { formatName } from "./util.js";\n\ntest("trims", () => expect(formatName(" x ")).toBe("x"));\n',
  );
  await fs.mkdir(path.join(root, "pkg"), { recursive: true });
  await fs.writeFile(
    path.join(root, "pkg", "mod.py"),
    "def frobnicate(x):\n    return x * 2\n",
  );
  if (withDevcontainer) {
    await fs.writeFile(
      path.join(root, "devcontainer.json"),
      JSON.stringify({ image: "node:20" }),
    );
  }
  return root;
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    id: "c1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

const SAMPLE_DIFF =
  [
    "--- a/src/util.ts",
    "+++ b/src/util.ts",
    "@@ -1,3 +1,3 @@",
    " export function formatName(name: string): string {",
    "-  return name.trim();",
    "+  return name.trim().toLowerCase();",
    " }",
  ].join("\n") + "\n";

test("composeCommand enforces the whitelist and rejects unsafe tokens", () => {
  const allowed = deriveAllowedCommands({
    root: "/fixture",
    packageManager: "npm",
    languages: ["typescript"],
    workspaces: [],
    frameworks: [],
    testRunners: ["jest"],
    commands: { build: "tsc .", test: "jest --silent" },
  } satisfies RepoProfile);

  const composed = composeCommand("test", ["src/util.test.ts"], allowed);
  assert.deepEqual(composed.tokens, ["jest", "--silent", "src/util.test.ts"]);
  assert.equal(composed.display, "jest --silent src/util.test.ts");
  assert.deepEqual(composeCommand("install", [], allowed).tokens, [
    "npm",
    "install",
  ]);
  // Models repeat the kind in args; it must not corrupt the argv.
  assert.deepEqual(composeCommand("install", ["install"], allowed).tokens, [
    "npm",
    "install",
  ]);
  assert.deepEqual(composeCommand("build", ["build"], allowed).tokens, [
    "tsc",
    ".",
  ]);

  const noInstall = deriveAllowedCommands({
    root: "/fixture",
    packageManager: null,
    languages: ["typescript"],
    workspaces: [],
    frameworks: [],
    testRunners: [],
    commands: {},
  } satisfies RepoProfile);
  assert.throws(
    () => composeCommand("install", [], noInstall),
    /not whitelisted/,
  );
  const lintMissing = noInstall;
  assert.throws(
    () => composeCommand("build", ["a.ts; rm -rf /"], allowed),
    /Unsafe token/,
  );
  assert.throws(
    () =>
      composeCommand(
        "build",
        Array.from({ length: 65 }, () => "x"),
        allowed,
      ),
    /Too many extra tokens/,
  );
  assert.equal(COMMAND_KINDS.length, 4);
});

test("MEMORY_PATTERN accepts docker size suffixes only", () => {
  assert.match("2g", MEMORY_PATTERN);
  assert.match("512m", MEMORY_PATTERN);
  assert.doesNotMatch("2 GB", MEMORY_PATTERN);
  assert.doesNotMatch("rm -rf *", MEMORY_PATTERN);
});

test("buildDockerRunArgs locks network, caps and mount modes", () => {
  const args = buildDockerRunArgs({
    image: "img-x",
    mounts: [
      { source: "/repo", target: "/repo", readOnly: true },
      { source: "/copy", target: "/workspace", readOnly: false },
    ],
    env: { CI: "1" },
    network: "off",
    cpus: 2,
    memory: "2g",
    workdir: "/workspace",
    commandTokens: ["jest", "util.test.ts"],
  });
  const flatten = args.join(" ");
  assert.match(flatten, /--network none/);
  assert.match(flatten, /--cpus 2 --memory 2g --memory-swap 2g/);
  assert.match(flatten, /-v \/repo:\/repo:ro/);
  assert.match(flatten, /-v \/copy:\/workspace -e CI=1/);
  assert.deepEqual(args.slice(args.indexOf("img-x") + 1), [
    "jest",
    "util.test.ts",
  ]);
  assert.throws(() =>
    buildDockerRunArgs({
      image: "img",
      mounts: [],
      env: {},
      network: "off",
      cpus: 1,
      memory: "2g; rm -rf /",
      workdir: "/workspace",
      commandTokens: ["true"],
    }),
  );
});

test("buildDevcontainerExecArgs uses npx CLI with -- separator", () => {
  assert.equal(
    buildDevcontainerExecArgs("/sandbox", ["npm", "test"]).join(" "),
    "npx --yes @devcontainers/cli exec --workspace-folder /sandbox -- npm test",
  );
});

test("extractPatchFiles handles adds/deletes; validatePatchPaths rejects escapes", () => {
  const addDelete = [
    "--- /dev/null",
    "+++ b/new/file.py",
    "--- a/old.ts",
    "+++ /dev/null",
  ].join("\n");
  assert.deepEqual(extractPatchFiles(addDelete), ["new/file.py", "old.ts"]);

  assert.throws(
    () =>
      validatePatchPaths(
        SAMPLE_DIFF.replace("+++ b/src/util.ts", "+++ /etc/passwd"),
      ),
    /absolute path/,
  );
  assert.throws(
    () =>
      validatePatchPaths(SAMPLE_DIFF.replace("b/src/util.ts", "b/../evil.ts")),
    /\.\./,
  );
  assert.throws(
    () =>
      validatePatchPaths(
        SAMPLE_DIFF.replace("b/src/util.ts", "b/.git/hooks/x"),
      ),
    /git metadata/,
  );
  validatePatchPaths(SAMPLE_DIFF);
});

test("manager picks docker, creates an isolated copy and records verification", async () => {
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const record: string[] = [];
    const runner = fakeRunner(
      record,
      (_cmd, args) => {
        if (args.includes("HEAD")) {
          return { exitCode: 0, stdout: "abc123", stderr: "" };
        }
        return undefined;
      },
      root,
    );
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      runner,
    });
    const spec = await manager.create();

    assert.equal(spec.provider, "docker");
    assert.equal(manager.base, "abc123");
    assert.equal(spec.network, "off");
    assert.equal(spec.image, "node:20-bookworm-slim");
    assert.equal(spec.mounts.length, 2);
    assert.equal(spec.mounts[0].readOnly, true);
    assert.equal(spec.env.CI, "1");
    assert.equal(
      spec.env.PATH?.startsWith("/workspace/node_modules/.bin:"),
      true,
      "container PATH must resolve sandbox-installed binaries",
    );
    assert.ok(spec.allowedCommands.includes("npm install"));

    const copied = await fs.readFile(
      path.join(spec.worktreePath, "src", "util.ts"),
      "utf-8",
    );
    assert.match(copied, /formatName/);
    assert.equal(
      await fs
        .stat(path.join(spec.worktreePath, "node_modules"))
        .then(() => true)
        .catch(() => false),
      false,
    );

    const result = await manager.run("test", ["src/util.test.ts"]);
    assert.equal(result.passed, true);
    assert.equal(result.command, "jest src/util.test.ts");
    assert.equal(manager.verificationResults.length, 1);
    assert.match(result.stdout.path, /run-1-test-stdout\.log/);
    const dockerRun = record.find((line) => line.startsWith("docker run "));
    assert.match(dockerRun ?? "", /--network none/);
    assert.match(
      dockerRun ?? "",
      /node:20-bookworm-slim jest src\/util\.test\.ts$/,
    );
  } finally {
    await cleanup(root, out);
  }
});

const copiedUtilPattern = /.*/;

test("sandbox provider selection prefers devcontainer and marks network reality", async () => {
  const root = await makeRepo(true);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const record: string[] = [];
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      runner: fakeRunner(record, undefined, root),
    });
    const spec = await manager.create();
    assert.equal(spec.provider, "devcontainer");
    assert.equal(spec.network, "on");
    assert.equal(spec.mounts.length, 0);
    assert.equal(spec.image, null);

    await manager.run("build", []);
    const exec = record.find((line) =>
      line.includes("exec --workspace-folder"),
    );
    assert.match(exec ?? "", /tsc$/);
  } finally {
    await cleanup(root, out);
  }
});

test("sandbox_create/patch/run tools work wired and fail graceful unwired", async () => {
  const unwired = await executeTool(toolCall("sandbox_create"), { registry });
  assert.equal(unwired.isError, true);
  assert.match(unwired.content, /no sandbox configured/);

  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      runner: fakeRunner(
        [],
        (_cmd, args) => {
          if (args.includes("HEAD"))
            return { exitCode: 0, stdout: "abc123", stderr: "" };
          return undefined;
        },
        root,
      ),
    });
    const ctx = { registry, repoRoot: root, artifacts, sandbox: manager };

    const created = await executeTool(toolCall("sandbox_create"), ctx);
    assert.equal(created.isError, undefined);
    assert.match(created.content, /Sandbox ready \(provider=docker\)/);
    assert.match(created.content, /Whitelisted commands/);

    const dry = await executeTool(
      toolCall("write_patch", { diff: SAMPLE_DIFF, dryRun: true }),
      ctx,
    );
    assert.equal(dry.isError, undefined);
    assert.match(dry.content, /Patch check passed/);
    const sandboxFiles = await fs.readdir(path.join(out, "sandbox"), {
      recursive: true,
    });
    assert.equal(
      sandboxFiles.filter((f) => String(f).startsWith("incoming-")).length,
      0,
    );
    const mainRepoUtil = await fs.readFile(
      path.join(root, "src", "util.ts"),
      "utf-8",
    );
    assert.doesNotMatch(mainRepoUtil, /toLowerCase/);

    const applied = await executeTool(
      toolCall("write_patch", { diff: SAMPLE_DIFF }),
      ctx,
    );
    assert.equal(applied.isError, undefined);
    assert.match(applied.content, /Patch applied in sandbox only/);
    assert.match(applied.content, /- src\/util\.ts/);
    assert.match(applied.content, /baseCommit: abc123/);
    assert.equal(artifacts.list().filter((a) => a.kind === "diff").length, 1);

    const evil = await executeTool(
      toolCall("write_patch", {
        diff: SAMPLE_DIFF.replace("b/src/util.ts", "b/../evil.ts"),
      }),
      ctx,
    );
    assert.equal(evil.isError, true);
    assert.match(evil.content, /\.\./);

    const run = await executeTool(
      toolCall("sandbox_run", { kind: "test", args: ["src/util.test.ts"] }),
      ctx,
    );
    assert.equal(run.isError, undefined);
    assert.match(run.content, /(PASS|FAIL)/);
    assert.match(run.content, /stdout artifact:/);
  } finally {
    await cleanup(root, out);
  }
});

test("write_patch and sandbox_run report precondition and whitelist errors", async () => {
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      runner: fakeRunner(
        [],
        (_cmd, args) =>
          args.includes("HEAD")
            ? { exitCode: 0, stdout: "abc123", stderr: "" }
            : undefined,
        root,
      ),
    });
    const ctx = { registry, repoRoot: root, artifacts, sandbox: manager };

    const early = await executeTool(
      toolCall("write_patch", { diff: SAMPLE_DIFF }),
      ctx,
    );
    assert.equal(early.isError, true);
    assert.match(early.content, /sandbox not created/);

    await executeTool(toolCall("sandbox_create"), ctx);
    const unknown = await executeTool(
      toolCall("sandbox_run", { kind: "shell" }),
      ctx,
    );
    assert.equal(unknown.isError, true);
    assert.match(unknown.content, /not whitelisted/);
    assert.match(unknown.content, /install, build, test, lint/);

    const missing = await executeTool(toolCall("sandbox_run"), ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.content, /not whitelisted/);
  } finally {
    await cleanup(root, out);
  }
});

test("risk_report aggregates evidence honestly and writes artifacts", async () => {
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      runner: fakeRunner(
        [],
        (cmd, args) => {
          if (args.includes("HEAD"))
            return { exitCode: 0, stdout: "abc123", stderr: "" };
          if (cmd === "docker" && args[0] === "run") return failJest();
          return undefined;
        },
        root,
      ),
    });
    await manager.create();
    await manager.run("test", ["src/util.test.ts"]); // -> FAIL via handler

    const report = await buildRiskReport({
      repoRoot: root,
      touchedFiles: ["src/util.ts", "pkg/mod.py"],
      verifications: manager.verificationResults,
    });
    assert.equal(report.level, "high");
    assert.ok(report.factors.some((f) => f.kind === "failed-test"));
    assert.ok(report.factors.some((f) => f.kind === "limited-confidence"));
    assert.ok(report.factors.some((f) => f.kind === "uncovered-test"));
    // src/util.test.ts imports src/util.ts, so a dependent exists: the factor
    // must not fire just because graph ids were cwd-relative.
    assert.equal(
      report.factors.some((f) => f.kind === "uncovered-caller"),
      false,
      report.factors.map((f) => f.kind).join(","),
    );
    assert.match(report.summary, /1 sandbox run\(s\) \(0 passed, 1 failed\)/);
    assert.ok(report.recommendations.length > 0);

    const ctx = { registry, repoRoot: root, artifacts, sandbox: manager };
    const result = await executeTool(
      toolCall("risk_report", { touchedFiles: ["src/util.ts"] }),
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content, /Risk level: HIGH/);
    assert.match(result.content, /risk-report\.md/);
    assert.match(result.content, /risk-report\.json/);
    assert.equal(artifacts.list().filter((a) => a.kind === "report").length, 2);

    const noEvidence = await buildRiskReport({
      repoRoot: root,
      touchedFiles: ["src/util.ts"],
      verifications: [],
    });
    assert.equal(noEvidence.level, "high");
    assert.ok(noEvidence.factors.some((f) => f.kind === "missing-evidence"));
  } finally {
    await cleanup(root, out);
  }
});

test("worktree-host requires the unsafe flag and a real git repo", async () => {
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const record: string[] = [];
    const denied = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "worktree-host",
      runner: fakeRunner(record, undefined, root),
    });
    await assert.rejects(() => denied.create(), /--unsafe-host-tests/);

    const noGit = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "worktree-host",
      unsafeHostTests: true,
      runner: fakeRunner(record, (_cmd, args) =>
        args.includes("--show-toplevel")
          ? { exitCode: 1, stdout: "", stderr: "not a repo" }
          : undefined,
      ),
    });
    await assert.rejects(() => noGit.create(), /git working tree/);
  } finally {
    await cleanup(root, out);
  }
});

test("a repo nested inside another git checkout is not treated as a git repo", async () => {
  const gitOk = await execRunner("git", ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  if (!gitOk) return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "sboxparent-"));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    await execRunner("git", ["init", "-q"], {
      cwd: parent,
      timeoutMs: 10_000,
    });
    await fs.writeFile(
      path.join(parent, "package.json"),
      JSON.stringify({ name: "parent", version: "1.0.0" }),
    );
    await execRunner(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
      ],
      { cwd: parent, timeoutMs: 10_000 },
    );
    const nested = path.join(parent, "fixtures", "scenario");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(nested, "package.json"),
      JSON.stringify({ name: "nested", version: "1.0.0" }),
    );

    const artifacts = await ArtifactStore.create(out);
    const manager = new SandboxManager({
      repoRoot: nested,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "worktree-host",
      unsafeHostTests: true,
    });
    await assert.rejects(() => manager.create(), /git working tree/);

    // The parent checkout must remain untouched: no worktree was added.
    const worktrees = await execRunner("git", ["worktree", "list"], {
      cwd: parent,
      timeoutMs: 10_000,
    });
    assert.equal(worktrees.stdout.trim().split("\n").length, 1);
  } finally {
    await cleanup(parent, out);
  }
});

test("worktree-host runs commands with the worktree bin dir on PATH", async () => {
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    let seenEnv: Record<string, string> | undefined;
    const runner: CommandRunner = async (cmd, args, options) => {
      if (cmd === "git" && args.includes("--show-toplevel")) {
        return { exitCode: 0, stdout: `${root}\n`, stderr: "" };
      }
      if (cmd === "git" && args.includes("HEAD")) {
        return { exitCode: 0, stdout: "abc123", stderr: "" };
      }
      if (cmd === "jest") {
        seenEnv = options.env;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "worktree-host",
      unsafeHostTests: true,
      runner,
    });
    const spec = await manager.create();
    const result = await manager.run("test", []);
    assert.equal(result.passed, true);
    const binDir = path.join(spec.worktreePath, "node_modules", ".bin");
    assert.ok(
      seenEnv?.PATH?.startsWith(`${binDir}${path.delimiter}`),
      `host PATH must start with the worktree bin dir: ${seenEnv?.PATH}`,
    );
    await manager.dispose();
  } finally {
    await cleanup(root, out);
  }
});

test("a missing sandbox binary reports 127 with the spawn error", async () => {
  const result = await execRunner("this-binary-does-not-exist-xyz", [], {
    cwd: os.tmpdir(),
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 127);
  assert.match(result.stderr, /ENOENT/);
});

test("worktree-host with a real git repo runs on the host and cleans up", async () => {
  const gitOk = await execRunner("git", ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  if (!gitOk) return;
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    await execRunner("git", ["init", "-q"], { cwd: root, timeoutMs: 10_000 });
    await execRunner(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
      ],
      { cwd: root, timeoutMs: 10_000 },
    );
    await fs.writeFile(
      path.join(root, "smoke.js"),
      "console.log('smoke-ok');\n",
    );
    const pkgPath = path.join(root, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = "node smoke.js";
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    await execRunner("git", ["add", "-A"], { cwd: root, timeoutMs: 10_000 });
    await execRunner(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"],
      { cwd: root, timeoutMs: 10_000 },
    );

    const artifacts = await ArtifactStore.create(out);
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "worktree-host",
      unsafeHostTests: true,
    });
    const spec = await manager.create();
    assert.equal(spec.provider, "worktree-host");
    const result = await manager.run("test", []);
    assert.equal(result.passed, true);
    assert.equal(result.command, "node smoke.js");
    const stdout = await fs.readFile(result.stdout.path, "utf-8");
    assert.match(stdout, /smoke-ok/);
    // Patches apply to the worktree on the host too.
    await manager.applyPatch(SAMPLE_DIFF, false);
    const patched = await fs.readFile(
      path.join(spec.worktreePath, "src", "util.ts"),
      "utf-8",
    );
    assert.match(patched, /toLowerCase/);
    await manager.dispose();
    assert.equal(
      await fs
        .stat(spec.worktreePath)
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await cleanup(root, out);
  }
});

test("detectRepoProfile stays consistent with whitelist derivation", async () => {
  const root = await makeRepo();
  try {
    const allowed = deriveAllowedCommands(await detectRepoProfile(root));
    assert.deepEqual(allowed.build, ["tsc"]);
    assert.deepEqual(allowed.test, ["jest"]);
    assert.deepEqual(allowed.install, ["npm", "install"]);
  } finally {
    await cleanup(root);
  }
});

test("docker integration: whitelisted command runs network-isolated in the container", async (t) => {
  const probe = { cwd: process.cwd(), timeoutMs: 15_000 } as const;
  const dockerOk = await execRunner(
    "docker",
    ["version", "--format", "json"],
    probe,
  )
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  if (!dockerOk) {
    t.skip("docker daemon not available");
    return;
  }
  const imageOk = await execRunner(
    "docker",
    ["image", "inspect", "node:20-bookworm-slim"],
    probe,
  )
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  if (!imageOk) {
    t.skip("node:20-bookworm-slim image not present locally");
    return;
  }
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "sboxout-"));
  try {
    await fs.writeFile(
      path.join(root, "smoke.js"),
      "console.log('container-ok');\n",
    );
    const pkgPath = path.join(root, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as {
      scripts: Record<string, string>;
    };
    pkg.scripts.test = "node smoke.js";
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    const artifacts = await ArtifactStore.create(out);
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "docker",
      config: { timeoutMs: 120_000 },
    });
    await manager.create();
    const result = await manager.run("test", []);
    assert.equal(result.passed, true);
    const stdout = await fs.readFile(result.stdout.path, "utf-8");
    assert.match(stdout, /container-ok/);
  } finally {
    await cleanup(root, out);
  }
});
