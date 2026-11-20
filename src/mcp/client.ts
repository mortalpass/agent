import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export class McpConnection {
  readonly name: string;
  private client: Client;

  private constructor(name: string, client: Client) {
    this.name = name;
    this.client = client;
  }

  static async connect(config: McpServerConfig): Promise<McpConnection> {
    const transport = config.url
      ? new SSEClientTransport(new URL(config.url))
      : new StdioClientTransport({
          command: config.command!,
          args: config.args,
          // Explicit env so the behavior does not depend on the SDK version's
          // default for a missing `env` field.
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            ...config.env,
          },
        });

    const client = new Client({
      name: "agent",
      version: "0.1.0",
    });
    await client.connect(transport);
    return new McpConnection(config.name, client);
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const { tools } = await this.client.listTools();
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    const requestOptions: RequestOptions = {};
    if (options?.signal) requestOptions.signal = options.signal;

    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      requestOptions,
    );
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (result.isError) {
      return `MCP tool error: ${text || "(no error detail)"}`;
    }
    return text || "(no text content returned)";
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
