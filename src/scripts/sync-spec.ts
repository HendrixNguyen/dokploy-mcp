/**
 * Regenerate `src/procedures.ts` from a Dokploy OpenAPI spec and report drift.
 *
 * Run this after upgrading the Dokploy instance the server talks to. Endpoint names drift
 * between releases, and the client throws on an unknown procedure, so a stale map turns a
 * Dokploy upgrade into runtime failures rather than a build-time signal.
 *
 *   DOKPLOY_URL=https://dokploy.example.com npm run sync-spec
 *
 * Dokploy does not serve a public spec: `/swagger` redirects to the dashboard and
 * `/api/openapi.json` returns 401. The spec is fetched from the upstream repository at the
 * tag matching the instance's own reported version, which is what the dashboard renders.
 */

import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { DokployClient } from "../client.js";
import { loadConfig } from "../config.js";

const SPEC_BASE = "https://raw.githubusercontent.com/Dokploy/dokploy";

interface Spec {
  paths: Record<string, Record<string, unknown>>;
}

function renderModule(entries: [string, "query" | "mutation"][], version: string): string {
  return `/**
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run sync-spec\`.
 *
 * Maps each Dokploy procedure to its call kind. This mirrors the pinned spec exactly:
 * the spec's HTTP method for a procedure is GET for queries and POST for mutations,
 * and the REST facade uses the same split.
 *
 * Purpose: the facade answers a POST to a query procedure with 404 NOT_FOUND, which is
 * indistinguishable from a missing resource. Checking the kind here turns that into a
 * precise error before the request is sent.
 *
 * Source: docs/openapi.v${version}.json (${entries.length} procedures).
 */

export type ProcedureKind = "query" | "mutation";

export const PROCEDURES = {
${entries.map(([name, kind]) => `  ${JSON.stringify(name)}: ${JSON.stringify(kind)},`).join("\n")}
} as const satisfies Record<string, ProcedureKind>;

export type ProcedureName = keyof typeof PROCEDURES;

const LOOKUP: ReadonlyMap<string, ProcedureKind> = new Map(Object.entries(PROCEDURES));

/** Returns undefined for an unknown procedure, so callers can distinguish 'unknown' from 'wrong kind'. */
export function getProcedureKind(procedure: string): ProcedureKind | undefined {
  return LOOKUP.get(procedure);
}

export function isKnownProcedure(procedure: string): boolean {
  return LOOKUP.has(procedure);
}

export const PROCEDURE_COUNT = ${entries.length};
`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new DokployClient({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
  });

  const rawVersion = await client.query<string>("settings.getDokployVersion");
  const version = rawVersion.replace(/^v/, "");
  console.log(`Instance reports Dokploy v${version}`);

  const url = `${SPEC_BASE}/v${version}/openapi.json`;
  console.log(`Fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch the spec for v${version}: HTTP ${response.status}`);
  }
  // Stored verbatim rather than re-serialised: the spec is ~1.6 MB and reformatting it
  // would bury the real diff under whitespace.
  const rawSpec = await response.text();
  const spec = JSON.parse(rawSpec) as Spec;

  const entries: [string, "query" | "mutation"][] = Object.entries(spec.paths)
    .flatMap(([path, ops]) =>
      Object.keys(ops).map(
        (method) =>
          [
            path.replace(/^\//, ""),
            method === "get" ? ("query" as const) : ("mutation" as const),
          ] as [string, "query" | "mutation"],
      ),
    )
    .sort(([a], [b]) => a.localeCompare(b));

  const snapshotPath = resolvePath(process.cwd(), `docs/openapi.v${version}.json`);
  await writeFile(snapshotPath, rawSpec, "utf8");
  console.log(`Wrote ${entries.length} procedures to docs/openapi.v${version}.json`);

  // Diff against the module currently compiled in, so drift is visible without a rebuild.
  const existing = await import("../procedures.js");
  const before = new Map(Object.entries(existing.PROCEDURES));
  const after = new Map(entries);

  const added = entries.filter(([name]) => !before.has(name)).map(([name]) => name);
  const removed = [...before.keys()].filter((name) => !after.has(name));

  if (added.length === 0 && removed.length === 0) {
    console.log(`No drift: src/procedures.ts still matches v${version}.`);
  } else {
    if (added.length > 0) {
      console.log(`\nAdded in v${version} (${added.length}) — no tool wraps these yet:`);
      for (const name of added.slice(0, 40)) console.log(`  + ${name}`);
      if (added.length > 40) console.log(`  … and ${added.length - 40} more`);
    }
    if (removed.length > 0) {
      console.log(`\nRemoved in v${version} (${removed.length}) — tools still calling these WILL FAIL:`);
      for (const name of removed.slice(0, 40)) console.log(`  - ${name}`);
      if (removed.length > 40) console.log(`  … and ${removed.length - 40} more`);
    }
    console.log(
      "\nTo adopt the new spec, copy the regenerated map over src/procedures.ts:\n" +
        "  node -e \"import('./dist/procedures.js')\" >/dev/null\n" +
        "(or re-run with --write to update the module in place)",
    );
  }

  if (process.argv.includes("--write")) {
    await writeFile(
      resolvePath(process.cwd(), "src/procedures.ts"),
      renderModule(entries, version),
      "utf8",
    );
    console.log(`\nUpdated src/procedures.ts for v${version}. Re-run \`npm run build\`.`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sync-spec failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
