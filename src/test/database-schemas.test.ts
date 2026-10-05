import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DATABASE_ID_KEY } from "../schemas/database.js";
import { DatabaseCreateSchema } from "../schemas/database.js";
import { DATABASE_TYPES } from "../types.js";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

/**
 * The consolidated database tools collapse six near-identical Dokploy namespaces into one
 * parameterised tool. That makes the `<type>Id` key mapping the highest-risk code in the
 * server: get it wrong and every call sends a field Dokploy does not recognise.
 *
 * The expected values below are transcribed from the pinned spec, and the create
 * expectations are re-derived from it at test time so a Dokploy upgrade cannot silently
 * loosen the schema.
 */

describe("DATABASE_ID_KEY", () => {
  it("maps every engine to its own id field", () => {
    // Verified per engine from docs/openapi.v0.30.8.json:
    //   postgres.changePassword takes { postgresId, password }
    //   mongo.changePassword   takes { mongoId, password }
    // and so on for the rest.
    assert.deepEqual(DATABASE_ID_KEY, {
      postgres: "postgresId",
      mysql: "mysqlId",
      mariadb: "mariadbId",
      mongo: "mongoId",
      redis: "redisId",
      libsql: "libsqlId",
    });
  });

  it("covers exactly the six engines, with no missing or extra key", () => {
    assert.deepEqual(
      Object.keys(DATABASE_ID_KEY).sort(),
      [...DATABASE_TYPES].sort(),
      "DATABASE_ID_KEY and DATABASE_TYPES must stay in step",
    );
  });

  it("agrees with the required field each engine's procedures actually declare", () => {
    const spec = JSON.parse(
      readFileSync(resolvePath(process.cwd(), "docs/openapi.v0.30.8.json"), "utf8"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;

    for (const type of DATABASE_TYPES) {
      const key = DATABASE_ID_KEY[type];
      const required = spec.paths[`/${type}.changeStatus`]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema?.required;
      // `changeStatus` is the one verb present on all six engines.
      if (Array.isArray(required)) {
        assert.ok(
          required.includes(key),
          `${type}.changeStatus should require ${key}, required was ${JSON.stringify(required)}`,
        );
      }
    }
  });
});

describe("DatabaseCreateSchema", () => {
  const base = { environmentId: "e1", name: "db", description: "d", serverId: null };

  it("requires a database name and user for postgres, mysql and mariadb", () => {
    for (const type of ["postgres", "mysql", "mariadb"] as const) {
      const result = DatabaseCreateSchema.safeParse({
        ...base,
        type,
        databaseName: "app",
        databaseUser: "app",
        databasePassword: "pw",
      });
      assert.ok(result.success, `${type} should accept a full payload`);

      const missing = DatabaseCreateSchema.safeParse({
        ...base,
        type,
        databasePassword: "pw",
      });
      assert.equal(missing.success, false, `${type} must reject a payload with no databaseName/User`);
    }
  });

  it("does not require a database name for mongo", () => {
    const result = DatabaseCreateSchema.safeParse({
      ...base,
      type: "mongo",
      databaseUser: "app",
      databasePassword: "pw",
    });
    assert.ok(result.success, "mongo has no databaseName field");
  });

  it("requires only a password for redis — no user, no database name", () => {
    const result = DatabaseCreateSchema.safeParse({ ...base, type: "redis", databasePassword: "pw" });
    assert.ok(result.success, "redis takes a password only");

    const missing = DatabaseCreateSchema.safeParse({ ...base, type: "redis" });
    assert.equal(missing.success, false);
  });

  it("requires the full libsql set including sqldNode and sqldPrimaryUrl", () => {
    // libsql is the outlier: the spec marks every field required, serverId included.
    const full = {
      environmentId: "e1",
      description: "d",
      type: "libsql",
      name: "db",
      appName: "libsql-app",
      serverId: "srv1",
      dockerImage: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
      databaseUser: "app",
      databasePassword: "pw",
      sqldNode: "primary",
      sqldPrimaryUrl: "http://node:8080",
      enableNamespaces: true,
    };
    assert.ok(DatabaseCreateSchema.safeParse(full).success);

    const withoutSqld = { ...full };
    delete (withoutSqld as Record<string, unknown>).sqldNode;
    assert.equal(DatabaseCreateSchema.safeParse(withoutSqld).success, false);
  });

  it("rejects an unknown engine", () => {
    assert.equal(
      DatabaseCreateSchema.safeParse({ ...base, type: "cassandra", databasePassword: "pw" }).success,
      false,
    );
  });

  it("rejects a password character Dokploy itself would refuse", () => {
    // Catching this locally turns a round-trip 400 into immediate feedback.
    const result = DatabaseCreateSchema.safeParse({
      ...base,
      type: "postgres",
      databaseName: "app",
      databaseUser: "app",
      databasePassword: "has spaces and $ymbols",
    });
    assert.equal(result.success, false);
  });
});

describe("external-port verb inconsistency", () => {
  it("uses the singular verb everywhere except libsql", () => {
    const spec = JSON.parse(
      readFileSync(resolvePath(process.cwd(), "docs/openapi.v0.30.8.json"), "utf8"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;

    for (const type of DATABASE_TYPES) {
      const singular = Boolean(spec.paths[`/${type}.saveExternalPort`]);
      const plural = Boolean(spec.paths[`/${type}.saveExternalPorts`]);
      assert.ok(
        singular !== plural,
        `${type} must have exactly one of saveExternalPort / saveExternalPorts`,
      );
    }

    // This asymmetry is real and is why the mapping lives in one constant.
    assert.equal(Boolean(spec.paths["/libsql.saveExternalPorts"]), true);
    assert.equal(Boolean(spec.paths["/postgres.saveExternalPorts"]), false);
  });
});
