// Records reference data — derived from the records-service engine source
// (records-service/handler, records-service/model, records-service/validate)
// AND the frontend form renderer (microstrate/src/components/records/form/**
// and rules/**), NOT just the OpenAPI spec. The records-service stores
// `views.forms`/`views.tables` as OPAQUE `[]map[string]any` (model/api.go) and
// never validates their inner shape — so the ONLY real contract for the form
// UI shape is the frontend renderer. The `form-builder` and `form-rules`
// topics below encode that contract (the form-creator / form-rule agent
// instructions), reconciled to what the renderer actually reads.

// Gotchas: spec-vs-engine truths the validator lints and the tools encode.
export const GOTCHAS = [
  // Discrepancy #1 — the spec's own ViewFieldNode.field description wrongly
  // says "This MUST be `ref` — not `field`". The engine reads `field`.
  'View field nodes use `field` (a dotted schema path), NOT `ref`. The struct is `{ "type": "field", "field": "address.city" }` (records-service/model/api.go ViewFieldNode/ViewNode). A `ref` key is ignored.',
  // Node-level input config — the single most important form-shape truth.
  'A placed field\'s input config lives ON THE VIEW NODE, not on the schema: `{ "type": "field", "field": "rating", "inputType": "slider", "props": { "label": "Rating", "min": 1, "max": 5 }, "rules": [...] }`. The renderer reads node `inputType`/`props`/`rules` first (view-field.component.svelte); the schema field\'s `ui.inputType`/`ui.props` is only a LEGACY FALLBACK for nested object-group members and array-item leaves that are not their own view node — and the frontend STRIPS `schema.*.ui` for any field placed on a form node when it saves. Build forms by putting inputType/props/rules on the field nodes. See get_records_reference("form-builder").',
  // Discrepancy #5 — record ids are server-generated.
  'Record IDs are server-generated (10-char nanoid over [a-zA-Z0-9]). Any `id` you send when creating a record is ignored (records.go CreateRecordHandler overwrites it). Config IDs, by contrast, are client-supplied and must match ^[a-zA-Z0-9_-]+$.',
  // Discrepancy #6 — required-field truth.
  'Config create requires only `id` and `name`. `schema` must compile as JSON Schema (an empty object compiles). `views` is optional. Record create/update does not strictly require `data` (a nil data is coerced to {}), but any data present is validated against the config schema.',
  // Update method + semantics.
  'Both record configs and records are updated with PUT (not PATCH). Config update applies only the fields you send; record update merges `data` key-by-key into the existing record and re-validates the merged result against the CURRENT schema.',
  // Query-records requirements.
  'GET /records requires `folder` OR `space_id`, and requires a Bearer JWT (used to derive the tenant) — an API key alone is rejected on this endpoint. It also accepts `config_id` (comma-separated: one → AND filter, many → OR group), `limit`, and `offset`. Results are sorted by created_at.',
  // Schema-change semantics.
  'Editing a config schema does NOT retroactively re-validate or migrate existing records. Old records keep their data; only new writes are checked against the new schema.',
  // Auth reality.
  'The service engine only reads `Authorization: Bearer <jwt>` (X-Api-Key is resolved by the gateway). Config CRUD and single-record ops do not enforce auth in the handler — tenant isolation there comes from the gateway/KV layer.',
  // Undocumented capability.
  'An engine endpoint `microstrate.records.get.records-count-by-config` (records-per-config counts, `ids` comma-separated) exists but has no confirmed public REST route, so it is not exposed as a tool here. See get_records_reference("endpoints").',
  // Multi-form model (records-service #1262, microstrate #1263/#1264).
  '`views.forms` (an array of `{ id, title, description?, layout }`) is the current model — a config can have several named forms, each with its own grid `layout`. The old singular `views.form` is deprecated but still accepted by the server; the frontend migrates it to `forms: [{ id: "default", ... }]` on read and drops it on save. On the wire, `RecordViews.Forms`/`.Tables` are stored server-side as opaque `[]map[string]any` (records-service/model/api.go) — the server does NOT validate their internal shape, so the frontend renderer (and this MCP\'s validator) is the only shape check an agent gets. `form-creator`\'s `{ "form": <root grid> }` output is exactly a `views.forms[].layout`.',
  // Repeater / array-field node.
  'A view node can be `{ "type": "array-field", "field": "<array-of-object schema path>", "props"?: {...}, "children": [...] }` — a repeating section bound to an array field. Each child\'s `field` is ELEMENT-RELATIVE (resolved against the array\'s `items.properties`), e.g. for array field "products", a child `field: "title"` means "products[].title", NOT the top-level path "products.title". `props` is UI-only container config (label, itemLabel, required, minItems, maxItems, collapsible, defaultCollapsed). Array-field `rules` are reserved/unused in v1 (the repeater does not evaluate node rules yet).',
  // Rules engine.
  'Conditional behaviour is expressed with `rules` on a node, evaluated by json-logic-engine. Field nodes support all five properties (visible, required, disabled, readonly, value); grid (container) nodes support `visible` only; ELEMENT nodes support `visible` plus a per-kind list; array-field rules are still NOT evaluated (record-view-renderer never passes `rules` to ViewRepeater). A rule is `{ id, property, logic, description? }`. See get_records_reference("form-rules") and ("form-elements").',
  // Element nodes now render (this reverses earlier guidance).
  'A view node can be `{ "type": "element", "element": "<kind>", "props": {...}, "children"?: [...] }` — presentational content with no schema binding: text-heading, text-paragraph, text-note, text-link, alert, and the containers card and card-collapsable. THESE NOW RENDER: record-view-renderer.component.svelte gained an `{:else if view.type === \'element\'}` branch handing the node to view-element.component.svelte. Earlier versions of this MCP warned that element nodes fall through to the field renderer and drop their children — that was true then and is WRONG now. A container element\'s `children` must be grid ROWS, same as the top level; leaf elements take no children. See get_records_reference("form-elements").',
  // Element key traps, all read off the renderer rather than the spec.
  'Three element gotchas where the visual builder, the Form Creator spec and the runtime renderer disagree — the RENDERER wins. (1) text-note alignment is `align`; the builder writes `textAlign`, which the renderer never reads for a note, so aligning a note in the UI does nothing (text-heading and text-paragraph really do use `textAlign`). (2) `visible` rules on card / card-collapsable DO work at runtime even though the builder catalog omits `visible` from their allowed rule properties. (3) a `visible` rule on an array-field repeater is inert — put it on the enclosing grid row instead. (4) text-note and text-paragraph hold content in `markdown`, not `text`, but a `text` RULE is what overrides it (ruleTargets).',
  // Validation bypass (records-service #1287).
  'create_record and update_record accept `validate: false`, which SKIPS schema validation entirely — required fields, types, formats, all of it. Verified live 2026-07-29: a create carrying only {"not_in_schema":123} 400s by default and returns 200 with validate:false, stored verbatim. Nothing marks such a record afterwards, and any form or flow built on that config can break on it. See get_records_reference("validation-bypass").',
  // Record-driven flow triggers (records-service + hub-service #1287).
  'A record write can START A FLOW, but it is OPT-IN: nothing is published unless the body sets `completed: true` (or passes `test_flow`). records-service then publishes `hub.trigger.record.<config_id>.<record_id>` and hub-service runs every PUBLISHED flow whose trigger node is trigger_type "record" on that config. Three traps: the publish is async so the write returns 200 regardless of whether any flow ran; the trigger glob never matches DRAFT flows; and `completed` is stored on update but NOT on create. `test_flow: { subject, run_id }` (create only, both fields required) runs one named flow instead and suppresses every configured trigger — the only way to hit a draft. See get_records_reference("flow-triggers").',
];

// JSON Schema field types the record schema accepts (standard JSON Schema —
// the service compiles the schema with santhosh-tekuri/jsonschema/v5).
const FIELD_TYPES = [
  'string', 'number', 'integer', 'boolean', 'object', 'array', 'null',
];

// Input types the visual form builder OFFERS per data type
// (microstrate records.utils.ts inputOptionsForType). These are the safe,
// renderer-backed choices for `node.inputType`. The full InputType union in
// form.types.ts is larger (see INPUT_TYPES_EXTENDED) but the extras are not
// surfaced by the builder and most lack prop editors.
const INPUT_TYPES = [
  'array', 'checkbox', 'country', 'currency', 'date', 'date-range', 'dropdown',
  'key-value', 'lookup', 'multi-country', 'multi-select', 'multi-toggle',
  'number', 'phone', 'slider', 'tags', 'text', 'textarea', 'toggle', 'uploader',
];

// Extra members of the InputType union (form.types.ts) that the renderer's
// field dispatch accepts but the visual builder does not offer as choices.
// Split by whether they are actually usable, because they are not equivalent.
//
// USABLE: renderer-backed, just absent from the builder's dropdown. The Form
// Creator spec treats these three as first-class for string fields.
const INPUT_TYPES_EXTENDED_USABLE = ['markdown', 'password', 'secret'];

// AVOID: the Form Creator spec explicitly forbids these — they degrade to a
// plain text box or are unsupported in the records form renderer. Setting one is
// not an error, it just does not give you the control you asked for.
const INPUT_TYPES_AVOID = [
  'statuses', 'search', 'code', 'code-editor', 'color-picker', 'icon',
  'display', 'question', 'toggleable', 'yesNo', 'custom', 'key-value-array',
];

// Kept for callers that want the whole non-builder set in one list.
const INPUT_TYPES_EXTENDED = [...INPUT_TYPES_EXTENDED_USABLE, ...INPUT_TYPES_AVOID];

// The builder's per-JSON-type input options (records.utils.ts inputOptionsForType).
const INPUT_TYPES_BY_DATA_TYPE = {
  string: ['text', 'textarea', 'dropdown', 'multi-select', 'multi-toggle', 'tags', 'array', 'date', 'date-range', 'phone', 'country', 'multi-country', 'uploader', 'lookup'],
  number: ['number', 'currency', 'slider'],
  integer: ['number', 'currency', 'slider'],
  boolean: ['toggle', 'checkbox'],
  // multi-select reads props.options and never items.enum, so an array of
  // strings qualifies whether or not the enum has been authored.
  array: ['tags', 'array', 'multi-select (array of strings)', 'uploader (array of strings — stores file paths)'],
  object: ['key-value'],
};

// Default input per JSON type when no inputType is set on the node
// (input.utils.ts defaultInputForType). Set inputType only to override this.
export const DEFAULT_INPUT_BY_TYPE = {
  string: 'text',
  number: 'number',
  integer: 'number',
  boolean: 'toggle',
  array: 'tags',
  object: 'key-value',
};

// Props each input type accepts, on `node.props`
// (microstrate input-prop-editors.config.ts EDITORS_BY_INPUT). `label` is
// always expected. Grouped so an agent knows what to seed from the schema.
export const INPUT_PROPS = {
  common_all: ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'defaultValue'],
  by_input_type: {
    'text|textarea|markdown|secret|password|search|tags|phone': ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'defaultValue'],
    'dropdown|statuses': ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'sort', 'options', 'defaultValue'],
    'multi-select': ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'sort', 'options', 'maxItems', 'defaultValue'],
    'multi-toggle': ['label', 'helpText', 'spacing', 'strictMultiline', 'sort', 'options', 'defaultValue'],
    'date|date-range': ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'minDate', 'maxDate', 'defaultValue'],
    'country|multi-country': ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'includedCountries', 'showNativeName', 'defaultValue'],
    // `step` verified reachable 2026-07-30: input-control declares step?: number
    // (line 166) and passes it to InputNumber (line 661), which uses it for the
    // spinner increments and forwards it to the native input.
    'number': ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'showControls', 'decimalPlace', 'step', 'min', 'max', 'defaultValue'],
    'currency': ['label', 'placeholder', 'helpText', 'spacing', 'strictMultiline', 'decimalPlace', 'min', 'max', 'defaultValue'],
    // decimalPlace, showControls and the two indicator flags are all declared on
    // input-control and passed straight to Slider (lines 748-757) — verified
    // 2026-07-30 after the Form Creator spec listed them and this table did not.
    // `step` is NOT settable: Slider defaults it to 10 ** -decimalPlace and
    // input-control never forwards one.
    'slider': ['label', 'helpText', 'spacing', 'strictMultiline', 'min', 'max', 'decimalPlace', 'showControls', 'showIndicatorMin', 'showIndicatorMax', 'defaultValue'],
    'toggle|checkbox': ['label', 'helpText', 'strictMultiline', 'spacing', 'defaultValue'],
    'key-value|array': ['label', 'helpText', 'spacing', 'strictMultiline', 'defaultValue'],
  },
  prop_shapes: {
    options: '[ { "value": "...", "text": "..." }, ... ] — seed from the schema field\'s enum.',
    sort: 'boolean — sort the options alphabetically.',
    min: 'number — seed from schema `minimum`.',
    max: 'number — seed from schema `maximum`.',
    decimalPlace: 'number of decimal places.',
    showControls: 'boolean — show spinner (increment/decrement) controls. Applies to `number` AND `slider`.',
    step: 'number — the amount the spinner steps by. `number` only, and only meaningful with showControls; a slider derives its step from decimalPlace and cannot be given one.',
    showIndicatorMin: 'boolean — slider only: label the minimum end of the track.',
    showIndicatorMax: 'boolean — slider only: label the maximum end of the track.',
    minDate: 'ISO date string — seed from schema date bounds if present.',
    maxDate: 'ISO date string.',
    maxItems: 'number — seed from schema `maxItems`.',
    includedCountries: 'string[] of ISO codes, e.g. ["uk","ua"].',
    showNativeName: 'boolean.',
    helpText: '{ "markdown": "..." } — extra guidance, use sparingly.',
    strictMultiline: 'boolean — force the label above the input.',
    defaultValue: 'a literal default for the input.',
  },
  array_field_container_props: ['label', 'itemLabel', 'required', 'minItems', 'maxItems', 'collapsible', 'defaultCollapsed'],
};

// display.formatter.type enum.
const FORMATTER_TYPES = [
  'text', 'number', 'currency', 'percent', 'date', 'datetime', 'time', 'boolean', 'json',
];

// Rule properties, and which node kinds honour which (rule.config.ts
// RULE_PROPERTIES_BY_KIND + renderer). Field nodes: all five. Grid/array-field
// containers: `visible` only (array-field rules are reserved in v1).
const RULE_PROPERTIES = ['visible', 'required', 'disabled', 'readonly', 'value'];
const RULE_PROPERTIES_BY_NODE = {
  field: ['visible', 'required', 'disabled', 'readonly', 'value'],
  grid: ['visible'],
  'array-field': ['visible (reserved — NOT evaluated: record-view-renderer passes field/children/props to ViewRepeater but never `rules`)'],
  element: ['visible, plus a per-kind list — see ELEMENT_CATALOG / get_records_reference("form-elements")'],
  table: ['(rules not evaluated by the form renderer)'],
};

// --- element nodes ----------------------------------------------------------
// `{ type: "element", element: "<kind>", props: {...}, children?: [...] }` — a
// presentational node with no schema binding. These RENDER: record-view-renderer
// gained an `{:else if view.type === 'element'}` branch that hands the whole node
// to view-element.component.svelte (which reads node.rules itself, unlike the
// repeater). Before that they fell through to the field renderer and their
// children were dropped — the reason this MCP used to warn against them.
//
// Every entry below is read off the two files that decide behaviour:
//   * props / allowedRuleProperties / ruleTargets / isContainer
//       -> form-editor/builder/element-catalog.config.ts (gates the BUILDER UI)
//   * what is actually rendered
//       -> records/form/view-element.component.svelte (gates RUNTIME)
// Where those two disagree, `divergences` records it — and the runtime wins.
const ELEMENT_KINDS = [
  'text-heading', 'text-paragraph', 'text-note', 'text-link', 'alert',
  'card', 'card-collapsable',
];

const ELEMENT_CONTAINERS = ['card', 'card-collapsable'];

const ELEMENT_CATALOG = {
  'text-heading': {
    category: 'typography',
    container: false,
    purpose: 'A section title. One at the top of the form, one per major section.',
    props: ['text', 'size', 'textAlign', 'overflowWrap', 'spacing', 'helpText'],
    default_props: { text: 'Heading', size: 'medium' },
    rule_properties: ['visible', 'text'],
  },
  'text-paragraph': {
    category: 'typography',
    container: false,
    purpose: 'A block of explanatory copy — section intros and instructions.',
    props: ['markdown', 'textAlign', 'wordWrap', 'spacing'],
    rule_properties: ['visible', 'text'],
    rule_targets: { text: 'markdown' },
    note: 'The content prop is `markdown`, not `text`. A `text` RULE overrides it (ruleTargets).',
  },
  'text-note': {
    category: 'typography',
    container: false,
    purpose: 'Small quiet secondary text — captions, one-line hints under a field.',
    props: ['markdown', 'align', 'lineClamp', 'size', 'spacing'],
    rule_properties: ['visible', 'text'],
    rule_targets: { text: 'markdown' },
    note: 'Alignment is `align` here, NOT `textAlign` (which text-heading and text-paragraph do use). See divergences.',
  },
  'text-link': {
    category: 'typography',
    container: false,
    purpose: 'A hyperlink to related material. Always opens in a new tab (target is hard-coded).',
    props: ['text', 'href', 'note', 'noteSize', 'underline'],
    default_props: { text: 'Link', href: '' },
    rule_properties: ['visible', 'href', 'underline'],
  },
  alert: {
    category: 'display',
    container: false,
    purpose: 'A prominent coloured callout. Usually paired with a `visible` rule so it only shows when it matters.',
    props: ['title', 'text', 'severity', 'showSeverityIcon', 'icon', 'spacing'],
    default_props: { severity: 'info', title: 'Alert', showSeverityIcon: true },
    rule_properties: ['visible', 'title', 'text', 'severity', 'showSeverityIcon', 'icon'],
    note: 'showSeverityIcon defaults to TRUE — the renderer tests `props.showSeverityIcon !== false`, so only an explicit false hides the icon.',
  },
  card: {
    category: 'container',
    container: true,
    purpose: 'A bordered panel grouping a subject area into its own visual block.',
    props: ['accent', 'border', 'borderRadius', 'highlight', 'spacing'],
    default_props: { accent: 'none', border: 'all', borderRadius: 'all' },
    rule_properties: ['visible', 'border', 'borderRadius', 'highlight'],
    note: 'accent "none" is normalised to undefined by the renderer. `visible` works at runtime but the builder will not offer it — see divergences.',
  },
  'card-collapsable': {
    category: 'container',
    container: true,
    purpose: 'A card with an expandable header. For optional or advanced sections that should not compete with the primary fields.',
    props: ['text', 'textSize', 'note', 'helpText', 'border', 'borderRadius', 'highlight', 'defaultOpen', 'spacing'],
    default_props: { text: 'Section', defaultOpen: true, border: 'all' },
    rule_properties: ['visible', 'text', 'note', 'border', 'borderRadius', 'highlight'],
    note: '`text` is the header title, not body content. `visible` works at runtime but the builder will not offer it — see divergences.',
  },
};

const ELEMENT_VALUE_TOKENS = {
  size: ['xSmall', 'small', 'medium', 'large', 'xLarge', 'xxLarge'],
  spacing: ['none', 'xSmall', 'small', 'medium', 'large', 'xLarge'],
  textAlign: ['left', 'center', 'right'],
  align: ['left', 'center', 'right'],
  overflowWrap: ['normal', 'break-word', 'anywhere'],
  wordWrap: ['normal', 'break-word'],
  severity: ['info', 'success', 'warning', 'error', 'none'],
  accent: ['none', 'primary', 'success', 'warning', 'error'],
  border: ['all', 'top', 'bottom', 'both', 'left'],
  borderRadius: ['all', 'none'],
  helpText: ['{ "markdown": "..." } — an OBJECT, not a string'],
};

const CONFIG_EXAMPLE = {
  id: 'customer_feedback',
  name: 'Customer Feedback',
  description: 'Feedback submissions from customers',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      rating: { type: 'number', title: 'Rating', minimum: 1, maximum: 5 },
      category: { type: 'string', title: 'Category', enum: ['bug', 'feature', 'general'] },
      comment: { type: 'string', title: 'Comment' },
      follow_up: { type: 'boolean', title: 'Requested follow-up' },
      email: { type: 'string', title: 'Email', format: 'email' },
    },
    required: ['rating', 'category'],
  },
  // Node-level model: inputType / props / rules live on the FIELD NODES, not on
  // the schema. `views.forms[].layout` is the root grid node.
  views: {
    forms: [
      {
        id: 'default',
        title: 'Default',
        layout: {
          type: 'grid',
          props: { gridTemplateColumns: '1fr' },
          children: [
            {
              type: 'grid',
              props: { gridTemplateColumns: '1fr 1fr' },
              children: [
                { type: 'field', field: 'rating', inputType: 'slider', props: { label: 'Rating', min: 1, max: 5 } },
                {
                  type: 'field',
                  field: 'category',
                  inputType: 'dropdown',
                  props: {
                    label: 'Category',
                    options: [
                      { value: 'bug', text: 'Bug' },
                      { value: 'feature', text: 'Feature' },
                      { value: 'general', text: 'General' },
                    ],
                  },
                },
              ],
            },
            {
              type: 'grid',
              props: { gridTemplateColumns: '1fr' },
              children: [
                { type: 'field', field: 'comment', inputType: 'textarea', props: { label: 'Comment' } },
              ],
            },
            {
              type: 'grid',
              props: { gridTemplateColumns: '1fr 1fr' },
              children: [
                { type: 'field', field: 'follow_up', inputType: 'toggle', props: { label: 'Requested follow-up' } },
                {
                  type: 'field',
                  field: 'email',
                  inputType: 'text',
                  props: { label: 'Email', placeholder: 'name@example.com' },
                  rules: [
                    {
                      id: 'email.required',
                      property: 'required',
                      logic: { '==': [{ var: 'follow_up' }, true] },
                      description: 'Email is required when a follow-up is requested.',
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    table: {
      type: 'table',
      columns: [
        { field: 'rating', order: 0 },
        { field: 'category', order: 1 },
        { field: 'comment', order: 2 },
      ],
    },
  },
};

// An `array-field` (repeater) node. Child `field` refs are element-relative
// ("title"/"price"), NOT "products.title"/"products.price".
// A repeater takes TWO coordinated pieces. The `ui` mirror on the schema's item
// leaves is what actually renders; the node children are what the visual builder
// writes. Emit both, with the same inputType/props in each.
const ARRAY_FIELD_EXAMPLE = {
  _note:
    'Both halves are required. Ship ONLY `node` and the item inputs silently degrade to type defaults — currency becomes a plain number, an enum becomes a free-typed text box.',
  schema_mirror: {
    products: {
      type: 'array',
      title: 'Products',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', title: 'Title', ui: { inputType: 'text', props: { label: 'Title' } } },
          price: {
            type: 'number',
            title: 'Price',
            minimum: 0,
            ui: { inputType: 'currency', props: { label: 'Price', min: 0, decimalPlace: 2 } },
          },
          tier: {
            type: 'string',
            title: 'Tier',
            enum: ['standard', 'premium'],
            // An enum item leaf needs its options HERE — child-node props are not read.
            ui: {
              inputType: 'dropdown',
              props: {
                label: 'Tier',
                options: [
                  { value: 'standard', text: 'Standard' },
                  { value: 'premium', text: 'Premium' },
                ],
              },
            },
          },
        },
      },
    },
  },
  node: {
    type: 'array-field',
    field: 'products',
    props: { label: 'Products', itemLabel: 'Product', required: true, minItems: 1, maxItems: 10 },
    children: [
      {
        type: 'grid',
        props: { gridTemplateColumns: '2fr 1fr 1fr' },
        children: [
          { type: 'field', field: 'title', inputType: 'text', props: { label: 'Title' } },
          { type: 'field', field: 'price', inputType: 'currency', props: { label: 'Price', min: 0, decimalPlace: 2 } },
          {
            type: 'field',
            field: 'tier',
            inputType: 'dropdown',
            props: {
              label: 'Tier',
              options: [
                { value: 'standard', text: 'Standard' },
                { value: 'premium', text: 'Premium' },
              ],
            },
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// form-builder — the complete form-UI generation spec (form-creator agent),
// reconciled to the renderer. This is the "how to shape the form UI" doc.
// ---------------------------------------------------------------------------
const FORM_BUILDER_GUIDE = {
  summary:
    'Complete instructions for turning a record config\'s JSON Schema (plus an optional NL request) into a form layout. A form layout is a tree of view nodes (grid / field / array-field) whose ROOT is a single grid node. That root grid is exactly what goes in `views.forms[].layout` (equivalently, the `{ "form": <root grid> }` a form-creator agent emits). Input config lives on the nodes, not the schema — with ONE exception that bites hard: array-field (repeater) ITEM leaves are configured on `schema.<array>.items.properties.<leaf>.ui`, because the renderer ignores array-field children. Two other things silently degrade a form: a choice input with no `options` (nothing derives them from the schema `enum`), and a prop name the input type does not accept (spread onto the input and dropped). Run validate_record_config — it now warns on all three.',
  output_contract:
    'A form is one named entry in `views.forms`: `{ "id": "<unique>", "title": "...", "description"?: "...", "layout": <ROOT_GRID_NODE> }`. The layout root is ALWAYS a single grid node. A config may hold several forms; `id` is unique within the config and appears in the URL. (The deprecated singular `views.form` is just a bare root grid; prefer `views.forms`.)',
  node_kinds: {
    grid: {
      shape: '{ "type": "grid", "props": { "gridTemplateColumns": "<css>", "gap"?: 16 }, "children": [...], "rules"?: [...] }',
      notes:
        '`gridTemplateColumns` is raw CSS; the number of space-separated tokens = number of columns, children fill left-to-right ("1fr", "1fr 1fr", "2fr 1fr", "1fr 1fr 1fr"). `gap` is an optional pixel number. A grid is a container: its only supported rule property is `visible`.',
    },
    field: {
      shape: '{ "type": "field", "field": "<dotted path>", "inputType"?: "<input type>", "props"?: {...}, "rules"?: [...] }',
      notes:
        '`field` is required and must resolve in the schema. `inputType`, `props`, and `rules` live HERE on the node (not on the schema) — one schema can back several forms with different input config. Omit `inputType` to accept the type default (see defaults_by_type). Always give `props.label`. If you omit `type` on a child that has a `field`, the renderer treats it as a field anyway — but emit `"type": "field"` explicitly.',
    },
    'array-field': {
      shape: '{ "type": "array-field", "field": "<array-of-object path>", "props"?: {...}, "children": [...] }',
      notes:
        'A repeater: a list of item instances the user can add/remove/reorder, each edited with real sub-inputs. Use it when the bound array\'s `items` is an object with its own properties. Children describe ONE item\'s layout and their `field` refs are ELEMENT-RELATIVE — resolved against the array\'s `items.properties`, e.g. child `field: "title"` for array "products" means products[].title, NOT "products.title". `{ "var": "..." }` in a child rule reads sibling fields within the same item. Container `props`: label, itemLabel, required, minItems, maxItems, collapsible, defaultCollapsed. Give a repeater its own full-width row. (For arrays of scalars, prefer a plain field with `tags` — or `array` for a List; use `multi-select` only when the items have an enum.)',
      item_input_config_gotcha:
        'CRITICAL: the renderer does NOT read the `inputType`/`props` you put on array-field CHILDREN. ViewArray renders each item by pointing ViewField at `{ item: field.items }` with no nodeInputType and no nodeProps (view-array.component.svelte), so every item leaf takes its input config from `schema.<array>.items.properties.<leaf>.ui = { inputType, props }` — the legacy fallback — or else the bare type default. Consequence if you only set the children: a money item renders as a plain number, a long-text item as single-line text, and an ENUM item as a free-typed text box. So for every repeater, WRITE THE CONFIG TWICE: onto `items.properties.<leaf>.ui` (what renders) and onto the children (what the visual builder writes, and what live configs carry). Live example: insurers.json does both. A corollary: item input config is per-SCHEMA, so a repeater looks the same in every form that places it — a per-form item layout is not expressible.',
      rules_gotcha:
        'The array-field node\'s OWN `rules` are still not evaluated: record-view-renderer passes schema/fieldRef/childNodes/value/errors/nodeProps/onChange to ViewRepeater and never passes `rules`. The Form Creator spec says the repeater container supports `visible`; it does not. Put that rule on the enclosing grid ROW instead — grid rules ARE evaluated and hiding the row hides the repeater. Child field rules inside a repeater do work, evaluated per item.',
    },
    element: {
      shape: '{ "type": "element", "element": "<kind>", "props": {...}, "children"?: [...], "rules"?: [...] }',
      notes:
        'Presentational content with NO schema binding, rendered straight from props: text-heading, text-paragraph, text-note, text-link, alert (leaves), plus the containers card and card-collapsable. These are NEW — record-view-renderer only recently gained an `element` branch, and before it existed an element node fell through to the field renderer and its children were dropped. A container element\'s `children` are grid ROWS, laid out exactly like the top level; leaf elements take no children. Element rules ARE evaluated (view-element receives the whole node and reads node.rules itself), which is why they work where the repeater\'s do not.',
      key_traps:
        'text-note alignment is `align`, NOT `textAlign` (the builder writes textAlign, which the renderer ignores for a note — text-heading and text-paragraph do use textAlign). text-note and text-paragraph hold content in `markdown`, but a `text` RULE is what overrides it. `visible` rules on card / card-collapsable work at runtime although the builder catalog omits them. Full per-kind props, rule properties, value tokens and divergences: get_records_reference("form-elements").',
    },
  },
  structural_rules: [
    'The layout root is a single grid, and EVERY child of the root is a grid ("row"). Field, element and array-field nodes are never direct children of the root.',
    'A row\'s children are its cells — one per column, filling left to right.',
    'A CONTAINER element\'s (card, card-collapsable) children are grid ROWS, same as the top level. A field placed straight into a card skips the row layer.',
    'Containers sit in a cell of a root-level row and are not nested inside one another.',
    'Wide or complex inputs get their own "1fr" row: textarea, markdown, array, key-value, repeaters, cards.',
    '`props.gap` is only read from the ROOT grid (default 16); on a nested row it has no effect.',
  ],
  input_selection: {
    defaults_by_type: DEFAULT_INPUT_BY_TYPE,
    allowed_by_type: INPUT_TYPES_BY_DATA_TYPE,
    hints: [
      'string with enum → dropdown; array items with enum → multi-select.',
      'format date → date; a start/end pair → date-range.',
      'long text (description/notes, large maxLength) → textarea.',
      'phone → phone; country → country (multi-country for arrays of countries).',
      'money/price/amount → currency; a bounded rating/percentage → slider.',
      'array of scalars → tags (or array for a List); array of objects → an array-field repeater.',
      'object with defined properties → expand into individual leaf field nodes (one node per leaf) rather than binding the whole object; use key-value only for a free-form object.',
      'Omit inputType when the type default already fits; set it otherwise.',
    ],
    extended_union:
      'The full InputType union also includes ' + INPUT_TYPES_EXTENDED.join(', ') + ' — valid on a node but NOT offered by the visual builder and mostly without prop editors. Prefer the allowed_by_type set.',
  },
  props: INPUT_PROPS,
  paths:
    'Reference nested properties with dots: Address.Country, Address.Phone. Resolution steps into `properties` for objects and `items.properties` for arrays of objects. Bind only leaf fields (primitives, enums, date/array leaves). Prefer expanding a nested object into individual leaf field nodes over binding the whole object. For an array of objects, use an array-field node with element-relative child refs.',
  layout_principles: [
    'Root = a single grid with `gridTemplateColumns: "1fr"` whose children are row grids.',
    'Each row = a child grid whose children are field nodes (or nested grids / array-fields).',
    'Keep rows to 1–3 columns. Put related fields in the same row.',
    'Wide/complex inputs (textarea, repeaters/array-fields, address groups) get their own full-width single-column row.',
    'Preserve a sensible reading order: identity/name first, then contact, address, then secondary details.',
    'Every field node binds a real leaf path and has a `props.label`. Every array-field binds a real array path and has a label (and preferably itemLabel).',
    'MANDATORY for every choice input (dropdown / multi-select / multi-toggle / statuses): supply `options`, seeded from the schema `enum`. Nothing derives them — InputControl gets `{...inputProps}` and never sees the schema field, and `options` defaults to `[]`. An enum field with no options renders an EMPTY picker the user cannot select anything from. Keep the option `value`s exactly equal to the enum values, or the form produces records the schema rejects.',
    'Reflect the rest of the schema constraints too: minimum/maximum → min/max; date bounds → minDate/maxDate; maxItems; array minItems/maxItems onto the array-field container; money → decimalPlace 2.',
    'Use only the props listed for that input type (see `props.by_input_type`). Props are spread onto the input as-is, so an invented or misspelled name is silently dropped — there is no per-field currency-code prop, for instance.',
    'If a user request names/implies specific fields, include only those; if it describes layout, honour it; with no request, include every leaf property.',
    'Never invent fields — only reference paths that exist in the schema.',
  ],
  rules_pointer: 'Conditional behaviour (visible/required/disabled/readonly/value) goes in a node\'s `rules` array. See get_records_reference("form-rules").',
  legacy_fallback:
    'The renderer reads node `inputType`/`props` first, falling back to the schema field\'s `ui.inputType`/`ui.props` only for nested object-group members and array-item leaves that are not their own view node. When saving, the frontend STRIPS `schema.*.ui` for any field placed on a form node. Build forms with node-level config; do not rely on schema `ui` — EXCEPT for array-item leaves, where the `ui` mirror is the only thing that renders (see the array-field `item_input_config_gotcha`).',
  props_fallback_is_wholesale:
    'The props fallback is `inputProps = nodeProps ?? field.ui.props ?? {}` (view-field.component.svelte) — a WHOLESALE choice between the two objects, NOT a merge. So a node whose props carry only a `label` completely shadows the schema `ui.props`, discarding any `options` defined there and rendering an empty picker. Put ALL props in one place: either give the node complete props (label AND options), or give the node no props at all and keep everything on `schema.<field>.ui.props`. Many live configs take the second route with bare `{ "type": "field", "field": "x" }` nodes.',
  example: CONFIG_EXAMPLE.views.forms[0],
  array_field_example: ARRAY_FIELD_EXAMPLE,
};

// ---------------------------------------------------------------------------
// form-rules — the complete rule-expression spec (form-rule agent), reconciled
// to the json-logic-engine the renderer runs.
// ---------------------------------------------------------------------------
const FORM_RULES_GUIDE = {
  summary:
    'How to write conditional rules on view nodes. Rules drive an element\'s state (visible / required / disabled / readonly / value) from the live form value, evaluated by json-logic-engine (LogicEngine.run). Rules are OPTIONAL — add one only when a node\'s behaviour genuinely depends on other fields; default to none.',
  rule_shape:
    'A rule attached to a node is `{ "id": "<Field>.<property>", "property": "visible|required|disabled|readonly|value", "logic": <json-logic>, "description"?: "<one plain sentence>" }`. `id` convention is "<FieldPath>.<property>" (e.g. "Address.Country.visible") and must be present on a stored node rule. `description` is human-readable and does not affect evaluation. (Note: a form-rule generator agent emits `{ property, logic, description, warning? }` WITHOUT an id — add the `id` when you attach it to a node.)',
  properties: {
    values: RULE_PROPERTIES,
    by_node_kind: RULE_PROPERTIES_BY_NODE,
    value_types:
      'visible/required/disabled/readonly are coerced to boolean; `value` keeps the raw computed value (any type) and writes it back into the field. A bare boolean logic is valid for an unconditional state (e.g. always read-only: { "property": "readonly", "logic": true }).',
  },
  field_references:
    'Read other fields with `{ "var": "FieldPath" }`; dotted paths allowed ({ "var": "Address.Country" }). At the form root, `var` resolves against the whole record-data object. Inside an array-field item, a child rule\'s `var` resolves against the CURRENT ITEM (sibling fields in the same entry) — there is no ambient access to the record root or other items.',
  operators: {
    comparison: ['==', '===', '!=', '!==', '<', '<=', '>', '>='],
    logical: ['and', 'or', '!', 'not'],
    conditional: ['if'],
    array: ['in', 'all', 'some', 'none', 'filter', 'map', 'reduce'],
    string: ['cat', 'substr'],
    numeric: ['+', '-', '*', '/', '%', 'min', 'max'],
    access: ['var'],
    note: 'Standard json-logic-engine operators; no custom operators are registered. Malformed logic evaluates to "no opinion" (undefined/falsy). An empty {} logic is skipped. When two rules target the same property, the last one wins.',
  },
  examples: [
    { property: 'visible', logic: { '>=': [{ var: 'Age' }, 18] }, description: 'The element is visible only if Age is 18 or older.' },
    { property: 'required', logic: { '==': [{ var: 'Type' }, 'company'] }, description: 'The element is required when Type is "company".' },
    { property: 'disabled', logic: { '!=': [{ var: 'Address.Country' }, 'us'] }, description: 'The element is disabled when Address.Country is not "us".' },
    { property: 'value', logic: { if: [{ '>=': [{ var: 'Age' }, 18] }, 'https', ''] }, description: 'The value is computed from Age.' },
    { property: 'required', logic: { '==': [{ var: 'IsPrimary' }, true] }, description: '(inside a repeater item) Email is required when IsPrimary is true.' },
  ],
  when_to_add: [
    'Dependent visibility: a field is pointless until another has a value (property visible).',
    'Conditional requirement: a field becomes mandatory based on another (property required).',
    'Conditional lock: read-only/disabled under a condition (property readonly / disabled).',
    'Derived value: one field is computed from others (property value).',
    'If nothing genuinely depends on other fields, output no rules.',
  ],
  description_style:
    'One plain-English sentence (British English) describing the condition and outcome, referencing field paths (e.g. "Address.Country") and using AND/OR/NOT for compound logic. Concise but complete.',
};

const REFERENCE = {
  'schema': {
    summary:
      'A record config `schema` is a standard JSON Schema document: `{ "$schema"?, "type": "object", "properties": { ... }, "required"?: [...] }`. The service compiles it with a real JSON Schema validator, so malformed schemas are rejected with 400 "invalid schema". Field metadata (title, description, enum, minimum/maximum, format, pattern, …) drives both validation and the form defaults. NOTE: put input config on the FORM view nodes, not on the schema — schema `ui`/`display` are legacy fallbacks (see form-builder).',
    field_types: FIELD_TYPES,
    field_keywords:
      'Per-field: type, title, description, enum, default, minimum/maximum, exclusiveMinimum/Maximum, minLength/maxLength, pattern, format, properties (objects), items (arrays), required (objects). Legacy per-field UI hints `ui` and `display` are still read as a fallback but should not be authored for placed form fields.',
    example: CONFIG_EXAMPLE.schema,
  },
  'field-types': {
    summary: 'Allowed JSON Schema types for a schema field (single or an array like ["string","null"]).',
    values: FIELD_TYPES,
  },
  'input-types': {
    summary: 'Values for a view field node\'s `inputType` (the form widget). These are the builder-offered set, per data type. `props.label` should always be set. Prefer these over the wider InputType union. See form-builder for props per input type.',
    values: INPUT_TYPES,
    by_data_type: INPUT_TYPES_BY_DATA_TYPE,
    defaults_by_type: DEFAULT_INPUT_BY_TYPE,
    extended_union: INPUT_TYPES_EXTENDED,
  },
  'formatters': {
    summary: 'Values for `display.formatter.type` — how a value is rendered read-only (legacy schema-level hint).',
    values: FORMATTER_TYPES,
  },
  'views': {
    summary:
      'Optional UI layout on a config. `views.forms` (current model) is an array of named forms: `{ "id", "title", "description"?, "layout": <root grid node> }`. `views.form` (singular) is the deprecated legacy single form (a bare root grid), still accepted by the server but migrated to `forms:[{id:"default",...}]` and dropped on save. `views.table` lists columns: `{ "type": "table", "columns": [ { "field": "<name>", "order": 0 } ] }`. Node kinds — grid: `{ "type":"grid","props":{"gridTemplateColumns":"1fr 1fr","gap"?:8},"children":[...],"rules"?:[...] }`; field: `{ "type":"field","field":"<dotted path>","inputType"?,"props"?,"rules"? }` (key is `field`, never `ref`; input config on the NODE); array-field repeater: `{ "type":"array-field","field":"<array path>","props"?,"children":[...] }` with element-relative child refs. For the full form-building spec use get_records_reference("form-builder"); for conditional rules use get_records_reference("form-rules").',
    example: CONFIG_EXAMPLE.views,
    array_field_example: ARRAY_FIELD_EXAMPLE,
  },
  'form-builder': FORM_BUILDER_GUIDE,
  'form-rules': FORM_RULES_GUIDE,
  'record': {
    summary:
      'A record is `{ id, config_id, data, created_at, updated_at }`. Create with `{ data, folder?, space_id? }` — `id` and `config_id` are set by the server (config_id from the URL). `data` is validated against the config schema. Update (PUT) merges the `data` you send into the existing record.',
    example: { data: { rating: 5, category: 'feature', comment: 'Loved it.' }, folder: 'folder_abc' },
  },
  'endpoints': {
    summary: 'The records-service surface (REST path → engine subject).',
    record_configs: [
      'GET    /records/config            → get.configs   (optional ?ids=a,b for batch)',
      'POST   /records/config            → post.config   (409 if id exists)',
      'GET    /records/config/{id}       → get.config',
      'PUT    /records/config/{id}       → put.config    (partial: only fields sent)',
      'DELETE /records/config/{id}       → delete.config (also purges its records)',
    ],
    records: [
      'GET    /records                   → get.query-records (folder|space_id required + Bearer; config_id/limit/offset optional)',
      'GET    /records/{config_id}       → get.records   (all records for a config)',
      'POST   /records/{config_id}       → post.record',
      'GET    /records/{config_id}/{id}  → get.record',
      'PUT    /records/{config_id}/{id}  → put.record    (merges data)',
      'DELETE /records/{config_id}/{id}  → delete.record',
      'NOTE: create and update both accept `validate` (default true — false skips schema validation entirely) and `completed` (true also publishes a record event that can start a flow). Create additionally accepts `test_flow: { subject, run_id }` to run one named flow and suppress every configured trigger. See get_records_reference("flow-triggers") and ("validation-bypass").',
    ],
    undocumented: [
      'get.records-count-by-config (records-per-config counts; `ids` comma-separated) — no confirmed public REST route, not exposed as a tool.',
    ],
  },
  'form-elements': {
    summary:
      'Presentational `element` nodes — headings, paragraphs, notes, links, alerts, cards, collapsible cards. `{ type: "element", element: "<kind>", props: {...}, children?: [...] }`. No schema binding: they render straight from props. These are NEW — the renderer only gained an `element` branch recently, and before that an element node fell through to the FIELD renderer and its children were silently dropped.',
    kinds: ELEMENT_KINDS,
    containers: ELEMENT_CONTAINERS,
    leaf_kinds: ELEMENT_KINDS.filter((k) => !ELEMENT_CONTAINERS.includes(k)),
    catalog: ELEMENT_CATALOG,
    value_tokens: ELEMENT_VALUE_TOKENS,
    structural_rules: [
      'The root of a form layout is a grid, and EVERY child of the root is a grid ("row"). Field, element and array-field nodes are never direct children of the root.',
      'A row\'s children are its cells — one per column, filling left to right. The column count is the number of space-separated tokens in props.gridTemplateColumns.',
      'A CONTAINER element\'s children are grid ROWS, exactly like the top level. Putting a field straight into a card\'s children skips the row layer.',
      'Containers sit in a cell of a root-level row and are never nested inside one another.',
      'Leaf elements (text-*, alert) take NO children — the renderer ignores any you pass.',
      'Wide or complex inputs get their own "1fr" row: textarea, markdown, array, key-value, repeaters, cards.',
      'props.gap is only read from the ROOT grid (default 16). On a nested row it has no effect.',
    ],
    divergences: {
      why:
        'Three places where the builder catalog (element-catalog.config.ts, which gates the editor UI) and the runtime renderer (view-element.component.svelte) disagree, or where the Form Creator spec does. RUNTIME WINS — that is what a stored config actually does. Each was read off both files, not inferred.',
      'text-note alignment': {
        runtime: "view-element reads props.align (`align={str('align') ?? 'default'}`).",
        builder: 'the catalog\'s prop editor writes props.textAlign.',
        consequence:
          'FRONTEND BUG: aligning a note in the visual builder writes a key the renderer never reads, so it does nothing at runtime. Author `align`. text-heading and text-paragraph genuinely use `textAlign` — the inconsistency is real, not a typo in this doc.',
      },
      'card visible rules': {
        runtime: 'both card branches are wrapped in `{#if !ruleState.visible}`, so a visible rule DOES hide a card and its contents.',
        builder: "the catalog's allowedRuleProperties for card and card-collapsable omit 'visible'.",
        consequence:
          'A hand-authored (or MCP-authored) `visible` rule on a card works, but the builder\'s Rules tab will not offer it and may not round-trip it. Safe to author; do not expect to edit it in the UI.',
      },
      'repeater visible rules': {
        runtime:
          'record-view-renderer passes schema/fieldRef/childNodes/value/errors/nodeProps/onChange to ViewRepeater and NEVER passes `rules`, so an array-field node\'s own rules are not evaluated.',
        spec:
          'the Form Creator spec claims the repeater container supports `visible`. It does not.',
        consequence:
          'A `visible` rule on an array-field is silently inert. Put the rule on the enclosing grid ROW instead — grid rules ARE evaluated, and hiding the row hides the repeater. Child field rules inside the repeater work and are evaluated per item.',
      },
    },
    element_vs_field_rules:
      'An element node keeps its rules on the node and view-element evaluates them itself (it receives the whole node). That is why element rules work while repeater rules do not.',
    examples: {
      heading: { type: 'element', element: 'text-heading', props: { text: 'Client onboarding', size: 'large', spacing: 'xSmall' } },
      note: { type: 'element', element: 'text-note', props: { markdown: 'Used for claims contact only.', size: 'small', align: 'left' } },
      conditional_alert: {
        type: 'element',
        element: 'alert',
        props: { title: 'Terms not yet accepted', text: 'Accept the terms of business to submit.', severity: 'warning' },
        rules: [
          {
            id: 'alert.visible',
            property: 'visible',
            logic: { '!': [{ var: 'consent.terms_accepted' }] },
            description: 'Shown while the terms have not been accepted.',
          },
        ],
      },
      card_with_rows: {
        type: 'element',
        element: 'card',
        props: { accent: 'primary', border: 'all', borderRadius: 'all', highlight: true },
        children: [
          {
            type: 'grid',
            props: { gridTemplateColumns: '1fr' },
            children: [{ type: 'element', element: 'text-heading', props: { text: 'Cover details', size: 'small' } }],
          },
          {
            type: 'grid',
            props: { gridTemplateColumns: '1fr 1fr' },
            children: [
              { type: 'field', field: 'cover.sum_insured', inputType: 'currency', props: { label: 'Sum insured', min: 0, decimalPlace: 2 } },
              { type: 'field', field: 'cover.start_date', inputType: 'date', props: { label: 'Start date' } },
            ],
          },
        ],
      },
    },
  },
  'flow-triggers': {
    summary:
      'A record create/update can start a flow. This is OPT-IN on the records side: nothing is published unless the write sets `completed: true` or passes `test_flow`. A plain create is silent. records-service #1287 / hub-service #1287.',
    how_it_works: [
      'records-service RepublishRecord publishes the marshalled record to `hub.trigger.record.<config_id>.<record_id>` with an `x-event-type` header of "record-created" or "record-updated".',
      'hub-service subscribes to `hub.trigger.>` and, for a record subject, looks up trigger nodes by GLOB: `ms.hub.config.workflow-node.*.*.record.<config_id>`.',
      'Each matching node must have node_type "trigger" and trigger_type "record". If its payload.event_type array is non-empty, the header must appear in it; an absent or empty array accepts every event.',
      'The flow is then run with the record as the trigger payload, so `$.trigger` is the whole record: { id, data, folder, space_id, completed, created_at, updated_at }.',
      'SOURCE-DERIVED, NOT OBSERVED: the steps above come from records-service/handler/records.go and hub-service/service/service.go. No triggered run has been observed end to end — see test_flow.verification_status for why (there is no read channel for an async run today).',
    ],
    completed: {
      on_create:
        '`completed: true` publishes the event. It is NOT stored on the record — CreateRecordHandler reads it off the request only, so a later GET does not show it.',
      on_update:
        '`completed` IS stored on update (existing.Completed is assigned) and publishes only when true. So the field is persistent after an update but absent after a create-with-completed.',
      async: 'The publish happens in a goroutine after the response is sent. The write returns 200 whether or not any flow matched or ran — check the flow run, never the write response.',
    },
    test_flow: {
      shape: '{ "subject": "ms.hub.config.workflow[.draft].<collection>.<flow>", "run_id": "<your id>" }',
      create_only: 'Accepted on create only — UpdateRecordRequest has no test_flow field.',
      both_required:
        'hub-service requires BOTH subject and run_id. With only one it falls through to the normal trigger lookup, so a half-filled test_flow silently behaves like `completed`.',
      suppresses_triggers:
        'When test_flow is set, hub-service runs ONLY that flow and skips the trigger-node lookup entirely — so it cannot accidentally fire the production flows for that config.',
      run_id:
        'A bare id is expanded to `ms.hub.run.<run_id>.<subject>`; pass something already starting with "ms.hub.run" to control it yourself. Use it to correlate the run in search_run_logs.',
      draft_ok:
        'This is the only way to trigger a DRAFT flow from a record — see published_only below.',
      verification_status:
        'NOT VERIFIED END TO END. Attempted 2026-07-29: a create with test_flow pointing at a known-good published flow returned 200 and echoed the test_flow back, but no run could be observed. The obstacle is the instrument, not necessarily the feature — a MANUAL awaited run of the same flow succeeded and returned a tracking_id, and that run did not appear in POST /hub/run-logs/search either (nor does workflow history list runs, only config versions). So there is currently no read channel for an asynchronously-triggered run, and this shape is documented from the hub-service source (service/service.go StartSubscriber) rather than from an observed run. Treat it as unconfirmed until someone can read hub-service logs or a run channel is available.',
    },
    published_only:
      'The trigger glob has exactly two wildcards (collection, flow), so it matches PUBLISHED node subjects only. A draft node subject carries an extra ".draft." token and never matches. A record trigger on an unpublished flow does nothing, silently. Publish the flow, or use test_flow.',
    the_node_id_trap:
      'The trigger node\'s id must be literally `record.<config_id>`, because the glob matches on the node subject and a node subject is the flow subject + "." + node.id. Any other id and the trigger never fires. That id contains a dot, which hub-service validate.ValidateID rejects — so a record-trigger flow has to be sent with server-side validation off. See quiva-flows-mcp get_node_type_reference("trigger").',
    example_create_that_fires: {
      config_id: 'risk_programme',
      completed: true,
      data: { status: 'bound' },
    },
    example_create_that_tests_one_flow: {
      config_id: 'risk_programme',
      data: { status: 'bound' },
      test_flow: {
        subject: 'ms.hub.config.workflow.draft.1389718614.1365955493',
        run_id: 'my-verification-run-1',
      },
    },
  },
  'validation-bypass': {
    summary:
      '`validate: false` on create or update SKIPS schema validation completely. Verified live 2026-07-29: a create carrying only {"not_in_schema":123} 400s by default and returns 200 with validate:false, storing the record exactly as sent.',
    default: 'Validation is on unless validate is explicitly false (the handler checks `body.Validate == nil || *body.Validate`).',
    what_it_skips:
      'Everything — required fields, types, formats, enums. The record is stored verbatim, so it can be missing every required property the config declares.',
    consequences: [
      'Any form built on that config can break: the renderer expects the schema to hold.',
      'A flow reading $.trigger.data can hit undefined where it expects a value.',
      'query_records / list_records return it like any other record, with nothing marking it as unvalidated.',
    ],
    legitimate_uses: [
      'Bulk import or backfill where the source data is known-imperfect and will be cleaned afterwards.',
      'On UPDATE, when the config schema has moved on and the stored record no longer satisfies it: validation runs against the schema as it is NOW, so an unrelated field edit can otherwise be blocked by a pre-existing mismatch.',
    ],
    not_stored:
      '`validate` is a request-only flag. It is echoed in the create response (which is the request struct, not the stored Record — that response also always carries `test_flow: null`), but a later GET shows neither field.',
  },
  'gotchas': { summary: 'Spec-vs-engine truths.', values: GOTCHAS },
};

export function listReferenceTopics() {
  return Object.keys(REFERENCE).map((topic) => ({ topic, summary: REFERENCE[topic].summary }));
}

export function getReference(topic) {
  const doc = REFERENCE[topic];
  if (!doc) {
    return { error: `Unknown topic "${topic}". Available: ${Object.keys(REFERENCE).join(', ')}` };
  }
  return { topic, ...doc };
}

export {
  FIELD_TYPES,
  INPUT_TYPES,
  INPUT_TYPES_EXTENDED,
  INPUT_TYPES_EXTENDED_USABLE,
  INPUT_TYPES_AVOID,
  FORMATTER_TYPES,
  RULE_PROPERTIES,
  RULE_PROPERTIES_BY_NODE,
  CONFIG_EXAMPLE,
  ELEMENT_KINDS,
  ELEMENT_CONTAINERS,
  ELEMENT_CATALOG,
  ELEMENT_VALUE_TOKENS,
};
