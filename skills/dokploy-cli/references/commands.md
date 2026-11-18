# Dokploy CLI Reference

`@dokploy/cli` auto-generates 449+ commands across 57 groups from the Dokploy OpenAPI specification. Always run `dokploy <group> --help` or `dokploy <group> <action> --help` if you are unsure about an exact flag.

## Command Groups

- **Core**: `auth`, `project`, `environment`, `server`, `settings`, `overview`
- **Services**: `application`, `compose`, `deployment`, `preview-deployment`, `rollback`
- **Databases**: `postgres`, `mysql`, `mariadb`, `mongo`, `redis`, `libsql`
- **Networking & Ingress**: `domain`, `certificates`, `port`, `redirects`, `forward-auth`, `network`
- **Docker & Host**: `docker`, `docker-disk-usage`, `docker-image`, `docker-volume`, `mounts`, `swarm`, `cluster`
- **Backups & Schedules**: `backup`, `destination`, `volume-backups`, `schedule`
- **Git & Registries**: `git-provider`, `github`, `gitlab`, `bitbucket`, `gitea`, `registry`, `ssh-key`
- **Admin / Restricted** (avoid unless explicitly requested): `admin`, `ai`, `audit-log`, `custom-role`, `dns-provider`, `license-key`, `notification`, `organization`, `patch`, `scim`, `security`, `sso`, `stripe`, `tag`, `user`, `vault-provider`, `whitelabeling`

## Known API Quirks

### 1. Database Engines (`postgres`, `mysql`, `mariadb`, `mongo`, `redis`, `libsql`)
- Every engine uses its own `<engine>Id` flag: `--postgresId`, `--mysqlId`, `--mariadbId`, `--mongoId`, `--redisId`, `--libsqlId`.
- **`libsql` is an outlier**:
  - Has **no** `search` command (use `dokploy-resolve.mjs` instead).
  - Has **no** `change-password` command.
  - External ports command is plural: `dokploy libsql save-external-ports` (all other engines use singular `save-external-port`).
  - `create` requires `--appName` and `--sqldNode` in addition to `--name` and `--environmentId`.
- **Per-engine `create` differences**:
  - `redis` does not take `--databaseUser` or `--databaseName`.
  - `mongo` takes `--databaseUser` and `--databasePassword` (no `--databaseName`).
  - `postgres`, `mysql`, `mariadb` take `--databaseName`, `--databaseUser`, `--databasePassword`.

### 2. Domains (`dokploy domain create`)
`--domainType` must match the target:
- Application: `--domainType application --applicationId <id>`
- Compose service: `--domainType compose --composeId <id> --serviceName <svc>`
- Preview deployment: `--domainType preview --previewDeploymentId <id>`

Common flags: `--host <hostname> --port <port> --https --certificateType letsencrypt --json`.

### 3. Deployments & Logs
- **Application deployments**: `dokploy deployment all --applicationId <id> --json`
- **Compose deployments**: `dokploy deployment all-by-compose --composeId <id> --json`
- **Centralized (incl. DBs)**: `dokploy deployment all-centralized --json`
- **Deployment build logs**: `dokploy deployment read-logs --deploymentId <id> --json` (check exact flags with `--help`)
- **Application runtime logs**: `dokploy application read-logs --applicationId <id> --tail 100 --json`
- **Compose runtime logs**: Requires both `--composeId` and `--containerId`:
  1. Find container: `dokploy docker get-containers-by-app-name-match --appName <appName> --json`
  2. Read logs: `dokploy compose read-logs --composeId <id> --containerId <containerId> --tail 100 --json`
