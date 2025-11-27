import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import type { GatewayConfig } from "./types.js";
import { logger } from "./utils/logger.js";

/**
 * Zod schema for configuration validation
 */
const UserConfigSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  token: z.string().min(1),
  scopes: z.array(z.string()),
});

const ServerConfigSchema = z.object({
  port: z.number().int().positive().default(3000),
  host: z.string().default("0.0.0.0"),
  baseUrl: z.string().url(),
});

const AuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  users: z.array(UserConfigSchema).default([]),
});

const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
  requiredScopes: z.array(z.string()).optional(),
});

const GatewayConfigSchema = z.object({
  server: ServerConfigSchema,
  auth: AuthConfigSchema,
  mcpServers: z.array(McpServerConfigSchema).default([]),
});

/**
 * Resolve environment variable references in config values
 * Supports ${VAR_NAME} syntax
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Replace ${VAR_NAME} with environment variable value
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        logger.warn(`Environment variable ${varName} not set, using empty string`);
        return "";
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }

  return obj;
}

/**
 * Load configuration from file
 */
function loadConfigFromFile(path: string): unknown {
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to load config from ${path}: ${message}`);
  }
}

/**
 * Build configuration from environment variables
 */
function loadConfigFromEnv(): Partial<GatewayConfig> {
  const config: Partial<GatewayConfig> = {};

  // Server config from env
  const port = process.env.GATEWAY_PORT || process.env.PORT;
  const host = process.env.GATEWAY_HOST;
  const baseUrl = process.env.GATEWAY_BASE_URL;

  if (port || host || baseUrl) {
    config.server = {
      port: port ? parseInt(port, 10) : 3000,
      host: host || "0.0.0.0",
      baseUrl: baseUrl || `http://localhost:${port || 3000}`,
    };
  }

  // Auth config from env
  const authEnabled = process.env.GATEWAY_AUTH_ENABLED;
  if (authEnabled !== undefined) {
    config.auth = {
      enabled: authEnabled === "true",
      users: [],
    };
  }

  return config;
}

/**
 * Load and validate gateway configuration
 */
export function loadConfig(): GatewayConfig {
  let rawConfig: unknown = {};

  // Priority 1: CONFIG_PATH environment variable
  const configPath = process.env.CONFIG_PATH;
  if (configPath && existsSync(configPath)) {
    logger.info(`Loading config from CONFIG_PATH: ${configPath}`);
    rawConfig = loadConfigFromFile(configPath);
  }
  // Priority 2: ./config.json in working directory
  else if (existsSync("./config.json")) {
    logger.info("Loading config from ./config.json");
    rawConfig = loadConfigFromFile("./config.json");
  }
  // Priority 3: Environment variables only
  else {
    logger.info("Loading config from environment variables");
    rawConfig = loadConfigFromEnv();
  }

  // Resolve environment variable references
  const resolvedConfig = resolveEnvVars(rawConfig);

  // Validate configuration
  const result = GatewayConfigSchema.safeParse(resolvedConfig);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid configuration: ${errors}`);
  }

  return result.data;
}

/**
 * Validate that a user has required scopes
 */
export function hasRequiredScopes(userScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) {
    return true;
  }
  return requiredScopes.every((scope) => userScopes.includes(scope));
}
