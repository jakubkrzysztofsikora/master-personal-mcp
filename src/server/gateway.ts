import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerPoolManager } from "../pool/manager.js";
import type { AuthenticatedUser } from "../types.js";
import { logger } from "../utils/logger.js";

// Type for MCP tool result content
type TextContent = {
  type: "text";
  text: string;
};

type ToolResult = {
  content: TextContent[];
  isError?: boolean;
};

/**
 * Creates and configures the MCP Gateway Server
 * Dynamically registers all tools from the pool as individual handlers
 */
export function createGatewayServer(
  poolManager: ServerPoolManager,
  user?: AuthenticatedUser
): McpServer {
  const server = new McpServer({
    name: "mcp-gateway-server",
    version: "1.0.0",
  });

  // Get tools available for this user
  const tools = poolManager.getToolsForUser(user);

  logger.info(`Creating gateway server with ${tools.length} tools`, {
    userId: user?.id,
  });

  // Register each tool from the pool
  for (const tool of tools) {
    // Use an empty shape - the tool accepts dynamic arguments
    // that will be passed to the underlying MCP server
    server.tool(
      tool.name,
      tool.description || `Tool: ${tool.name}`,
      {}, // Empty shape - accepts any args via passthrough
      async (args: Record<string, unknown>): Promise<ToolResult> => {
        logger.info(`Tool call received`, {
          tool: tool.name,
          userId: user?.id,
        });

        try {
          const result = await poolManager.routeToolCall(tool.name, args, user);

          // The result from callTool should already be in MCP format
          // If it has content array, return as-is; otherwise wrap it
          if (
            result &&
            typeof result === "object" &&
            "content" in result &&
            Array.isArray((result as ToolResult).content)
          ) {
            return result as ToolResult;
          }

          // Wrap non-standard responses
          return {
            content: [
              {
                type: "text",
                text:
                  typeof result === "string"
                    ? result
                    : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(`Tool call failed`, err, { tool: tool.name });

          return {
            content: [
              {
                type: "text",
                text: `Error: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

/**
 * Creates a stateless gateway server factory that creates per-request servers
 */
export class GatewayServerFactory {
  constructor(private readonly poolManager: ServerPoolManager) {}

  /**
   * Create a new gateway server instance for a request
   */
  createServer(user?: AuthenticatedUser): McpServer {
    return createGatewayServer(this.poolManager, user);
  }

  /**
   * Get the pool manager
   */
  getPoolManager(): ServerPoolManager {
    return this.poolManager;
  }
}
