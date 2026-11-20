import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Never copied into the writable sandbox: package stores (dependencies are
 * installed inside the sandbox instead), caches, and any secret material.
 */
const EXCLUDED_NAMES = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  ".next",
  "coverage",
  ".pytest_cache",
  ".DS_Store",
]);

export function isExcludedCopyEntry(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (/\.(pem|key|crt|p12|pyc)$/i.test(name)) return true;
  if (/^id_(rsa|ed25519|ecdsa)/.test(name)) return true;
  return false;
}

/**
 * Copy the repo into an empty writable sandbox dir (excluding the entries
 * above). The main repo itself is never touched; the copy is the delta target
 * for patches and verification. Returns the number of copied files.
 */
export async function copyRepo(
  repoRoot: string,
  targetDir: string,
): Promise<number> {
  await fs.mkdir(targetDir, { recursive: false });
  let copied = 0;

  const walk = async (src: string, dest: string): Promise<void> => {
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (isExcludedCopyEntry(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(destPath);
        await walk(srcPath, destPath);
        continue;
      }
      if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
        copied += 1;
      }
    }
  };

  await walk(repoRoot, targetDir);
  return copied;
}
