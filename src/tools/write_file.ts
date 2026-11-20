import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "../types.js";
import { assertWithinWorkspace, resolveToolPath } from "./workspace.js";

export const writeFileTool: Tool = {
  name: "write_file",
  // Path permission replaces the former dangerous-tool approval for file
  // tools; confirmation behavior is governed by PATH_APPROVAL.
  description:
    "Write content to a file. Creates the file if it does not exist, or overwrites if it does. Returns a success message with the number of bytes written.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to write (relative or absolute)",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },

  accessRequests(args, context) {
    return [{ path: resolveToolPath(args.path, context), operation: "write" }];
  },

  async execute(args, context) {
    const filePath = resolveToolPath(args.path, context);
    const content = args.content as string;
    const signal = context?.signal;

    try {
      if (signal?.aborted) throw new Error("aborted");
      const resolved = filePath;
      await assertWithinWorkspace(resolved);
      const dir = path.dirname(resolved);
      // fs.mkdir does not take a signal; the pre-check plus the writeFile
      // signal below cover cancellation.
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(resolved, content, { encoding: "utf-8", signal });
      // Report bytes (UTF-8) rather than UTF-16 code units: content.length
      // counts surrogate pairs twice, which does not match any real file size.
      return {
        content: `Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${filePath}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Error writing file: ${msg}`, isError: true };
    }
  },
};
