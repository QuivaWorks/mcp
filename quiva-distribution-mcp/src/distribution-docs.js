// Distribution reference, derived from accounts-service on evari-olympus main
// (6af2ba497). The engine wins over the plans in docs/; each claim cites its file.

const SUBJECT_SEGMENT_RULE = 'letters, digits, "_" or "-", 1 to 64 characters (accounts-service/model/distribution.go ValidSubjectSegment)';

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// The platform-bundle record sets every distributor account receives. A product
// action may be keyed by one of these as well as by its own record_configs.
export const DISTRIBUTOR_BUNDLE_CONFIGS = [
  'distribution_outcome',
  'distribution_quote_submission',
  'distribution_mta_request',
  'distribution_cancellation_request',
];

// Action types the engine accepts on main since #1441 (2026-09-25).
export const ACCEPTED_ACTION_TYPES = ['create', 'list'];
// Types the app offers and older stored versions carry, which that check refuses.
export const APP_ACTION_TYPES = ['create', 'rate', 'bind', 'mta', 'cancellation'];

export const DISTRIBUTION_STATUSES = ['pending', 'active', 'suspended', 'revoked'];
export const TRANSITIONS = {
  pending: ['active', 'revoked'],
  active: ['suspended', 'revoked'],
  suspended: ['active', 'revoked'],
  revoked: [],
};
export const INVITE_STATES = ['outstanding', 'redeemed', 'withdrawn', 'expired'];

export const GOTCHAS = [
  'A role gate answers 401, the same status as a missing or bad token: every handler returns util.ErrUnauthorized, which accounts-service/util/response.go maps to 401. A valid API key or JWT whose role is too low therefore looks unauthenticated. Check the role before assuming the credential is wrong.',
  'Three role sets gate these routes. READ (root, admin, developer, monitoring, billing; accounts-service/accounts/distributionregister.go distributionReadRoles) covers the register and product reads. WRITE (root, admin; accounts-service/accounts/distributioninvite.go distributionRoles) covers every write AND the two invitation lists. SUBMIT (root, admin, developer, collaborator; accounts-service/accounts/distributionmessage.go distributionSubmitRoles) covers the distributor-side granted-products read. distribution-status uses a fourth set: root, admin, developer (accounts-service/accounts/importexport.go importExportRoles).',
  'Everything is scoped to the CALLER\'S account, taken from the session. There is no account parameter: you name only the counterparty. A credential for the wrong account returns plausible, empty results rather than an error.',
  'A named refusal is not a plain error. It comes back as 403, 404 or 409 with { data: { status: "refused", refusal_code, detail } } (accounts-service/accounts/distributionmessage.go refuseDistributionCallWith). A plain failure is { error } with 400. This MCP surfaces refusal_code on the error.',
  'get_distribution answers 200 with an EMPTY refusal_code when the grant may carry traffic. When you pass product_id, read product_refusal_code too: "product_not_granted" (never granted) and "product_access_withdrawn" (granted, then withdrawn) are different answers (accounts-service/model/distribution.go ProductRefusalCode). A pair with no grant is a 400 "No distribution found", not a 404.',
  'get_distribution_status answers 200 even when nothing works, including when no grant exists at all. Read `complete` and `missing[]`, never the status code. `unverified[]` lists what the check cannot see, such as a message still in flight (accounts-service/accounts/distributionstatus_gateway.go).',
  'list_granted_products DROPS a granted product that has no published definition and reports it only in `notices[]` (accounts-service/accounts/distributionproductresolve.go grantedProductViews). An empty `products` list with a notice is a publisher-side gap, not an empty grant.',
  'A product version is immutable. update_product publishes the NEXT version as a whole document; it is not a merge. Every grant that does not pin a version tracks the latest, so an update changes what every such distributor sees at once (accounts-service/accounts/distributionproductauthor.go). There is no delete route: a code, once created, stays.',
  'Product action types: main accepts only "create" and "list" (accounts-service/model/product.go ValidateProductDefinition, check added in #1441 on 2026-09-25). The app still offers "rate", "bind", "mta" and "cancellation" (microstrate/src/services/api/distribution/product.services.ts ProductActionType), and versions published before that check carry them. Echoing a stored version back through update_product can therefore be refused on an environment running the check.',
  'amend_distribution: `revoked` is terminal. No status change, product grant or re-provision is possible afterwards (accounts-service/model/distribution.go DistributionTransitionAllowed). Suspension and revocation take effect on the next message; nothing already delivered is removed.',
  'amend_distribution refuses an amendment that changes nothing, and refuses the WHOLE request if any withdraw_products id is not on the grant. Granting a product with no published definition is accepted, and then shows up only as a notice on the distributor side.',
  'Invitations are listed by scanning the platform-wide ledger. The distributor inbox stops after 5000 entries and reports `complete: false` (accounts-service/accounts/distributioninviteinbox.go maxInviteInboxScan). An invitation that was redeemed cannot be withdrawn; amend the grant instead.',
  'Some identifiers name fields the platform defined for one customer domain: `brokerage_name`, `abn`, `afsl_number`, `quote_config`, and the message kinds `rate`, `bind`, `mta`, `cancellation`. Send them exactly as named. They are identifiers, not a description of what distribution is for.',
];

const REFERENCE = {
  concepts: {
    summary: 'Publisher, distributor, grant, product, invitation — and the two things called "product".',
    body: [
      'A PUBLISHER account defines products and lets other accounts work them. A DISTRIBUTOR account works them under a GRANT.',
      'A grant (the API calls it a "distribution") is ONE publisher and ONE distributor, carrying a list of granted products. One distributor holds at most one grant per publisher (accounts-service/accounts/distributioninvite.go refuseSecondGrantToOneBrokerage).',
      'A grant is created only by an INVITATION: the publisher mints one, the recipient redeems it from its own account. This MCP reads invitations but does not mint, send or redeem them.',
      'Two different things are called "product":',
      '- A DISTRIBUTION PRODUCT (distribution-product, create_product) is the publisher\'s own authoring: a code, a name, the record sets it is worked through, and the buttons a distributor gets.',
      '- A PRODUCT DEFINITION (product-definition, list_product_definition_versions) is a record config\'s SCHEMA published to the platform catalogue, so a distributor\'s copy resolves to the publisher\'s latest version.',
      'distribution_id is the grant\'s own route id. It is not a product id and not an account id.',
    ],
  },
  'roles-and-gates': {
    summary: 'Which role each tool needs, and why a low role answers 401.',
    table: [
      { tool: 'list_distributions, get_distribution, list_products, get_product, list_product_definition_versions', roles: 'root, admin, developer, monitoring, billing' },
      { tool: 'get_distribution_status', roles: 'root, admin, developer' },
      { tool: 'list_granted_products', roles: 'root, admin, developer, collaborator' },
      { tool: 'list_distribution_invites, list_invite_inbox', roles: 'root, admin' },
      { tool: 'create_product, update_product, amend_distribution, withdraw_distribution_invite', roles: 'root, admin' },
    ],
    notes: [
      'Every gate failure is a 401 (accounts-service/util/response.go RespondError). An API key carries its own permissions, so a restricted key must also allow the /accounts/distribution* routes.',
    ],
  },
  'envelope-and-refusals': {
    summary: 'Response shapes and every refusal_code.',
    body: [
      'Success: { message?, data }. This MCP returns `data`, adding `message` when it is non-empty (the inbox uses it to warn that a list is incomplete).',
      'Plain failure: { error } with 400 (or 401 for a gate).',
      'Named refusal: { data: { status: "refused", refusal_code, detail, ...extra }, message: "Refused" } with 403, 404 or 409.',
    ],
    refusal_codes: [
      { code: 'not_a_party', status: 403, meaning: 'The caller is neither side of the grant it named, or no such grant exists.' },
      { code: 'distribution_pending | distribution_suspended | distribution_revoked | distribution_inactive', status: 403, meaning: 'The grant exists but may not carry traffic now. Also returned by get_distribution as `refusal_code` with 200.' },
      { code: 'product_not_granted', status: 403, meaning: 'The product was never on this grant.' },
      { code: 'product_access_withdrawn', status: 403, meaning: 'The product was granted and then withdrawn.' },
      { code: 'product_exists', status: 409, meaning: 'create_product on a code that already has a version. Use update_product.' },
      { code: 'product_not_found', status: 404, meaning: 'get_product or update_product on a code, or version, that was never published.' },
      { code: 'config_id_reserved', status: 409, meaning: 'Publishing a product definition under a config id another account already claimed.' },
    ],
  },
  grants: {
    summary: 'The grant record, its status lifecycle, and product grant/withdrawal.',
    fields: {
      publisher_account_id: 'The publishing account.',
      distributor_account_id: 'The distributing account.',
      distributor_name: 'The publisher\'s own label for the counterparty, typed on the invitation. Not the distributor account\'s name.',
      publisher_name: 'The publisher account\'s name as it read at redemption. Never re-read.',
      products: '[{ product_id, version?, active }]. A withdrawn product stays with active: false; empty version tracks the latest.',
      distribution_id: 'The grant\'s route id.',
      status: DISTRIBUTION_STATUSES.join(' | '),
      provisioning_state: 'Whether the install behind the grant worked, from the last redemption or re-provision.',
      space_id: 'The publisher-side space holding this counterparty.',
      distributor_space_id: 'The space created in the distributor\'s account.',
      record_config_ids: 'The publisher record configs installed for this grant. Empty means the legacy default set, not "none".',
    },
    transitions: TRANSITIONS,
    notes: [
      'A transition to the SAME status is allowed and rewrites the reason.',
      'Revoked is terminal: no status change, no product grant, no re-provision (accounts-service/accounts/distributionregister.go AmendDistributionHandler, distributionreprovision.go).',
      'Withdrawing a product deactivates it and never removes it, so "withdrawn" and "never granted" stay distinguishable (accounts-service/model/distribution.go GrantedProduct).',
      'Granting a product also installs its record sets into the distributor\'s account, best-effort, reported in `steps[]` (accounts-service/accounts/distributionregister.go installAmendedProducts).',
      'The amendment re-reads the grant after writing and fails if the change did not land, so a 200 is trustworthy for the register. `steps[]` covers the follow-on writes, which can fail independently.',
    ],
  },
  products: {
    summary: 'The distribution product: fields, validation and versioning.',
    fields: {
      code: `The id. ${SUBJECT_SEGMENT_RULE}. Never changes once a grant carries it.`,
      name: 'Required. What a distributor picks the product by.',
      active: 'Optional; absent means true. false retires the product from NEW grants only.',
      record_configs: '[{ id, label }]. The record sets the product is worked through. A bare id string is also read (older versions).',
      actions: '{ <record_config_id>: [{ type, label?, icon? }] }. The key must be one of record_configs or a platform bundle config. One button per type per record set.',
      'version, publisher_account_id, published_at': 'Set by the service. Never send them.',
    },
    bundle_configs: DISTRIBUTOR_BUNDLE_CONFIGS,
    action_types: {
      accepted_on_main: ACCEPTED_ACTION_TYPES,
      offered_by_app: APP_ACTION_TYPES,
      note: 'See the gotcha on action types. validate_payload warns rather than errors on the app-only types, because which rule an environment enforces depends on its deploy.',
    },
    notes: [
      'Validation runs on save (accounts-service/model/product.go ValidateProductDefinition), so a bad key or type is refused at create/update time with a 400.',
      'After a write the service reads the version back and returns it as `product`; this MCP returns that read-back.',
      'get_product returns { code, product, versions[] }. Pass `version` to read an older one.',
    ],
  },
  'product-definitions': {
    summary: 'The catalogue of published record-config schemas.',
    body: [
      'list_product_definition_versions(config_id) returns { config_id, versions[], latest } for the caller\'s own catalogue entries (accounts-service/accounts/distributioncatalogue.go ListProductDefinitionsHandler). config_id is required.',
      'Publishing one (POST /accounts/product-definition) is NOT exposed: it claims the config id platform-wide, moves the schema for every distributor at once, and defaults a missing config_id to `quote_config` rather than refusing.',
    ],
  },
  invites: {
    summary: 'Invitation states and the two read-only lists.',
    body: [
      `States: ${INVITE_STATES.join(', ')} (accounts-service/model/distributioninvite.go).`,
      'list_distribution_invites is the publisher\'s view: every invitation it minted, newest first, filterable by state. Items carry no token.',
      'list_invite_inbox is the recipient\'s view: outstanding invitations addressed to the signed-in user\'s confirmed email, from other accounts. Check `complete`.',
      'An invitation is a signed, single-use bearer token. Minting, sending, re-sending and redeeming are not exposed; see not-exposed.',
      'withdraw_distribution_invite refuses a redeemed invitation. A withdrawal of an already-withdrawn invitation succeeds with no change.',
    ],
  },
  messages: {
    summary: 'The message route, documented but not exposed.',
    body: [
      'POST /accounts/distribution-message carries one message from one side of a grant to the other and lands a record in the OTHER account (accounts-service/accounts/distributionmessage.go).',
      'Required: distribution_id, kind, quote_id (the key the answer comes back on), request_id (the idempotency key). product_id is required on distributor-side kinds.',
      'Kinds: rate, bind, mta, cancellation, record (distributor side); decision, status (publisher side). A kind sent from the wrong side is refused with kind_not_allowed_for_side.',
    ],
  },
  'status-checks': {
    summary: 'How to read get_distribution_status.',
    body: [
      'Pass the COUNTERPARTY as account_id and your own side as side (default "publisher"). Your own account comes from the session.',
      'The answer is a list of named checks, each { name, passed, detail }. `missing[]` names the failed ones and `complete` is true only when none failed.',
      'A 200 with complete: false is normal for a broken grant. A 200 whose only check is distribution_record_present: false means no grant exists for that pair and side; try the other side.',
      '`unverified[]` lists what the check cannot observe.',
    ],
  },
  'not-exposed': {
    summary: 'Routes deliberately left out, and why.',
    table: [
      { route: 'POST /accounts/distribution-invite', why: 'Mints a bearer token and installs flows and records in the publisher account.' },
      { route: 'POST /accounts/send-distribution-invite, /resend-distribution-invite', why: 'Emails a real person. Re-sending a redeemed invitation also DELETES the grant it created.' },
      { route: 'POST /accounts/distribution-invite-link, /distribution-invite-inbox-link', why: 'Return a working invitation URL, which is a bearer credential.' },
      { route: 'POST /accounts/preview-distribution-invite, /redeem-distribution-invite', why: 'Take an invitation token; redeeming creates a grant and provisions an account.' },
      { route: 'POST /accounts/distribution-message', why: 'Lands a record in another account.' },
      { route: 'POST /accounts/product-definition', why: 'Claims a config id platform-wide and moves every distributor\'s schema.' },
      { route: 'POST /accounts/distribution-products-sync, /distribution-reprovision', why: 'Write into other accounts; partial failures are reported with 200.' },
      { route: 'POST /accounts/distribution-lookup', why: 'Runs the publisher\'s flow on the publisher\'s metered credentials.' },
      { route: 'config-reservation(s)', why: 'Platform housekeeping.' },
      { route: 'POST /accounts/distribution-clear-space-cards, /config-reservations-backfill', why: 'Not mapped on the production gateway (probed 2026-09-27).' },
      { route: 'POST /accounts/distribution-signing-key', why: 'Mapped on the gateway and called by the app, but NO handler is registered in accounts-service/service.go, so a call reaches no responder. Two refusal messages still point callers at it (accounts-service/accounts/distributioninvite.go, distributionredeem.go).' },
    ],
  },
  endpoints: {
    summary: 'Every route this MCP calls.',
    table: [
      { tool: 'list_distributions', route: 'GET /accounts/distributions?side=', source: 'accounts-service/accounts/distributionregister.go ListDistributionsHandler' },
      { tool: 'get_distribution', route: 'GET /accounts/distribution?publisher_account_id=|distributor_account_id=&product_id=', source: 'accounts-service/accounts/distributionregister.go GetDistributionHandler' },
      { tool: 'amend_distribution', route: 'PATCH /accounts/distribution', source: 'accounts-service/accounts/distributionregister.go AmendDistributionHandler' },
      { tool: 'get_distribution_status', route: 'GET /accounts/distribution-status?account_id=&side=', source: 'accounts-service/accounts/distributionstatus.go' },
      { tool: 'list_products', route: 'GET /accounts/distribution-products', source: 'accounts-service/accounts/distributionproductauthor.go' },
      { tool: 'get_product', route: 'GET /accounts/distribution-product?code=&version=', source: 'accounts-service/accounts/distributionproductauthor.go' },
      { tool: 'create_product', route: 'POST /accounts/distribution-product', source: 'accounts-service/accounts/distributionproductauthor.go' },
      { tool: 'update_product', route: 'PATCH /accounts/distribution-product', source: 'accounts-service/accounts/distributionproductauthor.go' },
      { tool: 'list_granted_products', route: 'GET /accounts/distribution-granted-products?publisher_account_id=', source: 'accounts-service/accounts/distributionproductresolve.go' },
      { tool: 'list_product_definition_versions', route: 'GET /accounts/product-definitions?config_id=', source: 'accounts-service/accounts/distributioncatalogue.go' },
      { tool: 'list_distribution_invites', route: 'GET /accounts/distribution-invites?state=', source: 'accounts-service/accounts/distributioninvitelist.go' },
      { tool: 'list_invite_inbox', route: 'GET /accounts/distribution-invite-inbox', source: 'accounts-service/accounts/distributioninviteinbox.go' },
      { tool: 'withdraw_distribution_invite', route: 'DELETE /accounts/distribution-invite?id=', source: 'accounts-service/accounts/distributioninvite.go RevokeDistributionInviteHandler' },
    ],
  },
};

export function listReferenceTopics() {
  return Object.keys(REFERENCE).map((topic) => ({ topic, summary: REFERENCE[topic].summary }));
}

export function getReference(topic) {
  const doc = REFERENCE[topic];
  if (!doc) return { error: `Unknown topic "${topic}". Available: ${Object.keys(REFERENCE).join(', ')}` };
  return { topic, ...doc };
}

export const TOPICS = Object.keys(REFERENCE);
