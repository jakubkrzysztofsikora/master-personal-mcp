import type { AuthConfig, AuthenticatedUser, UserConfig } from "../types.js";
import { AuthenticationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Static token authentication provider
 * Validates bearer tokens against a static list of configured users
 */
export class AuthProvider {
  private readonly tokenMap: Map<string, UserConfig>;
  private readonly enabled: boolean;

  constructor(authConfig: AuthConfig) {
    this.enabled = authConfig.enabled;
    this.tokenMap = new Map();

    // Build token lookup map
    for (const user of authConfig.users) {
      if (this.tokenMap.has(user.token)) {
        logger.warn(`Duplicate token detected for user ${user.id}`);
      }
      this.tokenMap.set(user.token, user);
    }

    logger.info(`Auth provider initialized`, {
      enabled: this.enabled,
      userCount: authConfig.users.length,
    });
  }

  /**
   * Check if authentication is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Validate a bearer token and return the authenticated user
   */
  validateToken(token: string): AuthenticatedUser {
    const user = this.tokenMap.get(token);
    if (!user) {
      throw new AuthenticationError("Invalid bearer token");
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      scopes: user.scopes,
    };
  }

  /**
   * Extract bearer token from Authorization header
   */
  static extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
      return null;
    }

    return parts[1];
  }
}
