#!/usr/bin/env node
// Quiva Distribution MCP server — products, grants and invitations (accounts-service).
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient } from './client.js';
import { GOTCHAS, TOPICS, TRANSITIONS, listReferenceTopics, getReference } from './distribution-docs.js';
import { validate, KINDS } from './validate.js';
import { listExamples, getExample } from './examples.js';

export const instructions = `
Tools for Quiva product distribution (accounts-service). A PUBLISHER account
defines products; a DISTRIBUTOR account works them under a GRANT (the API calls
it a "distribution"). Every call acts as the account your credential belongs to.

Recipe:
1. list_reference_topics / get_distribution_reference — concepts, role gates,
   refusal codes, the grant lifecycle and the product shape (engine-truth).
2. list_distributions / get_distribution / get_distribution_status — the grants
   this account holds, from either side, and whether each one works.
3. list_products / get_product — the publisher's own products and their versions.
   list_granted_products — what a distributor may work under one publisher.
4. validate_payload, then create_product / update_product — publish a version.
5. amend_distribution (confirm: true) — change a grant's status or products.
6. list_distribution_invites / list_invite_inbox / withdraw_distribution_invite.
   Minting, sending and redeeming invitations are not exposed (topic "not-exposed").

Top gotchas:
${GOTCHAS.map((g) => `- ${g}`).join('\n')}
`.trim();

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data ?? null, null, 2) }] };
}

function errorResult(err) {
  const detail = err?.body ? `\n${JSON.stringify(err.body, null, 2)}` : '';
  return { content: [{ type: 'text', text: `Error: ${err.message}${detail}` }], isError: true };
}

// MCP clients can pass untyped params as JSON strings; parse them back.
function parseJson(v) {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  if (!/^[[{]/.test(trimmed)) return v;
  try {
    return JSON.parse(trimmed);
  } catch {
    return v;
  }
}
const jsonValue = z.preprocess(parseJson, z.any());

const side = z.enum(['publisher', 'distributor']);
const accountId = z.string().min(1);

// A refused call is data the caller acts on, not a crash.
async function orRefusal(run) {
  try {
    return await run();
  } catch (err) {
    if (err.refusal) return { refused: true, http_status: err.status, ...err.refusal };
    throw err;
  }
}

function withWarnings(result, validation) {
  if (!validation?.warnings?.length) return result;
  return { ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }), warnings: validation.warnings };
}

export function registerTools(server, client, { prefix = '' } = {}) {
  function tool(name, description, inputSchema, handler) {
    server.registerTool(`${prefix}${name}`, { description, inputSchema }, async (args) => {
      try {
        return jsonResult(await handler(args ?? {}));
      } catch (err) {
        return errorResult(err);
      }
    });
  }

  // --- Reference -------------------------------------------------------------

  tool(
    'list_reference_topics',
    `List the distribution reference topics (${TOPICS.join(', ')}) and the known gotchas. Start here.`,
    {},
    async () => ({ topics: listReferenceTopics(), gotchas: GOTCHAS })
  );

  tool(
    'get_distribution_reference',
    'Get one reference topic in full: fields, allowed values, role gates, refusal codes and engine citations.',
    { topic: z.string().describe(`One of: ${TOPICS.join(', ')}`) },
    async ({ topic }) => getReference(topic)
  );

  tool(
    'list_examples',
    'List bundled examples. harvested = real read responses with every identity replaced by a placeholder (evidence). authored = write bodies and neutralised reads (illustration only).',
    {},
    async () => listExamples()
  );

  tool(
    'get_example',
    'Get one example in full, with what it teaches.',
    { slug: z.string().describe('Example slug from list_examples') },
    async ({ slug }) => getExample(slug)
  );

  tool(
    'validate_payload',
    'Lint a write body locally, with no network. kind "product" mirrors the engine\'s product validation (create_product / update_product); kind "amend" mirrors amend_distribution\'s pre-write checks. Returns { valid, errors, warnings }.',
    {
      kind: z.enum(KINDS).describe('"product" or "amend"'),
      payload: jsonValue.describe('The body you intend to send.'),
    },
    async ({ kind, payload }) => validate(kind, parseJson(payload))
  );

  // --- Grants ----------------------------------------------------------------

  tool(
    'list_distributions',
    'List this account\'s grants. side "publisher" (default) lists the counterparties you distribute to; "distributor" lists the publishers you work for. Returns { results, results_total }. Needs a read role (root, admin, developer, monitoring, billing); a lower role answers 401.',
    { side: side.optional().describe('Your own side. Default "publisher".') },
    async ({ side: s }) => client.get('/accounts/distributions', { side: s === 'distributor' ? 'distributor' : undefined })
  );

  tool(
    'get_distribution',
    'Read one grant. Name EXACTLY ONE counterparty: distributor_account_id when you are the publisher, publisher_account_id when you are the distributor. Returns { distribution, refusal_code, active_products, product_refusal_code? }. An EMPTY refusal_code means the grant may carry traffic. With product_id, product_refusal_code distinguishes "product_not_granted" from "product_access_withdrawn". A pair with no grant is a 400 "No distribution found".',
    {
      distributor_account_id: accountId.optional().describe('The distributor, when you are the publisher.'),
      publisher_account_id: accountId.optional().describe('The publisher, when you are the distributor.'),
      product_id: z.string().optional().describe('Optional: also answer whether this product may be worked.'),
    },
    async ({ distributor_account_id, publisher_account_id, product_id }) => {
      if (!distributor_account_id === !publisher_account_id) {
        throw new Error('Supply exactly one of distributor_account_id or publisher_account_id; your own account comes from the session.');
      }
      return client.get('/accounts/distribution', { distributor_account_id, publisher_account_id, product_id });
    }
  );

  tool(
    'get_distribution_status',
    'Run the health checks for one grant. account_id is the COUNTERPARTY; side is your own side (default "publisher"). ALWAYS answers 200, including when nothing works or no grant exists: read `complete` and `missing[]`, never the status code. `unverified[]` lists what the checks cannot see. Needs root, admin or developer.',
    {
      account_id: accountId.describe('The other account in the grant.'),
      side: side.optional().describe('Your own side. Default "publisher".'),
    },
    async ({ account_id, side: s }) => {
      const result = await client.get('/accounts/distribution-status', { account_id, side: s });
      if (result && result.complete === false) {
        const onlyRecordMissing = (result.missing ?? []).includes('distribution_record_present');
        result.note = onlyRecordMissing
          ? 'No grant exists for this pair from this side. If you are the distributor, pass side "distributor".'
          : `Not complete: ${(result.missing ?? []).join(', ')} failed. See each check's detail.`;
      }
      return result;
    }
  );

  tool(
    'amend_distribution',
    'Change a grant you PUBLISH: set status (active, suspended, revoked) and/or grant_products / withdraw_products. Requires confirm: true, because every amendment immediately changes what another account may do, and granting installs record sets into that account. "revoked" is TERMINAL: it can never be undone, and nothing can be granted afterwards. Allowed moves: pending -> active|revoked, active -> suspended|revoked, suspended -> active|revoked. The whole request is refused if any withdraw id is not on the grant. The service re-reads the grant after writing; follow-on writes are reported in steps[]. Needs root or admin.',
    {
      amendment: jsonValue.describe('{ distributor_account_id, status?, reason?, grant_products?: [{ product_id, version? }], withdraw_products?: [product_id] }. See get_example("amend-suspend").'),
      confirm: z.boolean().optional().describe('Must be true. Nothing is sent otherwise.'),
      allow_unpublished_products: z.boolean().optional().describe('Grant a product that has no published version. Default false: it would reach the distributor with no buttons.'),
      skip_local_validation: z.boolean().optional(),
    },
    async ({ amendment: raw, confirm, allow_unpublished_products, skip_local_validation }) => {
      const amendment = parseJson(raw);
      const validation = skip_local_validation ? null : validate('amend', amendment);
      if (validation && !validation.valid) return { sent: false, validation };
      if (confirm !== true) {
        return {
          sent: false,
          reason: 'confirm: true is required. This amendment takes effect immediately for another account' + (amendment?.status === 'revoked' ? ', and revoked can never be undone.' : '.'),
          validation,
        };
      }

      const current = await client.get('/accounts/distribution', { distributor_account_id: amendment.distributor_account_id });
      const from = current?.distribution?.status;
      if (amendment.status && from && from !== amendment.status && !(TRANSITIONS[from] ?? []).includes(amendment.status)) {
        return { sent: false, reason: `A ${from} grant cannot become ${amendment.status}.`, current_status: from };
      }

      if (!allow_unpublished_products) {
        const unpublished = [];
        for (const p of amendment.grant_products ?? []) {
          try {
            await client.get('/accounts/distribution-product', { code: p.product_id, version: p.version });
          } catch (err) {
            if (err.refusal?.refusal_code === 'product_not_found') unpublished.push(p.product_id);
            else throw err;
          }
        }
        if (unpublished.length) {
          return { sent: false, reason: `No published version for ${unpublished.join(', ')}. The distributor would receive it with no buttons. Publish it first, or pass allow_unpublished_products: true.` };
        }
      }

      const { confirm: _ignored, ...body } = amendment;
      return withWarnings(await client.patch('/accounts/distribution', body), validation);
    }
  );

  // --- Products ----------------------------------------------------------------

  tool(
    'list_products',
    'List your own products, the latest version of each: { count, products }. Your account only; a distributor uses list_granted_products instead.',
    {},
    async () => client.get('/accounts/distribution-products')
  );

  tool(
    'get_product',
    'Read one of your products at the latest version, or at `version`: { code, product, versions[] }. A code or version never published is refused with product_not_found (404).',
    {
      code: z.string().min(1).describe('The product code.'),
      version: z.string().optional().describe('A whole number, optionally "v"-prefixed. Omit for the latest.'),
    },
    async ({ code, version }) => orRefusal(() => client.get('/accounts/distribution-product', { code, version }))
  );

  const productArg = jsonValue.describe('{ code, name, active?, record_configs: [{ id, label }], actions: { <record_config_id>: [{ type, label?, icon? }] } }. See get_example("create-product").');

  async function publish(method, raw, skip) {
    const product = parseJson(raw);
    const validation = skip ? null : validate('product', product);
    if (validation && !validation.valid) return { published: false, validation };
    const written = await orRefusal(() => client[method]('/accounts/distribution-product', product));
    if (written?.refused) return written;
    // Read the version back independently of the write response.
    const readBack = await client.get('/accounts/distribution-product', { code: written.code, version: String(written.version) });
    const verified = readBack?.product?.version === written.version;
    return withWarnings({ published: verified, code: written.code, version: written.version, product: readBack?.product, versions: readBack?.versions }, validation);
  }

  tool(
    'create_product',
    'Publish version 1 of a new product. A code that already has a version is refused with product_exists (409); use update_product. There is no delete: a code, once created, stays in your product list. Version, publisher and timestamp are set by the service. Reads the version back before reporting success. Needs root or admin.',
    { product: productArg, skip_local_validation: z.boolean().optional() },
    async ({ product, skip_local_validation }) => publish('post', product, skip_local_validation)
  );

  tool(
    'update_product',
    'Publish the NEXT version of an existing product. Send the WHOLE definition: it is not a merge. Every grant that does not pin a version moves to the new one at once. A code never created is refused with product_not_found (404). Do not echo a get_product response back unchanged: stored versions can carry action types the current engine refuses. Reads the version back before reporting success. Needs root or admin.',
    { product: productArg, skip_local_validation: z.boolean().optional() },
    async ({ product, skip_local_validation }) => publish('patch', product, skip_local_validation)
  );

  tool(
    'list_granted_products',
    'As a DISTRIBUTOR: the products you may work under one publisher, resolved to their buttons. Returns { distribution_id, space_id, products[], notices[] }. A granted product with no published definition is left OUT of products[] and named only in notices[]. Refused with not_a_party when you hold no grant from that publisher, or a distribution_* code when the grant is not live. Needs root, admin, developer or collaborator.',
    { publisher_account_id: accountId.describe('The publisher whose products you work.') },
    async ({ publisher_account_id }) =>
      orRefusal(async () => {
        const result = await client.get('/accounts/distribution-granted-products', { publisher_account_id });
        if (result?.notices?.length) result.warning = 'Some granted products are missing from products[]; see notices[].';
        return result;
      })
  );

  tool(
    'list_product_definition_versions',
    'List the catalogue versions of one of your published record-config schemas: { config_id, versions[], latest }. config_id is required. Publishing a definition is not exposed.',
    { config_id: z.string().min(1).describe('A record config id you publish.') },
    async ({ config_id }) => client.get('/accounts/product-definitions', { config_id })
  );

  // --- Invitations ---------------------------------------------------------------

  tool(
    'list_distribution_invites',
    'As a PUBLISHER: every invitation you minted, newest first, with its state (outstanding, redeemed, withdrawn, expired). Items carry no token. Needs root or admin, NOT just a read role.',
    { state: z.enum(['outstanding', 'redeemed', 'withdrawn', 'expired']).optional() },
    async ({ state }) => client.get('/accounts/distribution-invites', { state })
  );

  tool(
    'list_invite_inbox',
    'As a RECIPIENT: outstanding invitations from other accounts addressed to the signed-in user\'s confirmed email. The scan stops at 5000 invitations; `complete: false` means the list may be missing some. Needs root or admin.',
    {},
    async () => client.get('/accounts/distribution-invite-inbox')
  );

  tool(
    'withdraw_distribution_invite',
    'Withdraw an outstanding invitation you minted, so its link stops working. Requires confirm: true: the recipient may already hold the link, and the only way back is a new invitation. A redeemed invitation cannot be withdrawn; amend the grant instead. An invitation minted by another account answers 401. Needs root or admin.',
    {
      invite_id: z.string().min(1),
      confirm: z.boolean().optional().describe('Must be true. Nothing is sent otherwise.'),
    },
    async ({ invite_id, confirm }) => {
      if (confirm !== true) return { sent: false, reason: 'confirm: true is required; withdrawing cannot be undone.' };
      const result = await client.delete('/accounts/distribution-invite', { id: invite_id });
      const listed = await client.get('/accounts/distribution-invites', { state: 'withdrawn' });
      const found = (listed?.results ?? []).some((i) => i.invite_id === invite_id);
      return { withdrawn: found, response: result, ...(found ? {} : { warning: 'The invitation is not listed as withdrawn after the call.' }) };
    }
  );
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`[quiva-distribution-mcp] Node ${process.versions.node} is too old; requires Node >= 18. Launch via bin/run.sh or set QUIVA_NODE.`);
    process.exit(1);
  }
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error('[quiva-distribution-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD).');
  }
  const server = new McpServer({ name: 'quiva-distribution', version: '0.1.0' }, { instructions });
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
  console.error(`[quiva-distribution-mcp] ready — API: ${client.baseUrl}`);
}

// Importing this module has no side effects; only the entry point connects.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-distribution-mcp] fatal:', err);
    process.exit(1);
  });
}
