import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { glob } from "tinyglobby";
import { execa } from "execa";
import pLimit from "p-limit";
import { logger } from "../logger.js";

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
];

const SOURCE_GLOB =
  "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,md,json,yaml,yml,txt}";

async function hasRipgrep(): Promise<boolean> {
  try {
    await execa("rg", ["--version"], { reject: false });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

/** ripgrep-run when installed; falls back to a Node scan so Windows/minimal
 * hosts still work (deterministic, slower). */
export async function searchSource(
  root: string,
  pattern: string,
  options: { glob?: string; maxMatches?: number } = {},
): Promise<SearchHit[]> {
  const max = options.maxMatches ?? 500;
  if (await hasRipgrep()) {
    const cli = await searchWithRipgrep(root, pattern, options, max);
    if (cli) return cli;
  }
  return searchWithNode(root, pattern, max);
}

async function searchWithRipgrep(
  root: string,
  pattern: string,
  options: { glob?: string },
  max: number,
): Promise<SearchHit[] | null> {
  const args = [
    "--json",
    "-e",
    pattern,
    "-g",
    options.glob ?? SOURCE_GLOB,
    root,
  ];
  for (const ignore of DEFAULT_IGNORES) {
    args.push("-g", `!${ignore.replace(/\*\*\//g, "").replace(/\*\*/g, "*")}`);
  }
  try {
    const { stdout } = await execa("rg", args, { maxBuffer: 64 * 1024 * 1024 });
    return parseRipgrepJson(stdout, root, max);
  } catch (error) {
    logger.warn(`ripgrep failed; falling back to Node scan: ${String(error)}`);
    return null;
  }
}

function parseRipgrepJson(
  stdout: string,
  root: string,
  max: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          matches?: Array<{ text?: string; line_number?: number }>;
        };
      };
      if (event.type !== "match" || !event.data?.matches) continue;
      const file = event.data.path?.text ?? "";
      for (const match of event.data.matches) {
        hits.push({
          path: path.isAbsolute(file) ? path.relative(root, file) : file,
          line: match.line_number ?? 0,
          text: (match.text ?? "").trim().slice(0, 200),
        });
        if (hits.length >= max) return hits;
      }
    } catch {
      // ripgrep --json lines are newline-separated JSON objects; skip garbage
    }
  }
  return hits;
}

async function searchWithNode(
  root: string,
  pattern: string,
  max: number,
): Promise<SearchHit[]> {
  const regex = new RegExp(pattern, "gm");
  const files = await glob({
    patterns: [SOURCE_GLOB],
    cwd: root,
    ignore: DEFAULT_IGNORES,
    dot: false,
  });
  const limited = pLimit(8);
  const hits: SearchHit[] = [];

  const tasks = files.map((file) =>
    limited(async () => {
      if (hits.length >= max) return;
      const absolute = path.join(root, file);
      const info = await stat(absolute).catch(() => null);
      if (!info || !info.isFile() || info.size > 1024 * 1024) return;
      const content = await readFile(absolute, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          hits.push({
            path: file,
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
          });
          if (hits.length >= max + 1) return; // allow one extra to detect overflow
        }
      }
    }),
  );
  await Promise.all(tasks);
  return hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}
