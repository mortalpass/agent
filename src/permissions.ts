import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import type {
  PathAccessDecision,
  PathAccessHandler,
  PathAccessRequest,
} from "./types.js";

export class PathAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathAccessDeniedError";
  }
}

/**
 * In-process memory of paths the user granted for the whole session.
 * Grants are exact resolved paths (symlink-aware); anything that cannot be
 * realpath'ed yet (e.g. a write target that does not exist) falls back to
 * the plain resolved path.
 */
export class PathPermissionStore {
  private allowed = new Set<string>();

  async allow(resolvedPath: string): Promise<void> {
    this.allowed.add(await this.normalize(resolvedPath));
  }

  async isAllowed(resolvedPath: string): Promise<boolean> {
    return this.allowed.has(await this.normalize(resolvedPath));
  }

  list(): string[] {
    return [...this.allowed];
  }

  clear(): void {
    this.allowed.clear();
  }

  private async normalize(resolvedPath: string): Promise<string> {
    return fs.realpath(resolvedPath).catch(() => path.resolve(resolvedPath));
  }
}

export interface PathAccessHandlerOptions {
  store: PathPermissionStore;
  /** Asks the user and returns their decision. */
  prompt: (request: PathAccessRequest) => Promise<PathAccessDecision>;
}

/**
 * Wraps a prompt function with session memory: granted paths are remembered
 * for the lifetime of the store, "once" grants are not, denials propagate.
 */
export function createPathAccessHandler(
  options: PathAccessHandlerOptions,
): PathAccessHandler {
  return async (request) => {
    if (await options.store.isAllowed(request.path)) {
      logger.debug(`Path access pre-approved: ${request.path}`);
      return "once";
    }
    const decision = await options.prompt(request);
    if (decision === "session") {
      await options.store.allow(request.path);
    }
    return decision;
  };
}

/**
 * Asks the configured handler for permission. No handler means the access
 * is allowed (library/test usage stays zero-config); "deny" throws so the
 * caller can turn it into a tool result string.
 */
export async function ensurePathAccess(
  tool: string,
  operation: PathAccessRequest["operation"],
  resolvedPath: string,
  handler?: PathAccessHandler,
): Promise<void> {
  if (!handler) return;
  const decision = await handler({ tool, operation, path: resolvedPath });
  if (decision === "deny") {
    logger.info(`Path access denied: ${operation} ${resolvedPath}`);
    throw new PathAccessDeniedError(
      `the user did not allow ${operation} access to ${resolvedPath}`,
    );
  }
}
