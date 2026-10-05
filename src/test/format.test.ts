import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampLimit,
  clampOffset,
  compact,
  humanTime,
  paginate,
  redactSecrets,
  renderResult,
  table,
  truncateId,
} from "../format.js";
import { CHARACTER_LIMIT, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";

describe("paginate", () => {
  it("derives has_more and next_offset from what came back, not what was asked for", () => {
    // Dokploy returns only { items, total }; these two fields have to be computed.
    const page = paginate({ items: [1, 2, 3], total: 10 }, 3, 0);
    assert.equal(page.total, 10);
    assert.equal(page.count, 3);
    assert.equal(page.offset, 0);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 3);
  });

  it("reports no more pages on the final page", () => {
    const page = paginate({ items: [8, 9, 10], total: 10 }, 3, 7);
    assert.equal(page.has_more, false);
    assert.equal(page.next_offset, undefined);
  });

  it("handles an empty result", () => {
    const page = paginate({ items: [], total: 0 }, 20, 0);
    assert.deepEqual(page, { total: 0, count: 0, offset: 0, items: [], has_more: false });
  });

  it("handles an offset past the end without inventing a next page", () => {
    const page = paginate({ items: [], total: 5 }, 20, 100);
    assert.equal(page.has_more, false);
    assert.equal(page.next_offset, undefined);
  });

  it("accepts a bare array, which is what the un-paginated .all procedures return", () => {
    const page = paginate([{ a: 1 }], 20, 0);
    assert.equal(page.total, 1);
    assert.equal(page.has_more, false);
  });

  it("tolerates null and undefined", () => {
    assert.equal(paginate(null, 20, 0).count, 0);
    assert.equal(paginate(undefined, 20, 0).total, 0);
  });
});

describe("clampLimit / clampOffset", () => {
  it("defaults when absent", () => {
    assert.equal(clampLimit(undefined), DEFAULT_PAGE_SIZE);
    assert.equal(clampOffset(undefined), 0);
  });

  it("clamps to Dokploy's documented 1..100 page size", () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-5), 1);
    assert.equal(clampLimit(1000), MAX_PAGE_SIZE);
    assert.equal(clampLimit(37), 37);
  });

  it("never produces a negative offset", () => {
    assert.equal(clampOffset(-1), 0);
    assert.equal(clampOffset(12.9), 12);
  });
});

describe("renderResult", () => {
  const payload = { items: [{ name: "UI" }], total: 1 };

  it("emits Markdown with the title by default", () => {
    const result = renderResult({
      format: "markdown",
      title: "Applications",
      structured: payload,
      markdown: (data) => `rows=${data.items.length}`,
    });
    assert.match(result.content[0].text, /^## Applications/);
    assert.match(result.content[0].text, /rows=1/);
  });

  it("emits valid JSON on request and keeps the same payload structured", () => {
    const result = renderResult({
      format: "json",
      title: "Applications",
      structured: payload,
      markdown: () => "unused",
    });
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
    assert.deepEqual(result.structuredContent, payload);
  });

  it("prefers the empty message when isEmpty reports true", () => {
    const result = renderResult({
      format: "markdown",
      title: "Applications",
      structured: { items: [], total: 0 },
      markdown: () => "should not appear",
      empty: "No applications matched.",
      isEmpty: (data) => (data.items as unknown[]).length === 0,
    });
    assert.equal(result.content[0].text, "No applications matched.");
  });

  it("truncates an oversized response and says how to get the rest", () => {
    const huge = { items: Array.from({ length: 4000 }, (_, i) => ({ i, blob: "x".repeat(60) })) };
    const result = renderResult({
      format: "json",
      title: "Big",
      structured: huge,
      markdown: () => "unused",
    });
    const text = result.content[0].text;
    assert.ok(text.length <= CHARACTER_LIMIT, `expected <= ${CHARACTER_LIMIT}, got ${text.length}`);
    assert.match(text, /truncated/);
    assert.match(text, /Narrow the query/);
  });

  it("does not truncate a normal response", () => {
    const result = renderResult({
      format: "json",
      title: "Small",
      structured: payload,
      markdown: () => "unused",
    });
    assert.ok(!result.content[0].text.includes("truncated"));
  });
});

describe("formatting helpers", () => {
  it("keeps short ids whole so an agent can paste them into the next call", () => {
    assert.equal(truncateId("orx5AvUcI14WNpxA8sdWY"), "orx5AvUcI14WNpxA8sdWY");
  });

  it("elides only genuinely long ids", () => {
    const long = "a".repeat(60);
    assert.equal(truncateId(long).length, 40);
    assert.match(truncateId(long), /\.\.\.$/);
  });

  it("renders an ISO timestamp readably and tolerates junk", () => {
    assert.equal(humanTime("2026-10-02T03:59:09.958Z"), "2026-10-02 03:59:09Z");
    assert.equal(humanTime(null), "—");
    assert.equal(humanTime(undefined), "—");
    assert.equal(humanTime("not a date"), "not a date");
  });

  it("drops empty values from Markdown rows", () => {
    assert.deepEqual(compact({ a: 1, b: null, c: "", d: undefined, e: 0, f: false }), {
      a: 1,
      e: 0,
      f: false,
    });
  });

  it("escapes pipes so a value cannot break the table", () => {
    const rendered = table([{ host: "a|b" }], [{ key: "host", label: "Host" }]);
    assert.match(rendered, /a\\\|b/);
    assert.equal(rendered.split("\n").length, 3);
  });

  it("collapses a newline in a value so it cannot forge an extra table row", () => {
    const rendered = table(
      [{ host: "evil\n| injected | yes |" }],
      [{ key: "host", label: "Host" }],
    );
    assert.equal(rendered.split("\n").length, 3, "the injected row must not become its own line");
    assert.match(rendered, /evil \| injected \\| yes/);
  });

  it("escapes a backtick so a value cannot close and reopen a code span", () => {
    const rendered = table([{ host: "a` b `c" }], [{ key: "host", label: "Host" }]);
    assert.match(rendered, /a\\` b \\`c/);
  });

  it("renders an explicit placeholder for an empty table", () => {
    assert.equal(table([], [{ key: "x", label: "X" }]), "_none_");
  });
});

describe("secret redaction", () => {
  it("masks the credential fields Dokploy returns in plaintext", () => {
    // Field names as they actually come back from a v0.30.8 `*.one` read.
    const redacted = redactSecrets({
      env: "DATABASE_URL=postgres://u:p@host/db",
      buildSecrets: "NPM_TOKEN=npm_abc123",
      databasePassword: "hunter2",
      refreshToken: "v1-refresh-secret",
      customDomain: "ui.example.com",
      accessKey: "AKIA...",
    });
    assert.equal(redacted.env, "__redacted__");
    assert.equal(redacted.buildSecrets, "__redacted__");
    assert.equal(redacted.databasePassword, "__redacted__");
    assert.equal(redacted.refreshToken, "__redacted__");
    assert.equal(redacted.accessKey, "__redacted__");
    assert.equal(redacted.customDomain, "ui.example.com", "non-secret fields must survive");
  });

  it("masks secrets nested inside arrays and objects", () => {
    const redacted = redactSecrets({
      items: [{ name: "UI", previewEnv: "A=1" }, { name: "API", databasePassword: "p" }],
      settings: { nested: { envVariables: "B=2", port: 5432 } },
    });
    assert.equal(redacted.items[0]!.previewEnv, "__redacted__");
    assert.equal(redacted.items[1]!.databasePassword, "__redacted__");
    assert.equal(redacted.settings.nested.envVariables, "__redacted__");
    assert.equal(redacted.settings.nested.port, 5432);
  });

  it("keeps identifiers readable, since an agent must be able to use them", () => {
    // `apiKeyId` matches the apikey pattern but names a row, not a credential.
    const redacted = redactSecrets({
      apiKeyId: "key_123",
      sshKeyId: "ssh_456",
      environmentId: "env-1",
      password: "p",
    });
    assert.equal(redacted.apiKeyId, "key_123");
    assert.equal(redacted.sshKeyId, "ssh_456");
    assert.equal(redacted.environmentId, "env-1");
    assert.equal(redacted.password, "__redacted__");
  });

  it("does not redact OAuth provider config that merely mentions a token", () => {
    const provider = redactSecrets({
      tokenEndpoint: "https://id.example.com/token",
      tokenEndpointAuthentication: "client_secret_post",
    });
    assert.equal(provider.tokenEndpoint, "https://id.example.com/token");
    assert.equal(provider.tokenEndpointAuthentication, "client_secret_post");
  });

  it("keeps the secret value itself out of renderResult in both formats", () => {
    const payload = {
      applicationId: "abc",
      name: "UI",
      env: "SUPER_SECRET_VALUE=do-not-leak",
      buildSecrets: "NPM_TOKEN=npm_leaked_token",
    };
    const asJson = renderResult({
      format: "json",
      title: "Service",
      structured: payload,
      markdown: () => "unused",
    });
    const asMarkdown = renderResult({
      format: "markdown",
      title: "Service",
      structured: payload,
      markdown: (data) => JSON.stringify(data),
    });

    for (const result of [asJson, asMarkdown]) {
      const blob = `${result.content[0].text}${JSON.stringify(result.structuredContent)}`;
      assert.ok(!blob.includes("do-not-leak"), "env value leaked into the response");
      assert.ok(!blob.includes("npm_leaked_token"), "buildSecrets value leaked into the response");
      assert.match(blob, /__redacted__/, "the field should still be visible, marked as redacted");
    }
  });

  it("does not mutate the caller's payload", () => {
    const payload = { env: "KEEP_ME", name: "UI" };
    redactSecrets(payload);
    assert.equal(payload.env, "KEEP_ME");
  });
});

describe("structuredContent size cap", () => {
  it("drops trailing items so structuredContent cannot exceed the character limit", () => {
    // Typed as a loose record because capStructured adds `truncated`/`has_more`, which a
    // literal-typed payload would not admit access to.
    const huge: Record<string, unknown> = {
      items: Array.from({ length: 4000 }, (_, i) => ({ i, blob: "x".repeat(60) })),
      total: 4000,
      offset: 0,
    };
    const result = renderResult({
      format: "json",
      title: "Big",
      structured: huge,
      markdown: () => "unused",
    });
    const size = JSON.stringify(result.structuredContent).length;
    assert.ok(size <= CHARACTER_LIMIT, `expected <= ${CHARACTER_LIMIT}, got ${size}`);
    assert.equal(result.structuredContent.truncated, true);
    assert.equal(result.structuredContent.has_more, true, "capped payload must still say more exist");
    assert.ok((result.structuredContent.items as unknown[]).length < 4000);
  });

  it("leaves a payload that already fits untouched", () => {
    const small: Record<string, unknown> = { items: [{ name: "UI" }], total: 1 };
    const result = renderResult({
      format: "json",
      title: "Small",
      structured: small,
      markdown: () => "unused",
    });
    assert.equal(result.structuredContent.truncated, undefined);
    assert.deepEqual(result.structuredContent.items, [{ name: "UI" }]);
  });
});
