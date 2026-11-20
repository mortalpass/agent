import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ToolRegistry } from "../tools/registry.js";
import { McpConnection, type McpServerConfig } from "./client.js";
import { mcpToolToTool } from "./tools.js";

export type { McpServerConfig } from "./client.js";

export function parseMcpServers(raw: string): McpServerConfig[] {
  if (!raw.trim()) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn("MCP_SERVERS must be a JSON array; ignoring");
      return [];
    }

    const servers: McpServerConfig[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const cfg = entry as Record<string, unknown>;
      if (typeof cfg.name !== "string" || !cfg.name.trim()) {
        logger.warn("MCP server entry missing a name; skipping");
        continue;
      }
      if (typeof cfg.url !== "string" && typeof cfg.command !== "string") {
        logger.warn(
          `MCP server "${cfg.name}" needs either "url" or "command"; skipping`,
        );
        continue;
      }
      servers.push({
        name: cfg.name.trim(),
        command: typeof cfg.command === "string" ? cfg.command : undefined,
        args: Array.isArray(cfg.args)
          ? cfg.args.filter((a): a is string => typeof a === "string")
          : undefined,
        env:
          cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
            ? Object.fromEntries(
                Object.entries(cfg.env).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string",
                ),
              )
            : undefined,
        url: typeof cfg.url === "string" ? cfg.url : undefined,
      });
    }
    return servers;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`Invalid MCP_SERVERS JSON: ${msg}`);
    return [];
  }
}

export async function connectMcpServers(
  serverConfigs: McpServerConfig[] | undefined,
  registry: ToolRegistry,
): Promise<McpConnection[]> {
  const servers = serverConfigs ?? parseMcpServers(config.mcp.servers);
  const connections: McpConnection[] = [];

  for (const cfg of servers) {
    try {
      const connection = await McpConnection.connect(cfg);
      const tools = await connection.listTools();
      for (const tool of tools) {
        registry.register(mcpToolToTool(connection, tool));
      }
      connections.push(connection);
      logger.info(`MCP server "${cfg.name}": ${tools.length} tool(s)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`MCP server "${cfg.name}" failed to connect: ${msg}`);
    }
  }

  return connections;
}

export async function closeMcpConnections(
  connections: McpConnection[],
): Promise<void> {
  await Promise.all(
    connections.map(async (connection) => {
      try {
        await connection.close();
      } catch (error) {
        logger.debug(
          `Failed to close MCP server "${connection.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),
  );
}
