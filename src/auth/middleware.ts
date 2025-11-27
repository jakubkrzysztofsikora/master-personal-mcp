import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";
import { AuthProvider } from "./provider.js";
import { AuthenticationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Create Express middleware for OAuth bearer token authentication
 */
export function createAuthMiddleware(authProvider: AuthProvider) {
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

    try {
      const user = authProvider.validateToken(token);
      req.user = user;
      logger.debug("User authenticated", { userId: user.id, path: req.path });
      next();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        logger.warn("Authentication failed", {
          path: req.path,
          method: req.method,
        });
        res
          .status(401)
          .setHeader("WWW-Authenticate", 'Bearer realm="mcp-gateway", error="invalid_token"')
          .json({
            error: "unauthorized",
            error_description: error.message,
          });
        return;
      }
      next(error);
    }
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
