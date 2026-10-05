/**
 * A stderr-only logger.
 *
 * The stdio transport multiplexes JSON-RPC over stdout. A single `console.log` there
 * corrupts the stream and the client drops the connection, so every diagnostic in this
 * server goes to stderr. Nothing in `logger` writes to stdout, by design.
 */

import type { LogLevel } from "./config.js";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];

  const emit = (at: LogLevel, message: string, detail?: unknown): void => {
    if (ORDER[at] > threshold) return;
    const line = `[dokploy-mcp] ${at.toUpperCase()} ${message}`;
    if (detail === undefined) {
      process.stderr.write(`${line}\n`);
      return;
    }
    const rendered = detail instanceof Error ? (detail.stack ?? detail.message) : safeStringify(detail);
    process.stderr.write(`${line} ${rendered}\n`);
  };

  return {
    error: (message, detail) => emit("error", message, detail),
    warn: (message, detail) => emit("warn", message, detail),
    info: (message, detail) => emit("info", message, detail),
    debug: (message, detail) => emit("debug", message, detail),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Discards everything. Useful in tests. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};
