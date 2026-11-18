#!/usr/bin/env node
/**
 * Summarize health of a Dokploy service by name or ID:
 * service status, latest deployment, and matching Docker containers.
 *
 * Usage:
 *   node dokploy-health.mjs <service-name-or-id> [--type <type>] [--env <env>]
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runJson(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (err) {
    if (err.code === "ENOENT" && cmd === "dokploy") {
      return runJson("npx", ["-y", "@dokploy/cli", ...args]);
    }
    return { error: err.stderr?.toString().trim() || err.message };
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: dokploy-health.mjs <service-name-or-id> [--type <type>] [--env <env>]"
    );
    process.exit(args.length === 0 ? 1 : 0);
  }

  const resolveScript = path.join(__dirname, "dokploy-resolve.mjs");
  const resolved = runJson("node", [resolveScript, ...args]);
  if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
  }
  if (!resolved.matches || resolved.matches.length === 0) {
    console.log(JSON.stringify({ error: "No matching service found", query: args[0] }, null, 2));
    process.exit(1);
  }
  if (resolved.matches.length > 1) {
    console.log(
      JSON.stringify(
        {
          error: "Multiple services matched; narrow with --type or --env",
          matches: resolved.matches,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const svc = resolved.matches[0];
  let latestDeployment = null;

  if (svc.type === "application") {
    const deps = runJson("dokploy", ["deployment", "all", "--applicationId", svc.id, "--json"]);
    if (Array.isArray(deps) && deps.length > 0) {
      const d = deps[0];
      latestDeployment = {
        deploymentId: d.deploymentId,
        status: d.status,
        title: d.title ?? null,
        createdAt: d.createdAt ?? null,
        finishedAt: d.finishedAt ?? null,
      };
    }
  } else if (svc.type === "compose") {
    const deps = runJson("dokploy", ["deployment", "all-by-compose", "--composeId", svc.id, "--json"]);
    if (Array.isArray(deps) && deps.length > 0) {
      const d = deps[0];
      latestDeployment = {
        deploymentId: d.deploymentId,
        status: d.status,
        title: d.title ?? null,
        createdAt: d.createdAt ?? null,
        finishedAt: d.finishedAt ?? null,
      };
    }
  }

  let containers = [];
  if (svc.appName) {
    const cArgs = ["docker", "get-containers-by-app-name-match", "--appName", svc.appName, "--json"];
    if (svc.serverId) cArgs.push("--serverId", svc.serverId);
    const rawContainers = runJson("dokploy", cArgs);
    if (Array.isArray(rawContainers)) {
      containers = rawContainers.map((c) => ({
        containerId: c.containerId,
        name: c.name,
        state: c.state,
        status: c.status,
      }));
    }
  }

  console.log(
    JSON.stringify(
      {
        service: svc,
        latestDeployment,
        containers,
      },
      null,
      2
    )
  );
}

main();
