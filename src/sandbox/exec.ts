export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra environment for the child; merged over the inherited host env. */
  env?: Record<string, string>;
}

/**
 * Injectable process runner so sandbox logic is testable without Docker or a
 * real CLI; the default implementation shells out via execa.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<CommandOutput>;

export const execRunner: CommandRunner = async (
  command,
  args,
  options,
): Promise<CommandOutput> => {
  const { execa } = await import("execa");
  const result = await execa(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    reject: false,
    signal: options.signal,
    env: options.env,
    // Byte-faithful stdout/stderr: execa's default strips the trailing "\n",
    // which breaks trailing-newline-sensitive payloads (git diff patches) and
    // misstates log artifacts.
    stripFinalNewline: false,
  });
  // A missing binary resolves with exitCode undefined and empty streams; left
  // alone that surfaces as a bare "FAIL (exitCode=1)" with no explanation.
  const spawnFailed = result.exitCode === undefined && !result.timedOut;
  return {
    exitCode: result.exitCode ?? (result.timedOut ? 124 : 127),
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ||
      (spawnFailed
        ? `${result.originalMessage ?? `spawn ${command} failed`}\n`
        : ""),
  };
};
