import type { AggregatedTool, McpTool } from "../types.js";
import type { LocalServerClient } from "./client.js";
import { ToolNotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Separator used for namespacing tools
 */
const NAMESPACE_SEPARATOR = "_";

/**
 * Aggregates tools from multiple MCP servers with namespacing
 */
export class ToolAggregator {
  private aggregatedTools: Map<string, AggregatedTool> = new Map();

  /**
   * Build namespaced tool name
   */
  static buildNamespacedName(serverId: string, toolName: string): string {
    return `${serverId}${NAMESPACE_SEPARATOR}${toolName}`;
  }

  /**
   * Parse namespaced tool name to extract server ID and original tool name
   */
  static parseNamespacedName(namespacedName: string): { serverId: string; toolName: string } | null {
    const separatorIndex = namespacedName.indexOf(NAMESPACE_SEPARATOR);
    if (separatorIndex === -1) {
      return null;
    }

    return {
      serverId: namespacedName.substring(0, separatorIndex),
      toolName: namespacedName.substring(separatorIndex + 1),
    };
  }

  /**
   * Aggregate tools from all connected servers
   */
  aggregate(servers: Map<string, LocalServerClient>): AggregatedTool[] {
    this.aggregatedTools.clear();

    for (const [serverId, client] of servers) {
      if (!client.connected) {
        logger.warn(`Skipping disconnected server ${serverId} during aggregation`);
        continue;
      }

      const tools = client.getTools();
      for (const tool of tools) {
        const namespacedName = ToolAggregator.buildNamespacedName(serverId, tool.name);
        const aggregatedTool: AggregatedTool = {
          ...tool,
          name: namespacedName,
          description: tool.description
            ? `[${client.name}] ${tool.description}`
            : `[${client.name}] ${tool.name}`,
          serverId,
          originalName: tool.name,
        };

        if (this.aggregatedTools.has(namespacedName)) {
          logger.warn(`Duplicate namespaced tool name: ${namespacedName}`);
        }

        this.aggregatedTools.set(namespacedName, aggregatedTool);
      }
    }

    logger.info(`Aggregated ${this.aggregatedTools.size} tools from ${servers.size} servers`);
    return this.getTools();
  }

  /**
   * Get all aggregated tools
   */
  getTools(): AggregatedTool[] {
    return Array.from(this.aggregatedTools.values());
  }

  /**
   * Get a specific aggregated tool by namespaced name
   */
  getTool(namespacedName: string): AggregatedTool | undefined {
    return this.aggregatedTools.get(namespacedName);
  }

  /**
   * Resolve a tool call to its target server and original name
   */
  resolveToolCall(namespacedName: string): { serverId: string; toolName: string } {
    const tool = this.aggregatedTools.get(namespacedName);
    if (!tool) {
      throw new ToolNotFoundError(namespacedName);
    }

    return {
      serverId: tool.serverId,
      toolName: tool.originalName,
    };
  }

  /**
   * Get tools for a specific server
   */
  getToolsForServer(serverId: string): AggregatedTool[] {
    return Array.from(this.aggregatedTools.values()).filter(
      (tool) => tool.serverId === serverId
    );
  }

  /**
   * Get tool count
   */
  get toolCount(): number {
    return this.aggregatedTools.size;
  }

  /**
   * Convert aggregated tools to MCP tool format (without internal metadata)
   */
  toMcpTools(): McpTool[] {
    return Array.from(this.aggregatedTools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}
