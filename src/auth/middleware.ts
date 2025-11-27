import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";
import { AuthProvider } from "./provider.js";
import { OAuthProvider } from "./oauth.js";
import { logger } from "../utils/logger.js";

/**
 * Create Express middleware for OAuth bearer token authentication
 * Supports both static tokens (from AuthProvider) and OAuth tokens (from OAuthProvider)
 */
export function createAuthMiddleware(authProvider: AuthProvider, oauthProvider?: OAuthProvider) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    // Skip authentication if disabled
    if (!authProvider.isEnabled()) {
      logger.debug("Auth disabled, skipping authentication");
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const token = AuthProvider.extractBearerToken(authHeader);

    if (!token) {
      logger.warn("Missing or invalid Authorization header", {
        path: req.path,
        method: req.method,
      });
      res
        .status(401)
        .setHeader("WWW-Authenticate", 'Bearer realm="mcp-gateway"')
        .json({
          error: "unauthorized",
          error_description: "Missing or invalid Authorization header",
        });
      return;
    }

    // First try static token validation
    try {
      const user = authProvider.validateToken(token);
      req.user = user;
      logger.debug("User authenticated via static token", { userId: user.id, path: req.path });
      next();
      return;
    } catch {
      // Static token validation failed, try OAuth token
    }

    // Try OAuth token validation
    if (oauthProvider) {
      const result = oauthProvider.validateAccessToken(token);
      if (result.valid) {
        req.user = {
          id: result.userId,
          email: "", // OAuth tokens don't include email
          name: "",
          scopes: result.scopes,
        };
        logger.debug("User authenticated via OAuth token", { userId: result.userId, path: req.path });
        next();
        return;
      }
    }

    // Both validations failed
    logger.warn("Authentication failed - invalid token", {
      path: req.path,
      method: req.method,
    });
    res
      .status(401)
      .setHeader("WWW-Authenticate", 'Bearer realm="mcp-gateway", error="invalid_token"')
      .json({
        error: "unauthorized",
        error_description: "Invalid bearer token",
      });
  };
}

/**
 * Middleware to check required scopes
 */
export function requireScopes(...requiredScopes: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        error: "unauthorized",
        error_description: "User not authenticated",
      });
      return;
    }

    const hasAllScopes = requiredScopes.every((scope) => user.scopes.includes(scope));
    if (!hasAllScopes) {
      logger.warn("Insufficient scopes", {
        userId: user.id,
        requiredScopes,
        userScopes: user.scopes,
      });
      res.status(403).json({
        error: "forbidden",
        error_description: "Insufficient scopes",
        required_scopes: requiredScopes,
      });
      return;
    }

    next();
  };
}
