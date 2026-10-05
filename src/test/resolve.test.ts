import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFromIndex } from "../tools/resolve.js";
import type { ResolvedService } from "../types.js";

/**
 * `resolveFromIndex` decides which service an agent meant. Two failure modes matter:
 * picking the wrong service (deploys or deletes the wrong thing) and refusing to pick when
 * there is only one obvious answer (the agent gives up on a solvable task).
 */

const index: ResolvedService[] = [
  {
    type: "application",
    id: "app-ui",
    name: "UI",
    appName: "router-ui",
    status: "done",
    projectId: "p-router",
    projectName: "AI Router",
    environmentId: "e-prod",
    environmentName: "production",
  },
  {
    type: "compose",
    id: "cmp-ddns",
    name: "cloudflare-ddns",
    appName: "router-ddns",
    status: "done",
    projectId: "p-router",
    projectName: "AI Router",
    environmentId: "e-prod",
    environmentName: "production",
  },
  {
    type: "postgres",
    id: "pg-api",
    name: "api-db",
    appName: "api-db",
    status: "running",
    projectId: "p-other",
    projectName: "Other Project",
    environmentId: "e-stage",
    environmentName: "staging",
  },
  {
    type: "application",
    id: "app-api",
    name: "api",
    appName: "other-api",
    status: "done",
    projectId: "p-other",
    projectName: "Other Project",
    environmentId: "e-stage",
    environmentName: "staging",
  },
];

describe("resolveFromIndex", () => {
  it("resolves an exact name to a single match", () => {
    const outcome = resolveFromIndex(index, { name: "UI" });
    assert.equal(outcome.match?.id, "app-ui");
    assert.equal(outcome.match?.type, "application");
  });

  it("prefers an exact match over a partial one that appears earlier", () => {
    // "api" is an exact service name and also a substring of nothing else here, but this
    // guards the real hazard: an exact match must win over a fuzzy hit in a narrowed pool.
    const outcome = resolveFromIndex(index, { name: "api" });
    assert.equal(outcome.match?.id, "app-api");
  });

  it("matches on appName as well as name", () => {
    const outcome = resolveFromIndex(index, { name: "router-ddns" });
    assert.equal(outcome.match?.id, "cmp-ddns");
  });

  it("returns candidates instead of guessing when a name is ambiguous", () => {
    const outcome = resolveFromIndex(index, { name: "a" });
    assert.equal(outcome.match, undefined, "must not pick arbitrarily");
    assert.ok(outcome.candidates.length > 1);
  });

  it("narrows by project", () => {
    const outcome = resolveFromIndex(index, { name: "a", project: "Other Project" });
    assert.ok(outcome.candidates.every((c) => c.projectName === "Other Project"));
  });

  it("narrows by environment", () => {
    const outcome = resolveFromIndex(index, { name: "a", environment: "production" });
    assert.ok(outcome.candidates.every((c) => c.environmentName === "production"));
  });

  it("narrows by service type", () => {
    const outcome = resolveFromIndex(index, { name: "api", type: "postgres" });
    assert.equal(outcome.match?.id, "pg-api");
  });

  it("excludes a service whose type was filtered out", () => {
    const outcome = resolveFromIndex(index, { name: "api", type: "compose" });
    assert.equal(outcome.match, undefined);
    assert.equal(outcome.candidates.length, 0);
  });

  it("requires a full match when exact is set", () => {
    const outcome = resolveFromIndex(index, { name: "UI", exact: true });
    assert.equal(outcome.match?.id, "app-ui");
    assert.equal(resolveFromIndex(index, { name: "U", exact: true }).candidates.length, 0);
  });

  it("accepts a raw id as the name", () => {
    const outcome = resolveFromIndex(index, { name: "pg-api" });
    assert.equal(outcome.match?.type, "postgres");
  });

  it("returns no match for an unknown name but keeps the full index for suggestions", () => {
    const outcome = resolveFromIndex(index, { name: "does-not-exist" });
    assert.equal(outcome.match, undefined);
    assert.equal(outcome.candidates.length, 0);
    assert.equal(outcome.everything.length, index.length, "suggestions still need the whole set");
  });

  it("combines filters rather than replacing them", () => {
    const outcome = resolveFromIndex(index, {
      name: "api",
      project: "Other Project",
      environment: "staging",
      type: "application",
    });
    assert.equal(outcome.match?.id, "app-api");
  });

  it("matches on a service with no id only by name", () => {
    // Dropping id-less tree entries is `loadServiceIndex`'s job, not this function's.
    // What matters here is that resolution itself never invents an id: with the entry
    // present it matches by name and reports the empty id faithfully, rather than
    // substituting something a caller could send to Dokploy.
    const outcome = resolveFromIndex([{ type: "application", id: "", name: "ghost" }], {
      name: "ghost",
    });
    assert.equal(outcome.match?.id, "");
  });
});
