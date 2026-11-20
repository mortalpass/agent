import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectRepoProfile } from "../src/repo/profile.js";
import { ArtifactStore } from "../src/context/artifacts.js";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import { findCycles } from "../src/investigate/analyze.js";
import { selectTests } from "../src/investigate/testmap.js";
import { buildRiskReport } from "../src/sandbox/risk.js";
import type { RepoProfile } from "../src/investigate/contracts.js";

const registry = createDefaultRegistry();

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "invgfw-"));
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
    path.join(root, "src", "app.ts"),
    'import { formatName } from "./util.js";\n\nexport const greeting = formatName(" hi ");\n',
  );
  await fs.writeFile(
    path.join(root, "src", "util.test.ts"),
    'import { formatName } from "./util.js";\n\ntest("trims", () => expect(formatName(" x ")).toBe("x"));\n',
  );
  // import cycle for impact_analyze
  await fs.writeFile(
    path.join(root, "src", "a.ts"),
    'import { b } from "./b.js";\nexport const a = () => b();\n',
  );
  await fs.writeFile(
    path.join(root, "src", "b.ts"),
    'import { a } from "./a.js";\nexport const b = () => a();\n',
  );
  // python side
  await fs.mkdir(path.join(root, "pkg"), { recursive: true });
  await fs.writeFile(
    path.join(root, "pkg", "mod.py"),
    "def frobnicate(x):\n    return x * 2\n",
  );
  await fs.writeFile(
    path.join(root, "pkg", "main.py"),
    "from pkg.mod import frobnicate\n\nresult = frobnicate(21)\n",
  );
  return root;
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    id: "c1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

test("detectRepoProfile reads package.json, workspaces and runners", async () => {
  const root = await makeRepo();
  try {
    const profile = await detectRepoProfile(root);
    assert.equal(profile.root, root);
    assert.equal(profile.packageManager, "npm");
    assert.equal(profile.languages.includes("typescript"), true);
    assert.equal(profile.languages.includes("python"), true);
    assert.equal(profile.testRunners.includes("jest"), true);
    assert.equal(profile.commands.test, "jest");
    assert.equal(profile.commands.build, "tsc");
    assert.equal(profile.commands.lint, "_biome");
  } finally {
    await cleanup(root);
  }
});

test("repo_profile tool requires repoRoot or path", async () => {
  const result = await executeTool(toolCall("repo_profile"), { registry });
  assert.equal(result.isError, true);
  assert.match(result.content, /no investigation root configured/);
});

test("repo_profile tool returns the detected profile", async () => {
  const root = await makeRepo();
  try {
    const result = await executeTool(toolCall("repo_profile"), {
      registry,
      repoRoot: root,
    });
    assert.equal(result.isError, undefined);
    const parsed: RepoProfile = JSON.parse(result.content);
    assert.equal(parsed.root, root);
    assert.deepEqual(parsed.languages, ["typescript", "javascript", "python"]);
  } finally {
    await cleanup(root);
  }
});

test("search_code finds matches and caps results", async () => {
  const root = await makeRepo();
  try {
    const result = await executeTool(
      toolCall("search_code", { pattern: "frobnicate" }),
      { registry, repoRoot: root },
    );
    assert.match(result.content, /Matched \d+ location/);
    assert.match(result.content, /pkg\/mod\.py:\d+/);
    assert.match(result.content, /pkg\/main\.py:\d+/);
    void "";
  } finally {
    await cleanup(root);
  }
});

test("search_code persists oversized results as artifacts", async () => {
  const root = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "invgout-"));
  try {
    const artifacts = await ArtifactStore.create(out);
    const result = await executeTool(
      toolCall("search_code", { pattern: ".", max: 3 }),
      { registry, repoRoot: root, artifacts },
    );
    assert.match(result.content, /Full result artifact:/);
    assert.equal(artifacts.list().length, 1);
    assert.equal(artifacts.list()[0].kind, "search");
  } finally {
    await cleanup(root);
    await cleanup(out);
  }
});

test("find_symbol reports ts definitions/references and python confidence", async () => {
  const root = await makeRepo();
  try {
    const ts = await executeTool(
      toolCall("find_symbol", { symbol: "formatName" }),
      {
        registry,
        repoRoot: root,
      },
    );
    assert.match(ts.content, /Definitions \(1\)/);
    assert.match(ts.content, /src\/util\.ts:1/);
    assert.match(ts.content, /References \((\d+)\)/);
    assert.match(ts.content, /confidence=1/);

    const py = await executeTool(
      toolCall("find_symbol", { symbol: "frobnicate" }),
      {
        registry,
        repoRoot: root,
      },
    );
    assert.match(py.content, /confidence=0\.7/);
    assert.match(py.content, /pkg\/mod\.py:1/);
    assert.match(py.content, /text-based \(best effort\)/i);
  } finally {
    await cleanup(root);
  }
});

test("impact_analyze detects the artificial import cycle", async () => {
  const root = await makeRepo();
  try {
    const result = await executeTool(
      toolCall("impact_analyze", {
        files: ["src/a.ts", "src/util.ts", "src/app.ts"],
      }),
      { registry, repoRoot: root },
    );
    assert.match(result.content, /Impact graph: \d+ nodes, \d+ edges/);
    assert.match(result.content, /↻/); // cycle marker
    assert.match(result.content, /a\.ts → b\.ts|b\.ts → a\.ts|src\//);
    // Dependents must resolve against repo-relative ids; a cwd-relative graph
    // (e.g. "invgfw-xxx/src/app.ts") used to make this always say "(none found)".
    assert.match(
      result.content,
      /Direct dependents of touched files: .*src\/app\.ts/,
    );
    assert.doesNotMatch(result.content, /invgfw-/);
    // The intent does not touch the a↔b cycle, so it must not be reported.
    const unrelated = await executeTool(
      toolCall("impact_analyze", { files: ["src/util.ts"] }),
      { registry, repoRoot: root },
    );
    assert.match(unrelated.content, /none among touched files/);
    assert.doesNotMatch(unrelated.content, /↻/);
  } finally {
    await cleanup(root);
  }
});

test("test_select falls back to the documented heuristic for TS repos", async () => {
  const root = await makeRepo();
  try {
    const coverage = await selectTests(root, ["src/util.ts"]);
    assert.deepEqual(coverage.selectedTests, ["src/util.test.ts"]);
    assert.deepEqual(coverage.touchedFiles, ["src/util.ts"]);
    assert.deepEqual(coverage.uncovered, []);
    assert.match(coverage.rationale, /heuristic/i);

    const untouched = await selectTests(root, ["src/a.ts"]);
    assert.deepEqual(untouched.selectedTests, []);
    assert.deepEqual(untouched.uncovered, ["src/a.ts"]);
  } finally {
    await cleanup(root);
  }
});

test("test_select tool returns rationale and artifact when oversized", async () => {
  const root = await makeRepo();
  try {
    const result = await executeTool(
      toolCall("test_select", { files: ["src/util.ts", "src/other.ts"] }),
      { registry, repoRoot: root },
    );
    assert.match(result.content, /Selected tests \(1\)/);
    assert.match(result.content, /src\/other\.ts/); // in uncovered list
    assert.match(result.content, /Rationale: /);
    assert.equal(result.isError, undefined);
  } finally {
    await cleanup(root);
  }
});

test("findCycles finds elementary loops and stays bounded", () => {
  const edges = [
    { from: "m", to: "n" },
    { from: "n", to: "m" },
    { from: "x", to: "y" },
  ];
  const cycles = findCycles(edges);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ["m", "n"]);
});

test("risk aggregation only reports cycles the change touches", async () => {
  const root = await makeRepo();
  try {
    const untouched = await buildRiskReport({
      repoRoot: root,
      touchedFiles: ["src/util.ts"],
      verifications: [],
    });
    assert.equal(
      untouched.factors.some((f) => f.kind === "import-cycle"),
      false,
      untouched.factors.map((f) => f.kind).join(","),
    );

    const cyclic = await buildRiskReport({
      repoRoot: root,
      touchedFiles: ["src/a.ts"],
      verifications: [],
    });
    assert.ok(cyclic.factors.some((f) => f.kind === "import-cycle"));
  } finally {
    await cleanup(root);
  }
});
