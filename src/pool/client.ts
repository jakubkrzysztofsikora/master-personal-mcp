import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig, McpTool } from "../types.js";
import { ServerConnectionError, ServerExecutionError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Client wrapper for a local MCP server connection via stdio
 */
export class LocalServerClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: McpTool[] = [];
  private _connected = false;

  constructor(private readonly config: McpServerConfig) {}

  /**
   * Get server ID
   */
  get id(): string {
    return this.config.id;
  }

  /**
   * Get server name
   */
  get name(): string {
    return this.config.name;
  }

  /**
   * Get server description
   */
  get description(): string | undefined {
    return this.config.description;
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Get required scopes for this server
   */
  get requiredScopes(): string[] {
    return this.config.requiredScopes || [];
  }

  /**
   * Connect to the local MCP server
   */
  async connect(): Promise<void> {
    if (this._connected) {
      logger.warn(`Server ${this.id} already connected`);
      return;
    }

    try {
      logger.info(`Connecting to server ${this.id}`, {
        command: this.config.command,
        args: this.config.args,
      });

      // Resolve environment variables
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
      };
      if (this.config.env) {
        for (const [key, value] of Object.entries(this.config.env)) {
          env[key] = value;
        }
      }

      // Create transport
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.cwd,
        env,
      });

      // Create client
      this.client = new Client({
        name: `gateway-client-${this.id}`,
        version: "1.0.0",
      });

      // Connect
      await this.client.connect(this.transport);
      this._connected = true;

      // Fetch capabilities
      await this.refreshCapabilities();

      logger.info(`Connected to server ${this.id}`, { toolCount: this.tools.length });
    } catch (error) {
      this._connected = false;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Failed to connect to server ${this.id}`, err);
      throw new ServerConnectionError(this.id, err);
    }
  }

  /**
   * Refresh cached capabilities from the server
   */
  async refreshCapabilities(): Promise<void> {
    if (!this.client || !this._connected) {
      throw new ServerConnectionError(this.id);
    }

    try {
      const result = await this.client.listTools();
      this.tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as McpTool["inputSchema"],
      }));
      logger.debug(`Refreshed capabilities for server ${this.id}`, {
        toolCount: this.tools.length,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Failed to refresh capabilities for server ${this.id}`, err);
      throw err;
    }
  }

  /**
   * Get cached tools
   */
  getTools(): McpTool[] {
    return [...this.tools];
  }

  /**
   * Call a tool on this server
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || !this._connected) {
      throw new ServerConnectionError(this.id);
    }

    try {
      logger.debug(`Calling tool ${name} on server ${this.id}`, { args });
      const result = await this.client.callTool({ name, arguments: args });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Failed to call tool ${name} on server ${this.id}`, err);
      throw new ServerExecutionError(this.id, name, err);
    }
  }

  /**
   * Disconnect from the server
   */
  async disconnect(): Promise<void> {
    if (!this._connected) {
      return;
    }

    try {
      logger.info(`Disconnecting from server ${this.id}`);

      if (this.client) {
        await this.client.close();
      }

      this._connected = false;
      this.client = null;
      this.transport = null;
      this.tools = [];

      logger.info(`Disconnected from server ${this.id}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Error disconnecting from server ${this.id}`, err);
      // Force cleanup even on error
      this._connected = false;
      this.client = null;
      this.transport = null;
      this.tools = [];
    }
  }
}
