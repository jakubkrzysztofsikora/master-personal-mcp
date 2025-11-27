import type { McpServerConfig, ServerStatus, AggregatedTool, AuthenticatedUser } from "../types.js";
import { LocalServerClient } from "./client.js";
import { ToolAggregator } from "./aggregator.js";
import { ServerNotFoundError, AuthorizationError } from "../utils/errors.js";
import { hasRequiredScopes } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Manages the pool of local MCP server connections
 */
export class ServerPoolManager {
  private servers: Map<string, LocalServerClient> = new Map();
  private readonly aggregator: ToolAggregator;
  private readonly serverConfigs: McpServerConfig[];

  constructor(serverConfigs: McpServerConfig[]) {
    this.serverConfigs = serverConfigs;
    this.aggregator = new ToolAggregator();
    logger.info(`Server pool manager initialized with ${serverConfigs.length} server configs`);
  }

  /**
   * Start all enabled servers
   */
  async startAll(): Promise<void> {
    logger.info("Starting all enabled MCP servers");

    const enabledConfigs = this.serverConfigs.filter((config) => config.enabled);
    const startPromises = enabledConfigs.map(async (config) => {
      try {
        const client = new LocalServerClient(config);
        await client.connect();
        this.servers.set(config.id, client);
      } catch (error) {
        logger.error(`Failed to start server ${config.id}`, error as Error);
        // Continue with other servers
      }
    });

    await Promise.all(startPromises);

    // Aggregate tools from all connected servers
    this.refreshAggregation();

    logger.info(`Server pool started`, {
      total: enabledConfigs.length,
      connected: this.servers.size,
    });
  }

  /**
   * Stop all servers
   */
  async stopAll(): Promise<void> {
    logger.info("Stopping all MCP servers");

    const stopPromises = Array.from(this.servers.values()).map((client) =>
      client.disconnect()
    );

    await Promise.all(stopPromises);
    this.servers.clear();
    this.refreshAggregation();

    logger.info("All servers stopped");
  }

  /**
   * Refresh tool aggregation from all connected servers
   */
  refreshAggregation(): void {
    this.aggregator.aggregate(this.servers);
  }

  /**
   * Get a specific server client
   */
  getServer(serverId: string): LocalServerClient {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new ServerNotFoundError(serverId);
    }
    return server;
  }

  /**
   * Check if a server exists and is connected
   */
  hasServer(serverId: string): boolean {
    const server = this.servers.get(serverId);
    return server !== undefined && server.connected;
  }

  /**
   * Get all aggregated tools
   */
  getTools(): AggregatedTool[] {
    return this.aggregator.getTools();
  }

  /**
   * Get tools filtered by user scopes
   */
  getToolsForUser(user?: AuthenticatedUser): AggregatedTool[] {
    const allTools = this.aggregator.getTools();

    if (!user) {
      return allTools;
    }

    return allTools.filter((tool) => {
      const server = this.servers.get(tool.serverId);
      if (!server) {
        return false;
      }
      return hasRequiredScopes(user.scopes, server.requiredScopes);
    });
  }

  /**
   * Route a tool call to the appropriate server
   */
  async routeToolCall(
    namespacedToolName: string,
    args: Record<string, unknown>,
    user?: AuthenticatedUser
  ): Promise<unknown> {
    const { serverId, toolName } = this.aggregator.resolveToolCall(namespacedToolName);
    const server = this.getServer(serverId);

    // Check user has required scopes for this server
    if (user && !hasRequiredScopes(user.scopes, server.requiredScopes)) {
      throw new AuthorizationError(
        `Insufficient scopes to access server ${serverId}`
      );
    }

    logger.info(`Routing tool call`, {
      namespacedToolName,
      serverId,
      toolName,
      userId: user?.id,
    });

    return await server.callTool(toolName, args);
  }

  /**
   * Get status of all servers
   */
  getStatus(): ServerStatus[] {
    return this.serverConfigs.map((config) => {
      const client = this.servers.get(config.id);
      return {
        id: config.id,
        name: config.name,
        connected: client?.connected ?? false,
        toolCount: client ? client.getTools().length : 0,
        error: client?.connected ? undefined : "Not connected",
      };
    });
  }

  /**
   * Get count of connected servers
   */
  get connectedCount(): number {
    return Array.from(this.servers.values()).filter((s) => s.connected).length;
  }

  /**
   * Get total tool count
   */
  get toolCount(): number {
    return this.aggregator.toolCount;
  }
}
