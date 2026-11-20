import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildInvestigationPathAccess } from "../src/investigate/access.js";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import type { PathAccessRequest } from "../src/types.js";

const registry = createDefaultRegistry();

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    id: "c1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acc-repo-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "access-fixture",
      devDependencies: { jest: "^29.0.0" },
      scripts: { test: "jest", build: "tsc" },
    }),
  );
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, name: "access-fixture" }),
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "app.ts"),
    'import moment from "moment";\n\nexport const label = (iso: string): string =>\n  moment(iso).format("YYYY-MM-DD");\n',
  );
  await fs.writeFile(
    path.join(root, "src", "app.test.ts"),
    'import { label } from "./app";\n\ntest("label", () => expect(label("2024-01-02")).toBe("2024-01-02"));\n',
  );
  return root;
}

test("investigation tools request access to the repo root, not the process cwd", async () => {
  const repoRoot = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "acc-out-"));
  const seen: PathAccessRequest[] = [];
  const base = buildInvestigationPathAccess(repoRoot, out);
  const recordingHandler = (request: PathAccessRequest) => {
    seen.push(request);
    return base(request);
  };

  try {
    const ctx = { registry, repoRoot, pathAccess: recordingHandler };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["repo_profile", {}],
      ["search_code", { pattern: "moment" }],
      ["impact_analyze", { files: ["src/app.ts"] }],
      ["test_select", { files: ["src/app.ts"] }],
      ["find_symbol", { symbol: "label" }],
    ];
    for (const [name, args] of calls) {
      const result = await executeTool(toolCall(name, args), ctx);
      assert.equal(
        result.isError,
        undefined,
        `${name} should not be denied: ${result.content}`,
      );
      assert.doesNotMatch(result.content, /Access denied/);
    }

    assert.ok(seen.length >= calls.length);
    for (const request of seen) {
      assert.equal(
        request.path.startsWith(repoRoot + path.sep) ||
          request.path === repoRoot,
        true,
        `access request must target the investigation repo: ${request.path}`,
      );
      assert.notEqual(
        request.path,
        process.cwd(),
        "access request must not fall back to the agent checkout",
      );
    }
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("relative file-tool paths resolve inside the investigation repo", async () => {
  const repoRoot = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "acc-out-"));
  try {
    const ctx = {
      registry,
      repoRoot,
      pathAccess: buildInvestigationPathAccess(repoRoot, out),
    };

    // "." used to resolve to the agent checkout and get denied; it must now
    // list the repository under investigation.
    const listing = await executeTool(
      toolCall("list_files", { path: "." }),
      ctx,
    );
    assert.equal(listing.isError, undefined, listing.content);
    assert.match(listing.content, /src\//);
    assert.match(listing.content, /package\.json/);

    const read = await executeTool(
      toolCall("read_file", { path: "src/app.ts" }),
      ctx,
    );
    assert.equal(read.isError, undefined, read.content);
    assert.match(read.content, /moment/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("investigation path policy keeps the repo read-only and writes only under out", async () => {
  const repoRoot = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "acc-out-"));
  try {
    const access = buildInvestigationPathAccess(repoRoot, out);
    const request = (
      operation: PathAccessRequest["operation"],
      target: string,
    ): PathAccessRequest => ({ tool: "test", operation, path: target });

    assert.equal(
      access(request("read", path.join(repoRoot, "src/app.ts"))),
      "session",
    );
    assert.equal(access(request("list", repoRoot)), "session");
    assert.equal(
      access(request("write", path.join(repoRoot, "src/app.ts"))),
      "deny",
    );
    assert.equal(
      access(request("write", path.join(repoRoot, "new-file.ts"))),
      "deny",
    );
    assert.equal(
      access(request("write", path.join(out, "artifacts/run/x.txt"))),
      "session",
    );
    assert.equal(access(request("read", path.dirname(repoRoot))), "deny");

    const ctx = {
      registry,
      repoRoot,
      pathAccess: buildInvestigationPathAccess(repoRoot, out),
    };
    const denied = await executeTool(
      toolCall("write_file", { path: "src/app.ts", content: "overwritten" }),
      ctx,
    );
    assert.equal(denied.isError, true);
    assert.match(denied.content, /Access denied/);
    const untouched = await fs.readFile(
      path.join(repoRoot, "src", "app.ts"),
      "utf-8",
    );
    assert.match(untouched, /moment/);

    const allowed = await executeTool(
      toolCall("write_file", {
        path: path.join(out, "notes.txt"),
        content: "evidence",
      }),
      ctx,
    );
    assert.equal(allowed.isError, undefined, allowed.content);
    assert.equal(
      await fs.readFile(path.join(out, "notes.txt"), "utf-8"),
      "evidence",
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});
