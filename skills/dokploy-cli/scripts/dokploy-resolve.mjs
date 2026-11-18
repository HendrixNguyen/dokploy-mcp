#!/usr/bin/env node
/**
 * Resolve Dokploy service, project, or environment names to opaque IDs
 * without dumping the full project tree or secrets into agent context.
 *
 * Usage:
 *   node dokploy-resolve.mjs --list [--project <name>] [--env <name>] [--type <type>]
 *   node dokploy-resolve.mjs <query> [--project <name>] [--env <name>] [--type <type>] [--exact]
 */

import { execFileSync } from "node:child_process";

const SERVICE_TYPES = [
  "application",
  "compose",
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
];

const TREE_KEYS = {
  application: "applications",
  compose: "compose",
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongo",
  redis: "redis",
  libsql: "libsql",
};

const ID_KEYS = {
  application: "applicationId",
  compose: "composeId",
  postgres: "postgresId",
  mysql: "mysqlId",
  mariadb: "mariadbId",
  mongo: "mongoId",
  redis: "redisId",
  libsql: "libsqlId",
};

const STATUS_KEYS = {
  application: "applicationStatus",
  compose: "composeStatus",
  postgres: "databaseStatus",
  mysql: "databaseStatus",
  mariadb: "databaseStatus",
  mongo: "databaseStatus",
  redis: "databaseStatus",
  libsql: "databaseStatus",
};

function runDokploy(args) {
  try {
    const out = execFileSync("dokploy", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (err) {
    if (err.code === "ENOENT") {
      const out = execFileSync("npx", ["-y", "@dokploy/cli", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse(out);
    }
    const msg = err.stderr?.toString().trim() || err.message;
    console.error(`dokploy ${args.join(" ")} failed: ${msg}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const opts = {
    list: false,
    exact: false,
    query: null,
    project: null,
    env: null,
    type: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list" || arg === "-l") {
      opts.list = true;
    } else if (arg === "--exact" || arg === "-e") {
      opts.exact = true;
    } else if (arg === "--project" || arg === "-p") {
      opts.project = argv[++i] ?? null;
    } else if (arg === "--env") {
      opts.env = argv[++i] ?? null;
    } else if (arg === "--type" || arg === "-t") {
      opts.type = argv[++i] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: dokploy-resolve.mjs [<query>] [--list] [--project <name>] [--env <name>] [--type <type>] [--exact]"
      );
      process.exit(0);
    } else if (!arg.startsWith("-") && !opts.query) {
      opts.query = arg;
    }
  }
  return opts;
}

function matchesText(candidates, needle, exact) {
  const target = needle.toLowerCase();
  return candidates.some((c) => {
    if (typeof c !== "string" || !c) return false;
    const val = c.toLowerCase();
    return exact ? val === target : val.includes(target);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.list && !opts.query) {
    console.error("Error: provide a <query> or --list. Use --help for usage.");
    process.exit(1);
  }
  if (opts.type && !SERVICE_TYPES.includes(opts.type)) {
    console.error(
      `Error: unknown --type "${opts.type}". Valid: ${SERVICE_TYPES.join(", ")}`
    );
    process.exit(1);
  }

  const projects = runDokploy(["project", "all", "--json"]);
  const index = [];

  for (const project of projects ?? []) {
    if (
      opts.project &&
      !matchesText([project.name, project.projectId], opts.project, opts.exact)
    ) {
      continue;
    }
    for (const env of project.environments ?? []) {
      if (
        opts.env &&
        !matchesText([env.name, env.environmentId], opts.env, opts.exact)
      ) {
        continue;
      }
      for (const type of SERVICE_TYPES) {
        if (opts.type && opts.type !== type) continue;
        const services = env[TREE_KEYS[type]] ?? [];
        for (const svc of services) {
          const id = svc[ID_KEYS[type]];
          if (typeof id !== "string" || !id) continue;
          const record = {
            type,
            id,
            idFlag: `--${ID_KEYS[type]}`,
            name: svc.name ?? null,
            appName: svc.appName ?? null,
            status: svc[STATUS_KEYS[type]] ?? null,
            projectId: project.projectId,
            projectName: project.name,
            environmentId: env.environmentId,
            environmentName: env.name,
            serverId: svc.serverId ?? null,
          };
          if (
            opts.list ||
            matchesText(
              [
                record.name,
                record.appName,
                record.id,
                `${record.projectName}/${record.name}`,
                `${record.environmentName}/${record.name}`,
              ],
              opts.query,
              opts.exact
            )
          ) {
            index.push(record);
          }
        }
      }
    }
  }

  console.log(JSON.stringify({ count: index.length, matches: index }, null, 2));
}

main();
