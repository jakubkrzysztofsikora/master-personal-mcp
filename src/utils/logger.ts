type LogLevel = "debug" | "info" | "warn" | "error";

interface LogData {
  level: LogLevel;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  if (level && level in LOG_LEVELS) {
    return level as LogLevel;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  const currentLevel = getLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatLog(level: LogLevel, msg: string, data?: Record<string, unknown>): string {
  const logData: LogData = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...data,
  };
  return JSON.stringify(logData);
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>): void {
    if (shouldLog("debug")) {
      console.log(formatLog("debug", msg, data));
    }
  },

  info(msg: string, data?: Record<string, unknown>): void {
    if (shouldLog("info")) {
      console.log(formatLog("info", msg, data));
    }
  },

  warn(msg: string, data?: Record<string, unknown>): void {
    if (shouldLog("warn")) {
      console.warn(formatLog("warn", msg, data));
    }
  },

  error(msg: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    if (shouldLog("error")) {
      const errorData: Record<string, unknown> = { ...data };
      if (error instanceof Error) {
        errorData.error = error.message;
        errorData.stack = error.stack;
      } else if (error) {
        errorData.error = String(error);
      }
      console.error(formatLog("error", msg, errorData));
    }
  },

  /**
   * Log with request context
   */
  request(
    level: LogLevel,
    msg: string,
    requestId: string,
    data?: Record<string, unknown>
  ): void {
    this[level](msg, { requestId, ...data });
  },
};
