/**
 * The HTTP client. This is the only file that knows Dokploy's wire format.
 *
 * Verified against a v0.30.8 instance:
 *   - REST facade:   `{DOKPLOY_URL}/api/<namespace>.<procedure>`
 *   - Auth:          single `x-api-key` header
 *   - Query (spec method GET):     plain query params
 *   - Mutation (spec method POST): raw JSON body
 *   - Success:       the payload, already unwrapped
 *
 * The raw tRPC surface also exists at `/api/trpc/...` but wraps every result in
 * `{"result":{"data":{"json":...}}}`, so the facade is used instead.
 */

import { DokployError, safeJsonParse, toDokployError } from "./errors.js";
import { getProcedureKind } from "./procedures.js";

export type QueryParams = Record<string, unknown>;

export interface DokployClientOptions {
  /** Base of the facade, e.g. `https://dokploy.example.com/api`. No trailing slash. */
  apiBaseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
}

export interface CallOptions {
  /**
   * Per-call timeout override. Log reads on a busy service can take far longer than a
   * metadata read, so log tools widen the budget instead of guessing a global maximum.
   */
  timeoutMs?: number;
}

export class DokployClient {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DokployClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Calls a query procedure (spec method GET).
   *
   * Undefined and null params are dropped rather than stringified: sending
   * `?limit=null` reaches the server as the literal string "null" and is rejected by
   * its zod schema, which reads as a confusing bug rather than an absent argument.
   */
  async query<T>(procedure: string, params?: QueryParams, options?: CallOptions): Promise<T> {
    this.assertKind(procedure, "query");
    const url = this.buildUrl(procedure);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return this.send<T>(url, "GET", undefined, options);
  }

  /** Calls a mutation procedure (spec method POST) with a raw JSON body. */
  async mutation<T>(procedure: string, input?: QueryParams, options?: CallOptions): Promise<T> {
    this.assertKind(procedure, "mutation");
    const url = this.buildUrl(procedure);
    return this.send<T>(url, "POST", input ?? {}, options);
  }

  /**
   * Verifies the key and instance before serving traffic, so a misconfiguration is
   * reported at startup rather than on the first tool call.
   */
  async probe(): Promise<{ version: string; status: string }> {
    const [version, health] = await Promise.all([
      this.query<string>("settings.getDokployVersion"),
      this.query<{ status?: string }>("settings.health"),
    ]);
    return { version, status: health.status ?? "unknown" };
  }

  private buildUrl(procedure: string): URL {
    return new URL(`${this.apiBaseUrl}/${procedure}`);
  }

  /**
   * Catches a query/mutation mismatch before the network call. The facade answers a
   * POST to a query procedure with 404 NOT_FOUND, which is indistinguishable from a
   * genuinely missing resource; failing here turns that into a precise message.
   */
  private assertKind(procedure: string, expected: "query" | "mutation"): void {
    const actual = getProcedureKind(procedure);
    if (actual === expected) return;
    if (actual === undefined) {
      throw new DokployError({
        status: 0,
        code: "UNKNOWN",
        message:
          `"${procedure}" is not a known Dokploy procedure for this server version. ` +
          `Run \`npm run sync-spec\` to refresh the procedure list against your instance ` +
          `(this build targets Dokploy ${"0.30.8"}).`,
      });
    }
    throw new DokployError({
      status: 0,
      code: "UNKNOWN",
      message:
        `"${procedure}" is a Dokploy ${actual} but was called as a ${expected}. ` +
        `Use client.${expected}() instead.`,
      procedure,
    });
  }

  private async send<T>(
    url: URL,
    method: "GET" | "POST",
    body?: unknown,
    options?: CallOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const procedure = url.pathname.split("/").pop();

    try {
      const response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          "x-api-key": this.apiKey,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const text = await response.text();
      const payload = text.length > 0 ? safeJsonParse(text) : null;

      if (!response.ok) {
        throw toDokployError(response.status, payload, procedure, this.apiKey);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof DokployError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DokployError({
          status: 504,
          code: "TIMEOUT",
          message: `Dokploy did not respond within ${timeoutMs}ms.`,
          procedure,
        });
      }
      throw new DokployError({
        status: 0,
        code: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : String(error),
        procedure,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
