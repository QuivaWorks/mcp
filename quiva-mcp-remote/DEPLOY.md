# Deploying quiva-mcp-remote (internal)

Internal notes. The staging URL is allowed here and nowhere else in this package.

## What it is

| | |
|---|---|
| Service | `quiva-mcp-remote`: one Node 22 process, stateless, port `8080` |
| Mesh access | None. It needs no Bellerophon creds, only outbound HTTPS to its environment's API gateway |
| Credentials | None at rest. Every request carries the caller's API key, which is forwarded to `QUIVA_API_URL` |
| Health | `GET /healthz` returns `200 {"ok":true}`; the image has a Docker `HEALTHCHECK` on it |
| Public URL | `https://api.microstrate.io/mcp` (staging), `https://api.quiva.ai/mcp` (production) |

## Image

Built from the root of the `QuivaWorks/mcp` repo, not from evari-olympus, so
evari-olympus `build.sh` cannot build it. Build it the same way as the other Node
images: `linux/amd64`, `-f quiva-mcp-remote/Dockerfile`, with the repo root as the
context.

- Image name: `quiva-mcp-remote`.
- Registry: the convention in evari-olympus `CLAUDE.md` is `gcr.io/microstrate/quiva-mcp-remote`.
  `build.sh` pushes the live services to ECR instead, at `817813566472.dkr.ecr.us-east-1.amazonaws.com/<name>:latest`.
  Push to whichever registry the target VM pulls from.
- `quiva-mcp-remote/Dockerfile.dockerignore` allowlists package manifests, `src/` and
  `examples/`. `.env` files, tests and harvest tools never enter the image.
- The root `package.json` workspaces and `package-lock.json` must include every
  composed package, or `npm ci` fails. A package that is missing from the image is
  skipped at startup with one log line, and the others still serve.

## Environment

| Variable | Staging | Production |
|---|---|---|
| `QUIVA_API_URL` | `https://api.microstrate.io` | unset (defaults to `https://api.quiva.ai`) |
| `HOST` | the VM's internal IP | the VM's internal IP |
| `PORT` | `8080` | `8080` |
| `TRUST_PROXY` | `true` | `true` |
| `ALLOWED_HOSTS` | `<vm-internal-ip>:8080` | `<vm-internal-ip>:8080` |
| `MAX_BODY_BYTES` | unset (1 MiB) | unset (1 MiB) |
| `REQUEST_TIMEOUT_MS` | unset (120000) | unset (120000) |
| `RECEIVE_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` | unset (30000 / 15000) | unset (30000 / 15000) |
| `MAX_CONNECTIONS` | unset (256) | unset (256) |
| `RATE_LIMIT_PER_SEC` / `RATE_LIMIT_BURST` | unset (10 / 40) | unset (10 / 40) |
| `AUTH_FAILURE_CACHE_SECONDS` | unset (off) | unset (off) |
| `ALLOWED_ORIGINS` | unset | unset |

- **`HOST`** defaults to `0.0.0.0`, which is right inside a bridged container. Under
  `--network=host` that binds every interface on the VM, so set the internal IP.
- **`TRUST_PROXY=true` is required behind cerberus.** Without it every request's
  socket peer is the cerberus node, so all users share one rate-limit bucket.
  With it the service takes the **last** `X-Forwarded-For` hop: cerberus's proxy is
  a Go `httputil.ReverseProxy` (`bellerophon-cerberus/gateway/gateway_api.go:705-724`),
  which appends its TCP peer to whatever `X-Forwarded-For` the client sent. The first
  hop is client-controlled; the last is not. Only set it when the port is
  firewalled to the gateway (below), or a direct caller can pick its own IP.
- **`ALLOWED_HOSTS` is the VM address, not `api.quiva.ai`.** The proxy rewrites
  `Host` to the mapping's `resource` host (`r.Host = url.Host`). It also sets
  `X-Forwarded-Host` from `r.Header.Get("Host")`, which Go always leaves empty, so
  the public host name never reaches the service. Anything but the listed `Host`
  gets 403, both from the service and from the MCP SDK's DNS-rebinding check.
- `ALLOWED_ORIGINS` unset means every browser `Origin` gets a 403. CLI and desktop
  clients send no `Origin` and are unaffected. Never set `QUIVA_API_KEY`,
  `QUIVA_EMAIL` or similar: the server ignores them by design.
- `MAX_BODY_BYTES`: see the README's body-cap note before raising it.
- `KEEP_ALIVE_TIMEOUT_MS` stays at Node's 5 s. The proxy's Go transport keeps idle
  connections for 90 s, so a POST can occasionally race a socket the service has
  just closed and get a 502. If that shows up, raise it above 90000 rather than
  retrying in clients.

## Runtime placement

The mesh runs containers with `--network=host` on a VM's internal IP
(`Microstrate_Mesh/ai/scripts/deploy.sh`). Pick a VM in each environment where port
8080 is free, or set `PORT`. The gateway reaches the service at
`http://<vm-internal-ip>:<PORT>`.
`Microstrate_Mesh/ai/deployment-config.yaml` has no Node services today. Adding an
entry there does not deploy anything, so run the container with your usual process.

**Firewall the port to the gateway only.** Allow ingress to `<PORT>` from the
cerberus nodes of that environment and nothing else. Every guard in the service
assumes its only direct caller is the gateway.

### Client IPs on the second hop (accepted)

Every tool call goes from this service to the API gateway, so upstream every user
of `/mcp` appears as the VM's IP. The service does **not** forward the client IP:
cerberus keys its per-IP limit by the TCP peer and ignores `X-Forwarded-For`
(`gateway_api.go:634-637`, `httprate.KeyByIP`; the WAF sees the peer too), so a
forwarded header would change nothing. The collapse is accepted. Mitigations, if
MCP traffic starts hitting the per-IP limit:
- exempt the VM's IP from cerberus's per-IP limit, relying on this service's own
  per-IP limit; or
- key that limit by credential rather than IP.

## Gateway: a cerberus proxy mapping on each environment

Only a `proxy` mapping works for MCP. It is handled at path level
(`bellerophon-cerberus/gateway/gateway_api.go:698-728`), so it:
- passes every header through both ways, with no X-Api-Key→JWT swap;
- keeps the `/mcp` path;
- streams, with no gateway timeout.

A `service` mapping hardcodes JSON and drops headers.

Proxy paths skip cerberus's auth, limit and timeout middleware entirely, so `/mcp`
has **no gateway-level rate limit**. The service's own per-IP limit, timeouts and
connection cap stand in for it. Auth is enforced twice downstream: the service
returns 401 without a key, and every tool call is authenticated by the API gateway
on the second hop.

The proxy branch only fires for **`method: "*"`** with `resource_type: "proxy"`, and
reads `resource` and `resource_type` from the mapping record itself
(`model.Mapping`), not from a mapping-version.

### `method: "*"` is untested: what gateway-service does with it

`post.mapping` builds the subject `ms.gateway.<id>.mapping.*.mcp`
(`gateway-service/handler/post-gateway-mapping.go:83-89`). The `*` is a wildcard
token, and the existence check at `:91-95` (`datapoint.SubjectExists` → latest
message on that subject) is therefore a wildcard read. Consequences:
- If **any** mapping already exists at `/mcp` (any method), the check matches it and
  `post.mapping` returns `400 this mapping already exists`.
- If none does, the write goes to a subject containing `*`. Whether the stream
  accepts a publish on it is unverified. No `method: "*"` mapping has been created
  on either gateway before.
- Later reads or patches on that subject are wildcard reads too.

### Procedure (staging first, then production)

`B="bcli --context staging"`. `bcli` defaults to production, so pass the context
(or `--server`) on every call. Staging's platform gateway (serving
`api.microstrate.io`) is `lqTzBJz_D5ms`. Look up the production gateway id for
`api.quiva.ai` the same way, and do not trust `DefaultGateway`. Send every
`post.*` / `get.*` below **with no `Authorization` header**: the platform token
makes the existence check fail with `404 the gateway does not exist`, and the list
fail with `400 the list errored`.

1. **Check `/mcp` is free.** `$B request microstrate.gateway.get.mappings
   '{"subject":"ms.gateway.<gateway-id>.gateway"}'` and confirm no mapping has path
   `/mcp`. If one does, stop and escalate (see below).
2. **Create the mapping.**
   ```sh
   $B request microstrate.gateway.post.mapping '{
     "gateway": "ms.gateway.<gateway-id>.gateway",
     "method": "*",
     "path": "/mcp",
     "resource_type": "proxy",
     "resource": "http://<vm-internal-ip>:8080",
     "is_public": true,
     "apply_limits": false,
     "proxy": false,
     "limit": { "request": 10000, "time": 1000 },
     "timeout": 300000,
     "traffic_distribution": { "1": 100 }
   }'
   ```
   `traffic_distribution` must be explicit: omitted, it is an empty map and every
   request 500s with an empty body.
3. **Create the mapping-version**: `post.mapping-version` with
   `"mapping": "ms.gateway.<gateway-id>.mapping.*.mcp"`, the same `resource`,
   `resource_type: "proxy"` and `active: true`. The proxy branch does not read it,
   but the rest of the gateway tooling expects one. It always mints N+1, so read
   back the version number it actually allocated.
4. **Read it back.** Repeat step 1. Exactly one mapping must have path `/mcp`,
   subject `ms.gateway.<gateway-id>.mapping.*.mcp`, method `*`,
   `resource_type: "proxy"` and the right `resource`. Anything else means the write
   was stored oddly: stop and escalate.
5. **Reload once**, after every write has landed:
   `$B publish 'ms.gateway.<gateway-id>.reload' '{}'`. A reload that fires while
   writes are still landing is discarded, so wait for a quiet minute first.
6. **Curl, expecting 401.**
   ```sh
   curl -si -X POST https://api.microstrate.io/mcp | head -20
   ```

   | Response | Meaning |
   |---|---|
   | `401` JSON-RPC error with `WWW-Authenticate: Bearer` | Routed. Continue |
   | Plain-text `404 page not found` | No route. Wait a few quiet minutes, reload once more, then escalate |
   | `502` | Route exists, but the proxy can't reach `resource`: check the firewall, `HOST` and `PORT` |
   | `403 Host not allowed` | Routed, but `ALLOWED_HOSTS` doesn't match `<vm-internal-ip>:<PORT>` |

### Stop and escalate

If `post.mapping` rejects `method: "*"` (any 4xx or 5xx, including `this mapping
already exists`), if the read-back in step 4 doesn't match, or if the curl is not a
401 after one extra reload: **stop**, leave the records as they are, and escalate
to the gateway-service owner with the exact request and response.

Do not improvise a workaround. In particular, do not:
- delete other `/mcp` mappings to clear the existence check;
- switch to a per-method or `service` mapping (it will not proxy);
- `patch.mapping` a record into shape;
- call `patch.gateway`, which logs every user on that account out.

## Order

1. **Staging.** Deploy the image with the staging env, firewall the port, and run the
   mapping procedure above to its 401. Then connect Claude Code to `https://api.microstrate.io/mcp` with a
   short-lived staging key, and run one read tool per prefix. Record the result in
   the plan's Outcome.
2. **Production.** Once staging passes against real data, deploy the same image with
   no `QUIVA_API_URL`, and run the same procedure on the `api.quiva.ai` gateway,
   curling `https://api.quiva.ai/mcp` in step 6.

## Local smoke against staging (already run once)

```sh
QUIVA_API_URL=https://api.microstrate.io PORT=8080 node quiva-mcp-remote/src/server.js
```

Mint a one-day key (`POST /accounts/api-key {"key_name":"mcp-remote-smoke","expiry_days":1}`),
call it with `Authorization: Bearer <key>`, then delete the key. The create
response carries no id: find it in `GET /accounts/api-keys` by name, then
`DELETE /accounts/api-key {"id":...}`.
