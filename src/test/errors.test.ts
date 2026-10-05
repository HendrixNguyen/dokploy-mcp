import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DokployError, describeError, toDokployError } from "../errors.js";

/**
 * Shapes below are transcribed verbatim from live responses on a v0.30.8 instance.
 *
 * The `issues` array is the highest-value thing Dokploy returns for a bad call: it names the
 * field and what was expected. These tests exist so that array is never dropped, reformatted
 * or swallowed on the way to the agent.
 */
describe("toDokployError", () => {
  it("parses the real validation-failure body", () => {
    const body = {
      message: "Input validation failed",
      code: "BAD_REQUEST",
      data: {
        code: "BAD_REQUEST",
        httpStatus: 400,
        path: "application.create",
        zodError: {
          formErrors: [],
          fieldErrors: {
            name: ["Invalid input: expected string, received undefined"],
            environmentId: ["Invalid input: expected string, received undefined"],
          },
        },
      },
      issues: [
        {
          expected: "string",
          code: "invalid_type",
          path: ["name"],
          message: "Invalid input: expected string, received undefined",
        },
        {
          expected: "string",
          code: "invalid_type",
          path: ["environmentId"],
          message: "Invalid input: expected string, received undefined",
        },
      ],
    };

    const error = toDokployError(400, body, "application.create");
    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.status, 400);
    assert.equal(error.issues.length, 2);
    assert.equal(error.procedure, "application.create");
  });

  it("parses the flat unauthorized body, which carries no code field", () => {
    // Unauthenticated calls return exactly this, so the mapper cannot assume `code` exists.
    const error = toDokployError(401, { message: "Unauthorized" });
    assert.equal(error.code, "UNAUTHORIZED");
    assert.equal(error.status, 401);
  });

  it("derives issues from data.zodError when the top-level issues array is absent", () => {
    const error = toDokployError(400, {
      message: "Input validation failed",
      code: "BAD_REQUEST",
      data: {
        code: "BAD_REQUEST",
        zodError: { formErrors: ["something global"], fieldErrors: { host: ["Required"] } },
      },
    });
    assert.equal(error.issues.length, 2);
    assert.deepEqual(error.issues[0]?.path, []);
    assert.deepEqual(error.issues[1]?.path, ["host"]);
  });

  it("infers the code from the status when Dokploy omits it", () => {
    assert.equal(toDokployError(403, { message: "nope" }).code, "FORBIDDEN");
    assert.equal(toDokployError(404, { message: "Not found" }).code, "NOT_FOUND");
    assert.equal(toDokployError(429, { message: "slow down" }).code, "TOO_MANY_REQUESTS");
    assert.equal(toDokployError(500, { message: "boom" }).code, "INTERNAL_SERVER_ERROR");
  });

  it("recognises rate limiting spelled the way Dokploy spells it", () => {
    assert.equal(toDokployError(400, { code: "TOO_MANY_REQUESTS" }).code, "TOO_MANY_REQUESTS");
    assert.equal(toDokployError(400, { code: "RATE_LIMIT_EXCEEDED" }).code, "TOO_MANY_REQUESTS");
  });

  it("survives a non-JSON body", () => {
    const error = toDokployError(502, "<html>bad gateway</html>");
    assert.equal(error.code, "INTERNAL_SERVER_ERROR");
    assert.match(error.message, /bad gateway/);
  });

  it("survives a null body", () => {
    const error = toDokployError(500, null);
    assert.equal(error.code, "INTERNAL_SERVER_ERROR");
    assert.match(error.message, /no error message/);
  });
});

describe("describeError", () => {
  const issue = (path: string[], message: string) => ({ path, message });

  it("lists every offending field for a 400 so the agent can self-correct", () => {
    const text = describeError(
      new DokployError({
        status: 400,
        code: "BAD_REQUEST",
        message: "Input validation failed",
        issues: [issue(["name"], "expected string"), issue(["environmentId"], "expected string")],
        procedure: "application.create",
      }),
    );
    assert.match(text, /name: expected string/);
    assert.match(text, /environmentId: expected string/);
    assert.match(text, /application\.create/);
    assert.match(text, /Fix these fields and retry/);
  });

  it("labels a root-level issue rather than printing a bare colon", () => {
    const text = describeError(
      new DokployError({
        status: 400,
        code: "BAD_REQUEST",
        message: "bad",
        issues: [issue([], "must be a cron expression")],
      }),
    );
    assert.match(text, /\(root\): must be a cron expression/);
  });

  it("points an operator at the credential when authentication fails", () => {
    const text = describeError(
      new DokployError({ status: 401, code: "UNAUTHORIZED", message: "Unauthorized" }),
    );
    assert.match(text, /DOKPLOY_API_KEY/);
    assert.match(text, /DOKPLOY_URL/);
  });

  it("explains that this API returns 404 for a method mismatch, not just a missing id", () => {
    const text = describeError(
      new DokployError({ status: 404, code: "NOT_FOUND", message: "Not found" }),
    );
    assert.match(text, /POST to a query procedure also returns 404/);
  });

  it("gives a recovery instruction for a rate-limited call", () => {
    const text = describeError(
      new DokployError({ status: 429, code: "TOO_MANY_REQUESTS", message: "slow down" }),
    );
    assert.match(text, /refill/);
    assert.match(text, /retry the same call/i);
  });

  it("never leaks the API key, even if Dokploy echoes it back", () => {
    const secret = "s3cr3t-key-value-that-must-not-appear";
    const error = toDokployError(
      400,
      { message: `rejected key ${secret}`, code: "BAD_REQUEST" },
      "application.create",
      secret,
    );
    const text = describeError(error, secret);
    assert.ok(!text.includes(secret), "API key must not appear in the error text");
    assert.match(text, /\*\*\*/);
  });

  it("describes a non-Dokploy throw without pretending it is one", () => {
    const text = describeError(new TypeError("boom"));
    assert.match(text, /unexpected failure/);
    assert.match(text, /boom/);
  });
});
