import type { Request } from "express";

/**
 * User configuration for static authentication
 */
export interface UserConfig {
  id: string;
  email: string;
  name: string;
  password: string;
  token: string;
  scopes: string[];
}

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  host: string;
  baseUrl: string;
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  enabled: boolean;
  users: UserConfig[];
}

/**
 * Local MCP server configuration
 */
export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  requiredScopes?: string[];
}

/**
 * Complete gateway configuration
 */
export interface GatewayConfig {
  server: ServerConfig;
  auth: AuthConfig;
  mcpServers: McpServerConfig[];
}

/**
 * Authenticated user context attached to requests
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  scopes: string[];
}

/**
 * Express request with authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * MCP Tool definition
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Aggregated tool with source server info
 */
export interface AggregatedTool extends McpTool {
  serverId: string;
  originalName: string;
}

/**
 * Server pool status
 */
export interface ServerStatus {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Gateway health status
 */
export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  uptime: number;
  servers: ServerStatus[];
  timestamp: string;
}
