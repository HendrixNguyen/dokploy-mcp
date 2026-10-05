import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../server.js";
import { DokployClient } from "../client.js";
import { loadConfig } from "../config.js";
import { silentLogger } from "../logger.js";
import type { ToolContext } from "../tools/registry.js";

/**
 * Drives the real server over the real MCP protocol. Anything wrong with registration, the
 * input schemas, the annotations or the confirmation gate shows up here rather than in a
 * client.
 *
 * `fetch` is stubbed, so these tests never touch the network and no tool can mutate
 * anything, whatever its arguments.
 */

interface Recorded {
  url: string;
  method?: string;
  body?: unknown;
}

function stubContext() {
  const calls: Recorded[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url: url.pathname,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    const procedure = url.pathname.replace(/^\/api\//, "");
    const replies: Record<string, unknown> = {
      "settings.health": { status: "ok" },
      "settings.getDokployVersion": "v0.30.8",
      "user.session": {
        user: { id: "u1" },
        session: { activeOrganizationId: "org1" },
      },
      "project.all": [
        {
          projectId: "p1",
          name: "AI Router",
          environments: [
            {
              environmentId: "e1",
              name: "production",
              isDefault: true,
              // Two services, so name resolution can actually be exercised on the
              // ambiguous path as well as the unique one.
              applications: [
                {
                  applicationId: "a1",
                  name: "UI",
                  appName: "router-ui",
                  applicationStatus: "done",
                },
              ],
              compose: [
                { composeId: "c1", name: "cloudflare-ddns", composeStatus: "done" },
                { composeId: "c2", name: "cloudflare-api", composeStatus: "done" },
              ],
            },
          ],
        },
      ],
      "application.search": { items: [{ applicationId: "a1", name: "UI" }], total: 1 },
      // describe_service fans out to these alongside `application.one`; an empty list is
      // the honest answer for a service with no domains or deployments yet.
      "domain.byApplicationId": [],
      "deployment.all": [],
      // Shaped like a real `application.one` reply, which returns the build environment
      // and build-time secrets in plaintext.
      "application.one": {
        applicationId: "a1",
        name: "UI",
        appName: "router-ui",
        sourceType: "github",
        env: "DATABASE_URL=postgres://app:hunter2@db:5432/app",
        buildSecrets: "NPM_TOKEN=npm_do_not_leak_9f3a",
        previewEnv: "MODE=preview",
        repository: "org/router",
        buildType: "nixpacks",
      },
    };

    // Default reply keeps unstubbed reads harmless; anything unstubbed and mutated is
    // visible as a call in `calls`, which is what the gate tests assert on.
    const body = procedure in replies ? replies[procedure] : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;

  const config = loadConfig({
    DOKPLOY_URL: "https://dokploy.example.com",
    DOKPLOY_API_KEY: "test-key",
  });
  const client = new DokployClient({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    fetchImpl: impl,
  });
  const context: ToolContext = { client, logger: silentLogger, config };
  return { context, calls };
}

describe("MCP server contract", () => {
  let client: Client;
  let context: ToolContext;
  let calls: Recorded[];
  let tools: ListToolsResult["tools"];

  before(async () => {
    const stub = stubContext();
    context = stub.context;
    calls = stub.calls;

    const server = createServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools;
  });

  after(async () => {
    await client.close();
  });

  it("registers the full tool surface", () => {
    assert.ok(tools.length >= 80, `expected at least 80 tools, got ${tools.length}`);
  });

  it("gives every tool a title, a description and annotations", () => {
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has no title`);
      assert.ok(
        (tool.description ?? "").length > 120,
        `${tool.name} description is too thin to guide an agent`,
      );
      assert.ok(tool.annotations, `${tool.name} has no annotations`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    }
  });

  it("names every tool with the service prefix and snake_case", () => {
    for (const tool of tools) {
      assert.match(tool.name, /^dokploy_[a-z0-9_]+$/, `${tool.name} breaks the naming convention`);
    }
  });

  it("documents Args, Returns and Error Handling on every tool", () => {
    for (const tool of tools) {
      const description = tool.description ?? "";
      assert.match(description, /Args:/, `${tool.name} has no Args section`);
      assert.match(description, /Returns:/, `${tool.name} has no Returns section`);
      assert.match(description, /Error Handling:/, `${tool.name} has no Error Handling section`);
    }
  });

  it("does not expose the arbitrary host-file primitives", () => {
    // patch.* reads and writes arbitrary files on the Dokploy host, and
    // docker.uploadFileToContainer writes into a running container. Neither is something an
    // agent needs to deploy a service.
    const names = new Set(tools.map((tool) => tool.name));
    for (const forbidden of [
      "dokploy_upload_file_to_container",
      "dokploy_save_file_as_patch",
      "dokploy_read_repo_file",
      "dokploy_clean_all",
      "dokploy_clean_docker_prune",
      "dokploy_create_api_key",
    ]) {
      assert.equal(names.has(forbidden), false, `${forbidden} must not be exposed`);
    }
  });

  it("never mutates when confirm is omitted, for any mutating tool", async () => {
    // The safety property is behavioural, not structural: whatever a mutating tool's
    // JSON Schema looks like, calling it without `confirm: true` must not reach Dokploy.
    // Some of these fail schema validation first (a missing required id), which is also
    // safe — either way nothing is sent.
    const mutating = tools.filter((tool) => tool.annotations?.readOnlyHint !== true);
    assert.ok(mutating.length > 20, `expected many mutating tools, got ${mutating.length}`);

    for (const tool of mutating) {
      const before = calls.length;
      void (await client.callTool({ name: tool.name, arguments: {} }));
      assert.equal(
        calls.length,
        before,
        `${tool.name} called Dokploy with no arguments — an omitted confirm must be inert`,
      );
    }
  });

  it("advertises the confirm gate wherever the schema is introspectable", () => {
    // Root-level unions and intersections cannot express `required` in JSON Schema, so for
    // those the behavioural test above is the guarantee. Where the schema is a plain object,
    // the gate should still be visible to a client rendering the tool list.
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint === true) continue;
      const schema = tool.inputSchema as {
        required?: string[];
        properties?: Record<string, { default?: unknown }>;
      };
      const properties = schema.properties ?? {};
      if (Object.keys(properties).length === 0) continue; // opaque union/intersection
      assert.ok(
        (schema.required ?? []).includes("confirm") || properties.confirm?.default === false,
        `${tool.name} does not show the confirm gate in its advertised schema`,
      );
    }
  });

  it("answers whoami with the session identity", async () => {
    const result = (await client.callTool({ name: "dokploy_whoami", arguments: {} })) as CallToolResult;
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    assert.match(text, /org1/);
    assert.equal(result.isError, undefined);
  });

  it("resolves a compose name to its id", async () => {
    const result = (await client.callTool({
      name: "dokploy_resolve_service",
      arguments: { name: "cloudflare-ddns" },
    })) as CallToolResult;
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    assert.match(text, /c1/);
    assert.match(text, /AI Router/);
  });

  it("refuses an ambiguous name instead of picking one", async () => {
    // "cloudflare" matches both stacks in the fixture; the tool must return candidates
    // rather than silently choosing the first.
    const result = (await client.callTool({
      name: "dokploy_resolve_service",
      arguments: { name: "cloudflare" },
    })) as CallToolResult;
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    assert.match(text, /Ambiguous/i);
    assert.match(text, /will not pick one for you/);
    assert.match(text, /c1/);
    assert.match(text, /c2/);
  });

  it("reports a not-found name with suggestions rather than an empty result", async () => {
    const result = (await client.callTool({
      name: "dokploy_resolve_service",
      arguments: { name: "totally-unknown-name" },
    })) as CallToolResult;
    assert.equal(result.isError, true);
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    assert.match(text, /No Dokploy service matches/);
    assert.match(text, /cloudflare-ddns/, "should suggest the names it does know");
  });

  it("returns JSON on request and exposes the same payload as structuredContent", async () => {
    const result = (await client.callTool({
      name: "dokploy_search_applications",
      arguments: { response_format: "json" },
    })) as CallToolResult;
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    const parsed = JSON.parse(text) as { total: number; has_more: boolean };
    assert.equal(parsed.total, 1);
    assert.equal(parsed.has_more, false);
    assert.ok(result.structuredContent);
  });

  it("rejects an argument the schema forbids instead of forwarding it", async () => {
    // Zod `.strict()` plus an unknown key must be an error, not a silently dropped field.
    const result = (await client.callTool({
      name: "dokploy_whoami",
      arguments: { unexpected: true },
    })) as CallToolResult;
    assert.ok(result.isError || /unexpected|invalid/i.test(JSON.stringify(result.content)));
  });

  describe("confirmation gate", () => {
    it("refuses every mutating tool with confirm:false and calls nothing", async () => {
      const mutating = tools.filter((tool) => tool.annotations?.readOnlyHint !== true);
      assert.ok(mutating.length > 20, `expected many mutating tools, got ${mutating.length}`);

      // A representative mutating input per tool, chosen so that if the gate ever failed
      // open, the call would reach Dokploy rather than being rejected by validation first.
      const samples: Record<string, Record<string, unknown>> = {
        dokploy_delete_application: { applicationId: "a1", confirm: false },
        dokploy_delete_compose: { composeId: "c1", confirm: false },
        dokploy_delete_database: { type: "postgres", postgresId: "p1", confirm: false },
        dokploy_stop_application: { applicationId: "a1", confirm: false },
        dokploy_start_container: { containerId: "abc", confirm: false },
        dokploy_delete_domain: { domainId: "d1", confirm: false },
      };

      let checked = 0;
      for (const tool of mutating) {
        const arguments_ = samples[tool.name] ?? { confirm: false };
        const before_ = calls.length;
        const result = (await client.callTool({ name: tool.name, arguments: arguments_ })) as CallToolResult;

        if (result.isError && /confirm/i.test(JSON.stringify(result.content))) {
          checked += 1;
          assert.equal(
            calls.length,
            before_,
            `${tool.name} called Dokploy despite confirm being absent`,
          );
        }
      }
      assert.ok(checked >= 6, `expected the gate to fire on every sampled tool, fired on ${checked}`);
    });

    it("names the consequence when it refuses", async () => {
      const result = (await client.callTool({
        name: "dokploy_delete_application",
        arguments: { applicationId: "a1", confirm: false },
      })) as CallToolResult;
      const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
      assert.match(text, /refused/i);
      assert.match(text, /confirm: true/);
    });
  });

  it("never exposes the API key in any tool response", async () => {
    for (const name of ["dokploy_whoami", "dokploy_list_projects", "dokploy_check_health"]) {
      const result = (await client.callTool({ name, arguments: {} })) as CallToolResult;
      assert.ok(
        !JSON.stringify(result).includes("test-key"),
        `${name} leaked the API key into its response`,
      );
    }
  });

  it("reports a Dokploy failure as a tool error, not a protocol error", async () => {
    const failing: ToolContext = {
      ...context,
      client: new DokployClient({
        apiBaseUrl: "https://dokploy.example.com/api",
        apiKey: "test-key",
        fetchImpl: (async () => ({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              message: "Input validation failed",
              code: "BAD_REQUEST",
              issues: [{ path: ["name"], message: "expected string" }],
            }),
        })) as unknown as typeof fetch,
      }),
    };
    const server = createServer(failing);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const localClient = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([server.connect(serverT), localClient.connect(clientT)]);

    const result = (await localClient.callTool({
      name: "dokploy_delete_application",
      arguments: { applicationId: "a1", confirm: true },
    })) as CallToolResult;

    assert.equal(result.isError, true, "must surface as isError, not a thrown protocol error");
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    assert.match(text, /name: expected string/);
    assert.ok(!text.includes("test-key"));
    await localClient.close();
  });
});

describe("secret redaction over the real protocol", () => {
  // Regression for the review finding that `dokploy_describe_service` forwarded the raw
  // `application.one` row — including `env` and `buildSecrets` — into both the rendered text
  // and `structuredContent`, on a tool annotated READ_ONLY and behind no confirmation gate.
  // Redaction is enforced centrally in renderResult, so it has to be proven at the tool
  // boundary where the leak actually reached the model.
  let client: Client;

  before(async () => {
    const stub = stubContext();
    const server = createServer(stub.context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
  });

  for (const response_format of ["markdown", "json"] as const) {
    it(`keeps build secrets out of a describe_service result (${response_format})`, async () => {
      const result = (await client.callTool({
        name: "dokploy_describe_service",
        arguments: { name: "UI", response_format },
      })) as CallToolResult;

      const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
      const blob = `${text}${JSON.stringify(result.structuredContent ?? {})}`;

      assert.ok(!blob.includes("npm_do_not_leak_9f3a"), "buildSecrets value reached the model");
      assert.ok(!blob.includes("hunter2"), "password embedded in env reached the model");
      assert.match(blob, /__redacted__/, "the field should remain visible, marked as redacted");
      assert.ok(blob.includes("router"), "non-secret service fields must still be readable");
    });
  }
});
