import { config } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const configuredLevel = config.log.level.toLowerCase();
const activeLevel: LogLevel =
  configuredLevel in LEVEL_ORDER ? (configuredLevel as LogLevel) : "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[activeLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

if (activeLevel !== configuredLevel) {
  console.error(
    `${formatTimestamp()} [WARN]  Unknown LOG_LEVEL "${config.log.level}", using "info"`,
  );
}

export const logger = {
  // All log output goes to stderr so it never mixes with agent answers on
  // stdout when streams are redirected; the readline prompt is on stderr too.
  debug(msg: string, ...args: unknown[]): void {
    if (shouldLog("debug")) {
      console.error(`${formatTimestamp()} [DEBUG] ${msg}`, ...args);
    }
  },

  info(msg: string, ...args: unknown[]): void {
    if (shouldLog("info")) {
      console.error(`${formatTimestamp()} [INFO]  ${msg}`, ...args);
    }
  },

  warn(msg: string, ...args: unknown[]): void {
    if (shouldLog("warn")) {
      console.error(`${formatTimestamp()} [WARN]  ${msg}`, ...args);
    }
  },

  error(msg: string, ...args: unknown[]): void {
    if (shouldLog("error")) {
      console.error(`${formatTimestamp()} [ERROR] ${msg}`, ...args);
    }
  },

  tool(name: string, args: string): void {
    if (shouldLog("info")) {
      console.error(`${formatTimestamp()} [TOOL]  ${name}(${args})`);
    }
  },

  result(content: string): void {
    if (shouldLog("debug")) {
      const preview =
        content.length > 200 ? content.slice(0, 200) + "..." : content;
      console.error(`${formatTimestamp()} [RESULT] ${preview}`);
    }
  },
};
