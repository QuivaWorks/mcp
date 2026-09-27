# Quiva remote MCP server

One hosted MCP endpoint for the whole Quiva platform:

```
https://api.quiva.ai/mcp
```

You authenticate with a Quiva API key. Nothing to install or run locally.

## Get an API key

In Quiva, open **Settings → API keys** and create a key. Treat it like a password:
anyone holding it can act as you in your account. Give it an expiry, and revoke it
from the same page when you no longer need it.

Send the key on every request as `Authorization: Bearer <API_KEY>`
(`X-Api-Key: <API_KEY>` also works). A request without one gets `401`. If a request
carries both `Authorization: Bearer` and `X-Api-Key`, `Authorization` wins and
`X-Api-Key` is ignored.

## Tools

Tools are grouped by prefix, one group per area of the platform:

| Prefix | Covers |
|---|---|
| `flows_` | Workflows: build, validate, publish, run and debug |
| `records_` | Record configs (schema and form views) and records |
| `documents_` | Document templates, generated documents and e-signatures |
| `workspaces_` | Spaces, tasks, comments and space files |
| `assistants_` | Assistant configurations, and invoking an assistant |
| `distribution_` | Distribution: products, product definitions, invites and messages |
| `coworker_` | Abbie, your AI coworker: skills, todos, organisation memory, profile and corrections |

Each group has a `<prefix>list_reference_topics` tool. Point your assistant at it
before it builds anything: the reference topics describe how the platform really
behaves, including the cases where a request succeeds but does nothing.

## Connect a client

Replace `<API_KEY>` with your key in each example.

### Claude Code

```sh
claude mcp add --transport http quiva https://api.quiva.ai/mcp \
  --header "Authorization: Bearer <API_KEY>"
```

Add `--scope user` to make it available in every project. Run `/mcp` inside
Claude Code to check the connection.

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "quiva": {
      "url": "https://api.quiva.ai/mcp",
      "headers": { "Authorization": "Bearer <API_KEY>" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`. VS Code prompts for the key once and stores it securely, so it
never sits in the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "quiva-api-key", "description": "Quiva API key", "password": true }
  ],
  "servers": {
    "quiva": {
      "type": "http",
      "url": "https://api.quiva.ai/mcp",
      "headers": { "Authorization": "Bearer ${input:quiva-api-key}" }
    }
  }
}
```

### Claude Desktop

Claude Desktop's config file launches local commands, so connect through the
`mcp-remote` bridge (needs Node.js). In **Settings → Developer → Edit Config**:

```json
{
  "mcpServers": {
    "quiva": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.quiva.ai/mcp", "--header", "Authorization:${QUIVA_AUTH}"],
      "env": { "QUIVA_AUTH": "Bearer <API_KEY>" }
    }
  }
}
```

Restart Claude Desktop after saving.

## Troubleshooting

| Response | Meaning |
|---|---|
| `401` | No key was sent. Check the header name and the `Bearer ` prefix. |
| A tool returns `401` or `403` from the API | The key is expired, revoked, or lacks permission for that action. |
| `403 Origin not allowed` | A browser-based client on an origin that isn't allowed. Use a desktop or CLI client. |
| `413` | The request body is over the size limit (1 MiB by default). Split large payloads. |
| `429` | Too many requests from your IP address. Wait for the `Retry-After` seconds. |

## Running it yourself

The server is stateless and reads configuration from the environment only:

| Variable | Default | Purpose |
|---|---|---|
| `QUIVA_API_URL` | `https://api.quiva.ai` | The Quiva API every tool calls |
| `HOST` | `0.0.0.0` | Listen address. On a shared or host-networked machine, set the internal IP |
| `PORT` | `8080` | Listen port |
| `MAX_BODY_BYTES` | `1048576` | Request body cap (413 above it) |
| `REQUEST_TIMEOUT_MS` | `120000` | Per-request deadline, from arrival to response, including tool calls (504 above it) |
| `RECEIVE_TIMEOUT_MS` | `30000` | Time allowed to receive the whole request (Node `requestTimeout`) |
| `HEADERS_TIMEOUT_MS` | `15000` | Time allowed to receive the headers (Node `headersTimeout`) |
| `KEEP_ALIVE_TIMEOUT_MS` | `5000` | Idle keep-alive socket lifetime |
| `MAX_CONNECTIONS` | `256` | Open sockets; further connections are dropped |
| `RATE_LIMIT_PER_SEC` / `RATE_LIMIT_BURST` | `10` / `40` | Per-IP token bucket, checked before the body is read (429 with `Retry-After`) |
| `TRUST_PROXY` | `false` | `true` takes the client IP from the **last** `X-Forwarded-For` hop, which is the one the proxy in front appended. Set it only behind a proxy that appends |
| `ALLOWED_HOSTS` | empty | Comma-separated `Host` values to accept, e.g. `10.0.0.5:8080`. When set, anything else gets 403 |
| `AUTH_FAILURE_CACHE_SECONDS` | `0` (off) | Refuse a credential the API returned 401 for, for this long, without reading the body. Only a SHA-256 of the credential is kept. Off by default because a scoped API key gets 401 on routes outside its scope |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins to accept; requests with no `Origin` are always accepted |

**Body cap.** The largest legitimate request is `documents_validate_docx`, which
sends the file base64-encoded (4/3 of its size) inside a JSON-RPC envelope. At the
1 MiB default, a DOCX or PDF up to about 760 KB fits. Image-heavy templates can be
larger: raise `MAX_BODY_BYTES` to at most `10000000`, because the API gateway refuses
request bodies over 10 MB on the next hop anyway. Worst-case buffered memory is
`MAX_CONNECTIONS × MAX_BODY_BYTES`, so lower `MAX_CONNECTIONS` if you raise the cap a
lot.

```sh
npm start                                        # from this directory
docker build -f quiva-mcp-remote/Dockerfile -t quiva-mcp-remote .   # from the repo root
```

The server never reads credentials from its environment: each request carries its
own key.
