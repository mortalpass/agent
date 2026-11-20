import type { SandboxMount } from "../investigate/contracts.js";

export const MEMORY_PATTERN = /^\d+(b|k|m|g)$/i;

export const DEFAULT_IMAGE_JS = "node:20-bookworm-slim";

/**
 * PATH inside the container (container-internal value, never the host env):
 * the writable copy's node_modules/.bin must win so whitelisted JS commands
 * (jest/tsc, installed via the sandboxed install step) resolve; remaining
 * entries mirror the default PATH of the base image. Without this, the node
 * image entrypoint cannot find local binaries and falls back to prefixing
 * `node` onto the command.
 */
export const SANDBOX_CONTAINER_PATH =
  "/workspace/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Volume arguments are generated from SandboxSpec.mounts — the spec is the
 * single source of truth, so the container always materializes exactly what
 * the audited sandbox declared (repo read-only, copy read-write).
 */
export function dockerMountArgs(mounts: SandboxMount[]): string[] {
  const args: string[] = [];
  for (const mount of mounts) {
    args.push(
      "-v",
      `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`,
    );
  }
  return args;
}

export function dockerEnvArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

export interface DockerRunInput {
  image: string;
  mounts: SandboxMount[];
  env: Record<string, string>;
  network: "off" | "on";
  cpus: number;
  memory: string;
  workdir: string;
  commandTokens: string[];
}

export function buildDockerRunArgs(input: DockerRunInput): string[] {
  if (!MEMORY_PATTERN.test(input.memory)) {
    throw new Error(
      `Invalid sandbox memory limit "${input.memory}" (expected e.g. 2g)`,
    );
  }
  return [
    "run",
    "--rm",
    "--cpus",
    String(input.cpus),
    "--memory",
    input.memory,
    // Same value twice: no swap headroom beyond the memory cap.
    "--memory-swap",
    input.memory,
    "--pids-limit",
    "512",
    "--network",
    input.network === "on" ? "bridge" : "none",
    ...dockerMountArgs(input.mounts),
    ...dockerEnvArgs(input.env),
    "-w",
    input.workdir,
    input.image,
    ...input.commandTokens,
  ];
}
