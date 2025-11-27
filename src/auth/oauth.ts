import { randomBytes, createHash } from "crypto";
import type { GatewayConfig, UserConfig } from "../types.js";
import { logger } from "../utils/logger.js";

// In-memory stores (in production, use Redis or database)
const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

interface AccessToken {
  token: string;
  clientId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

// Pre-configured OAuth clients
const OAUTH_CLIENTS: Record<string, OAuthClient> = {
  "claude-ai": {
    clientId: "claude-ai",
    clientName: "Claude AI",
    redirectUris: [
      "https://claude.ai/oauth/callback",
      "https://www.claude.ai/oauth/callback",
    ],
  },
};

interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
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
  codeChallenge: string,
  method: string
): boolean {
  if (method === "S256") {
    const hash = createHash("sha256").update(codeVerifier).digest("base64url");
    return hash === codeChallenge;
  } else if (method === "plain") {
    return codeVerifier === codeChallenge;
  }
  return false;
}

/**
 * OAuth 2.1 Provider
 */
export class OAuthProvider {
  private users: Map<string, UserConfig>;

  constructor(private config: GatewayConfig) {
    this.users = new Map();
    for (const user of config.auth.users) {
      this.users.set(user.id, user);
      // Also index by email for login
      this.users.set(user.email, user);
    }
  }

  /**
   * Get OAuth metadata
   */
  getMetadata(): Record<string, unknown> {
    const baseUrl = this.config.server.baseUrl;
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ["tools:read", "tools:execute"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      service_documentation: `${baseUrl}/docs`,
    };
  }

  /**
   * Validate authorization request
   */
  validateAuthorizationRequest(params: {
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    scope?: string;
    state?: string;
  }): { valid: true; client: OAuthClient } | { valid: false; error: string; errorDescription: string } {
    const { client_id, redirect_uri, response_type, code_challenge } = params;

    // Validate client_id
    if (!client_id) {
      return { valid: false, error: "invalid_request", errorDescription: "Missing client_id" };
    }

    const client = OAUTH_CLIENTS[client_id];
    if (!client) {
      // For unknown clients, allow any redirect_uri (dynamic registration)
      logger.info(`Unknown client ${client_id}, allowing dynamic registration`);
    }

    // Validate redirect_uri
    if (!redirect_uri) {
      return { valid: false, error: "invalid_request", errorDescription: "Missing redirect_uri" };
    }

    if (client && !client.redirectUris.some(uri => redirect_uri.startsWith(uri.split('?')[0]))) {
      return { valid: false, error: "invalid_request", errorDescription: "Invalid redirect_uri" };
    }

    // Validate response_type
    if (response_type !== "code") {
      return { valid: false, error: "unsupported_response_type", errorDescription: "Only 'code' response type is supported" };
    }

    // PKCE is required in OAuth 2.1
    if (!code_challenge) {
      return { valid: false, error: "invalid_request", errorDescription: "PKCE code_challenge is required" };
    }

    return { valid: true, client: client || { clientId: client_id, clientName: client_id, redirectUris: [redirect_uri] } };
  }

  /**
   * Create authorization code
   */
  createAuthorizationCode(
    clientId: string,
    redirectUri: string,
    userId: string,
    scopes: string[],
    codeChallenge: string,
    codeChallengeMethod: string = "S256"
  ): string {
    const code = generateRandomString(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    authorizationCodes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      userId,
      scopes,
      expiresAt,
    });

    logger.info("Authorization code created", { clientId, userId });
    return code;
  }

  /**
   * Exchange authorization code for access token
   */
  exchangeCode(params: {
    grant_type?: string;
    code?: string;
    redirect_uri?: string;
    client_id?: string;
    code_verifier?: string;
  }): { success: true; accessToken: string; tokenType: string; expiresIn: number; scope: string }
     | { success: false; error: string; errorDescription: string } {
    const { grant_type, code, redirect_uri, client_id, code_verifier } = params;

    if (grant_type !== "authorization_code") {
      return { success: false, error: "unsupported_grant_type", errorDescription: "Only authorization_code grant is supported" };
    }

    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return { success: false, error: "invalid_request", errorDescription: "Missing required parameters" };
    }

    const authCode = authorizationCodes.get(code);
    if (!authCode) {
      return { success: false, error: "invalid_grant", errorDescription: "Invalid authorization code" };
    }

    // Delete the code (one-time use)
    authorizationCodes.delete(code);

    // Validate expiration
    if (Date.now() > authCode.expiresAt) {
      return { success: false, error: "invalid_grant", errorDescription: "Authorization code expired" };
    }

    // Validate client_id and redirect_uri
    if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
      return { success: false, error: "invalid_grant", errorDescription: "Client ID or redirect URI mismatch" };
    }

    // Verify PKCE
    if (!verifyCodeChallenge(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
      return { success: false, error: "invalid_grant", errorDescription: "PKCE verification failed" };
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
      success: true,
      accessToken,
      tokenType: "Bearer",
      expiresIn,
      scope: authCode.scopes.join(" "),
    };
  }

  /**
   * Validate access token
   */
  validateAccessToken(token: string): { valid: true; userId: string; scopes: string[] } | { valid: false } {
    const accessToken = accessTokens.get(token);
    if (!accessToken) {
      // Check if it's a static token from config
      for (const user of this.config.auth.users) {
        if (user.token === token) {
          return { valid: true, userId: user.id, scopes: user.scopes };
        }
      }
      return { valid: false };
    }

    if (Date.now() > accessToken.expiresAt) {
      accessTokens.delete(token);
      return { valid: false };
    }

    return { valid: true, userId: accessToken.userId, scopes: accessToken.scopes };
  }

  /**
   * Get user by ID or email
   */
  getUser(idOrEmail: string): UserConfig | undefined {
    return this.users.get(idOrEmail);
  }

  /**
   * Authenticate user with email (simplified - in production use password)
   */
  authenticateUser(email: string): UserConfig | undefined {
    return this.users.get(email);
  }

  /**
   * Generate login page HTML
   */
  generateLoginPage(params: {
    client_id: string;
    redirect_uri: string;
    state?: string;
    scope?: string;
    code_challenge: string;
    code_challenge_method?: string;
  }): string {
    const { client_id, redirect_uri, state, scope, code_challenge, code_challenge_method } = params;
    const client = OAUTH_CLIENTS[client_id];
    const clientName = client?.clientName || client_id;
    const scopes = scope?.split(" ") || ["tools:read", "tools:execute"];

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
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      color: #1a1a1a;
    }
    .subtitle {
      color: #666;
      margin-bottom: 24px;
    }
    .client-name {
      font-weight: 600;
      color: #667eea;
    }
    .scopes {
      background: #f5f5f5;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .scopes h3 {
      margin: 0 0 12px;
      font-size: 14px;
      color: #666;
    }
    .scope {
      display: flex;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #eee;
    }
    .scope:last-child { border-bottom: none; }
    .scope-icon { margin-right: 12px; font-size: 18px; }
    .scope-text { font-size: 14px; color: #333; }
    form { margin-top: 20px; }
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: #333;
    }
    input[type="email"] {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input[type="email"]:focus {
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
    .cancel {
      display: block;
      text-align: center;
      margin-top: 16px;
      color: #666;
      text-decoration: none;
    }
    .cancel:hover { color: #333; }
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
      ${scopes.map(s => `
        <div class="scope">
          <span class="scope-icon">${s.includes('execute') ? '⚡' : '👁️'}</span>
          <span class="scope-text">${s === 'tools:read' ? 'View available tools' : 'Execute tools on your behalf'}</span>
        </div>
      `).join('')}
    </div>

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${client_id}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <input type="hidden" name="state" value="${state || ''}">
      <input type="hidden" name="scope" value="${scope || 'tools:read tools:execute'}">
      <input type="hidden" name="code_challenge" value="${code_challenge}">
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}">

      <label for="email">Email address</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required>

      <button type="submit">Authorize</button>
    </form>

    <a href="${redirect_uri}?error=access_denied&state=${state || ''}" class="cancel">Cancel</a>
  </div>
</body>
</html>
    `;
  }
}
