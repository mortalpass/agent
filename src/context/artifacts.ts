import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ArtifactRef {
  id: string;
  kind: string;
  path: string;
  size: number;
  sha256: string;
}

/**
 * Per-run artifact store: oversized tool outputs are written to disk and the
 * agent context only carries a summary plus the reference (guarding the
 * per-tool-result truncation in MessageManager).
 */
export class ArtifactStore {
  private entries: ArtifactRef[] = [];
  private seq = 0;

  private constructor(private readonly dir: string) {}

  static async create(outDir: string): Promise<ArtifactStore> {
    const runId = `run-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(outDir, "artifacts", runId);
    await fs.mkdir(dir, { recursive: true });
    return new ArtifactStore(dir);
  }

  /** Directory all artifacts of this run live in. */
  get root(): string {
    return this.dir;
  }

  async add(kind: string, name: string, content: string): Promise<ArtifactRef> {
    this.seq += 1;
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = path.join(
      this.dir,
      `${String(this.seq).padStart(3, "0")}-${safeName}`,
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf-8");

    const ref: ArtifactRef = {
      id: `${String(this.seq).padStart(3, "0")}-${safeName}`,
      kind,
      path: file,
      size: Buffer.byteLength(content, "utf-8"),
      sha256: createHash("sha256").update(content).digest("hex").slice(0, 16),
    };
    this.entries.push(ref);
    await this.writeIndex();
    return ref;
  }

  /** References written so far (also persisted as index.json). */
  list(): ArtifactRef[] {
    return [...this.entries];
  }

  private async writeIndex(): Promise<void> {
    await fs.writeFile(
      path.join(this.dir, "index.json"),
      JSON.stringify(this.entries, null, 2),
      "utf-8",
    );
  }
}
