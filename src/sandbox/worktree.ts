import type { CommandRunner } from "./exec.js";

/**
 * git worktree + host execution. Files are isolated, processes are NOT — this
 * provider is admissible only with --unsafe-host-tests and never runs networked
 * install unless the host's own policy allows it.
 */
export async function createWorktree(
  runner: CommandRunner,
  repoRoot: string,
  worktreePath: string,
  baseCommit: string,
): Promise<void> {
  const result = await runner(
    "git",
    ["-C", repoRoot, "worktree", "add", "--detach", worktreePath, baseCommit],
    { cwd: repoRoot, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

export async function removeWorktree(
  runner: CommandRunner,
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  await runner(
    "git",
    ["-C", repoRoot, "worktree", "remove", "--force", worktreePath],
    { cwd: repoRoot, timeoutMs: 30_000 },
  );
}
