// Risk Programme record config + form UI.
// Assumptions are marked ASSUMPTION — flag any that are wrong.
//
// Three renderer truths this file has to respect (all verified against
// microstrate/src/components/records/form/, and against the 19 harvested live
// configs in examples/harvested/):
//
//  1. A dropdown / multi-select / multi-toggle / statuses input gets its choices
//     ONLY from `options`. `InputControl` receives `{...inputProps}` plus
//     type/value — never the schema field — and `options` defaults to `[]`
//     (input-control.component.svelte:257). Nothing anywhere derives options
//     from a schema `enum`, so an enum input with no options renders an EMPTY
//     dropdown. The options must sit wherever the renderer reads props from:
//     `inputProps = nodeProps ?? field.ui.props ?? {}` (view-field:112) is a
//     WHOLESALE fallback, not a merge — so a node carrying even just a label
//     shadows the schema `ui.props` entirely. This file puts them on the node,
//     since its nodes carry props; most live configs instead use bare nodes and
//     keep inputType + options on `schema.<field>.ui`.
//
//  2. `array-field` children are IGNORED by the renderer. ViewArray renders each
//     item by pointing ViewField at `{ item: field.items }` with no
//     nodeInputType and no nodeProps (view-array.component.svelte:126), so item
//     leaves fall back to `schema.<array>.items.properties.<leaf>.ui`. Children
//     are still emitted because the visual builder writes them and the live
//     corpus carries them — but the `ui` mirror is what actually renders.
//
//  3. There is no per-field currency-code prop. InputCurrency takes no such
//     prop (input-currency.component.svelte) and the valid currency props are
//     label/placeholder/helpText/spacing/strictMultiline/decimalPlace/min/max/
//     defaultValue. A `currencyField` prop is silently dropped.

const money = (label, description) => ({ type: 'number', minimum: 0, title: label, description });

// enum -> [{ value, text }] in the shape the live corpus uses. `labels` overrides
// the derived text where title-casing is wrong (state codes, currency codes, n/a).
const optionsFor = (values, labels = {}) =>
  values.map((value) => ({
    value,
    text: labels[value] ?? value.charAt(0).toUpperCase() + value.slice(1),
  }));

// Attach legacy `ui` to an array's item leaves — the only input config the
// renderer reads for repeater items (truth #2 above).
const withItemUi = (schemaField, uiByLeaf) => {
  for (const [leaf, ui] of Object.entries(uiByLeaf)) {
    schemaField.items.properties[leaf].ui = ui;
  }
  return schemaField;
};

export const config = {
  id: 'risk_programme',
  name: 'Risk Programme',
  description:
    'An insurance risk programme: the placement record covering info/quote/policy/renewal stages, cover terms, insurer panel, premium build-up and payment status.',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['type', 'status', 'coverage_class', 'inception_date', 'currency', 'subject_type'],
    properties: {
      // --- programme identity -------------------------------------------------
      type: {
        type: 'string',
        title: 'Type',
        description: 'Stage of the programme.',
        enum: ['info', 'quote', 'policy', 'renewal'],
      },
      status: {
        type: 'string',
        title: 'Status',
        enum: ['current', 'expired', 'cancelled', 'superseded'],
      },
      coverage_class: {
        type: 'string',
        title: 'Coverage class',
        description: 'Class of business / cover type, e.g. Property, Liability, Marine Cargo.',
      },
      inception_date: { type: 'string', format: 'date', title: 'Inception date' },
      renewal_date: { type: 'string', format: 'date', title: 'Renewal date' },

      // --- cover terms --------------------------------------------------------
      coverage_limits: {
        type: 'array',
        title: 'Coverage limits',
        items: {
          type: 'object',
          required: ['name', 'amount'],
          properties: {
            name: { type: 'string', title: 'Limit' },
            amount: money('Amount'),
            basis: {
              type: 'string',
              title: 'Basis',
              enum: ['any one claim', 'aggregate', 'any one claim and in the aggregate'],
            },
          },
        },
      },
      coverage_sub_limits: {
        type: 'array',
        title: 'Coverage sub-limits',
        items: {
          type: 'object',
          required: ['name', 'amount'],
          properties: {
            name: { type: 'string', title: 'Sub-limit' },
            amount: money('Amount'),
            applies_to: { type: 'string', title: 'Applies to' },
          },
        },
      },
      excesses: {
        type: 'array',
        title: 'Excesses / deductibles',
        items: {
          type: 'object',
          required: ['name', 'amount'],
          properties: {
            name: { type: 'string', title: 'Excess' },
            amount: money('Amount'),
            basis: { type: 'string', title: 'Basis', enum: ['each and every claim', 'aggregate', 'time excess'] },
          },
        },
      },
      specified_items: {
        type: 'array',
        title: 'Specified items',
        items: {
          type: 'object',
          required: ['description'],
          properties: {
            description: { type: 'string', title: 'Description' },
            identifier: { type: 'string', title: 'Serial / identifier' },
            value: money('Value'),
          },
        },
      },
      endorsements: {
        type: 'array',
        title: 'Special endorsements / clauses',
        items: {
          type: 'object',
          required: ['clause_reference'],
          properties: {
            clause_reference: { type: 'string', title: 'Clause reference' },
            description: { type: 'string', title: 'Description' },
          },
        },
      },
      policy_wording_reference: { type: 'string', title: 'Policy wording reference' },
      policy_wording_version: { type: 'string', title: 'Policy wording version' },

      // --- insurer panel (ASSUMPTION: insurers + % is a co-insurance panel,
      //     so the share belongs to each insurer rather than being one field) --
      insurers: {
        type: 'array',
        title: 'Insurers',
        description: 'Co-insurance panel. Shares should total 100%.',
        items: {
          type: 'object',
          required: ['insurer_name', 'share_pct'],
          properties: {
            insurer_name: { type: 'string', title: 'Insurer' },
            share_pct: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              title: '% of insured amount',
            },
            policy_number: { type: 'string', title: 'Policy number' },
            is_lead: { type: 'boolean', title: 'Lead insurer' },
          },
        },
      },
      placed_by: { type: 'string', title: 'Cover placed by', description: 'Broker or team who placed the cover.' },

      // --- subject of insurance (ASSUMPTION: address OR asset, discriminated) --
      subject_type: {
        type: 'string',
        title: 'Subject of insurance',
        enum: ['address', 'asset'],
      },
      risk_address: {
        type: 'object',
        title: 'Risk address',
        properties: {
          line1: { type: 'string', title: 'Address line 1' },
          line2: { type: 'string', title: 'Address line 2' },
          suburb: { type: 'string', title: 'Suburb' },
          state: { type: 'string', title: 'State', enum: ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] },
          postcode: { type: 'string', title: 'Postcode', pattern: '^[0-9]{4}$' },
          country: { type: 'string', title: 'Country' },
        },
      },
      asset_details: {
        type: 'object',
        title: 'Asset details',
        properties: {
          asset_type: { type: 'string', title: 'Asset type' },
          description: { type: 'string', title: 'Description' },
          identifier: { type: 'string', title: 'Identifier / VIN / registration' },
          value: money('Declared value'),
        },
      },

      // --- commercials --------------------------------------------------------
      quote_form_id: { type: 'string', title: 'Quote form ID', description: 'External quote form reference.' },
      currency: { type: 'string', title: 'Currency', enum: ['AUD', 'NZD', 'USD', 'GBP', 'EUR'] },
      target_premium: money('Target premium', 'Premium sought when going to market.'),
      premium: money('Premium', 'Base premium excluding taxes and levies.'),
      taxes: money('Taxes (GST)'),
      stamp_duty: money('Stamp duty'),
      fire_levy: money('Fire services levy'),
      brokerage_fee: money('Brokerage fee'),
      payment_status: { type: 'string', title: 'Payment status', enum: ['n/a', 'invoiced', 'paid'] },
      payment_due_date: { type: 'string', format: 'date', title: 'Payment due date' },
    },
  },
};

// --- form -------------------------------------------------------------------
const field = (path, inputType, props, rules) => ({
  type: 'field',
  field: path,
  inputType,
  props,
  ...(rules ? { rules } : {}),
});

const grid = (columns, children, extra = {}) => ({
  type: 'grid',
  props: { gridTemplateColumns: columns },
  children,
  ...extra,
});

// Resolve a dotted path against the schema so options are always derived from
// the enum rather than hand-copied — the two cannot drift.
const schemaAt = (path) =>
  path.split('.').reduce((node, key) => node.properties[key], config.schema);

// A choice input, options seeded from the schema enum (truth #1 above).
const select = (path, label, { inputType = 'dropdown', labels, ...rest } = {}, rules) => {
  const { enum: values } = schemaAt(path);
  if (!Array.isArray(values) || !values.length) {
    throw new Error(`select("${path}") — schema field has no enum to seed options from`);
  }
  return field(path, inputType, { label, options: optionsFor(values, labels), ...rest }, rules);
};

// Money: no currency-code prop exists (truth #3) — decimalPlace/min are the real ones.
const money$ = (path, label, rules) =>
  field(path, 'currency', { label, decimalPlace: 2, min: 0 }, rules);

// --- repeaters --------------------------------------------------------------
// One registry per array, used TWICE: written onto
// `schema.<array>.items.properties.<leaf>.ui` (what the renderer actually reads,
// truth #2) and used to build the array-field node's children (what the visual
// builder writes and the live corpus carries). Single source of truth, so the two
// representations cannot disagree.
const cash = (label) => ['currency', { label, decimalPlace: 2, min: 0 }];

const REPEATERS = {
  coverage_limits: {
    label: 'Coverage limits',
    itemLabel: 'Limit',
    columns: '2fr 1fr 1fr',
    items: { name: ['text', { label: 'Limit' }], amount: cash('Amount'), basis: ['dropdown', { label: 'Basis' }] },
  },
  coverage_sub_limits: {
    label: 'Coverage sub-limits',
    itemLabel: 'Sub-limit',
    columns: '2fr 1fr 1fr',
    items: {
      name: ['text', { label: 'Sub-limit' }],
      amount: cash('Amount'),
      applies_to: ['text', { label: 'Applies to' }],
    },
  },
  excesses: {
    label: 'Excesses / deductibles',
    itemLabel: 'Excess',
    columns: '2fr 1fr 1fr',
    items: { name: ['text', { label: 'Excess' }], amount: cash('Amount'), basis: ['dropdown', { label: 'Basis' }] },
  },
  specified_items: {
    label: 'Specified items',
    itemLabel: 'Item',
    columns: '2fr 1fr 1fr',
    items: {
      description: ['text', { label: 'Description' }],
      identifier: ['text', { label: 'Serial / identifier' }],
      value: cash('Value'),
    },
  },
  endorsements: {
    label: 'Special endorsements / clauses',
    itemLabel: 'Endorsement',
    columns: '1fr 2fr',
    items: {
      clause_reference: ['text', { label: 'Clause reference' }],
      description: ['textarea', { label: 'Description' }],
    },
  },
  insurers: {
    label: 'Insurers (shares should total 100%)',
    itemLabel: 'Insurer',
    columns: '2fr 1fr 1fr 1fr',
    items: {
      insurer_name: ['text', { label: 'Insurer' }],
      share_pct: ['number', { label: '% of insured amount', min: 0, max: 100, showControls: true }],
      policy_number: ['text', { label: 'Policy number' }],
      is_lead: ['toggle', { label: 'Lead insurer' }],
    },
  },
};

// Resolve each leaf's props, seeding `options` from the item enum for choice
// inputs so a repeater dropdown is never empty either.
const itemUi = (arrayPath) => {
  const itemProps = config.schema.properties[arrayPath].items.properties;
  const out = {};
  for (const [leaf, [inputType, props]] of Object.entries(REPEATERS[arrayPath].items)) {
    const values = itemProps[leaf]?.enum;
    if (!itemProps[leaf]) throw new Error(`repeater ${arrayPath}[].${leaf} is not in the schema`);
    const needsOptions = ['dropdown', 'multi-select', 'multi-toggle', 'statuses'].includes(inputType);
    if (needsOptions && !Array.isArray(values)) {
      throw new Error(`repeater ${arrayPath}[].${leaf} is a ${inputType} but has no schema enum`);
    }
    out[leaf] = {
      inputType,
      props: needsOptions ? { ...props, options: optionsFor(values) } : props,
    };
  }
  return out;
};

// Write the `ui` mirror (truth #2) and build the matching array-field node.
const repeater = (arrayPath) => {
  const spec = REPEATERS[arrayPath];
  const ui = itemUi(arrayPath);
  withItemUi(config.schema.properties[arrayPath], ui);
  return {
    type: 'array-field',
    field: arrayPath,
    props: { label: spec.label, itemLabel: spec.itemLabel },
    children: [
      grid(
        spec.columns,
        Object.entries(ui).map(([leaf, { inputType, props }]) => field(leaf, inputType, props))
      ),
    ],
  };
};

// json-logic conditions
const isPolicy = { '==': [{ var: 'type' }, 'policy'] };
const isQuote = { '==': [{ var: 'type' }, 'quote'] };
const isPolicyOrRenewal = { in: [{ var: 'type' }, ['policy', 'renewal']] };
const isInvoiced = { '==': [{ var: 'payment_status' }, 'invoiced'] };
const subjectIsAddress = { '==': [{ var: 'subject_type' }, 'address'] };
const subjectIsAsset = { '==': [{ var: 'subject_type' }, 'asset'] };

config.views = {
  forms: [
    {
      id: 'default',
      title: 'Risk Programme',
      description: 'Full programme record.',
      layout: grid('1fr', [
        // Identity
        grid('1fr 1fr', [
          select('type', 'Type'),
          select('status', 'Status'),
        ]),
        grid('2fr 1fr 1fr', [
          field('coverage_class', 'text', { label: 'Coverage class' }),
          field('inception_date', 'date', { label: 'Inception date' }),
          // ASSUMPTION: a renewal date is expected for policy and renewal records
          field('renewal_date', 'date', { label: 'Renewal date' }, [
            {
              id: 'renewal_date.required',
              property: 'required',
              logic: isPolicyOrRenewal,
              description: 'Required for policy and renewal records.',
            },
          ]),
        ]),

        // Subject of insurance
        grid('1fr', [
          select('subject_type', 'Subject of insurance', { inputType: 'multi-toggle' }),
        ]),
        grid(
          '1fr 1fr 1fr',
          [
            field('risk_address.line1', 'text', { label: 'Address line 1' }),
            field('risk_address.line2', 'text', { label: 'Address line 2' }),
            field('risk_address.suburb', 'text', { label: 'Suburb' }),
            // State codes are already display-ready — don't title-case them.
            select('risk_address.state', 'State', {
              labels: Object.fromEntries(
                schemaAt('risk_address.state').enum.map((s) => [s, s])
              ),
              sort: true,
            }),
            field('risk_address.postcode', 'text', { label: 'Postcode' }),
            field('risk_address.country', 'country', { label: 'Country' }),
          ],
          {
            rules: [
              {
                id: 'risk_address.visible',
                property: 'visible',
                logic: subjectIsAddress,
                description: 'Shown when the subject of insurance is an address.',
              },
            ],
          }
        ),
        grid(
          '1fr 1fr',
          [
            field('asset_details.asset_type', 'text', { label: 'Asset type' }),
            field('asset_details.identifier', 'text', { label: 'Identifier / VIN / registration' }),
            field('asset_details.description', 'textarea', { label: 'Description' }),
            money$('asset_details.value', 'Declared value'),
          ],
          {
            rules: [
              {
                id: 'asset_details.visible',
                property: 'visible',
                logic: subjectIsAsset,
                description: 'Shown when the subject of insurance is an asset.',
              },
            ],
          }
        ),

        // Cover terms — each repeater gets its own full-width row.
        grid('1fr', [
          repeater('coverage_limits'),
          repeater('coverage_sub_limits'),
          repeater('excesses'),
          repeater('specified_items'),
          repeater('endorsements'),
        ]),
        grid('1fr 1fr', [
          field('policy_wording_reference', 'text', { label: 'Policy wording reference' }),
          field('policy_wording_version', 'text', { label: 'Policy wording version' }),
        ]),

        // Insurer panel
        grid('1fr', [repeater('insurers')]),
        grid('1fr 1fr', [
          field('placed_by', 'text', { label: 'Cover placed by' }),
          field('quote_form_id', 'text', { label: 'Quote form ID' }),
        ]),

        // Commercials
        grid('1fr 1fr 1fr', [
          select('currency', 'Currency', {
            labels: Object.fromEntries(schemaAt('currency').enum.map((c) => [c, c])),
          }),
          // ASSUMPTION: target premium matters while quoting
          money$('target_premium', 'Target premium', [
            {
              id: 'target_premium.visible',
              property: 'visible',
              logic: { in: [{ var: 'type' }, ['info', 'quote']] },
              description: 'Shown while the programme is at info or quote stage.',
            },
          ]),
          // ASSUMPTION: actual premium is required once bound as a policy
          money$('premium', 'Premium', [
            {
              id: 'premium.required',
              property: 'required',
              logic: isPolicy,
              description: 'Required once the programme is a policy.',
            },
          ]),
        ]),
        grid('1fr 1fr 1fr 1fr', [
          money$('taxes', 'Taxes (GST)'),
          money$('stamp_duty', 'Stamp duty'),
          money$('fire_levy', 'Fire services levy'),
          money$('brokerage_fee', 'Brokerage fee'),
        ]),

        // Payment — ASSUMPTION: only relevant once bound
        grid(
          '1fr 1fr',
          [
            select('payment_status', 'Payment status', {
              labels: { 'n/a': 'N/A', invoiced: 'Invoiced', paid: 'Paid' },
            }),
            field('payment_due_date', 'date', { label: 'Payment due date' }, [
              {
                id: 'payment_due_date.required',
                property: 'required',
                logic: isInvoiced,
                description: 'Required once the programme has been invoiced.',
              },
            ]),
          ],
          {
            rules: [
              {
                id: 'payment.visible',
                property: 'visible',
                logic: isPolicyOrRenewal,
                description: 'Payment details apply to policies and renewals.',
              },
            ],
          }
        ),
      ]),
    },
    {
      id: 'quote_capture',
      title: 'Quote capture',
      description: 'Shortened form for going to market.',
      layout: grid('1fr', [
        grid('1fr 1fr', [
          field('coverage_class', 'text', { label: 'Coverage class' }),
          field('inception_date', 'date', { label: 'Inception date' }),
        ]),
        grid('1fr 1fr', [
          select('currency', 'Currency', {
            labels: Object.fromEntries(schemaAt('currency').enum.map((c) => [c, c])),
          }),
          money$('target_premium', 'Target premium'),
        ]),
        // Repeater item input config lives on the SCHEMA (items.properties.*.ui),
        // not the form node — so a repeater renders identically in every form that
        // places it. A per-form item layout is not expressible; reuse the registry
        // rather than pretending a shorter item list here would take effect.
        grid('1fr', [repeater('coverage_limits')]),
      ]),
    },
  ],
};

void isQuote;
