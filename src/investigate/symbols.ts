import * as path from "node:path";
import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import { glob } from "tinyglobby";
import { searchSource } from "./scan.js";

export interface SymbolReference {
  path: string;
  line: number;
  text: string;
}

export interface SymbolReport {
  symbol: string;
  definitions: SymbolReference[];
  references: SymbolReference[];
  language: "typescript" | "javascript" | "python";
  confidence: number;
  note?: string;
}

const IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
];

const TS_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

function lineOf(source: SourceFile, position: number): number {
  try {
    return source.getLineAndColumnAtPos(position).line;
  } catch {
    return 0;
  }
}

/** TS/JS symbols: exact definitions + references via ts-morph (confidence 1). */
export async function analyzeSymbolTs(
  root: string,
  symbol: string,
): Promise<SymbolReport | null> {
  const files = await glob({
    patterns: [TS_GLOB],
    cwd: root,
    ignore: IGNORES,
    dot: false,
  });
  if (files.length === 0) return null;

  const project = new Project({
    compilerOptions: { allowJs: true },
    skipAddingFilesFromTsConfig: true,
  });
  const sources = project.addSourceFilesAtPaths(
    files.map((f) => path.join(root, f)),
  );

  const definitions: SymbolReference[] = [];
  const references: SymbolReference[] = [];

  for (const source of sources) {
    const relative = path.relative(root, source.getFilePath());
    for (const exported of source.getExportSymbols()) {
      if (exported.getName() !== symbol) continue;
      for (const declaration of exported.getDeclarations()) {
        definitions.push({
          path: relative,
          line: lineOf(source, declaration.getStart()),
          text: declaration.getText().split("\n")[0].slice(0, 160),
        });
      }
    }

    for (const reference of source.getImportDeclarations()) {
      const named = reference.getImportClause()?.getNamedImports() ?? [];
      if (named.some((n) => n.getName() === symbol)) {
        references.push({
          path: relative,
          line: lineOf(source, reference.getStart()),
          text: reference.getText().slice(0, 160),
        });
      }
    }

    if (
      source.getFilePath().endsWith(".ts") ||
      source.getFilePath().endsWith(".tsx")
    ) {
      for (const identifier of source.getDescendantsOfKind(
        SyntaxKind.Identifier,
      )) {
        if (identifier.getText() !== symbol) continue;
        // The declaration itself also registers an Identifier occurrence;
        // keep both — the caller dedupes/labels by file+line overlap.
        references.push({
          path: relative,
          line: lineOf(source, identifier.getStart()),
          text:
            identifier.getParent()?.getText().split("\n")[0].slice(0, 160) ??
            "",
        });
      }
    }
  }

  return {
    symbol,
    definitions: dedupe(definitions),
    references: dedupe(references),
    language: "typescript",
    confidence: 1,
  };
}

/** Python symbols: text/regex based (best effort, confidence < 1). */
export async function analyzeSymbolPython(
  root: string,
  symbol: string,
): Promise<SymbolReport> {
  const definitions = await searchSource(root, `^(def|class)\\s+${symbol}\\b`, {
    glob: "**/*.py",
    maxMatches: 100,
  });
  const usage = await searchSource(root, `\\b${symbol}\\b`, {
    glob: "**/*.py",
    maxMatches: 500,
  });
  const defSet = new Set(definitions.map((d) => `${d.path}:${d.line}`));
  const references = usage.filter((u) => !defSet.has(`${u.path}:${u.line}`));

  return {
    symbol,
    definitions: definitions.map((d) => ({ ...d, text: d.text.slice(0, 160) })),
    references,
    language: "python",
    confidence: definitions.length > 0 ? 0.7 : 0.4,
    note: "Python symbol references are text-based (best effort); callers may be missed for dynamic dispatch or re-exports.",
  };
}

function dedupe(list: SymbolReference[]): SymbolReference[] {
  const seen = new Set<string>();
  const out: SymbolReference[] = [];
  for (const ref of list) {
    const key = `${ref.path}:${ref.line}:${ref.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}
