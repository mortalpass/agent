import * as fs from "node:fs/promises";
import type { Tool, ToolResult } from "../types.js";
import { assertWithinWorkspace, resolveToolPath } from "./workspace.js";

const MAX_READ_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the text content of the file at the given path. Files larger than 256KB are truncated.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to read (relative or absolute)",
      },
    },
    required: ["path"],
  },

  accessRequests(args, context) {
    return [{ path: resolveToolPath(args.path, context), operation: "read" }];
  },

  async execute(args, context): Promise<ToolResult> {
    const filePath = resolveToolPath(args.path, context);
    const signal = context?.signal;

    try {
      if (signal?.aborted) throw new Error("aborted");
      const resolved = filePath;
      await assertWithinWorkspace(resolved);
      const stat = await fs.stat(resolved);
      const handle = await fs.open(resolved, "r");
      try {
        const length = Math.min(stat.size, MAX_READ_BYTES);
        // Read in chunks so an abort between chunks takes effect instead of
        // leaving a stuck read running after the timeout already fired.
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset < length) {
          if (signal?.aborted) throw new Error("aborted");
          const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, length - offset));
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            offset,
          );
          if (bytesRead === 0) break;
          chunks.push(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        let content = Buffer.concat(chunks).toString("utf-8");
        // stat.size may be stale (TOCTOU with the open/read) and offset is
        // what was actually read; a short read means the file ended early,
        // so only append the notice when the read really filled the cap.
        if (offset >= MAX_READ_BYTES && stat.size > offset) {
          content += `\n\n[truncated: showing first ${offset} of ${stat.size} bytes; use a narrower path or split the file]`;
        }
        return { content };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Error reading file: ${msg}`, isError: true };
    }
  },
};
