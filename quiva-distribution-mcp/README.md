# Quiva Distribution MCP Server

An MCP server for Quiva product distribution: the products a publisher account
offers, the grants that let other accounts work them, and the invitations that
create those grants. It wraps the `accounts-service` `/accounts/distribution*`
routes that are mapped on the production gateway.

The reference docs and validator come from the `accounts-service` source, not
from a spec. Each claim cites its file.

## Setup

Requires **Node.js >= 18**. `bin/run.sh` loads `.env` and finds a suitable Node.

```bash
cd quiva-distribution-mcp
npm install
cp .env.example .env   # then fill in one auth option
```

Auth precedence (first configured wins):

1. `QUIVA_API_KEY` → `X-Api-Key`
2. `QUIVA_BEARER_TOKEN` → `Authorization: Bearer`
3. `QUIVA_EMAIL` + `QUIVA_PASSWORD` (+ optional `QUIVA_ACCOUNT`) → auto-login

`QUIVA_API_URL` defaults to `https://api.quiva.ai`.

Every call acts as the account behind the credential; you only ever name the
counterparty.

| Role | Can use |
|---|---|
| root, admin | everything |
| developer | reads, `get_distribution_status`, `list_granted_products` |
| monitoring, billing | the register and product reads |
| collaborator | `list_granted_products` |

A role that is too low answers **401**, the same as a bad credential.

## Tools

**Reference and validation (no API call)**

| Tool | Does |
|---|---|
| `list_reference_topics` | Topics and gotchas |
| `get_distribution_reference` | One topic in full |
| `list_examples` / `get_example` | Harvested reads and authored write bodies |
| `validate_payload` | Lints a `product` or `amend` body |

**Grants**

| Tool | Route | Kind |
|---|---|---|
| `list_distributions` | `GET /accounts/distributions` | read |
| `get_distribution` | `GET /accounts/distribution` | read |
| `get_distribution_status` | `GET /accounts/distribution-status` | read |
| `amend_distribution` | `PATCH /accounts/distribution` | write, needs `confirm: true` |

**Products**

| Tool | Route | Kind |
|---|---|---|
| `list_products` | `GET /accounts/distribution-products` | read |
| `get_product` | `GET /accounts/distribution-product` | read |
| `create_product` | `POST /accounts/distribution-product` | write |
| `update_product` | `PATCH /accounts/distribution-product` | write |
| `list_granted_products` | `GET /accounts/distribution-granted-products` | read |
| `list_product_definition_versions` | `GET /accounts/product-definitions` | read |

**Invitations**

| Tool | Route | Kind |
|---|---|---|
| `list_distribution_invites` | `GET /accounts/distribution-invites` | read |
| `list_invite_inbox` | `GET /accounts/distribution-invite-inbox` | read |
| `withdraw_distribution_invite` | `DELETE /accounts/distribution-invite` | write, needs `confirm: true` |

Minting, sending, re-sending and redeeming invitations, cross-account messages,
catalogue publishing, sync and re-provisioning are deliberately not exposed.
`get_distribution_reference("not-exposed")` says why for each.

## Gotchas

- A role gate answers 401, so a valid credential with too low a role looks unauthenticated.
- `get_distribution_status` always answers 200. Read `complete` and `missing[]`.
- `list_granted_products` drops a product with no published definition and names it only in `notices[]`.
- `update_product` publishes a whole new version. Grants that do not pin a version move to it at once. There is no delete.
- `revoked` is terminal.
- Some field and message-kind names (`brokerage_name`, `abn`, `afsl_number`, `quote_config`, `rate`, `bind`, `mta`, `cancellation`) are identifiers the platform defined. Send them as named.

The full list is in `list_reference_topics`.

## Examples

- `examples/harvested/` holds real read responses from a test environment. Every account, user, invite, space, gateway and product identifier, email and name is replaced by a `<<PLACEHOLDER>>`.
- `examples/authored/` holds write bodies and neutralised reads. They illustrate a shape and prove nothing.

Re-harvest with `npm run harvest` against a test environment (set `QUIVA_API_URL`
and the `QUIVA_*` credentials; the harvest only reads).

## Tests

```bash
npm test
```

Network-free: the validator, the examples, and every tool against a stub client.
