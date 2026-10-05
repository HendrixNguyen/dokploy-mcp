/**
 * Environment configuration. Parsed and validated once at startup so a missing or
 * malformed variable fails immediately with an actionable message, rather than
 * surfacing later as a confusing tool error.
 */

export type Transport = "stdio" | "http";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Config {
  readonly dokployUrl: string;
  /** Base URL of the REST facade, i.e. `${dokployUrl}/api` with no trailing slash. */
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly transport: Transport;
  readonly port: number;
  readonly httpToken: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly logLevel: LogLevel;
  readonly timeoutMs: number;
}

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];
const TRANSPORTS: readonly Transport[] = ["stdio", "http"];

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function required(env: NodeJS.ProcessEnv, key: string, hint: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(`${key} is required. ${hint}`);
  }
  return value;
}

/** Strips trailing slashes so callers can safely concatenate paths. */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Dokploy's `/api/` surface is what every procedure lives under. Accepting a URL that
 * already ends in `/api` is a common mistake when copying from the docs, so normalise it
 * rather than producing `/api/api/application.one`.
 */
function normaliseBaseUrl(raw: string): { baseUrl: string; apiBaseUrl: string } {
  const baseUrl = stripTrailingSlash(raw);
  const apiBaseUrl = baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`;
  return { baseUrl, apiBaseUrl };
}

function validateHttpUrl(raw: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${key} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(`${key} must use http or https, received ${parsed.protocol}`);
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dokployUrl = stripTrailingSlash(
    validateHttpUrl(
      required(env, "DOKPLOY_URL", "Example: DOKPLOY_URL=https://dokploy.example.com"),
      "DOKPLOY_URL",
    ),
  );

  const apiKey = required(
    env,
    "DOKPLOY_API_KEY",
    "Create one in the Dokploy dashboard under Settings -> API Keys.",
  );

  const transportRaw = (env.TRANSPORT?.trim() || "stdio") as Transport;
  if (!TRANSPORTS.includes(transportRaw)) {
    throw new ConfigError(`TRANSPORT must be one of ${TRANSPORTS.join(", ")}, got "${transportRaw}".`);
  }

  const logLevelRaw = (env.LOG_LEVEL?.trim() || "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${logLevelRaw}".`);
  }

  const portRaw = env.PORT?.trim();
  const port = portRaw ? Number(portRaw) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${portRaw ?? ""}".`);
  }

  const httpToken = env.MCP_HTTP_TOKEN?.trim() || undefined;
  if (transportRaw === "http" && !httpToken) {
    throw new ConfigError(
      "MCP_HTTP_TOKEN is required when TRANSPORT=http. The /mcp endpoint would otherwise be unauthenticated and able to deploy to your infrastructure.",
    );
  }

  const timeoutRaw = env.DOKPLOY_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new ConfigError(`DOKPLOY_TIMEOUT_MS must be a number >= 1000, got "${timeoutRaw ?? ""}".`);
  }

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const { baseUrl, apiBaseUrl } = normaliseBaseUrl(dokployUrl);

  return Object.freeze({
    dokployUrl: baseUrl,
    apiBaseUrl,
    apiKey,
    transport: transportRaw,
    port,
    httpToken,
    allowedOrigins: Object.freeze(allowedOrigins),
    logLevel: logLevelRaw,
    timeoutMs,
  });
}

/**
 * Redacts the API key anywhere it might be interpolated into a message. Defence in
 * depth: the key is held in a closure and never passed to a schema or a log line, but an
 * upstream error could still echo a request header back at us.
 */
export function redact(value: string, secret: string): string {
  if (!secret) return value;
  return value.split(secret).join("***");
}
