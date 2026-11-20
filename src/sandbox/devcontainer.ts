/**
 * devcontainers/cli integration (external CLI, adopted per section 9 of
 * REFERENCE_PROJECTS.md). The CLI resolves its own image/config; docker-level
 * resource caps and network off cannot be passed through it, which the
 * SandboxSpec and tool results must disclose honestly.
 */
export function buildDevcontainerExecArgs(
  workspaceFolder: string,
  commandTokens: string[],
): string[] {
  return [
    "npx",
    "--yes",
    "@devcontainers/cli",
    "exec",
    "--workspace-folder",
    workspaceFolder,
    "--",
    ...commandTokens,
  ];
}
