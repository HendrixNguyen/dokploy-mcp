import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

/**
 * The procedure kind map is generated from the pinned spec, so this test re-derives it from
 * that same spec. If the map and the spec ever drift, or the facade's GET/POST split stops
 * matching the spec's methods, this fails.
 */
describe("procedures", () => {
  const specPath = resolvePath(process.cwd(), "docs/openapi.v0.30.8.json");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };

  it("matches the pinned spec exactly, procedure for procedure", async () => {
    const { PROCEDURES } = await import("../procedures.js");
    const expected = new Map<string, "query" | "mutation">();
    for (const [path, ops] of Object.entries(spec.paths)) {
      const name = path.replace(/^\//, "");
      for (const method of Object.keys(ops)) {
        // Verified against the live instance: the facade uses the spec's own HTTP method,
        // with GET meaning query and POST meaning mutation.
        expected.set(name, method === "get" ? "query" : "mutation");
      }
    }

    const actual = new Map(Object.entries(PROCEDURES));
    assert.equal(actual.size, expected.size, "procedure count differs from the pinned spec");

    for (const [name, kind] of expected) {
      assert.equal(actual.get(name), kind, `${name} should be a ${kind}`);
    }
  });

  it("agrees with the spec on the fixtures the tool modules depend on", async () => {
    const { getProcedureKind } = await import("../procedures.js");
    // Pinned here on purpose: if a Dokploy upgrade moves one of these, the failure should
    // name the procedure rather than surface later as a confusing runtime 404.
    const fixtures: Record<string, "query" | "mutation"> = {
      "settings.health": "query",
      "settings.getDokployVersion": "query",
      "user.session": "query",
      "project.all": "query",
      "project.search": "query",
      "environment.byProjectId": "query",
      "application.one": "query",
      "application.readLogs": "query",
      "compose.loadServices": "query",
      "deployment.all": "query",
      "deployment.allByCompose": "query",
      "deployment.allCentralized": "query",
      "deployment.readLogs": "query",
      "application.create": "mutation",
      "application.reload": "mutation",
      "application.saveEnvironment": "mutation",
      "domain.validateDomain": "mutation",
      "domain.create": "mutation",
      "rollback.rollback": "mutation",
      "backup.create": "mutation",
      "postgres.changePassword": "mutation",
      "libsql.saveExternalPorts": "mutation",
      "postgres.saveExternalPort": "mutation",
    };
    for (const [name, kind] of Object.entries(fixtures)) {
      assert.equal(getProcedureKind(name), kind, `${name} should be a ${kind}`);
    }
  });

  it("returns undefined for an unknown procedure rather than guessing", async () => {
    const { getProcedureKind, isKnownProcedure } = await import("../procedures.js");
    assert.equal(getProcedureKind("does.notExist"), undefined);
    assert.equal(isKnownProcedure("does.notExist"), false);
    assert.equal(isKnownProcedure("application.one"), true);
  });

  it("records every procedure exactly once", async () => {
    const { PROCEDURES, PROCEDURE_COUNT } = await import("../procedures.js");
    assert.equal(PROCEDURE_COUNT, Object.keys(PROCEDURES).length);
  });
});
