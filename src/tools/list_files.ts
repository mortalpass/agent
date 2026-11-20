import * as fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { assertWithinWorkspace, resolveToolPath } from "./workspace.js";

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and directories at the given path. Returns a list of entry names. Directories end with '/'.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "The directory path to list (relative or absolute). Defaults to current directory.",
      },
    },
    required: [],
  },

  accessRequests(args, context) {
    return [{ path: resolveToolPath(args.path, context), operation: "list" }];
  },

  async execute(args, context) {
    const dirPath = resolveToolPath(args.path, context);

    try {
      // list_files has no signal-aware API, so the pre-check + short listing
      // keep timeout handling functional; sandbox maps to the same pattern.
      if (context?.signal?.aborted) throw new Error("aborted");
      const resolved = dirPath;
      await assertWithinWorkspace(resolved);
      const entries = await fs.readdir(resolved, {
        withFileTypes: true,
      });
      const result = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b))
        .join("\n");
      return { content: result || "(empty directory)" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Error listing directory: ${msg}`, isError: true };
    }
  },
};
