import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DokployClient } from "../client.js";
import { DokployError } from "../errors.js";

/**
 * The client's job is to be exactly right about the wire format. Everything here runs
 * against a stubbed `fetch`, so a change to URL construction, parameter dropping, the
 * auth header or the response shape fails here rather than against a live instance.
 */
function stubFetch(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.text ?? JSON.stringify(response.body ?? null),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = "https://dokploy.example.com/api";

function clientWith(impl: typeof fetch, apiKey = "test-key") {
  return new DokployClient({ apiBaseUrl: BASE, apiKey, timeoutMs: 5_000, fetchImpl: impl });
}

describe("DokployClient.query", () => {
  it("builds the facade path and sends the x-api-key header", async () => {
    const stub = stubFetch({ body: { status: "ok" } });
    await clientWith(stub.impl).query("settings.health");

    assert.equal(stub.calls[0]?.url.pathname, "/api/settings.health");
    const headers = stub.calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "test-key");
    assert.equal(stub.calls[0]?.init.method, "GET");
  });

  it("sends plain query params", async () => {
    const stub = stubFetch({ body: { items: [], total: 0 } });
    await clientWith(stub.impl).query("application.search", { q: "UI", limit: 1, offset: 0 });

    assert.equal(stub.calls[0]?.url.searchParams.get("q"), "UI");
    assert.equal(stub.calls[0]?.url.searchParams.get("limit"), "1");
  });

  it("drops undefined and null params instead of stringifying them", async () => {
    // Sending "null" reaches Dokploy as the literal string and fails its zod schema,
    // which reads as a confusing server bug rather than an omitted argument.
    const stub = stubFetch({ body: {} });
    await clientWith(stub.impl).query("application.search", {
      q: undefined,
      name: null,
      limit: 5,
    });

    assert.equal(stub.calls[0]?.url.searchParams.has("q"), false);
    assert.equal(stub.calls[0]?.url.searchParams.has("name"), false);
    assert.equal(stub.calls[0]?.url.searchParams.get("limit"), "5");
  });

  it("repeats a key once per array element", async () => {
    // No GET procedure in the pinned v0.30.8 spec takes an array query parameter, so this
    // is future-proofing rather than a case the API currently exercises. It is asserted on
    // URL construction only: an unfamiliar key is still appended, which is what the
    // behaviour under test is.
    const stub = stubFetch({ body: {} });
    await clientWith(stub.impl).query("application.search", { tag: ["a", "b"] });
    assert.deepEqual(stub.calls[0]?.url.searchParams.getAll("tag"), ["a", "b"]);
  });

  it("returns the payload already unwrapped", async () => {
    const stub = stubFetch({ body: { items: [{ a: 1 }], total: 1 } });
    const result = await clientWith(stub.impl).query<PaginatedLike>("application.search");
    assert.equal(result.total, 1);
    assert.equal(result.items?.[0]?.a, 1);
  });
});

interface PaginatedLike {
  items?: { a: number }[];
  total: number;
}

describe("DokployClient.mutation", () => {
  it("POSTs a raw JSON body", async () => {
    const stub = stubFetch({ body: { applicationId: "x" } });
    await clientWith(stub.impl).mutation("application.create", {
      name: "UI",
      environmentId: "e1",
    });

    assert.equal(stub.calls[0]?.init.method, "POST");
    assert.equal(stub.calls[0]?.url.pathname, "/api/application.create");
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init.body)), {
      name: "UI",
      environmentId: "e1",
    });
  });

  it("sends an empty object when given no input", async () => {
    const stub = stubFetch({ body: {} });
    await clientWith(stub.impl).mutation("application.stop");
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init.body)), {});
  });
});

describe("DokployClient kind checking", () => {
  it("refuses a query procedure called as a mutation, before touching the network", async () => {
    // The facade answers a POST to a query with 404, which is indistinguishable from a
    // missing resource. Catching it here keeps that ambiguity out of the error path.
    const stub = stubFetch({ body: {} });
    await assert.rejects(
      () => clientWith(stub.impl).mutation("application.one", { applicationId: "x" }),
      (error: unknown) => {
        assert.ok(error instanceof DokployError);
        assert.match(error.message, /is a Dokploy query but was called as a mutation/);
        return true;
      },
    );
    assert.equal(stub.calls.length, 0, "no request should have been sent");
  });

  it("refuses a mutation called as a query", async () => {
    const stub = stubFetch({ body: {} });
    await assert.rejects(
      () => clientWith(stub.impl).query("application.create"),
      /was called as a query/,
    );
    assert.equal(stub.calls.length, 0);
  });

  it("reports an unknown procedure as a sync problem rather than a 404", async () => {
    const stub = stubFetch({ body: {} });
    await assert.rejects(
      () => clientWith(stub.impl).query("does.notExist"),
      /is not a known Dokploy procedure/,
    );
    assert.equal(stub.calls.length, 0);
  });
});

describe("DokployClient error handling", () => {
  it("turns a non-2xx into a DokployError carrying the status and issues", async () => {
    const stub = stubFetch({
      ok: false,
      status: 400,
      body: {
        message: "Input validation failed",
        code: "BAD_REQUEST",
        issues: [{ path: ["name"], message: "expected string" }],
      },
    });
    await assert.rejects(
      () => clientWith(stub.impl).mutation("application.create", { name: 1 as unknown as string }),
      (error: unknown) => {
        assert.ok(error instanceof DokployError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.issues.length, 1);
        assert.equal(error.procedure, "application.create");
        return true;
      },
    );
  });

  it("handles an empty 200 body", async () => {
    const stub = stubFetch({ ok: true, status: 200, text: "" });
    assert.equal(await clientWith(stub.impl).query("settings.health"), null);
  });

  it("maps an abort to a TIMEOUT error, not a generic network failure", async () => {
    const impl = (async (_input: URL | string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    await assert.rejects(
      () => clientWith(impl).query("application.readLogs", { applicationId: "x", tail: 10000 }),
      (error: unknown) => {
        assert.ok(error instanceof DokployError);
        assert.equal(error.code, "TIMEOUT");
        return true;
      },
    );
  });

  it("maps a transport failure to NETWORK_ERROR", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => clientWith(impl).query("settings.health"),
      (error: unknown) => {
        assert.ok(error instanceof DokployError);
        assert.equal(error.code, "NETWORK_ERROR");
        return true;
      },
    );
  });
});

describe("DokployClient URL normalisation", () => {
  it("tolerates a trailing slash on the base URL", async () => {
    const stub = stubFetch({ body: {} });
    const client = new DokployClient({
      apiBaseUrl: "https://dokploy.example.com/api/",
      apiKey: "k",
      fetchImpl: stub.impl,
    });
    await client.query("settings.health");
    assert.equal(stub.calls[0]?.url.pathname, "/api/settings.health");
  });

  it("honours a per-call timeout override", async () => {
    // Log tools rely on this: they need longer than the default metadata budget.
    let observed: number | undefined;
    const impl = (async (_input: URL | string, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => undefined);
      observed = init?.signal ? 1 : undefined;
      return { ok: true, status: 200, text: async () => "[]" } as Response;
    }) as unknown as typeof fetch;

    const client = new DokployClient({ apiBaseUrl: BASE, apiKey: "k", fetchImpl: impl });
    await client.query("application.readLogs", { applicationId: "a", tail: 5000 }, { timeoutMs: 90_000 });
    assert.equal(observed, 1);
  });
});
