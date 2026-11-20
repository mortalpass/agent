import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";

const registry = createDefaultRegistry();
import {
  createPathAccessHandler,
  PathPermissionStore,
} from "../src/permissions.js";
import type { PathAccessDecision, PathAccessRequest } from "../src/types.js";

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    id: "call_1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

interface Harness {
  decisions: PathAccessDecision[];
  asks: PathAccessRequest[];
  handler: (request: PathAccessRequest) => Promise<PathAccessDecision>;
}

function harness(
  ...decisions: PathAccessDecision[]
): { harness: Harness } & Harness {
  const h: Harness = {
    decisions,
    asks: [],
    async handler(request) {
      h.asks.push(request);
      return h.decisions.shift() ?? "deny";
    },
  };
  return Object.assign({ harness: h }, h);
}

test("PathPermissionStore grants exact paths only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permstore-"));
  try {
    const siblingA = path.join(dir, "a.txt");
    const siblingB = path.join(dir, "b.txt");
    await fs.writeFile(siblingA, "a");

    const store = new PathPermissionStore();
    await store.allow(siblingA);
    assert.ok(await store.isAllowed(siblingA));
    assert.ok(await store.isAllowed(path.join(dir, "a.txt")));
    // Same directory, different file: NOT covered (exact-path grants).
    assert.equal(await store.isAllowed(siblingB), false);
    assert.deepEqual(store.list(), [await fs.realpath(siblingA)]);

    store.clear();
    assert.deepEqual(store.list(), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("PathPermissionStore matches through symlinks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permsymlink-"));
  try {
    const realDir = path.join(dir, "real");
    await fs.mkdir(realDir);
    const link = path.join(dir, "link");
    await fs.symlink(realDir, link);
    // Same file reachable via the symlink and the real path: an exact-path
    // grant for either form covers both after realpath normalization.
    const viaReal = path.join(realDir, "f.txt");
    const viaLink = path.join(link, "f.txt");
    await fs.writeFile(viaReal, "x");

    const store = new PathPermissionStore();
    await store.allow(viaLink);
    assert.ok(await store.isAllowed(viaLink));
    assert.ok(await store.isAllowed(viaReal));
    const linked = await fs.realpath(viaReal);
    assert.ok(await store.isAllowed(linked));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("createPathAccessHandler remembers session grants only", async () => {
  const store = new PathPermissionStore();
  const h = harness("session", "once", "deny");
  let calls = 0;
  const handler = createPathAccessHandler({
    store,
    prompt: async (request) => {
      calls++;
      return h.handler(request);
    },
  });

  const request = {
    tool: "read_file",
    operation: "read" as const,
    path: "/tmp/target",
  };

  // session: asked once, then remembered for the exact same path.
  assert.equal(await handler({ ...request, path: "/tmp/target" }), "session");
  assert.equal(await handler({ ...request, path: "/tmp/target" }), "once");
  assert.equal(calls, 1);
  // A different path asks again.
  assert.equal(await handler({ ...request, path: "/tmp/other" }), "once");
  assert.equal(calls, 2);
  // Denials propagate and are not remembered.
  assert.equal(await handler({ ...request, path: "/tmp/third" }), "deny");
  assert.equal(await handler({ ...request, path: "/tmp/third" }), "deny");
  assert.equal(calls, 4);
  // /tmp/target still covered by the session grant even after denials.
  assert.ok(await store.isAllowed("/tmp/target"));
});

test("denied access blocks the tool before any fs operation", async () => {
  const missing = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "permdeny-")),
    "missing.txt",
  );
  const h = harness("deny");
  const result = await executeTool(toolCall("read_file", { path: missing }), {
    pathAccess: h.handler,
    registry,
  });
  assert.match(result.content, /Access denied/);
  assert.match(result.content, /read access/);
  assert.equal(h.asks.length, 1);
  assert.equal(h.asks[0].operation, "read");
  assert.equal(h.asks[0].tool, "read_file");
  // Denial happened before touching the filesystem (no stat error surfaced).
  assert.equal(result.content.includes("Error reading file"), false);
});

test("a one-time grant asks again on the next call", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permonce-"));
  try {
    const file = path.join(dir, "f.txt");
    await fs.writeFile(file, "hello");
    const h = harness("once", "once");
    const read = () =>
      executeTool(toolCall("read_file", { path: file }), {
        pathAccess: h.handler,
        registry,
      });
    assert.equal((await read()).content, "hello");
    assert.equal((await read()).content, "hello");
    assert.equal(h.asks.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a session grant answers follow-up calls in the same directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permsession-"));
  try {
    const file = path.join(dir, "f.txt");
    await fs.writeFile(file, "x");
    const other = path.join(dir, "g.txt");
    await fs.writeFile(other, "y");

    // One session grant for f.txt plus one "once" for the sibling prompt.
    // Wrap the decision source exactly like the CLI does, since session
    // memory lives in createPathAccessHandler; the store is shared across
    // calls because that is what makes the session grant persist.
    const h = harness("session", "once");
    const store = new PathPermissionStore();
    const read = (p: string) =>
      executeTool(toolCall("read_file", { path: p }), {
        pathAccess: createPathAccessHandler({ store, prompt: h.handler }),
        registry,
      });
    assert.equal((await read(file)).content, "x");
    assert.equal(h.asks.length, 1);
    // Sibling file: still prompted (exact-path grants), "once" is applied.
    assert.equal((await read(other)).content, "y");
    assert.equal(h.asks.length, 2);
    // Same file again: remembered, no new prompt.
    assert.equal((await read(file)).content, "x");
    assert.equal(h.asks.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("list_files and write_file declare their operations", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permops-"));
  try {
    const h = harness("deny", "deny");
    await executeTool(toolCall("list_files", { path: dir }), {
      pathAccess: h.handler,
      registry,
    });
    assert.equal(h.asks[0].operation, "list");
    await executeTool(
      toolCall("write_file", { path: path.join(dir, "o.txt"), content: "z" }),
      { pathAccess: h.handler, registry },
    );
    assert.equal(h.asks[1].operation, "write");
    assert.equal(
      await fs
        .readFile(path.join(dir, "o.txt"), "utf-8")
        .catch(() => "blocked"),
      "blocked",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("user deliberation does not consume the tool timeout", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permtimeout-"));
  try {
    const file = path.join(dir, "f.txt");
    await fs.writeFile(file, "slow prompt");
    const handler: PathAccessHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "once";
    };
    const result = await executeTool(toolCall("read_file", { path: file }), {
      pathAccess: handler,
      timeoutMs: 30,
      registry,
    });
    assert.equal(result.content, "slow prompt");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("no handler keeps zero-config behavior", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "permnone-"));
  try {
    const result = await executeTool(
      toolCall("read_file", { path: path.join(dir, "f.txt") }),
      { registry },
    );
    assert.match(result.content, /Error reading file/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
