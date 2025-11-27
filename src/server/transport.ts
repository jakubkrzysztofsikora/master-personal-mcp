import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { GatewayConfig, AuthenticatedRequest, HealthStatus } from "../types.js";
import { AuthProvider } from "../auth/provider.js";
import { OAuthProvider } from "../auth/oauth.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { GatewayServerFactory } from "./gateway.js";
import { ServerPoolManager } from "../pool/manager.js";
import { GatewayError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const startTime = Date.now();

/**
 * Create and configure the Express application
 */
export function createApp(config: GatewayConfig, poolManager: ServerPoolManager): Express {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`, {
      userAgent: req.headers["user-agent"],
    });
    next();
  });

  // Auth providers
  const authProvider = new AuthProvider(config.auth);
  const oauthProvider = new OAuthProvider(config);
  const authMiddleware = createAuthMiddleware(authProvider, oauthProvider);

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

  // ==================== OAuth 2.1 Endpoints ====================

  // OAuth Authorization Server Metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json(oauthProvider.getMetadata());
  });

  // OAuth Protected Resource Metadata (RFC 9728)
  app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: config.server.baseUrl,
      authorization_servers: [config.server.baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["tools:read", "tools:execute"],
      resource_documentation: `${config.server.baseUrl}/docs`,
    });
  });

  // Authorization endpoint - GET shows login page
  app.get("/oauth/authorize", (req: Request, res: Response) => {
    const params = {
      client_id: req.query.client_id as string,
      redirect_uri: req.query.redirect_uri as string,
      response_type: req.query.response_type as string,
      code_challenge: req.query.code_challenge as string,
      code_challenge_method: req.query.code_challenge_method as string,
      scope: req.query.scope as string,
      state: req.query.state as string,
    };

    const validation = oauthProvider.validateAuthorizationRequest(params);
    if (!validation.valid) {
      if (params.redirect_uri) {
        const redirectUrl = new URL(params.redirect_uri);
        redirectUrl.searchParams.set("error", validation.error);
        redirectUrl.searchParams.set("error_description", validation.errorDescription);
        if (params.state) redirectUrl.searchParams.set("state", params.state);
        res.redirect(redirectUrl.toString());
      } else {
        res.status(400).json({ error: validation.error, error_description: validation.errorDescription });
      }
      return;
    }

    // Show login page
    res.type("html").send(oauthProvider.generateLoginPage(params));
  });

  // Authorization endpoint - POST handles login submission
  app.post("/oauth/authorize", (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, scope, code_challenge, code_challenge_method, email } = req.body;

    // Validate the authorization request again
    const validation = oauthProvider.validateAuthorizationRequest({
      client_id,
      redirect_uri,
      response_type: "code",
      code_challenge,
      code_challenge_method,
      scope,
      state,
    });

    if (!validation.valid) {
      res.status(400).json({ error: validation.error, error_description: validation.errorDescription });
      return;
    }

    // Authenticate user
    const user = oauthProvider.authenticateUser(email);
    if (!user) {
      // Show login page with error
      res.type("html").send(oauthProvider.generateLoginPage({
        client_id,
        redirect_uri,
        state,
        scope,
        code_challenge,
        code_challenge_method,
      }).replace('</form>', '<p style="color: red; margin-top: 10px;">User not found. Please use a registered email.</p></form>'));
      return;
    }

    // Create authorization code
    const scopes = scope?.split(" ") || ["tools:read", "tools:execute"];
    const code = oauthProvider.createAuthorizationCode(
      client_id,
      redirect_uri,
      user.id,
      scopes,
      code_challenge,
      code_challenge_method || "S256"
    );

    // Redirect back to client with code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    logger.info("Authorization successful, redirecting", { clientId: client_id, userId: user.id });
    res.redirect(redirectUrl.toString());
  });

  // Token endpoint
  app.post("/oauth/token", (req: Request, res: Response) => {
    const result = oauthProvider.exchangeCode({
      grant_type: req.body.grant_type,
      code: req.body.code,
      redirect_uri: req.body.redirect_uri,
      client_id: req.body.client_id,
      code_verifier: req.body.code_verifier,
    });

    if (!result.success) {
      res.status(400).json({
        error: result.error,
        error_description: result.errorDescription,
      });
      return;
    }

    res.json({
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      scope: result.scope,
    });
  });

  // Dynamic client registration (simplified)
  app.post("/oauth/register", (req: Request, res: Response) => {
    const { client_name, redirect_uris } = req.body;

    if (!client_name || !redirect_uris || !Array.isArray(redirect_uris)) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "client_name and redirect_uris are required",
      });
      return;
    }

    // Generate a client ID (in production, store this)
    const clientId = `client_${Date.now()}`;

    res.status(201).json({
      client_id: clientId,
      client_name,
      redirect_uris,
      token_endpoint_auth_method: "none",
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
  <p>Include a Bearer token in the Authorization header:</p>
  <pre>Authorization: Bearer your-token-here</pre>

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

  // MCP Streamable HTTP endpoint
  app.post("/mcp", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const server = gatewayFactory.createServer(user);

      // Create transport for this request
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
      });

      // Handle request close
      res.on("close", () => {
        transport.close().catch((err) => {
          logger.error("Error closing transport", err as Error);
        });
      });

      // Connect server to transport
      await server.connect(transport);

      // Handle the request
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

  // GET endpoint for SSE (server-sent events)
  app.get("/mcp", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const server = gatewayFactory.createServer(user);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        transport.close().catch((err) => {
          logger.error("Error closing transport", err as Error);
        });
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("MCP GET request error", err);

      if (!res.headersSent) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  });

  // DELETE endpoint for session close
  app.delete("/mcp", authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
    // Stateless mode - no session to close
    res.status(200).json({ status: "ok" });
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
