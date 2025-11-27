/**
 * Base error class for gateway errors
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "GatewayError";
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

/**
 * Authentication error - invalid or missing token
 */
export class AuthenticationError extends GatewayError {
  constructor(message: string = "Authentication required") {
    super(message, "AUTHENTICATION_ERROR", 401);
    this.name = "AuthenticationError";
  }
}

/**
 * Authorization error - insufficient permissions
 */
export class AuthorizationError extends GatewayError {
  constructor(message: string = "Insufficient permissions") {
    super(message, "AUTHORIZATION_ERROR", 403);
    this.name = "AuthorizationError";
  }
}

/**
 * Server not found error
 */
export class ServerNotFoundError extends GatewayError {
  constructor(serverId: string) {
    super(`Server not found: ${serverId}`, "SERVER_NOT_FOUND", 404, { serverId });
    this.name = "ServerNotFoundError";
  }
}

/**
 * Tool not found error
 */
export class ToolNotFoundError extends GatewayError {
  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`, "TOOL_NOT_FOUND", 404, { toolName });
    this.name = "ToolNotFoundError";
  }
}

/**
 * Server connection error
 */
export class ServerConnectionError extends GatewayError {
  constructor(serverId: string, cause?: Error) {
    super(
      `Failed to connect to server: ${serverId}`,
      "SERVER_CONNECTION_ERROR",
      502,
      { serverId, cause: cause?.message }
    );
    this.name = "ServerConnectionError";
  }
}

/**
 * Server execution error
 */
export class ServerExecutionError extends GatewayError {
  constructor(serverId: string, toolName: string, cause?: Error) {
    super(
      `Failed to execute tool ${toolName} on server ${serverId}`,
      "SERVER_EXECUTION_ERROR",
      500,
      { serverId, toolName, cause: cause?.message }
    );
    this.name = "ServerExecutionError";
  }
}

/**
 * Configuration error
 */
export class ConfigurationError extends GatewayError {
  constructor(message: string, details?: unknown) {
    super(message, "CONFIGURATION_ERROR", 500, details);
    this.name = "ConfigurationError";
  }
}

/**
 * Invalid request error
 */
export class InvalidRequestError extends GatewayError {
  constructor(message: string, details?: unknown) {
    super(message, "INVALID_REQUEST", 400, details);
    this.name = "InvalidRequestError";
  }
}
