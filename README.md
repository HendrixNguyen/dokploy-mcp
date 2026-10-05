# dokploy-mcp-server

An MCP server that lets an AI agent operate a [Dokploy](https://dokploy.com) instance:
deploy applications and compose stacks, manage the six database engines, configure domains,
and inspect deployments — by service **name**, not by opaque id.

- **87 tools** covering ~300 of Dokploy's 554 procedures
- **Verified against Dokploy v0.30.8**
- Transport: `stdio` (local clients) or stateless streamable HTTP (remote/shared)

---

## Why this exists

Dokploy's API is well-shaped but hostile to an agent. Every procedure addresses its resource
by an opaque id (`environmentId: "3dFId8fY7N0ujnExgYYKL"`), and the API exposes no lookup that
maps a human name to one. An agent that cannot resolve names must pull the whole project tree
and hand-match ids on every single task — that is the dominant source of failed tool calls
against this API.

So the first tools registered here are not endpoint wrappers. `dokploy_resolve_service` and
`dokploy_describe_service` turn a name into every id a caller needs, and three workflow tools
(`deploy_service`, `get_service_health`, `provision_service_stack`) chain calls so common
tasks are one call.

The other significant decision: `postgres`, `mysql`, `mariadb`, `mongo`, `redis` and
`libsql` each expose a near-identical 16-procedure surface — 96 procedures that differ only
in a noun. Exposed one-to-one they would be 96 tools whose descriptions are indistinguishable,
which burns context and confuses tool selection. They collapse into 13 tools parameterised by
engine, with a discriminated union on `create` so each engine still enforces its own required
fields.

---

## Requirements

- Node.js **22 or newer** (native `fetch`, `node --test`)
- A Dokploy instance (v0.30.8 tested; other versions may drift — see [Spec drift](#spec-drift))
- An API key from **Dokploy dashboard → Settings → API Keys**

## Install

```bash
git clone git@github.com:HendrixNguyen/dokploy-mcp.git
cd dokploy-mcp-server
npm install
npm run build
```

## Configure

```bash
cp .env.example .env
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DOKPLOY_URL` | yes | — | `https://dokploy.example.com` — **no trailing `/api`**, it is appended for you (supplying it is fine too; it will not double up) |
| `DOKPLOY_API_KEY` | yes | — | Never logged, never echoed in errors |
| `TRANSPORT` | no | `stdio` | `stdio` \| `http` |
| `PORT` | no | `3000` | http only |
| `MCP_HTTP_TOKEN` | http only | — | Bearer token required on `POST /mcp`; startup fails without it |
| `ALLOWED_ORIGINS` | no | `http://localhost:5173` | Comma-separated `Origin` allowlist |
| `LOG_LEVEL` | no | `info` | `debug` logs every request, credentials redacted |
| `DOKPLOY_TIMEOUT_MS` | no | `30000` | Log reads use their own longer budget |

The server does not read `.env` itself — export the variables, or use your process manager.

## Connect a client

stdio (most clients):

```json
{
  "mcpServers": {
    "dokploy": {
      "command": "node",
      "args": ["/absolute/path/to/dokploy-mcp-server/dist/index.js"],
      "env": {
        "DOKPLOY_URL": "https://dokploy.example.com",
        "DOKPLOY_API_KEY": "your-key"
      }
    }
  }
}
```

Use an absolute path to the interpreter and to `dist/index.js`. Relying on `node` being on
`PATH` fails in any non-login shell.

Remote (streamable HTTP):

```bash
TRANSPORT=http PORT=3000 MCP_HTTP_TOKEN=… DOKPLOY_URL=… DOKPLOY_API_KEY=… npm start
```

The endpoint is `POST /mcp`. It binds to `127.0.0.1` by default (set `HOST` to change),
validates `Origin` against `ALLOWED_ORIGINS`, and requires the bearer token — all three
matter, because this endpoint can deploy to your infrastructure.

## Verify the connection

```bash
npm test          # 108 unit + protocol-contract tests, no network
npx @modelcontextprotocol/inspector dist/index.js
```

---

## Tool surface

| Group | Tools | Covers |
|---|---|---|
| `discovery` | 9 | `user.session`, `settings.*`, `project.*`, `environment.*`, `server.all`, `tag.all` |
| `resolve` | 3 | name → id, full service context, cross-type search |
| `applications` | 14 | `application.*` lifecycle, logs, env, build type, git |
| `compose` | 12 | `compose.*` lifecycle, services, logs (resolves `containerId` for you) |
| `databases` | 13 | all six engines via one `<type>` parameter |
| `domains` | 7 | `domain.*`, `certificates.all` |
| `deployments` | 5 | `deployment.*`, `rollback.rollback` |
| `backups` | 7 | `backup.*`, `destination.*`, `schedule.*` |
| `docker` | 5 | `docker.getContainers`, container lifecycle, `swarm` stats |
| `infra` | 10 | `mounts`, `registry`, `sshKey`, `network`, `cluster`, `auditLog`, `notification`, git branches |
| `workflows` | 3 | deploy-by-name, health-in-one-call, full-stack provisioning |

Every tool carries `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`, and
its description states its arguments, its return shape, when **not** to use it, and what each
failure means.

### Safety model

Mutating tools take `confirm`. It defaults to `false`, so omitting it makes the tool **refuse
before making any request** and say what it would have done:

```
Error: refused without calling Dokploy. This will change the password for the
postgres database engine. When you are ready: Set confirm=true …
```

That is a real gate in the handler, not an annotation — MCP annotations are documented as
hints a client may ignore. A contract test asserts that *no* mutating tool reaches Dokploy
without `confirm: true`.

### Secret handling

Dokploy returns credentials in plaintext on its `*.one` reads — an application's `env` and
`buildSecrets`, a database's `databasePassword`, a compose stack's `refreshToken`. Those
procedures are exactly the ones an agent needs, so the response path, not the procedure list,
is where the guarantee has to live.

Every successful tool result is built through one function, which rewrites any value whose
field name looks like a credential to `__redacted__` before the text is rendered *and*
before it is handed over as `structuredContent`. Doing it there rather than per tool is the
point: it holds for the tools nobody has audited. The field names come from the pinned
v0.30.8 spec, and identifiers (`apiKeyId`, `sshKeyId`, `environmentId`) are deliberately
kept readable, because an agent cannot use an id it is not allowed to see.

The API key is never logged or echoed, and `describe_error` scrubs it from Dokploy's own
messages. Redaction is not a substitute for not writing down a secret; it is the reason a
read-only tool cannot become a credential-exfiltration tool by accident.

### Deliberately not exposed

Roughly 250 procedures are excluded. The rule: an agent gets a tool when it needs it to deploy
or operate a service — not when it can cause damage.

| Excluded | Why |
|---|---|
| `settings.cleanAll`, `cleanDockerPrune`, `cleanUnusedVolumes`, … | Global destructive operations with no target id. An agent can destroy an instance. |
| `settings.readTraefikConfig`, `readTraefikEnv`, `saveSSHPrivateKey`, … | Read paths leak TLS keys, SSH keys and proxy credentials into agent context; write paths can break ingress. |
| `patch.*` (12 procedures) | Arbitrary file read/write on the Dokploy host. An arbitrary-write primitive. |
| `docker.uploadFileToContainer` | Arbitrary file write into a running container. |
| `user.createApiKey`, `assignPermissions`, `createUserWithCredentials` | Creates credentials and grants permissions. |
| `organization.*`, `customRole.*`, `sso.*`, `scim.*`, `security.*` | Access control and identity. |
| `stripe.*`, `licenseKey.*` | An agent should not spend money. |
| `cluster.addManager`, `addWorker`, `removeWorker` | Cluster membership. |
| `ai.*` (14), `notification.create*`/`test*`/`update*` (40), `forwardAuth.*` | Not needed to deploy or operate a service. The one useful read in each (`notification.all`, `ai.getModels`) is kept. |

### Known API quirks this server handles

Dokploy's spec has some rough edges. These are handled in code, with tests:

- **`libsql` is an outlier.** No `search` and no `changePassword` procedures; `saveExternalPort`
  is spelled **`saveExternalPorts`** (plural) only for libsql. `dokploy_search_databases` falls
  back to the project tree for libsql, and the external-port tool maps the verb.
- **`appName` is optional everywhere except libsql** — Dokploy generates it otherwise.
- **`domain.create` takes 15 mostly-optional fields** whose `domainType` must match the target.
  `dokploy_create_domain` takes `{ target, targetId, … }` and derives them.
- **Per-engine `create` contracts differ** — redis needs only a password, mongo needs a user
  but no database name, libsql needs everything including `sqldNode`.
- **`deployment.all` requires `applicationId`** and `deployment.allByCompose` requires
  `composeId`; the database engines belong to neither and read from `allCentralized`.
- **The spec's `security` requirement is dangling** — all 554 operations require an
  `Authorization` scheme that is never defined. The real one is an `x-api-key` header.

---

## Spec drift

`src/procedures.ts` is generated from the pinned spec in `docs/`, and the client refuses to
call a procedure that is not in it — a stale map becomes a precise error instead of a 404.

After upgrading Dokploy:

```bash
DOKPLOY_URL=… DOKPLOY_API_KEY=… npm run sync-spec            # report drift
DOKPLOY_URL=… DOKPLOY_API_KEY=… npm run sync-spec -- --write # adopt it
npm run build && npm test
```

`sync-spec` reads the instance's own version, fetches the matching upstream spec, and prints
added and removed procedures. Note that Dokploy serves **no public Swagger UI** — `/swagger`
redirects to the dashboard and `/api/openapi.json` returns 401 — so the spec comes from
`raw.githubusercontent.com/Dokploy/dokploy/<tag>/openapi.json`.

## Layout

```
src/
├── client.ts        DokployClient — the only file that knows the wire format
├── errors.ts        Dokploy failures → actionable text, API key redacted
├── format.ts        pagination, Markdown/JSON rendering, truncation
├── procedures.ts    GENERATED procedure → query|mutation map
├── config.ts        env parsing, validated at startup
├── logger.ts        stderr only (stdout is the JSON-RPC channel)
├── server.ts        server assembly + stateless HTTP handler
├── schemas/         shared Zod fragments; per-engine database unions
├── scripts/         sync-spec
├── test/            108 tests, incl. a full MCP protocol contract test
└── tools/           one module per domain
```

## Development

```bash
npm run typecheck
npm run build
npm test          # builds, then runs the suite
npm run dev       # tsc --watch
```

Tests need no database and no network: `fetch` is stubbed. The suite covers the error mapper
against every recorded failure shape, pagination boundaries, the `<type>Id` mapping for all six
engines, procedure kinds against the pinned spec, name resolution, the confirmation gate, and a
contract test that drives the real server over the real MCP protocol.

## Licence

Apache-2.0
