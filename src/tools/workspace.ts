import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "../config.js";

/**
 * Resolve a tool-supplied path. Absolute paths are used as-is; relative paths
 * resolve against the investigation repo root when one is configured (the
 * investigate CLI sets it) and against the process cwd otherwise. This keeps
 * `list_files(".")`/`read_file("src/app.ts")` meaning "inside the repo under
 * investigation" during investigations instead of the agent's own checkout.
 */
export function resolveToolPath(
  input: unknown,
  context?: { repoRoot?: string },
): string {
  const raw = typeof input === "string" && input.trim() ? input : ".";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const base = context?.repoRoot
    ? path.resolve(context.repoRoot)
    : process.cwd();
  return path.resolve(base, raw);
}

/**
 * Optional path sandbox for read_file / list_files / write_file. When
 * WORKSPACE_ROOT is set, every resolved path must stay beneath it (after
 * symlink resolution so links cannot escape); unset means unrestricted.
 */
export async function assertWithinWorkspace(
  resolvedPath: string,
): Promise<void> {
  const root = config.agent.workspaceRoot;
  if (!root) return;
  const allowedBase = await fs
    .realpath(path.resolve(root))
    .catch(() => path.resolve(root));
  const targetReal = await fs.realpath(resolvedPath).catch(() => resolvedPath);
  if (
    targetReal !== allowedBase &&
    !targetReal.startsWith(allowedBase + path.sep)
  ) {
    throw new Error(
      `path is outside WORKSPACE_ROOT (${allowedBase}): ${resolvedPath}`,
    );
  }
}
