# Dokploy MCP Server — Implementation Plan

Target: `dokploy-mcp-server`, Node 20+ / TypeScript, in `~/workspaces/dokploy-mcp-server`.
Dokploy instance under analysis: `https://dokploy.huyndg.io.vn`, running **v0.30.8**.

---

## 1. API analysis — verified findings

Everything in this section was confirmed by calling the live instance, not inferred from the spec.

### 1.1 The Swagger URL is not public, but the spec is accurate

`https://dokploy.huyndg.io.vn/swagger` **307-redirects to `/`** (the dashboard). The spec at
`/api/openapi.json` returns `401`. There is no publicly reachable Swagger UI on this instance.

The authoritative spec was retrieved from the upstream repository instead, pinned to the
instance's exact version tag (`openapi.json` at the repo root):

```
https://raw.githubusercontent.com/Dokploy/dokploy/v0.30.8/openapi.json
```

- OpenAPI `3.1.0`, title "Dokploy API", `554` operations across `51` tags.
- That file is what the dashboard's Swagger UI renders, so it is the right source of truth.

**Drift was checked, not assumed.** The `main` and `v0.30.8` specs were diffed and are
identical: `554` paths each, `0` added, `0` removed. The pinned snapshot is saved at
`docs/openapi.v0.30.8.json`, with a flat procedure index at
`docs/endpoints.v0.30.8.txt`.

Phase 0 still re-runs this diff, because Dokploy releases often ship procedure renames and
the instance can be upgraded independently of this plan.

### 1.2 Dokploy exposes two surfaces; use the REST façade

| Surface | Path | Response body |
|---|---|---|
| REST façade | `{DOKPLOY_URL}/api/<namespace>.<procedure>` | **Unwrapped** payload |
| Raw tRPC v11 | `{DOKPLOY_URL}/api/trpc/<namespace>.<procedure>` | `{"result":{"data":{"json":…}}}` |

Both were verified working. **Build against the REST façade** — the spec documents it, and it
returns the payload directly with no envelope to unwrap.

> Correction worth recording: an unauthenticated probe suggested the spec's paths were wrong,
> because a generic auth guard returns `401` for *any* path under `/api/`, including
> `/api/nonexistent.proc`. A `401` therefore proves nothing about routing. Re-probe **with a
> valid key** before drawing conclusions about the API's shape.

### 1.3 Authentication

Single header, API key generated in the dashboard under **Settings → API Keys**:

```
x-api-key: <key>
```

The spec has a generation bug worth knowing about: all `554` operations declare
`security: [{ "Authorization": [] }]`, but the only *defined* security scheme is
`apiKey` → header `x-api-key`. The `Authorization` requirement is dangling and should be
ignored. `Authorization: Bearer …` was tested and does not authenticate.

API keys can carry a **rate limit** (`user.createApiKey` accepts `rateLimitEnabled`,
`rateLimitTimeWindow`, `rateLimitMax`, `remaining`, `refillAmount`, `refillInterval`).
The MCP client must treat `429` as a normal, recoverable condition.

### 1.4 Request encoding

| Procedure kind | Spec method | Facade call |
|---|---|---|
| Query | `GET` | `GET /api/<ns>.<proc>?param=value` (plain query params) |
| Mutation | `POST` | `POST /api/<ns>.<proc>` with a **raw JSON body** |

Both `?input={"json":{…}}` and a `{"json":{…}}` body wrapper are also tolerated by the
façade, but plain params and a raw body are the documented form and should be used.

Method mismatches are **not** 405 on the façade. `POST` to a query procedure returns
`404 NOT_FOUND` — so a 404 can mean "wrong method", not only "no such resource".

### 1.5 Response shapes (all verified against live data)

Paginated list procedures return a two-key envelope — **not** `has_more`/`next_offset`:

```json
{ "items": [ … ], "total": 2 }
```

Confirmed on `application.search`, `compose.search`, `postgres.search`. `limit` is capped
at `100`, `offset` at `0`. The MCP layer must normalise this into the richer
`{total, count, offset, has_more, next_offset}` shape expected of a paginated tool.

Other confirmed shapes:

| Procedure | Returns |
|---|---|
| `user.session` | `{"user":{"id":"…"},"session":{"activeOrganizationId":"…"}}` |
| `settings.health` | `{"status":"ok"}` |
| `settings.getDokployVersion` | `"v0.30.8"` (bare string) |
| `project.all` | projects nested `→ environments[] → services[]` **with ids inline** |
| `deployment.all` | array of deployment rows (`deploymentId`, `status`, `logPath`, …) |

`project.all` is the backbone of the agent's mental model and is what the
`dokploy_resolve_service` tool is built on.

### 1.6 Error shape

Validation and runtime errors return the proper HTTP status with a rich body:

```json
{
  "message": "Input validation failed",
  "code": "BAD_REQUEST",
  "data": { "code": "BAD_REQUEST", "httpStatus": 400, "path": "application.create", "zodError": { … } },
  "issues": [ { "expected": "string", "code": "invalid_type", "path": ["name"],
                "message": "Invalid input: expected string, received undefined" } ]
}
```

The `issues[]` array is directly actionable: it names the offending field and what was
expected. The error mapper must surface it verbatim in the tool result — it is the single
best source of agent self-correction available.

Unauthenticated calls return a **flat** `{"message":"Unauthorized"}` with no `code` field,
so the error mapper must tolerate its absence.

---

## 2. Architecture

### 2.1 Why the six database namespaces are consolidated

`postgres`, `mysql`, `mariadb`, `mongo`, `redis`, `libsql` each expose an almost identical
16-operation surface — `96` procedures in total. Exposed one-to-one they would be `96` tools
whose descriptions differ only in a noun, which burns context and confuses tool selection.

They collapse into **10** tools parameterised by a `type` enum, with a discriminated Zod
union for `create` so each type still enforces its own required fields
(`postgres.create` requires `databaseName`/`databaseUser`; `mysql.create` also takes
`dockerImage`, defaulting to `mysql:8`; `mongo`/`redis` have no `databaseUser`).

The procedure-name mapping is then mechanical:

```ts
const ns = `postgres`;            // or mysql | mariadb | mongo | redis | libsql
await client.mutation(`${ns}.create`, input);
```

Trade-off, stated plainly: consolidation saves ~86 tools and roughly 40k tokens of tool
definitions, at the cost of a one-of-six branch in each handler. For an agent-facing server
that is the right trade — but the discriminated union in `create` must be maintained per
type or the schema silently loosens.

### 2.2 Project structure

```
dokploy-mcp-server/
├── package.json
├── tsconfig.json                  # strict, Node16 resolution
├── .env.example                   # DOKPLOY_URL, DOKPLOY_API_KEY, TRANSPORT, PORT
├── README.md
├── docs/
│   ├── implementation-plan.md     # this file
│   ├── openapi.v0.30.8.json       # pinned spec snapshot (already verified, 554 paths)
│   └── endpoints.v0.30.8.txt      # flat procedure index by tag
├── scripts/
│   └── sync-spec.ts               # fetch + diff spec against the running instance
├── src/
│   ├── index.ts                   # entry; transport selection
│   ├── server.ts                  # McpServer + registerTools()
│   ├── config.ts                  # env parse/validate, fail fast
│   ├── constants.ts               # CHARACTER_LIMIT, DEFAULTS, TIMEOUT
│   ├── client.ts                  # DokployClient: query() / mutation() / probe()
│   ├── errors.ts                  # tRPC + façade error → actionable text
│   ├── format.ts                  # json/markdown renderers, pagination, truncation
│   ├── types.ts                   # shared response interfaces
│   ├── procedures.ts              # GENERATED kind map (query|mutation) per procedure
│   ├── schemas/
│   │   ├── common.ts              # response_format, pagination, ServiceType
│   │   ├── database.ts            # discriminated unions per engine
│   │   └── ...
│   └── tools/
│       ├── index.ts               # registerTools(server, client)
│       ├── discovery.ts           # whoami, health, version, projects, servers, tags
│       ├── resolve.ts             # resolve_service, describe_service
│       ├── applications.ts
│       ├── compose.ts
│       ├── databases.ts
│       ├── domains.ts
│       ├── deployments.ts
│       ├── backups.ts
│       ├── docker.ts
│       ├── infra.ts               # mounts, registries, ssh keys, networks, cluster, audit
│       └── workflows.ts           # deploy_service, service_health, provision_stack
└── test/
```

### 2.3 The client — the piece that must be right

`src/client.ts` is the only file that knows the wire format. Every tool goes through it.

```ts
export class DokployClient {
  constructor(private readonly opts: {
    baseUrl: string;      // e.g. "https://dokploy.huyndg.io.vn/api"
    apiKey: string;
    timeoutMs?: number;
  }) {}

  /** Spec method GET. Plain query params. */
  async query<T>(procedure: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.opts.baseUrl.replace(/\/$/, "")}/${procedure}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return this.send<T>(url, "GET");
  }

  /** Spec method POST. Raw JSON body. */
  async mutation<T>(procedure: string, input?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.opts.baseUrl.replace(/\/$/, "")}/${procedure}`);
    return this.send<T>(url, "POST", input ?? {});
  }

  private async send<T>(url: URL, method: "GET" | "POST", body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          "x-api-key": this.opts.apiKey,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      const payload = text ? safeJsonParse(text) : null;
      if (!res.ok) throw toDokployError(res.status, payload, url.pathname);
      return payload as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new DokployError(504, "TIMEOUT", `Dokploy did not respond within ${this.opts.timeoutMs}ms to ${url.pathname}.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

Three details that are easy to get wrong:

1. **Undefined/null params are dropped, not stringified.** Sending `?limit=null` is rejected
   by zod on the server and surfaces as a confusing `400`.
2. **`limit=100` is the hard ceiling.** Clamp in the tool layer, not the client, so the
   `limit` a user asked for is visibly honoured.
3. **Timeouts are per call.** `readLogs` on a large project can take tens of seconds; give
   log tools a longer budget than metadata reads.

### 2.4 Error mapping

`src/errors.ts` turns a Dokploy failure into something an agent can act on without guessing.

```ts
export function describeError(status: number, code: string, message: string, issues?: Issue[]) {
  switch (code) {
    case "UNAUTHORIZED":
      return "Error: Dokploy rejected the API key (401). Check DOKPLOY_API_KEY — it must be a valid key from Settings → API Keys, and the instance must be reachable at DOKPLOY_URL.";
    case "FORBIDDEN":
      return "Error: The API key is valid but lacks permission for this action (403). It may be scoped to a different organization, or the procedure requires an admin role.";
    case "NOT_FOUND":
      return "Error: Not found (404). Verify the id, and confirm it belongs to the right service type. Note a POST to a query procedure also returns 404 on this API.";
    case "TOO_MANY_REQUESTS":
      return "Error: Rate limited (429). The key has a refill-based quota; wait for the refill window or reduce polling, then retry the same call.";
    case "BAD_REQUEST":
      return issues?.length
        ? `Error: Invalid input (400).\n${issues.map(i => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}\nFix these fields and retry.`
        : `Error: Invalid input (400). ${message}`;
    default:
      return `Error: Dokploy returned ${status} (${code ?? "no code"}). ${message}`;
  }
}
```

Tool handlers return these inside the result object with `isError: true` — not as
protocol-level JSON-RPC errors — per MCP best practice.

### 2.5 Pagination, formatting, truncation

`src/format.ts` holds three shared helpers so no tool reimplements them:

- `paginate(items, total, limit, offset)` → adds `count`, `has_more`, `next_offset` to the
  server's `{items, total}`. `has_more = offset + items.length < total`.
- `render(data, format)` → Markdown (default) or JSON. Markdown shows display name with id
  in parentheses, humanised timestamps, and drops verbose internals.
- `truncate(text, limit)` → enforces `CHARACTER_LIMIT = 25_000`, halving the item list and
  reporting what was dropped plus the exact `offset` to resume from.

`response_format: "markdown" | "json"` is part of every list tool's schema, defaulting to
`markdown`, per the skill's response-format guidance.

### 2.6 Procedure kind map

`src/procedures.ts` maps each procedure name to `query` or `mutation` so the client can
refuse a mismatched call before it reaches the network — turning a confusing 404 into a
precise developer error. It is **generated** from the pinned spec by `scripts/sync-spec.ts`
(rule: spec method `GET` → `query`, `POST` → `mutation`, which §1.4 confirms is exact).

---

## 3. Endpoint → tool mapping

All procedures below are from the pinned spec. Every tool is `snake_case`, prefixed
`dokploy_`, and carries `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/
`openWorldHint`). R = read-only, W = writes, D = destructive.

### 3.1 Discovery & context — 9 tools

| Tool | Procedure | Notes |
|---|---|---|
| `dokploy_whoami` | `GET user.session` | R. First call in any session |
| `dokploy_check_health` | `GET settings.health` | R |
| `dokploy_get_version` | `GET settings.getDokployVersion` | R. Returns a bare string |
| `dokploy_list_projects` | `GET project.all` | R. Nested project→env→services tree |
| `dokploy_get_project` | `GET project.one` | R |
| `dokploy_search_projects` | `GET project.search` | R, paginated |
| `dokploy_list_environments` | `GET environment.byProjectId` | R |
| `dokploy_list_servers` | `GET server.all` | R. Needed for `serverId` on create |
| `dokploy_list_tags` | `GET tag.all` | R |

### 3.2 Resolution workflows — 2 tools

These are the highest-leverage tools in the server. Agents fail on Dokploy not because the
API is hard but because every procedure wants an opaque id
(`environmentId: "3dFId8fY7N0ujnExgYYKL"`) and nothing maps a human name to one.

| Tool | Built from | Behaviour |
|---|---|---|
| `dokploy_resolve_service` | `project.all` | Input `name` + optional `project`/`environment`/`type`. Returns `{type, id, name, appName, projectId, projectName, environmentId, environmentName, status}`. On ambiguity returns all candidates and asks the agent to disambiguate — never guesses. |
| `dokploy_describe_service` | `project.all` + `*.one` + `domain.by*` + `deployment.all` | Full context in one call: config, domains, last 5 deployments, current status. Saves 4 round-trips and is what an agent should reach for instead of assembling state by hand. |

### 3.3 Applications — 14 tools

| Tool | Procedure | |
|---|---|---|
| `dokploy_search_applications` | `GET application.search` | R, paginated |
| `dokploy_get_application` | `GET application.one` | R |
| `dokploy_create_application` | `POST application.create` | W. `name` + `environmentId` required |
| `dokploy_update_application` | `POST application.update` | W |
| `dokploy_deploy_application` | `POST application.deploy` | W. Returns `deploymentId` |
| `dokploy_start_application` | `POST application.start` | W |
| `dokploy_stop_application` | `POST application.stop` | W |
| `dokploy_reload_application` | `POST application.reload` | W |
| `dokploy_cancel_application_deployment` | `POST application.cancelDeployment` | D |
| `dokploy_delete_application` | `POST application.delete` | D |
| `dokploy_get_application_logs` | `GET application.readLogs` | R. `tail` 1–10000, `since`, `search` |
| `dokploy_set_application_env` | `POST application.saveEnvironment` | D. Rewrites the whole env; `createEnvFile` to write `.env` |
| `dokploy_set_application_build_type` | `POST application.saveBuildType` | W. `nixpacks`/`static`/`dockerfile` |
| `dokploy_connect_application_git` | `POST application.saveGitProvider` | W |

### 3.4 Compose — 12 tools

Mirrors applications against the `compose` namespace:
`dokploy_search_composes` (`GET compose.search`), `dokploy_get_compose` (`GET compose.one`),
`dokploy_create_compose` (`POST compose.create`), `dokploy_update_compose`,
`dokploy_deploy_compose`, `dokploy_start_compose`, `dokploy_stop_compose`,
`dokploy_reload_compose`, `dokploy_delete_compose`,
`dokploy_set_compose_env` (`POST compose.saveEnvironment`),
`dokploy_get_compose_logs` (`GET compose.readLogs` — **requires `containerId`**; the tool
resolves it via `GET compose.loadServices` and errors clearly if the service has no
container), and `dokploy_get_compose_services` (`GET compose.loadServices`).

### 3.5 Databases — 10 tools covering 96 procedures

`type` ∈ `postgres | mysql | mariadb | mongo | redis | libsql`. Procedure = `` `${type}.${verb}` ``.

| Tool | Verb | Annotations |
|---|---|---|
| `dokploy_search_databases` | `search` | R, paginated |
| `dokploy_get_database` | `one` | R |
| `dokploy_create_database` | `create` | W — discriminated union per engine |
| `dokploy_update_database` | `update` | W |
| `dokploy_deploy_database` | `deploy` | W |
| `dokploy_start_database` | `start` | W |
| `dokploy_stop_database` | `stop` | W |
| `dokploy_reload_database` | `reload` | W |
| `dokploy_rebuild_database` | `rebuild` | D — recreates the container |
| `dokploy_delete_database` | `remove` | D |
| `dokploy_change_database_password` | `changePassword` | D |
| `dokploy_get_database_logs` | `readLogs` | R |
| `dokploy_set_database_external_port` | `saveExternalPort` | D. **Warn that this restarts the engine.** Note `libsql` uses the plural `saveExternalPorts` — a real inconsistency in the spec, handled in the mapping table. |

### 3.6 Domains & TLS — 7 tools

| Tool | Procedure | |
|---|---|---|
| `dokploy_validate_domain` | `POST domain.validateDomain` | R. `domain` + `serverIp`; reports DNS readiness before a deploy |
| `dokploy_list_application_domains` | `GET domain.byApplicationId` | R |
| `dokploy_list_compose_domains` | `GET domain.byComposeId` | R |
| `dokploy_create_domain` | `POST domain.create` | W. Large body: `host`, `port`, `https`, `certificateType`, `applicationId`\|`composeId`+`serviceName`, `middlewares[]` |
| `dokploy_update_domain` | `POST domain.update` | W |
| `dokploy_delete_domain` | `POST domain.delete` | D. Removes the live route |
| `dokploy_list_certificates` | `GET certificates.all` | R |

`domain.create` is the clearest example of a tool that must be better than its endpoint: the
raw body is 15 mostly-optional fields. The tool takes
`{target: "application" | "compose", targetId, serviceName?, host, port, https?}` and fills
the rest, so the agent never has to remember that `domainType` must match the target.

### 3.7 Deployments — 5 tools

| Tool | Procedure | |
|---|---|---|
| `dokploy_list_deployments` | `GET deployment.all` / `allByCompose` / `allCentralized` | R. Dispatch on `serviceType`+`serviceId` |
| `dokploy_get_deployment_logs` | `GET deployment.readLogs` | R. `tail` 1–10000 |
| `dokploy_get_deployment_queue` | `GET deployment.queueList` | R |
| `dokploy_kill_deployment` | `POST deployment.killProcess` | D |
| `dokploy_rollback_deployment` | `POST rollback.rollback` | D |

### 3.8 Backups & destinations — 7 tools

`dokploy_create_backup` (`POST backup.create`), `dokploy_list_backup_files`
(`GET backup.listBackupFiles`), `dokploy_delete_backup` (`POST backup.remove`),
`dokploy_list_backup_destinations` (`GET destination.all`),
`dokploy_create_backup_destination` (`POST destination.create`),
`dokploy_list_schedules` (`GET schedule.list`),
`dokploy_run_schedule_now` (`POST schedule.runManually`).

`backup.create` is discriminated on `backupType` (`database` | `compose`) and
`databaseType` (`postgres|mariadb|mysql|mongo|web-server|libsql`) — without that
discrimination an agent can easily send a `postgresId` for a compose backup and get an
opaque failure.

### 3.9 Docker — 5 tools

`dokploy_list_containers` (`GET docker.getContainers`),
`dokploy_start_container` / `dokploy_stop_container` / `dokploy_restart_container`
(`POST docker.*Container`), `dokploy_list_container_stats` (`GET swarm.getContainerStats`).

### 3.10 Infrastructure — 9 tools

`dokploy_list_mounts` (`GET mounts.allNamedByApplicationId`),
`dokploy_create_mount` (`POST mounts.create` — discriminated on
`bind`|`volume`|`file`),
`dokploy_delete_mount` (`POST mounts.remove`),
`dokploy_list_registries` (`GET registry.all`),
`dokploy_list_ssh_keys` (`GET sshKey.all`),
`dokploy_list_networks` (`GET network.all`),
`dokploy_list_cluster_nodes` (`GET cluster.getNodes`),
`dokploy_list_audit_logs` (`GET auditLog.all`),
`dokploy_list_notification_channels` (`GET notification.all`),
`dokploy_list_git_branches` (`GET github|gitlab|gitea|bitbucket.get*Branches`).

### 3.11 Workflow tools — 3 tools

The skill is explicit that tools should "enable complete workflows, not just API endpoint
wrappers". These three are why the server is more than a 1:1 mirror:

| Tool | Sequence | Why it earns its place |
|---|---|---|
| `dokploy_deploy_service` | `resolve_service` → `<type>.deploy` → `deployment.all` | Deploys **by name**, returns the `deploymentId` to poll. An agent otherwise needs 4 calls and a manual id handoff. |
| `dokploy_get_service_health` | `describe_service` + last 200 log lines | One call answers "is it healthy?". The single most common operational question. |
| `dokploy_provision_service_stack` | `environment.create?` → `<type>.create` → `application.create` → `domain.create` | Creates env + database + app + domain together, returning every generated id. `confirm: true` is required before any create call. |

**Approximate total: ~85 tools across 11 files**, covering ~300 of the 554 procedures, with
the remaining ones reachable through a deliberately excluded set (§3.12).

### 3.12 Deliberately excluded — and why

| Excluded | Reason |
|---|---|
| `settings.cleanAll`, `cleanDockerPrune`, `cleanAllDeploymentQueue`, `cleanUnusedVolumes`, `cleanStoppedContainers`, `cleanDockerBuilder`, `cleanRedis`, `cleanMonitoring`, `cleanSSHPrivateKey` | Global destructive operations with no target id. An agent can destroy an entire instance. **Exclude.** |
| `settings.updateServer`, `updateTraefikConfig`, `writeTraefikEnv`, `readTraefikConfig`, `readTraefikEnv`, `readMiddlewareTraefikConfig`, `saveSSHPrivateKey` | Read paths leak TLS keys, SSH keys and proxy credentials into agent context; write paths can brick ingress. **Exclude both directions.** |
| `patch.*` (12 ops) | Reads and writes arbitrary files on the host — `readRepoFile`, `saveFileAsPatch`, `markFileForDeletion`. An arbitrary-write primitive on the Dokploy host. **Exclude.** |
| `docker.uploadFileToContainer` | Arbitrary file write into a running container. **Exclude.** |
| `user.createApiKey`, `generateToken`, `remove`, `assignPermissions`, `createUserWithCredentials` | Creates credentials and grants permissions. **Exclude.** |
| `organization.*`, `customRole.*`, `sso.*`, `scim.*`, `security.*` | Access control and identity. `organization.create`/`delete` would let an agent manage tenancy. **Exclude.** |
| `stripe.*`, `licenseKey.*` | Billing and licensing; an agent should not spend money. **Exclude.** |
| `cluster.addManager`, `addWorker`, `removeWorker` | Cluster membership changes. **Exclude.** |
| `ai.*` (14 ops), `notification.create*`/`test*`/`update*` (40 ops), `forwardAuth.*`, `domain.generateDomain` | Not needed to deploy or operate services. The one useful read each (`notification.all`, `ai.getModels`) is kept. **Exclude the rest.** |

The governing rule: **an agent gets a tool when it needs it to deploy or operate a service.**
`settings.cleanAll` is not something an agent needs; it is something an agent can do by
accident. Everything on this list is recoverable only by restoring a backup.

---

## 4. Tool definition shape

Two representative definitions, showing the description discipline the skill requires —
`Args`, `Returns`, `Examples`, `Error Handling`, and an explicit "don't use when".

```ts
server.registerTool(
  "dokploy_resolve_service",
  {
    title: "Resolve Dokploy Service",
    description: `Resolve a human-readable service name to the ids Dokploy procedures require.

Dokploy addresses every resource by opaque id (e.g. "3dFId8fY7N0ujnExgYYKL"). Use this tool
first whenever you have a name instead of an id. It searches applications, compose stacks and
all six database engines at once.

Args:
  - name (string, required): Service name or appName to look for
  - project (string, optional): Narrow to this project name
  - environment (string, optional): Narrow to this environment name
  - type (enum, optional): 'application' | 'compose' | 'postgres' | 'mysql' | 'mariadb' |
    'mongo' | 'redis' | 'libsql'. Omit to search all.
  - exact (boolean, default false): Require an exact name match before falling back to fuzzy

Returns: A single match, or a candidate list when ambiguous:
  { "match": { "type": "compose", "id": "zWYIcwaGz5LFoTL4TXaXM", "name": "cloudflare-ddns",
               "appName": "ai-router-cloudflaredns-bp8dx6", "status": "done",
               "projectId": "…", "projectName": "AI Router",
               "environmentId": "…", "environmentName": "production" } }

Examples:
  - Use when: "Restart cloudflare-ddns" -> resolve_service({name: "cloudflare-ddns"}),
    then dokploy_reload_compose({composeId: <id>})
  - Use when: "What is the postgres id for the API project?" ->
    resolve_service({name: "api", type: "postgres"})
  - Don't use when: you already have an id — pass it straight to the operation

Error Handling:
  - No match -> "No service named 'x' found. Searched N services across M projects.
    Available: …" and lists near matches
  - Multiple matches -> returns every candidate with its project/environment; the caller
    must disambiguate. This tool never picks one arbitrarily.`,
    inputSchema: ResolveServiceInput,
    annotations: {
      readOnlyHint: true, destructiveHint: false,
      idempotentHint: true, openWorldHint: true,
    },
  },
  async (params) => { /* … */ },
);
```

```ts
server.registerTool(
  "dokploy_change_database_password",
  {
    title: "Change Dokploy Database Password",
    description: `Change the application user's password on a running database. Takes effect on
the next connection attempt; existing sessions are not dropped.

Args:
  - type (enum, required): 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis'
  - databaseId (string, required)
  - password (string, required): Allowed characters are letters, digits and @#%^&*()_+-=
    []{}|;:,.<>?~\` — anything else is rejected by Dokploy
  - confirm (boolean, required): Must be true. Any application still using the old password
    will start failing to connect

Returns: { "type": "postgres", "databaseId": "…", "changedAt": "…" }

Examples:
  - Use when: "Rotate the API database password" ->
    change_database_password({type:"postgres", databaseId:"…", password:"…", confirm:true}),
    then update the consuming app's env with dokploy_set_application_env
  - Don't use when: you are creating a database for the first time — pass the password to
    dokploy_create_database instead

Error Handling:
  - confirm !== true -> refuses without calling the API
  - 404 -> wrong engine for this id, or the id does not exist`,
    inputSchema: ChangeDatabasePasswordInput,
    annotations: {
      readOnlyHint: false, destructiveHint: true,
      idempotentHint: false, openWorldHint: true,
    },
  },
  async (params) => {
    if (!params.confirm) {
      return {
        isError: true,
        content: [{ type: "text", text:
          "Error: confirm must be true. Changing a database password breaks every client " +
          "still using the old one. Re-run with confirm: true once you have updated the " +
          "consuming application's environment." }],
      };
    }
    await client.mutation(`${params.type}.changePassword`, {
      [`${params.type}Id`]: params.databaseId,
      password: params.password,
    });
    return { /* … */ };
  },
);
```

Note the id key is computed (`${type}Id`) — `postgres.changePassword` wants `postgresId`,
`mongo.changePassword` wants `mongoId`. That mapping is the main source of bugs in
consolidated database tools and belongs in one place, not inline in each handler.

Every mutating tool also takes a `confirm: z.literal(true)`-style guard, consistent with the
`mcp-builder` guidance that annotations are hints and not security guarantees.

---

## 5. Transport & configuration

**Both transports, selected by `TRANSPORT` env var** — `stdio` (default) for local clients,
streamable HTTP for remote/shared use, per the skill's transport guidance.

- **stdio**: must log to **stderr** only. A single `console.log` corrupts the JSON-RPC
  stream. All diagnostics go through a `logger` writing to `process.stderr`.
- **Streamable HTTP**: stateless JSON — `sessionIdGenerator: undefined` and
  `enableJsonResponse: true`, with a fresh `StreamableHTTPServerTransport` per request.
  Bind to `127.0.0.1` by default, validate `Origin` against an allowlist, and require an
  auth token on `/mcp` (DNS-rebinding protection, per best practices).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DOKPLOY_URL` | yes | — | `https://dokploy.huyndg.io.vn` — **no trailing `/api`**; the client appends it |
| `DOKPLOY_API_KEY` | yes | — | Settings → API Keys. Never logged, never echoed in errors |
| `TRANSPORT` | no | `stdio` | `stdio` \| `http` |
| `PORT` | no | `3000` | http only |
| `MCP_HTTP_TOKEN` | http only | — | Bearer token required on `/mcp` |
| `ALLOWED_ORIGINS` | no | `http://localhost:*` | Comma-separated |
| `LOG_LEVEL` | no | `info` | `debug` enables request logging (redacted) |

`src/config.ts` validates all of this at startup and exits with an actionable message rather
than failing on the first tool call. `DOKPLOY_API_KEY` is read once and held in a closure —
never passed into a Zod schema, a tool description, or a log line.

---

## 6. Build order

Each phase is independently verifiable.

| # | Phase | Deliverable | Verify with |
|---|---|---|---|
| 0 | **Re-verify the spec** | `scripts/sync-spec.ts` fetches the spec for the instance's current version; diff against the pinned snapshot | Diff report; every tool's procedure must exist on the instance. *(Baseline already done — `main` ≡ `v0.30.8`, 554/554. This phase exists to catch a future Dokploy upgrade.)* |
| 1 | **Skeleton** | `package.json`, `tsconfig.json`, `config.ts`, `constants.ts`, `client.ts`, `errors.ts`, `format.ts` | `npm run build` clean; `client.query("settings.health")` returns `{status:"ok"}` |
| 2 | **Smoke tool** | `dokploy_whoami` + `dokploy_check_health` over stdio | MCP Inspector `tools/list` + `tools/call` |
| 3 | **Discovery + resolution** | §3.1, §3.2 | Resolve all live services by name; every id round-trips into a subsequent call |
| 4 | **Applications + compose** | §3.3, §3.4 | Deploy an existing app by name end-to-end; read its logs |
| 5 | **Databases** | §3.5 | `dokploy_describe_service` resolves all six engines; create against a scratch environment |
| 6 | **Domains, deployments, backups** | §3.6–3.8 | `domain.validateDomain` on a real host; list and read a real deployment's logs |
| 7 | **Docker + infra** | §3.9, §3.10 | List containers; list mounts |
| 8 | **Workflows** | §3.11 | `deploy_service` by name; `get_service_health`; `provision_service_stack` on a scratch env |
| 9 | **Docs + evals** | `README.md`; `evaluations/evaluation.xml` | 10 read-only eval questions, each answered by hand and verified |

Phase 3 before 4 is deliberate: resolution is what makes every later tool usable by an agent,
and it is the cheapest thing to get right.

---

## 7. Testing

**Unit** (`bun test` / `vitest`, no network): the error mapper against every recorded
Dokploy failure shape; `paginate` boundary cases (`offset` at the end, `total` = 0,
`offset` past `total`); `truncate`; the `${type}Id` key mapping for all six engines — a table
test, because this is the highest-risk mapping in the codebase; and the procedure kind map
(`GET`→query, `POST`→mutation) against the pinned spec.

**Integration** (requires `DOKPLOY_API_KEY`, read-only against the live instance):
`settings.health`, `user.session`, `project.all`, and `*.search` for every service type,
asserting the `{items, total}` envelope. A live smoke test that the façade path and the
`x-api-key` header are both still correct.

**Contract** (`npx @modelcontextprotocol/inspector`): every tool appears with a valid input
schema; a `400` surfaces `issues[]` legibly; a `401` produces the "check DOKPLOY_API_KEY"
message rather than a stack trace.

**Evaluations** (`evaluations/evaluation.xml`, 10 questions): read-only, multi-call,
realistic, and each independently verifiable by string comparison — e.g. "Which compose stack
in the AI Router project has a `cloudflare-ddns` service and is in state `done`?" and "How
many environments does the project created most recently have?". Verify every answer by hand
before shipping the file; an unverified answer makes the eval worse than no eval.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Spec drift vs. the running instance | Snapshot pinned at `v0.30.8` (drift already checked: 0 procedures); `sync-spec.ts` re-diffs on demand |
| Spec bug: dangling `Authorization` security scheme | Use the defined `apiKey` scheme; §1.3 |
| Facade returns `404` for a wrong method | `procedures.ts` kind map catches it pre-flight |
| libsql's `saveExternalPorts` (plural) | Encoded in the mapping table, with a table test |
| Agent destroys the instance via `settings.cleanAll` | Excluded (§3.12); the arbitrary-write primitives go with it |
| Secrets reach agent context | Excluded settings readers; `DOKPLOY_API_KEY` never logged or echoed |
| Tool count erodes tool selection | 96 database procedures → 10 tools; the rest consolidated likewise |
| Rate-limited API key | `429` mapped to an actionable retry message; tools default to `tail: 200`, not unbounded |
| stdio stdout corruption | Logger writes to stderr only; CI asserts no stdout writes |
| Unbounded log responses | `CHARACTER_LIMIT` truncation with a resume `offset` |

---

## Appendix A — Tag distribution (554 operations)

Verified against the pinned `v0.30.8` spec. Full listing in `docs/endpoints.v0.30.8.txt`.

| Ops | Tag | Ops | Tag |
|---|---|---|---|
| 54 | settings | 12 | patch |
| 41 | notification | 11 | organization |
| 31 | application | 11 | sso |
| 31 | compose | 10 | forwardAuth |
| 23 | user | 9 | deployment |
| 18 | server | 9 | domain |
| 16 | mariadb / mongo / mysql / postgres / redis | 9 | project |
| 14 | libsql | 8 | network, gitea, stripe, tag |
| 14 | ai | 7 | bitbucket, gitlab, registry, sshKey |
| 12 | backup | 7 | environment |
| 12 | docker | 6 | destination, github, mounts, licenseKey, customRole, schedule, volumeBackups |

## Appendix B — Reproducing the analysis

```bash
KEY=<your key>          # never commit this
B=https://dokploy.huyndg.io.vn/api

# version + health
curl -s -H "x-api-key: $KEY" "$B/settings.getDokployVersion"
curl -s -H "x-api-key: $KEY" "$B/settings.health"

# a query, paginated
curl -s -G -H "x-api-key: $KEY" "$B/application.search" \
     --data-urlencode 'q=UI' --data-urlencode 'limit=1'

# the project tree with inline ids
curl -s -H "x-api-key: $KEY" "$B/project.all"

# a mutation that cannot succeed — safe way to read the validation error shape
curl -s -X POST -H "x-api-key: $KEY" -H 'content-type: application/json' \
     -d '{}' "$B/application.create"
```
