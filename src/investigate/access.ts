import * as path from "node:path";
import type { PathAccessHandler } from "../types.js";

/**
 * Path policy for investigation sessions: the repository under investigation
 * is readable (and listable) but never writable — writes go through the
 * sandbox/patch tools and land under the output directory. The output root is
 * fully allowed (artifacts, sandbox copies, logs).
 */
export function buildInvestigationPathAccess(
  repoRoot: string,
  outRoot: string,
): PathAccessHandler {
  const repo = path.resolve(repoRoot);
  const out = path.resolve(outRoot);
  const within = (base: string, target: string): boolean =>
    target === base || target.startsWith(base + path.sep);

  return (request) => {
    if (within(out, request.path)) return "session";
    if (request.operation !== "write" && within(repo, request.path)) {
      return "session";
    }
    return "deny";
  };
}
