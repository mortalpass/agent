import * as path from "node:path";

/**
 * Pull the target paths out of a unified diff ("--- a/x" / "+++ b/x" headers,
 * /dev/null for adds/deletes); "a/"/"b/" prefixes are stripped.
 */
export function extractPatchFiles(diffText: string): string[] {
  const files = new Set<string>();
  for (const line of diffText.split("\n")) {
    const match = /^(\+\+\+|---) (\S+).*$/.exec(line);
    if (!match) continue;
    let candidate = match[2];
    if (candidate === "/dev/null") continue;
    candidate = candidate.replace(/^[ab]\//, "");
    candidate = candidate.replace(/"/g, "");
    if (candidate) files.add(candidate);
  }
  return [...files].sort();
}

function assertSandboxRelative(file: string): void {
  if (path.isAbsolute(file)) {
    throw new Error(
      `Patch touches an absolute path outside the sandbox: ${file}`,
    );
  }
  if (file.split("/").includes("..")) {
    throw new Error(`Patch escapes the sandbox via "..": ${file}`);
  }
  if (file.startsWith(".git/") || file === ".git") {
    throw new Error(
      `Patch must not target the git metadata directory: ${file}`,
    );
  }
}

/**
 * Path-safety gate before git apply ever runs: only relative repo files
 * inside the sandbox copy may be touched.
 */
export function validatePatchPaths(diffText: string): void {
  const files = extractPatchFiles(diffText);
  for (const file of files) assertSandboxRelative(file);
}
