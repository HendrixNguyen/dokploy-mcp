---
name: dokploy-cli
description: Use when deploying, managing, or inspecting Dokploy projects, applications, compose stacks, databases, domains, or deployments via the Dokploy CLI instead of Dokploy MCP tools.
---

# Dokploy CLI

Operate Dokploy instances via `@dokploy/cli` (`dokploy`) and lightweight helper scripts instead of loading dozens of MCP tool schemas into context.

## Prerequisites & Authentication

Verify `dokploy` is available (`dokploy --version`; fallback `npx -y @dokploy/cli`).

Authentication is resolved in this order:
1. Environment variables: `DOKPLOY_URL` (base URL **without** trailing `/api`) and `DOKPLOY_API_KEY` (or `DOKPLOY_AUTH_TOKEN`).
2. A `.env` file in the current working directory with `DOKPLOY_URL` and `DOKPLOY_API_KEY`.
3. Saved config from `dokploy auth -u https://panel.example.com -t YOUR_API_KEY`.

Quick check:
```bash
dokploy settings health --json
```

## Core Workflow: Resolve Names to IDs First

Dokploy CLI commands require opaque IDs (`--applicationId`, `--composeId`, `--environmentId`, `--postgresId`, etc.). **Never** dump `dokploy project all --json` raw into context on large instances. Use the bundled resolver script:

```bash
# List all projects, environments, and services (compact, no secrets)
node <skill-dir>/scripts/dokploy-resolve.mjs --list

# Resolve a service by name, appName, or partial match
node <skill-dir>/scripts/dokploy-resolve.mjs my-api

# Narrow by project, environment, or service type
node <skill-dir>/scripts/dokploy-resolve.mjs my-db --type postgres --env production
```

For a one-shot health summary (service status + latest deployment + Docker containers):
```bash
node <skill-dir>/scripts/dokploy-health.mjs my-api
```

## Quick Reference

Always pass `--json` when parsing output programmatically, and `--help` on any command/subcommand to verify exact flags.

| Task | Command |
|---|---|
| **Projects & Envs** | `dokploy project one --projectId <id> --json` / `dokploy environment by-project-id --projectId <id> --json` |
| **App: inspect / deploy** | `dokploy application one --applicationId <id> --json` / `dokploy application deploy --applicationId <id> --json` |
| **App: start / stop / reload** | `dokploy application start\|stop\|reload --applicationId <id> --json` |
| **App: logs** | `dokploy application read-logs --applicationId <id> --tail 100 --json` |
| **App: env vars** | `dokploy application save-environment --applicationId <id> --env "KEY=VAL" --json` |
| **Compose: inspect / deploy** | `dokploy compose one --composeId <id> --json` / `dokploy compose deploy --composeId <id> --json` |
| **Compose: logs** | Requires `--containerId` from `dokploy docker get-containers-by-app-name-match --appName <appName> --json`:<br>`dokploy compose read-logs --composeId <id> --containerId <cid> --tail 100 --json` |
| **Databases** | `dokploy <engine> <action> --<engine>Id <id> --json` (`postgres`, `mysql`, `mariadb`, `mongo`, `redis`, `libsql`) |
| **Deployments** | App: `dokploy deployment all --applicationId <id> --json`<br>Compose: `dokploy deployment all-by-compose --composeId <id> --json`<br>All/DBs: `dokploy deployment all-centralized --json` |
| **Rollback** | `dokploy rollback rollback --rollbackId <id> --json` |
| **Domains** | `dokploy domain by-application-id --applicationId <id> --json` or `by-compose-id --composeId <id> --json`<br>`dokploy domain create --host <host> --domainType application --applicationId <id> --https --certificateType letsencrypt --json` |
| **Containers** | `dokploy docker get-containers --json` / `dokploy docker restart-container --containerId <cid> --json` |
| **Backups** | `dokploy backup manual-backup-postgres --backupId <id> --json` (see `dokploy backup --help`) |

## Safety & Secret Redaction Rules

1. **Confirm before destructive or mutating actions**: Ask the user before running `delete`, `remove`, `stop`, `kill-*`, `rollback`, `change-password`, `rebuild`, `clean-*`, `save-environment`, or `deploy`/`redeploy` on production services unless the user explicitly requested that action.
2. **Never echo plaintext secrets**: `application one`, `compose one`, and `<engine> one` return `env`, `buildSecrets`, `databasePassword`, and `refreshToken` in plaintext. Filter or redact those fields before printing output to the user.
3. **High-risk commands to avoid unless explicitly instructed**:
   - `settings clean-all`, `clean-docker-prune`, `clean-unused-volumes` (global destructive cleanup)
   - `settings read-traefik-config`, `read-traefik-env`, `save-sshprivate-key` (host TLS/SSH secrets & ingress)
   - `patch *` and `docker upload-file-to-container` (arbitrary file writes)
   - `user create-api-key`, `organization *`, `custom-role *`, `sso *`, `scim *`, `security *` (IAM/credentials)
   - `stripe *`, `license-key *`, `cluster add-manager|add-worker|remove-worker`

## Detailed Reference

See [references/commands.md](references/commands.md) for all 57 command groups, database engine quirks (`libsql` differences), `domain create` flags, and deployment log patterns.
