import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "tinyglobby";
import type { RepoProfile } from "../investigate/contracts.js";
import { parseRepoProfile } from "../investigate/contracts.js";

const IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
];

interface PkgJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

async function readPackageJson(root: string): Promise<PkgJson | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    return JSON.parse(raw) as PkgJson;
  } catch {
    return null;
  }
}

async function findFiles(root: string): Promise<string[]> {
  return glob({
    patterns: [
      "*lock.{json,yaml}",
      "bun.lockb",
      "tsconfig*.json",
      "pyproject.toml",
      "requirements*.txt",
      "setup.cfg",
      "setup.py",
      "pytest.ini",
      "tox.ini",
      "**/conftest.py",
      "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py}",
      "**/package.json",
      "**/{jest,vitest,turbo,nx}.config.*",
      "**/{turbo.json,nx.json}",
    ],
    cwd: root,
    ignore: IGNORES,
    dot: true,
  });
}

async function readTextIfPresent(
  root: string,
  file: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, file), "utf-8");
  } catch {
    return null;
  }
}

function packageManagerFromLocks(
  files: string[],
  pkg: PkgJson | null,
): "npm" | "pnpm" | "yarn" | "bun" | null {
  if (files.includes("package-lock.json")) return "npm";
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lockb")) return "bun";
  const pm = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  const match = /^(npm|pnpm|yarn|bun)@/.exec(pm);
  return match ? (match[1] as "npm" | "pnpm" | "yarn" | "bun") : null;
}

function scriptCommands(pkg: PkgJson | null): RepoProfile["commands"] {
  const scripts = pkg?.scripts ?? {};
  return {
    install: scripts.start ? undefined : undefined,
    build: scripts.build ?? undefined,
    test: scripts.test ?? undefined,
    lint: scripts.lint ?? undefined,
  };
}

/** Detects languages, package manager, workspaces, test runners, commands. */
export async function detectRepoProfile(root: string): Promise<RepoProfile> {
  const resolved = path.resolve(root);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Repo root is not a directory: ${resolved}`);
  }

  const files = await findFiles(resolved);
  const pkg = await readPackageJson(resolved);

  const workspacesRaw = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : ((pkg?.workspaces as { packages?: string[] })?.packages ?? []);
  const declaredWorkspaces = workspacesRaw.filter((p) => typeof p === "string");
  // Workspace globs in package.json get expanded lazily: presence of
  // nested package.json files proves actual workspaces (resolved first).
  const nestedWorkspaces = [
    ...new Set(
      files
        .filter((f) => f.endsWith("/package.json"))
        .map((f) => f.slice(0, -"package.json".length).replace(/\/+$/, "")),
    ),
  ];
  const workspaces =
    nestedWorkspaces.length > 0 ? nestedWorkspaces : declaredWorkspaces;

  const languages: string[] = [];
  if (files.some((f) => /\.(ts|tsx|mts|cts)$/.test(f))) {
    languages.push("typescript");
  }
  if (files.some((f) => /\.(js|jsx|mjs|cjs)$/.test(f)) || pkg !== null) {
    languages.push("javascript");
  }
  // Python markers, weakest to strongest.
  const setupFiles = ["pyproject.toml", "setup.cfg", "setup.py"];
  const requirements = files.filter((f) => /^requirements.*\.txt$/.test(f));
  const pythonSources = files.some((f) => f.endsWith(".py"));
  if (
    pythonSources ||
    setupFiles.some((f) => files.includes(f)) ||
    requirements.length > 0
  ) {
    languages.push("python");
  }

  const jsDeps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  const testRunners: string[] = [];
  if ("jest" in jsDeps) testRunners.push("jest");
  if ("vitest" in jsDeps) testRunners.push("vitest");
  if ("mocha" in jsDeps) testRunners.push("mocha");
  if (files.includes("turbo.json")) testRunners.push("turborepo");
  if (files.includes("nx.json")) testRunners.push("nx");

  if (languages.includes("python")) {
    const pyprojectToml = await readTextIfPresent(resolved, "pyproject.toml");
    const reqTexts = await Promise.all(
      requirements.map((f) => readTextIfPresent(resolved, f)),
    );
    const wanted = [pyprojectToml ?? "", ...reqTexts].join("\n");
    if (wanted.includes("pytest")) testRunners.push("pytest");
    else if (files.includes("conftest.py") || files.includes("pytest.ini")) {
      testRunners.push("pytest");
    } else {
      testRunners.push("unittest");
    }
  }

  const frameworks: string[] = [];
  if ("react" in jsDeps) frameworks.push("react");
  if ("vue" in jsDeps) frameworks.push("vue");
  if ("turbo" in jsDeps || files.includes("turbo.json")) {
    frameworks.push("turborepo");
  }

  return parseRepoProfile({
    root: resolved,
    packageManager: packageManagerFromLocks(files, pkg),
    languages,
    workspaces,
    frameworks,
    testRunners,
    commands: scriptCommands(pkg),
  });
}
