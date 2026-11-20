import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../src/context/artifacts.js";
import { PlanStore } from "../src/planner.js";
import { detectRepoProfile } from "../src/repo/profile.js";
import { selectTests } from "../src/investigate/testmap.js";
import { buildRiskReport } from "../src/sandbox/risk.js";
import { SandboxManager } from "../src/sandbox/index.js";
import { execRunner } from "../src/sandbox/exec.js";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";

const registry = createDefaultRegistry();

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    id: "c1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function fixtureDir(scenario: "scenario-a" | "scenario-b"): string {
  return path.resolve("fixtures", scenario);
}

/**
 * Materialize a fixture as its own git repo in a temp dir: the temp copy is
 * "the repo under investigation"; the committed fixture stays pristine.
 */
async function instantiateFixture(
  scenario: "scenario-a" | "scenario-b",
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `acc-${scenario}-`));
  await fs.cp(fixtureDir(scenario), root, { recursive: true });
  const git = (args: string[]) =>
    execRunner("git", args, { cwd: root, timeoutMs: 15_000 });
  const init = await git(["init", "-q"]);
  assert.equal(init.exitCode, 0, init.stderr);
  await git(["add", "-A"]);
  const commit = await git([
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "user.name=fixture",
    "commit",
    "-qm",
    "fixture",
  ]);
  assert.equal(commit.exitCode, 0, commit.stderr);
  return root;
}

async function cleanupFixture(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Produce an authoritative unified diff via git itself (the documented patch
 * mechanism, REFERENCE_PROJECTS.md §6): edit the working tree, capture
 * `git diff`, then restore the tree. Every edit must match, or the test stops.
 */
async function patchFromGitChanges(
  root: string,
  edits: Array<{ file: string; from: string; to: string }>,
): Promise<string> {
  const git = (args: string[]) =>
    execRunner("git", args, { cwd: root, timeoutMs: 15_000 });
  for (const edit of edits) {
    const file = path.join(root, edit.file);
    const content = await fs.readFile(file, "utf-8");
    assert.ok(
      content.includes(edit.from),
      `${edit.file} should contain "${edit.from}"`,
    );
    await fs.writeFile(file, content.replace(edit.from, edit.to), "utf-8");
  }
  const diff = await git(["diff"]);
  assert.equal(diff.exitCode, 0, diff.stderr);
  const restore = await git(["checkout", "--", "."]);
  assert.equal(restore.exitCode, 0, restore.stderr);
  assert.ok(diff.stdout.includes("diff --git"), "diff must be non-empty");
  return diff.stdout;
}

async function gitStatusPorcelain(root: string): Promise<string> {
  const result = await execRunner("git", ["status", "--porcelain"], {
    cwd: root,
    timeoutMs: 15_000,
  });
  return result.stdout;
}

async function dockerDaemonUp(): Promise<boolean> {
  return execRunner("docker", ["version", "--format", "json"], {
    cwd: process.cwd(),
    timeoutMs: 15_000,
  })
    .then((r) => r.exitCode === 0)
    .catch(() => false);
}

test("acceptance A: touchpoints, impact graph with cycle, coverage, plan (artifact-backed)", async () => {
  const root = await instantiateFixture("scenario-a");
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "accout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const ctx = { registry, repoRoot: root, artifacts };

    const profile = await detectRepoProfile(root);
    assert.equal(profile.packageManager, "npm");
    assert.deepEqual(profile.languages, ["typescript", "javascript"]);
    assert.equal(profile.commands.test, "jest");

    const touchpoints = await executeTool(
      toolCall("search_code", { pattern: "moment" }),
      ctx,
    );
    assert.equal(touchpoints.isError, undefined);
    assert.match(touchpoints.content, /src\/date\/format-date\.ts:\d+/);
    assert.match(touchpoints.content, /Full result artifact:/);
    assert.equal(artifacts.list()[0].kind, "search");

    const impact = await executeTool(
      toolCall("impact_analyze", {
        files: [
          "src/date/format-date.ts",
          "src/app.ts",
          "src/cycle/a.ts",
          "src/cycle/b.ts",
        ],
      }),
      ctx,
    );
    assert.equal(impact.isError, undefined);
    assert.match(impact.content, /↻/); // intentional a.ts ↔ b.ts cycle
    assert.match(impact.content, /Direct dependents of touched files/);

    const coverage = await executeTool(
      toolCall("test_select", {
        files: ["src/date/format-date.ts", "src/app.ts"],
      }),
      ctx,
    );
    assert.equal(coverage.isError, undefined);
    assert.match(coverage.content, /format-date\.test\.ts/);
    assert.match(coverage.content, /Rationale: .*heuristic/i);

    const plan = await executeTool(
      toolCall("update_plan", {
        steps: [
          "Detect repo profile",
          "Find moment touchpoints",
          "Analyze impact and cycles",
          "Select tests",
          "Patch in sandbox",
          "Verify selected tests",
          "Report risk",
        ],
        completed: 0,
      }),
      { registry, planStore: new PlanStore() },
    );
    assert.equal(plan.isError, undefined);
    assert.match(plan.content, /Plan updated \(0\/7 completed\)/);
    assert.match(plan.content, /Patch in sandbox/);
  } finally {
    await cleanupFixture(root, out);
  }
});

test("acceptance A: moment→dayjs diff applies to the sandbox copy only; main repo stays clean", async () => {
  const root = await instantiateFixture("scenario-a");
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "accout-"));
  try {
    const diff = await patchFromGitChanges(root, [
      {
        file: "src/date/format-date.ts",
        from: 'import moment from "moment";\n\nexport function formatDate(iso: string): string {\n  const m = moment(iso);\n  return m.format("YYYY-MM-DD");\n}',
        to: 'import dayjs from "dayjs";\n\nexport function formatDate(iso: string): string {\n  const d = dayjs(iso);\n  return d.format("YYYY-MM-DD");\n}',
      },
      {
        file: "package.json",
        from: '"dependencies": {\n    "moment": "^2.30.1"\n  },',
        to: '"dependencies": {\n    "dayjs": "^1.11.10"\n  },',
      },
    ]);

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

    const applied = await manager.applyPatch(diff, false);
    assert.deepEqual(applied.files, [
      "package.json",
      "src/date/format-date.ts",
    ]);

    const patched = await fs.readFile(
      path.join(spec.worktreePath, "src", "date", "format-date.ts"),
      "utf-8",
    );
    assert.match(patched, /import dayjs from "dayjs"/);
    assert.doesNotMatch(patched, /moment/);
    const pkg = JSON.parse(
      await fs.readFile(path.join(spec.worktreePath, "package.json"), "utf-8"),
    ) as { dependencies: Record<string, string> };
    assert.ok("dayjs" in pkg.dependencies);
    assert.ok(!("moment" in pkg.dependencies));
    assert.equal(artifacts.list().filter((a) => a.kind === "diff").length, 1);

    // The repo under investigation is untouched: status clean, source still moment.
    assert.equal(await gitStatusPorcelain(root), "");
    const mainSource = await fs.readFile(
      path.join(root, "src", "date", "format-date.ts"),
      "utf-8",
    );
    assert.match(mainSource, /moment/);

    const risk = await buildRiskReport({
      repoRoot: root,
      touchedFiles: ["src/date/format-date.ts", "src/app.ts", "package.json"],
      verifications: [],
    });
    assert.equal(risk.level, "high");
    assert.ok(risk.factors.some((f) => f.kind === "missing-evidence"));
    assert.ok(risk.factors.some((f) => f.kind === "uncovered-test"));
  } finally {
    await cleanupFixture(root, out);
  }
});

test("acceptance B: TS symbol map exact, Python callers with disclosed confidence", async () => {
  const root = await instantiateFixture("scenario-b");
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "accout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const ctx = { registry, repoRoot: root, artifacts };

    const tsSymbol = await executeTool(
      toolCall("find_symbol", { symbol: "UserService" }),
      ctx,
    );
    assert.equal(tsSymbol.isError, undefined);
    assert.match(tsSymbol.content, /confidence=1/);
    assert.match(tsSymbol.content, /Definitions \(1\)/);
    assert.match(tsSymbol.content, /ts\/user-service\.ts:\d+/);
    assert.match(tsSymbol.content, /References \(\d+\)/);
    assert.match(tsSymbol.content, /ts\/app\.ts:\d+/);

    const pySymbol = await executeTool(
      toolCall("find_symbol", { symbol: "call_gateway" }),
      ctx,
    );
    assert.equal(pySymbol.isError, undefined);
    assert.match(pySymbol.content, /confidence=0\.7/);
    assert.match(pySymbol.content, /py\/gw\.py:1/);
    assert.match(pySymbol.content, /py\/user_client\.py:\d+/);
    assert.match(pySymbol.content, /text-based \(best effort\)/i);

    const pyCallers = await executeTool(
      toolCall("search_code", { pattern: "call_gateway", glob: "**/*.py" }),
      ctx,
    );
    assert.match(pyCallers.content, /py\/user_client\.py:\d+/);

    const coverage = await executeTool(
      toolCall("test_select", {
        files: ["ts/user-service.ts", "py/user_client.py"],
      }),
      ctx,
    );
    assert.match(coverage.content, /user-service\.test\.ts/);
    assert.match(coverage.content, /test_user_client\.py/);
    assert.match(coverage.content, /heuristic/i);
    // find_symbol ×2 + search_code ×1 persist kind=search; test_select adds
    // kind=test → 4 artifacts, each carrying its sha256 in the result text.
    const list = artifacts.list();
    assert.equal(list.length, 4);
    assert.equal(list.filter((a) => a.kind === "search").length, 3);
    assert.equal(list.filter((a) => a.kind === "test").length, 1);
  } finally {
    await cleanupFixture(root, out);
  }
});

test("acceptance B: tenant-isolation patch and risk report disclose Python limitations", async () => {
  const root = await instantiateFixture("scenario-b");
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "accout-"));
  try {
    const diff = await patchFromGitChanges(root, [
      {
        file: "ts/user-service.ts",
        from: "  findById(id: string): User {\n    return { id };\n  }",
        to: "  findById(id: string, tenant: string): User {\n    return { id, tenant };\n  }",
      },
      {
        file: "ts/app.ts",
        from: "export function onboard(id: string): string {\n  const service = new UserService();\n  const user = service.findById(id);\n  return `onboarded: ${user.id}`;\n}",
        to: "export function onboard(id: string, tenant: string): string {\n  const service = new UserService();\n  const user = service.findById(id, tenant);\n  return `onboarded: ${user.id}`;\n}",
      },
      {
        file: "py/gw.py",
        from: 'def call_gateway(user_id: str):\n    """Gateway call used by user_client.fetch_user."""\n    return {"ok": True, "user": user_id}',
        to: 'def call_gateway(user_id: str, tenant: str):\n    """Gateway call used by user_client.fetch_user."""\n    return {"ok": True, "user": user_id, "tenant": tenant}',
      },
      {
        file: "py/user_client.py",
        from: "def fetch_user(user_id: str):\n    return call_gateway(user_id)",
        to: "def fetch_user(user_id: str, tenant: str):\n    return call_gateway(user_id, tenant)",
      },
    ]);

    const artifacts = await ArtifactStore.create(out);
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "worktree-host",
      unsafeHostTests: true,
    });
    const spec = await manager.create();
    const applied = await manager.applyPatch(diff, false);
    assert.ok(applied.files.includes("ts/user-service.ts"));
    assert.ok(applied.files.includes("py/user_client.py"));

    const tsPatched = await fs.readFile(
      path.join(spec.worktreePath, "ts", "user-service.ts"),
      "utf-8",
    );
    assert.match(tsPatched, /tenant/);
    const pyPatched = await fs.readFile(
      path.join(spec.worktreePath, "py", "user_client.py"),
      "utf-8",
    );
    assert.match(pyPatched, /tenant/);
    assert.equal(await gitStatusPorcelain(root), "");

    const ctx = { registry, repoRoot: root, artifacts, sandbox: manager };
    const report = await executeTool(
      toolCall("risk_report", {
        touchedFiles: ["ts/user-service.ts", "ts/app.ts", "py/user_client.py"],
      }),
      ctx,
    );
    assert.equal(report.isError, undefined);
    assert.match(report.content, /Risk level: HIGH/);
    assert.match(report.content, /\[limited-confidence\]/);
    assert.match(report.content, /text-based best effort|limited-confidence/);
    assert.match(report.content, /risk-report\.md/);
    assert.match(report.content, /risk-report\.json/);
    const refs = artifacts.list().filter((a) => a.kind === "report");
    assert.equal(refs.length, 2);
    const md = await fs.readFile(
      refs.find((r) => r.path.endsWith(".md"))!.path,
      "utf-8",
    );
    assert.match(md, /Risk report \(level: high\)/);
    assert.match(md, /limited-confidence/);
  } finally {
    await cleanupFixture(root, out);
  }
});

test("acceptance A E2E in container: install → native selection → jest → risk (gated: docker + image + registry)", async (t) => {
  const daemonUp = await dockerDaemonUp();
  if (!daemonUp) {
    t.skip("docker daemon not available");
    return;
  }
  const imageOk = await execRunner(
    "docker",
    ["image", "inspect", "node:20-bookworm-slim"],
    { cwd: process.cwd(), timeoutMs: 15_000 },
  )
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  if (!imageOk) {
    t.skip("node:20-bookworm-slim image not present locally");
    return;
  }

  const root = await instantiateFixture("scenario-a");
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "accout-"));
  try {
    const diff = await patchFromGitChanges(root, [
      {
        file: "src/date/format-date.ts",
        from: 'import moment from "moment";\n\nexport function formatDate(iso: string): string {\n  const m = moment(iso);\n  return m.format("YYYY-MM-DD");\n}',
        to: 'import dayjs from "dayjs";\n\nexport function formatDate(iso: string): string {\n  const d = dayjs(iso);\n  return d.format("YYYY-MM-DD");\n}',
      },
      {
        file: "package.json",
        from: '"dependencies": {\n    "moment": "^2.30.1"\n  },',
        to: '"dependencies": {\n    "dayjs": "^1.11.10"\n  },',
      },
    ]);

    const artifacts = await ArtifactStore.create(out);
    // network "on" so the whitelisted install step can fetch dependencies
    // (node_modules are never copied from the host; this is the documented flow).
    const manager = new SandboxManager({
      repoRoot: root,
      artifacts,
      sandboxBase: path.join(out, "sandbox"),
      provider: "docker",
      config: { network: "on", timeoutMs: 600_000 },
    });
    const spec = await manager.create();
    assert.equal(spec.provider, "docker");

    await manager.applyPatch(diff, false);

    const install = await manager.run("install", []);
    assert.equal(
      install.passed,
      true,
      `npm install should pass: ${install.command}`,
    );

    const selected = await selectTests(spec.worktreePath, [
      "src/date/format-date.ts",
    ]);
    assert.match(selected.rationale, /native/i);
    assert.ok(
      selected.selectedTests.includes("src/date/format-date.test.ts"),
      `native selection should pick the test: ${selected.selectedTests.join(", ")}`,
    );

    const verify = await manager.run("test", ["src/date/format-date.test.ts"]);
    assert.equal(verify.passed, true, `jest should pass: ${verify.command}`);
    // jest writes its summary to stderr when stdout is not a TTY (as in the
    // sandboxed run), so read the summary from the stderr artifact.
    const jestOut = await fs.readFile(verify.stderr.path, "utf-8");
    assert.match(jestOut, /1 passed/);

    const risk = await buildRiskReport({
      repoRoot: spec.worktreePath,
      touchedFiles: ["src/date/format-date.ts", "src/app.ts", "package.json"],
      verifications: manager.verificationResults,
    });
    // Verification passed (never "high"); the remaining deterministic factors
    // are coverage gaps (e.g. src/app.ts has no dedicated test), so the level
    // is "medium" by the documented mapping.
    assert.equal(risk.level, "medium");
    assert.ok(!risk.factors.some((f) => f.kind === "failed-test"));
    assert.ok(!risk.factors.some((f) => f.kind === "missing-evidence"));
    assert.ok(
      risk.factors.some((f) => f.kind === "uncovered-test"),
      `expected coverage-gap factors, got: ${JSON.stringify(risk.factors)}`,
    );
    assert.match(risk.summary, /2 sandbox run\(s\) \(2 passed, 0 failed\)/);

    assert.equal(await gitStatusPorcelain(root), "");
    const mainSource = await fs.readFile(
      path.join(root, "src", "date", "format-date.ts"),
      "utf-8",
    );
    assert.match(mainSource, /moment/);
  } finally {
    await cleanupFixture(root, out);
  }
});
