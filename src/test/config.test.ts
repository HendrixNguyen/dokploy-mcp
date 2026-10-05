import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../config.js";

const VALID = {
  DOKPLOY_URL: "https://dokploy.example.com",
  DOKPLOY_API_KEY: "k",
} satisfies NodeJS.ProcessEnv;

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...VALID, ...overrides };
}

describe("loadConfig", () => {
  it("appends /api and strips a trailing slash", () => {
    const config = loadConfig(env({ DOKPLOY_URL: "https://dokploy.example.com/" }));
    assert.equal(config.dokployUrl, "https://dokploy.example.com");
    assert.equal(config.apiBaseUrl, "https://dokploy.example.com/api");
  });

  it("does not double up /api when the user already included it", () => {
    // Copying "https://host/api" straight out of the docs is the easy mistake.
    const config = loadConfig(env({ DOKPLOY_URL: "https://dokploy.example.com/api" }));
    assert.equal(config.apiBaseUrl, "https://dokploy.example.com/api");
  });

  it("defaults to stdio on 3000 with no transport variables set", () => {
    const config = loadConfig(env());
    assert.equal(config.transport, "stdio");
    assert.equal(config.port, 3000);
    assert.equal(config.logLevel, "info");
    assert.equal(config.timeoutMs, 30_000);
  });

  it("names the missing variable and how to fix it", () => {
    assert.throws(() => loadConfig({ DOKPLOY_URL: "https://x.example.com" }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /DOKPLOY_API_KEY is required/);
      assert.match(error.message, /Settings -> API Keys/, "must say where to get one");
      return true;
    });
  });

  it("treats a whitespace-only key as missing", () => {
    assert.throws(() => loadConfig(env({ DOKPLOY_API_KEY: "   " })), /DOKPLOY_API_KEY is required/);
  });

  it("rejects a URL that is not a URL", () => {
    assert.throws(() => loadConfig(env({ DOKPLOY_URL: "dokploy.example.com" })), /not a valid URL/);
  });

  it("rejects a non-http scheme", () => {
    assert.throws(() => loadConfig(env({ DOKPLOY_URL: "ftp://dokploy.example.com" })), /http or https/);
  });

  it("insists on a bearer token in http mode rather than serving /mcp open", () => {
    assert.throws(
      () => loadConfig(env({ TRANSPORT: "http" })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /MCP_HTTP_TOKEN is required/);
        assert.match(error.message, /deploy to your infrastructure/, "must state the consequence");
        return true;
      },
    );
  });

  it("accepts http mode once a token is supplied", () => {
    const config = loadConfig(env({ TRANSPORT: "http", MCP_HTTP_TOKEN: "secret" }));
    assert.equal(config.transport, "http");
    assert.equal(config.httpToken, "secret");
  });

  it("rejects an unknown transport or log level rather than silently defaulting", () => {
    assert.throws(() => loadConfig(env({ TRANSPORT: "grpc" })), /TRANSPORT must be one of/);
    assert.throws(() => loadConfig(env({ LOG_LEVEL: "chatty" })), /LOG_LEVEL must be one of/);
  });

  it("rejects an out-of-range port", () => {
    assert.throws(() => loadConfig(env({ PORT: "70000" })), /PORT must be an integer/);
    assert.throws(() => loadConfig(env({ PORT: "abc" })), /PORT must be an integer/);
  });

  it("rejects a nonsensical timeout", () => {
    assert.throws(() => loadConfig(env({ DOKPLOY_TIMEOUT_MS: "50" })), /DOKPLOY_TIMEOUT_MS/);
  });

  it("splits and trims the origin allowlist", () => {
    const config = loadConfig(
      env({ ALLOWED_ORIGINS: "http://localhost:5173, https://app.example.com , " }),
    );
    assert.deepEqual([...config.allowedOrigins], [
      "http://localhost:5173",
      "https://app.example.com",
    ]);
  });

  it("freezes the result so nothing can mutate the key at runtime", () => {
    const config = loadConfig(env());
    assert.throws(() => {
      (config as unknown as Record<string, unknown>).apiKey = "leaked";
    }, TypeError);
  });
});
