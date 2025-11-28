import { randomBytes, createHash } from "crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { GatewayConfig, UserConfig } from "../types.js";
import { logger } from "../utils/logger.js";

// In-memory stores
const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessTokenData>();
const registeredClients = new Map<string, OAuthClientInformationFull>();

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

interface AccessTokenData {
  token: string;
  clientId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

/**
 * Generate a random string for codes/tokens
 */
function generateRandomString(length: number = 32): string {
  return randomBytes(length).toString("hex");
}

/**
 * Verify PKCE code challenge
 */
function verifyCodeChallenge(
  codeVerifier: string,
  codeChallenge: string
): boolean {
  const hash = createHash("sha256").update(codeVerifier).digest("base64url");
  return hash === codeChallenge;
}

/**
 * OAuth Clients Store implementation
 */
export class GatewayClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return registeredClients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const clientId = `client_${generateRandomString(16)}`;
    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    registeredClients.set(clientId, fullClient);
    logger.info("Registered new OAuth client", { clientId, clientName: client.client_name });
    return fullClient;
  }
}

/**
 * OAuth Server Provider implementation using MCP SDK interfaces
 */
export class GatewayOAuthProvider implements OAuthServerProvider {
  private users: Map<string, UserConfig>;
  private _clientsStore: GatewayClientsStore;

  constructor(private config: GatewayConfig) {
    this.users = new Map();
    for (const user of config.auth.users) {
      this.users.set(user.id, user);
      this.users.set(user.email, user);
    }
    this._clientsStore = new GatewayClientsStore();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  /**
   * Begins authorization - renders login page
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const loginPage = this.generateLoginPage(client, params);
    res.type("html").send(loginPage);
  }

  /**
   * Returns the code challenge for a given authorization code
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const authCode = authorizationCodes.get(authorizationCode);
    if (!authCode) {
      throw new Error("Invalid authorization code");
    }
    return authCode.codeChallenge;
  }

  /**
   * Exchanges authorization code for tokens
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const authCode = authorizationCodes.get(authorizationCode);
    if (!authCode) {
      throw new Error("Invalid authorization code");
    }

    // Delete the code (one-time use)
    authorizationCodes.delete(authorizationCode);

    // Validate expiration
    if (Date.now() > authCode.expiresAt) {
      throw new Error("Authorization code expired");
    }

    // Validate client_id and redirect_uri
    if (authCode.clientId !== client.client_id) {
      throw new Error("Client ID mismatch");
    }
    if (redirectUri && authCode.redirectUri !== redirectUri) {
      throw new Error("Redirect URI mismatch");
    }

    // Verify PKCE
    if (codeVerifier && !verifyCodeChallenge(codeVerifier, authCode.codeChallenge)) {
      throw new Error("PKCE verification failed");
    }

    // Create access token
    const accessToken = generateRandomString(32);
    const expiresIn = 3600; // 1 hour
    const expiresAt = Date.now() + expiresIn * 1000;

    accessTokens.set(accessToken, {
      token: accessToken,
      clientId: authCode.clientId,
      userId: authCode.userId,
      scopes: authCode.scopes,
      expiresAt,
    });

    logger.info("Access token created", { clientId: authCode.clientId, userId: authCode.userId });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: authCode.scopes.join(" "),
    };
  }

  /**
   * Exchanges refresh token for new tokens (not implemented)
   */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    throw new Error("Refresh tokens not supported");
  }

  /**
   * Verifies an access token
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const accessToken = accessTokens.get(token);
    if (!accessToken) {
      // Check if it's a static token from config
      for (const user of this.config.auth.users) {
        if (user.token === token) {
          return {
            token,
            clientId: "static",
            scopes: user.scopes,
          };
        }
      }
      throw new Error("Invalid access token");
    }

    if (Date.now() > accessToken.expiresAt) {
      accessTokens.delete(token);
      throw new Error("Access token expired");
    }

    return {
      token,
      clientId: accessToken.clientId,
      scopes: accessToken.scopes,
      expiresAt: Math.floor(accessToken.expiresAt / 1000),
    };
  }

  /**
   * Revokes a token
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    accessTokens.delete(request.token);
  }

  /**
   * Create authorization code (called from login handler)
   */
  createAuthorizationCode(
    clientId: string,
    redirectUri: string,
    userId: string,
    scopes: string[],
    codeChallenge: string
  ): string {
    const code = generateRandomString(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    authorizationCodes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      userId,
      scopes,
      expiresAt,
    });

    logger.info("Authorization code created", { clientId, userId });
    return code;
  }

  /**
   * Authenticate user with email and password
   */
  authenticateUser(email: string, password: string): UserConfig | undefined {
    const user = this.users.get(email);
    if (!user) {
      return undefined;
    }
    if (user.password !== password) {
      return undefined;
    }
    return user;
  }

  /**
   * Generate login page HTML
   */
  private generateLoginPage(
    client: OAuthClientInformationFull,
    params: AuthorizationParams
  ): string {
    const clientName = client.client_name || client.client_id;
    const scopes = params.scopes || ["tools:read", "tools:execute"];

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${clientName} - MCP Gateway</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      padding: 40px;
      max-width: 400px;
      width: 100%;
    }
    h1 { margin: 0 0 8px; font-size: 24px; color: #1a1a1a; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .client-name { font-weight: 600; color: #667eea; }
    .scopes { background: #f5f5f5; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .scopes h3 { margin: 0 0 12px; font-size: 14px; color: #666; }
    .scope { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; }
    .scope:last-child { border-bottom: none; }
    .scope-icon { margin-right: 12px; font-size: 18px; }
    .scope-text { font-size: 14px; color: #333; }
    form { margin-top: 20px; }
    label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
    input[type="email"], input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input[type="email"]:focus, input[type="password"]:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .cancel { display: block; text-align: center; margin-top: 16px; color: #666; text-decoration: none; }
    .cancel:hover { color: #333; }
    .error { color: red; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to continue</h1>
    <p class="subtitle">
      <span class="client-name">${clientName}</span> wants to access your MCP Gateway
    </p>

    <div class="scopes">
      <h3>This will allow ${clientName} to:</h3>
      ${scopes.map((s: string) => `
        <div class="scope">
          <span class="scope-icon">${s.includes("execute") ? "⚡" : "👁️"}</span>
          <span class="scope-text">${s === "tools:read" ? "View available tools" : "Execute tools on your behalf"}</span>
        </div>
      `).join("")}
    </div>

    <form method="POST" action="/authorize/callback">
      <input type="hidden" name="client_id" value="${client.client_id}">
      <input type="hidden" name="redirect_uri" value="${params.redirectUri}">
      <input type="hidden" name="state" value="${params.state || ""}">
      <input type="hidden" name="scope" value="${scopes.join(" ")}">
      <input type="hidden" name="code_challenge" value="${params.codeChallenge}">

      <label for="email">Email address</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required>

      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Your password" required>

      <button type="submit">Authorize</button>
    </form>

    <a href="${params.redirectUri}?error=access_denied&state=${params.state || ""}" class="cancel">Cancel</a>
  </div>
</body>
</html>
    `;
  }
}
