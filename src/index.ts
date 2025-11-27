import { loadConfig } from "./config.js";
import { ServerPoolManager } from "./pool/manager.js";
import { createApp } from "./server/transport.js";
import { logger } from "./utils/logger.js";

/**
 * Main entry point for the MCP Gateway Server
 */
async function main(): Promise<void> {
  logger.info("Starting MCP Gateway Server");

  // Load configuration
  let config;
  try {
    config = loadConfig();
    logger.info("Configuration loaded", {
      port: config.server.port,
      baseUrl: config.server.baseUrl,
      authEnabled: config.auth.enabled,
      serverCount: config.mcpServers.length,
    });
  } catch (error) {
    logger.error("Failed to load configuration", error as Error);
    process.exit(1);
  }

  // Initialize server pool (don't start servers yet)
  const poolManager = new ServerPoolManager(config.mcpServers);

  // Create Express app
  const app = createApp(config, poolManager);

  // Start HTTP server FIRST so health checks work immediately
  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`MCP Gateway Server listening`, {
      host: config.server.host,
      port: config.server.port,
      baseUrl: config.server.baseUrl,
    });
    logger.info(`Health check: ${config.server.baseUrl}/health`);
    logger.info(`MCP endpoint: ${config.server.baseUrl}/mcp`);
    logger.info(`Documentation: ${config.server.baseUrl}/docs`);
  });

  // Start MCP servers in the background (non-blocking)
  // This allows health checks to pass while servers are connecting
  poolManager.startAll().then(() => {
    logger.info("Server pool initialized", {
      connectedServers: poolManager.connectedCount,
      totalTools: poolManager.toolCount,
    });
  }).catch((error) => {
    logger.error("Failed to initialize server pool", error as Error);
    // Continue - health check still works, just no MCP tools available yet
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully`);

    // Stop accepting new connections
    server.close(() => {
      logger.info("HTTP server closed");
    });

    // Stop all MCP servers
    try {
      await poolManager.stopAll();
      logger.info("All MCP servers stopped");
    } catch (error) {
      logger.error("Error stopping MCP servers", error as Error);
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", reason as Error);
  });
}

// Run
main().catch((error) => {
  logger.error("Fatal error", error as Error);
  process.exit(1);
});
