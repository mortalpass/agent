import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { glob } from "tinyglobby";
import { execa } from "execa";
import type { CoverageMap } from "./contracts.js";
import { CoverageMapSchema } from "./contracts.js";

/** Copied into a target repo's node_modules; fast existence probe. */
async function localBinExists(root: string, bin: string): Promise<boolean> {
  for (const candidate of [
    path.join(root, "node_modules", ".bin", bin),
    path.join(root, "node_modules", ".bin", `${bin}.cmd`),
  ]) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return true;
  }
  return false;
}

async function pytestAvailable(): Promise<boolean> {
  try {
    const { exitCode } = await execa("pytest", ["--version"], {
      reject: false,
      timeout: 5000,
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

const IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
];

async function runNativeSelector(
  root: string,
  touchedFiles: string[],
): Promise<string[] | null> {
  const touched = touchedFiles.map((f) => path.resolve(root, f));

  if (await localBinExists(root, "jest")) {
    const { stdout } = await execa(
      "npx",
      ["jest", "--findRelatedTests", ...touched, "--listTests"],
      { cwd: root, reject: false, timeout: 60_000 },
    );
    if (stdout.trim()) {
      return stdout
        .trim()
        .split("\n")
        .map((l) => path.relative(root, l) || l);
    }
  }

  if (await localBinExists(root, "vitest")) {
    const { stdout } = await execa(
      "npx",
      ["vitest", "related", ...touched, "--list"],
      { cwd: root, reject: false, timeout: 60_000 },
    );
    if (stdout.trim()) {
      return stdout
        .trim()
        .split("\n")
        .filter((l) => /\.(test|spec)\./.test(l))
        .map(
          (l) => path.relative(root, path.resolve(root, l.trim())) || l.trim(),
        );
    }
  }

  if (
    touchedFiles.some((f) => f.endsWith(".py")) &&
    (await pytestAvailable())
  ) {
    // Native-only selection for pytest: map touched packages to their test
    // dirs and run pytest --collect-only against them.
    const collected = new Set<string>();
    for (const file of touched) {
      const dir = path.dirname(file);
      const matches = await glob({
        patterns: ["test_*.py", "*_test.py"],
        cwd: path.isAbsolute(dir) ? dir : path.join(root, dir),
        ignore: IGNORES,
      });
      for (const m of matches) {
        const rel = path.isAbsolute(dir)
          ? path.relative(root, path.join(dir, m))
          : path.join(dir, m);
        collected.add(rel);
      }
    }
    if (collected.size > 0) return [...collected];
    return [];
  }

  return null;
}

/**
 * Content heuristic fallback: select test files that mention the touched
 * file's basename or its exported symbols. Fast, dependency-free, and the
 * documented fallback for brand-new / uncovered tests.
 */
async function heuristicSelection(
  root: string,
  touchedFiles: string[],
): Promise<{ selected: string[]; matchedTouched: string[] }> {
  const testFiles = await glob({
    patterns: [
      "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
      "**/test_*.py",
      "**/*_test.py",
      "**/__tests__/**/*.{ts,tsx,js,jsx}",
    ],
    cwd: root,
    ignore: IGNORES,
    dot: false,
  });

  const needles = new Map<string, string>();
  for (const touched of touchedFiles) {
    const base = path.basename(touched).replace(/\.[^.]+$/, "");
    needles.set(base, touched);
  }
  const contents = new Map<string, string>();
  await Promise.all(
    testFiles.map(async (file) => {
      const info = await stat(path.join(root, file)).catch(() => null);
      if (!info || info.size > 1024 * 1024) return;
      try {
        contents.set(file, await readFile(path.join(root, file), "utf-8"));
      } catch {
        // unreadable test file: skipped from heuristic selection
      }
    }),
  );

  const selected: string[] = [];
  const matched = new Set<string>();
  for (const [file, content] of contents) {
    let hits = false;
    for (const [needle, touched] of needles) {
      if (!needle) continue;
      // Whole-boundary match: a bare "a" needle must not ride on other words.
      const regex = new RegExp(
        `\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      );
      if (regex.test(content)) {
        matched.add(touched);
        hits = true;
      }
    }
    if (hits) selected.push(file);
  }
  selected.sort((a, b) => a.localeCompare(b));
  return { selected, matchedTouched: [...matched] };
}

export async function selectTests(
  root: string,
  touchedFiles: string[],
): Promise<CoverageMap> {
  const native = await runNativeSelector(root, touchedFiles);
  if (native !== null) {
    return CoverageMapSchema.parse({
      touchedFiles,
      selectedTests: native,
      uncovered: [],
      rationale:
        native.length > 0
          ? "Selected via the repo's native test-impact runner."
          : "Native runner reports no tests related to the touched files.",
    });
  }

  const { selected, matchedTouched } = await heuristicSelection(
    root,
    touchedFiles,
  );
  return CoverageMapSchema.parse({
    touchedFiles,
    selectedTests: selected,
    uncovered: touchedFiles.filter((f) => !matchedTouched.includes(f)),
    rationale:
      "Native runner unavailable or not installed; heuristic content match " +
      "was used (test files mentioning the touched basenames). This is " +
      "best-effort and may miss indirectly-related tests.",
  });
}
