import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayConfig, AuthenticatedRequest, HealthStatus } from "../types.js";
import { GatewayOAuthProvider } from "../auth/oauth.js";
import { GatewayServerFactory } from "./gateway.js";
import { ServerPoolManager } from "../pool/manager.js";
import { GatewayError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const startTime = Date.now();

// Map to store transports by session ID (following SDK pattern)
const transports: Record<string, StreamableHTTPServerTransport> = {};

/**
 * Create and configure the Express application
 */
export function createApp(config: GatewayConfig, poolManager: ServerPoolManager): Express {
  const app = express();

  // Middleware - CORS must allow all origins for Claude.ai
  app.use(cors({
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Last-Event-ID"],
    exposedHeaders: ["Mcp-Session-Id"],
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`, {
      userAgent: req.headers["user-agent"],
      sessionId: req.headers["mcp-session-id"],
    });
    next();
  });

  // OAuth provider
  const oauthProvider = new GatewayOAuthProvider(config);
  const baseUrl = new URL(config.server.baseUrl);

  // Gateway server factory
  const gatewayFactory = new GatewayServerFactory(poolManager);

  // Root route - simple ping
  app.get("/", (_req: Request, res: Response) => {
    res.json({ service: "mcp-gateway-server", status: "running" });
  });

  // Health check endpoint (no auth required)
  app.get("/health", (_req: Request, res: Response) => {
    const status: HealthStatus = {
      status: poolManager.connectedCount > 0 ? "ok" : "degraded",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      servers: poolManager.getStatus(),
      timestamp: new Date().toISOString(),
    };
    res.json(status);
  });

  // ==================== OAuth Configuration ====================
  // Claude.ai expects OAuth endpoints at /oauth/* paths per MCP spec
  const mcpEndpoint = new URL("/mcp", baseUrl);

  // Create custom OAuth metadata with /oauth/* paths (Claude.ai requirement)
  const oauthMetadata = {
    issuer: baseUrl.href,
    service_documentation: new URL("/docs", baseUrl).href,
    authorization_endpoint: new URL("/oauth/authorize", baseUrl).href,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint: new URL("/oauth/token", baseUrl).href,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["tools:read", "tools:execute"],
    revocation_endpoint: new URL("/oauth/revoke", baseUrl).href,
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
    registration_endpoint: new URL("/oauth/register", baseUrl).href,
  };

  // Protected resource metadata (RFC 9728)
  const protectedResourceMetadata = {
    resource: mcpEndpoint.href,
    authorization_servers: [baseUrl.href],
    scopes_supported: ["tools:read", "tools:execute"],
    resource_name: "MCP Gateway",
    resource_documentation: new URL("/docs", baseUrl).href,
  };

  // Serve OAuth Authorization Server Metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json(oauthMetadata);
  });

  // Serve OAuth Protected Resource Metadata (RFC 9728)
  app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata);
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata);
  });

  // Mount OAuth router at /oauth (endpoints will be at /oauth/authorize, /oauth/token, etc.)
  app.use("/oauth", mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: baseUrl,
    baseUrl: baseUrl,  // The router will create /authorize, /token internally
    resourceServerUrl: mcpEndpoint,
    serviceDocumentationUrl: new URL("/docs", baseUrl),
    scopesSupported: ["tools:read", "tools:execute"],
    resourceName: "MCP Gateway",
  }));

  // Custom callback handler for login form submission
  app.post("/oauth/authorize/callback", (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, scope, code_challenge, email, password } = req.body;

    // Get the client (may be a promise)
    Promise.resolve(oauthProvider.clientsStore.getClient(client_id))
      .then((client) => {
        if (!client) {
          res.status(400).json({ error: "invalid_client", error_description: "Unknown client" });
          return;
        }

        // Authenticate user
        const user = oauthProvider.authenticateUser(email, password);
        if (!user) {
          // Redirect back to authorize with error shown
          const errorUrl = `/oauth/authorize?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&code_challenge=${encodeURIComponent(code_challenge)}&code_challenge_method=S256&state=${encodeURIComponent(state || "")}&scope=${encodeURIComponent(scope || "")}&error=invalid_credentials`;
          res.redirect(errorUrl);
          return;
        }

        // Create authorization code
        const scopes = scope?.split(" ") || ["tools:read", "tools:execute"];
        const code = oauthProvider.createAuthorizationCode(
          client_id,
          redirect_uri,
          user.id,
          scopes,
          code_challenge
        );

        // Redirect back to client with code
        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set("code", code);
        if (state) redirectUrl.searchParams.set("state", state);

        logger.info("Authorization successful, redirecting", { clientId: client_id, userId: user.id });
        res.redirect(redirectUrl.toString());
      })
      .catch((err) => {
        logger.error("Error in authorize callback", err as Error);
        res.status(500).json({ error: "server_error", error_description: "Internal error" });
      });
  });

  // Simple docs endpoint
  app.get("/docs", (_req: Request, res: Response) => {
    const tools = poolManager.getTools();
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>MCP Gateway - Documentation</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { color: #333; }
    h2 { color: #666; margin-top: 2rem; }
    .tool { background: #f5f5f5; padding: 1rem; margin: 0.5rem 0; border-radius: 4px; }
    .tool-name { font-weight: bold; color: #0066cc; }
    .tool-desc { color: #666; margin-top: 0.5rem; }
    pre { background: #eee; padding: 1rem; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>MCP Gateway Server</h1>
  <p>This gateway aggregates multiple MCP servers and exposes them through a single endpoint.</p>

  <h2>Endpoint</h2>
  <pre>POST ${config.server.baseUrl}/mcp</pre>

  <h2>Authentication</h2>
  <p>This server uses OAuth 2.1. Connect via Claude.ai or use a Bearer token.</p>

  <h2>Available Tools (${tools.length})</h2>
  ${tools.map((tool) => `
  <div class="tool">
    <div class="tool-name">${tool.name}</div>
    <div class="tool-desc">${tool.description || "No description"}</div>
  </div>
  `).join("")}

  <h2>Server Status</h2>
  ${poolManager.getStatus().map((s) => `
  <div class="tool">
    <div class="tool-name">${s.name} (${s.id})</div>
    <div class="tool-desc">Status: ${s.connected ? "Connected" : "Disconnected"} | Tools: ${s.toolCount}</div>
  </div>
  `).join("")}
</body>
</html>
    `;
    res.type("html").send(html);
  });

  // Create auth middleware using SDK's bearer auth
  const authMiddleware = requireBearerAuth({ verifier: oauthProvider });

  // ==================== MCP Streamable HTTP Endpoint (following SDK pattern) ====================

  // POST handler - main MCP request handler
  app.post("/mcp", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    logger.debug("MCP POST request", {
      sessionId,
      isInitialize: isInitializeRequest(req.body),
      method: req.body?.method
    });

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport for known session
        transport = transports[sessionId];
        logger.debug("Reusing existing transport", { sessionId });
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request - create new transport with session
        logger.info("Creating new MCP session");

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            // Store transport when session is initialized
            logger.info("Session initialized", { sessionId: newSessionId });
            transports[newSessionId] = transport;
          }
        });

        // Clean up on transport close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info("Transport closed, removing session", { sessionId: sid });
            delete transports[sid];
          }
        };

        // Create and connect the MCP server
        const server = gatewayFactory.createServer();
        await server.connect(transport);

        // Handle the initialization request
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        // Invalid request - no session ID and not an initialization request
        logger.warn("Invalid MCP request - no session or not initialize", { sessionId, body: req.body });
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      // Handle request with existing transport
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("MCP request error", err);

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err.message,
          },
          id: null,
        });
      }
    }
  });

  // GET handler - SSE streams for server-to-client messages
  app.get("/mcp", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      logger.warn("GET request with invalid session", { sessionId });
      res.status(400).json({
        error: "Invalid or missing session ID",
      });
      return;
    }

    logger.debug("SSE stream request", { sessionId });

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // DELETE handler - session termination
  app.delete("/mcp", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      logger.warn("DELETE request with invalid session", { sessionId });
      res.status(400).json({
        error: "Invalid or missing session ID",
      });
      return;
    }

    logger.info("Session termination request", { sessionId });

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Error handling session termination", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error processing session termination" });
      }
    }
  });

  // Error handling middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error", err);

    if (err instanceof GatewayError) {
      res.status(err.statusCode).json({
        error: err.code,
        message: err.message,
        details: err.details,
      });
      return;
    }

    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Endpoint not found",
    });
  });

  return app;
}

// Export for graceful shutdown
export function closeAllTransports(): Promise<void[]> {
  const closePromises: Promise<void>[] = [];
  for (const sessionId in transports) {
    logger.info("Closing transport", { sessionId });
    closePromises.push(
      transports[sessionId].close().catch((err) => {
        logger.error("Error closing transport", err as Error);
      })
    );
    delete transports[sessionId];
  }
  return Promise.all(closePromises);
}
