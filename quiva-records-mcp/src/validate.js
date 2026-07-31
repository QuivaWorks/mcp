// Local validator for record configs — no API call. Encodes the rules the
// records-service enforces (records-service/handler/config.go) plus lints for
// the spec-vs-engine gotchas, so mistakes are caught before a POST/PUT.

import {
  DEFAULT_INPUT_BY_TYPE,
  ELEMENT_CATALOG,
  ELEMENT_CONTAINERS,
  ELEMENT_KINDS,
  ELEMENT_VALUE_TOKENS,
  INPUT_PROPS,
  INPUT_TYPES,
  INPUT_TYPES_AVOID,
  INPUT_TYPES_EXTENDED,
  RULE_PROPERTIES,
  RULE_PROPERTIES_BY_NODE,
} from './records-docs.js';

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// Every InputType the renderer accepts on a node (builder-offered + union-only).
const KNOWN_INPUT_TYPES = new Set([...INPUT_TYPES, ...INPUT_TYPES_EXTENDED]);
const KNOWN_RULE_PROPERTIES = new Set(RULE_PROPERTIES);

// Inputs whose choices come ONLY from `props.options`. InputControl is handed
// `{...inputProps}` plus type/value and never sees the schema field, and
// `options` defaults to `[]` (input-control.component.svelte). Nothing derives
// options from a schema `enum`, so an enum field with no `props.options` renders
// an EMPTY picker with nothing to select.
const CHOICE_INPUT_TYPES = new Set(['dropdown', 'multi-select', 'multi-toggle', 'statuses']);

// Flatten the pipe-delimited INPUT_PROPS.by_input_type keys into one lookup, so
// a prop that no editor accepts (and that the renderer therefore drops) is
// caught rather than passed silently through `{...inputProps}`.
const PROPS_BY_INPUT_TYPE = (() => {
  const map = new Map();
  for (const [key, props] of Object.entries(INPUT_PROPS.by_input_type)) {
    for (const type of key.split('|')) map.set(type, new Set(props));
  }
  return map;
})();
const ARRAY_FIELD_PROPS = new Set(INPUT_PROPS.array_field_container_props);
// Which rule `property` values each node kind actually honours (renderer truth).
const RULE_PROPS_BY_KIND = {
  field: new Set(['visible', 'required', 'disabled', 'readonly', 'value']),
  grid: new Set(['visible']),
  'array-field': new Set(['visible']),
};

const ELEMENT_KIND_SET = new Set(ELEMENT_KINDS);
const ELEMENT_CONTAINER_SET = new Set(ELEMENT_CONTAINERS);
const AVOID_INPUT_TYPES = new Set(INPUT_TYPES_AVOID);

// Per-element-kind prop and rule-property lookups, built from the catalog so
// there is one source of truth and no second list to drift.
const ELEMENT_PROPS = new Map(
  Object.entries(ELEMENT_CATALOG).map(([kind, def]) => [kind, new Set(def.props)])
);
const ELEMENT_RULE_PROPS = new Map(
  Object.entries(ELEMENT_CATALOG).map(([kind, def]) => [kind, new Set(def.rule_properties)])
);

// Props whose value must be one of a fixed token set (element-catalog dropdown
// options + the renderer's own defaults). A bad token does not error — the
// component falls back to its default — so these are warnings.
const ELEMENT_ENUM_PROPS = {
  size: ELEMENT_VALUE_TOKENS.size,
  textSize: ELEMENT_VALUE_TOKENS.size,
  noteSize: ELEMENT_VALUE_TOKENS.size,
  spacing: ELEMENT_VALUE_TOKENS.spacing,
  textAlign: ELEMENT_VALUE_TOKENS.textAlign,
  align: ELEMENT_VALUE_TOKENS.align,
  overflowWrap: ELEMENT_VALUE_TOKENS.overflowWrap,
  wordWrap: ELEMENT_VALUE_TOKENS.wordWrap,
  severity: ELEMENT_VALUE_TOKENS.severity,
  accent: ELEMENT_VALUE_TOKENS.accent,
  border: ELEMENT_VALUE_TOKENS.border,
  borderRadius: ELEMENT_VALUE_TOKENS.borderRadius,
};

// The prop each element kind carries its visible content in. An element with an
// empty one renders as blank space, which is easy to ship by accident.
const ELEMENT_CONTENT_PROP = {
  'text-heading': 'text',
  'text-paragraph': 'markdown',
  'text-note': 'markdown',
  'text-link': 'text',
  alert: 'title',
  'card-collapsable': 'text',
};

// Prop keys that are a near-miss for the right one on a given kind. The renderer
// silently ignores an unknown key, so naming the correct one is the whole value.
const ELEMENT_PROP_CORRECTIONS = {
  'text-note': {
    textAlign:
      'use `align` on a text-note — view-element reads props.align for a note, NOT textAlign. (The visual builder writes textAlign here, which is a frontend bug: aligning a note in the UI does nothing. text-heading and text-paragraph do use textAlign.)',
    text: 'use `markdown` — a text-note holds its content in props.markdown. A `text` RULE overrides it, but the PROP is markdown.',
  },
  'text-paragraph': {
    text: 'use `markdown` — a text-paragraph holds its content in props.markdown. A `text` RULE overrides it, but the PROP is markdown.',
    align: 'use `textAlign` on a text-paragraph (only text-note uses `align`).',
  },
  'text-heading': {
    align: 'use `textAlign` on a text-heading (only text-note uses `align`).',
    markdown: 'use `text` — a heading is plain text, not markdown.',
  },
  alert: {
    message: 'use `text` for the body and `title` for the headline.',
    severityIcon: 'use `showSeverityIcon`.',
  },
  card: {
    text: 'a plain `card` has no title prop — put a text-heading in its first grid row, or use card-collapsable which does have `text`.',
    title: 'a plain `card` has no title prop — put a text-heading in its first grid row, or use card-collapsable which does have `text`.',
    defaultOpen: 'a plain `card` does not collapse — use card-collapsable for that.',
  },
  'card-collapsable': {
    title: 'use `text` for the header title.',
    defaultCollapsed: 'use `defaultOpen` (inverted) — defaultCollapsed is the REPEATER prop.',
  },
};

// Validate a record config: { id, name, description?, label?, schema, views? }.
// Returns { valid, errors, warnings }. `id` is not required for updates
// (pass { requireId: false }); it is required for create.
export function validateRecordConfig(config, { requireId = true } = {}) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['config must be an object'], warnings };
  }

  // --- id ---
  if (requireId) {
    if (!config.id || typeof config.id !== 'string') {
      errors.push('id is required and must be a string');
    } else if (!ID_REGEX.test(config.id)) {
      errors.push(`id "${config.id}" is invalid — allowed characters: letters, numbers, underscore, hyphen (^[a-zA-Z0-9_-]+$)`);
    }
  } else if (config.id !== undefined && typeof config.id === 'string' && !ID_REGEX.test(config.id)) {
    errors.push(`id "${config.id}" is invalid — allowed characters: letters, numbers, underscore, hyphen`);
  }

  // --- name ---
  if (requireId || config.name !== undefined) {
    if (!config.name || typeof config.name !== 'string') {
      errors.push('name is required and must be a non-empty string');
    }
  }

  // --- schema ---
  if (config.schema !== undefined) {
    validateSchema(config.schema, errors, warnings);
  } else if (requireId) {
    warnings.push('no schema provided — an empty schema is accepted by the server but records will not be validated against any fields');
  }

  // --- views (optional) ---
  if (config.views !== undefined && config.views !== null) {
    validateViews(config.views, config.schema, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateSchema(schema, errors, warnings) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push('schema must be a JSON Schema object');
    return;
  }
  if (schema.type !== undefined && schema.type !== 'object') {
    errors.push(`schema.type must be "object" (a record is always a top-level object); got ${JSON.stringify(schema.type)}`);
  }
  if (schema.type === undefined) {
    warnings.push('schema.type is missing — set it to "object"');
  }
  if (schema.properties === undefined) {
    warnings.push('schema has no `properties` — records of this config will have no defined fields');
  } else if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    errors.push('schema.properties must be an object keyed by field name');
  } else {
    for (const [name, field] of Object.entries(schema.properties)) {
      validateField(name, field, errors, warnings);
    }
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    errors.push('schema.required must be an array of field names');
  }
}

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function validateField(path, field, errors, warnings) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    errors.push(`field "${path}" must be an object`);
    return;
  }
  const types = Array.isArray(field.type) ? field.type : field.type !== undefined ? [field.type] : [];
  for (const t of types) {
    if (!VALID_TYPES.has(t)) {
      errors.push(`field "${path}" has invalid type ${JSON.stringify(t)} — allowed: ${[...VALID_TYPES].join(', ')}`);
    }
  }
  if (types.length === 0) {
    warnings.push(`field "${path}" has no type`);
  }
  if (field.ui !== undefined) {
    if (typeof field.ui !== 'object' || Array.isArray(field.ui)) {
      errors.push(`field "${path}".ui must be an object`);
    } else {
      if (!field.ui.props || typeof field.ui.props.label !== 'string' || field.ui.props.label === '') {
        warnings.push(`field "${path}".ui.props.label is required for form rendering`);
      }
      // A choice input declared on the schema `ui` needs its options there too —
      // it is the fallback the renderer uses for bare nodes and array items.
      if (CHOICE_INPUT_TYPES.has(field.ui.inputType) && !Array.isArray(field.ui.props?.options)) {
        warnings.push(
          `field "${path}".ui.inputType is "${field.ui.inputType}" but .ui.props.options is missing — it renders as an EMPTY picker${
            Array.isArray(field.enum) ? `; seed it from this field's ${field.enum.length}-value enum` : ' (choices come only from options)'
          }`
        );
      }
    }
  }
  // Recurse into nested object properties and array items.
  if (field.properties && typeof field.properties === 'object') {
    for (const [child, sub] of Object.entries(field.properties)) {
      validateField(`${path}.${child}`, sub, errors, warnings);
    }
  }
  if (field.items && typeof field.items === 'object') {
    validateField(`${path}[]`, field.items, errors, warnings);
  }
}

function validateViews(views, schema, errors, warnings) {
  if (typeof views !== 'object' || Array.isArray(views)) {
    errors.push('views must be an object with optional `forms`, `form`, and `table` keys');
    return;
  }
  const known = collectFieldPaths(schema);
  const schemaContext = schema && typeof schema === 'object' ? schema : undefined;
  if (views.forms !== undefined) {
    validateRecordForms(views.forms, known, schemaContext, errors, warnings);
  }
  if (views.form !== undefined) {
    warnings.push('views.form is the deprecated legacy single form — the server still accepts it, but new/updated configs should use views.forms[] (an array of { id, title, description?, layout }) instead.');
    validateViewNode(views.form, 'views.form', known, schemaContext, errors, warnings, true);
  }
  if (views.table !== undefined) {
    validateTableNode(views.table, known, errors, warnings);
  }
}

// Validate `views.forms`: an array of named forms, each `{ id, title, description?, layout }`
// (records.types.ts RecordForm). `id` must be unique within the config and is used in the
// app URL; `layout` is a grid node, same shape as legacy `views.form`.
function validateRecordForms(forms, known, schemaContext, errors, warnings) {
  if (!Array.isArray(forms)) {
    errors.push('views.forms must be an array of { id, title, description?, layout }');
    return;
  }
  const seenIds = new Set();
  forms.forEach((form, i) => {
    const path = `views.forms[${i}]`;
    if (!form || typeof form !== 'object' || Array.isArray(form)) {
      errors.push(`${path} must be an object { id, title, description?, layout }`);
      return;
    }
    if (typeof form.id !== 'string' || form.id === '') {
      errors.push(`${path}.id is required and must be a non-empty string`);
    } else if (seenIds.has(form.id)) {
      errors.push(`${path}.id "${form.id}" is duplicated — form ids must be unique within a config`);
    } else {
      seenIds.add(form.id);
    }
    if (typeof form.title !== 'string' || form.title === '') {
      errors.push(`${path}.title is required and must be a non-empty string`);
    }
    if (form.description !== undefined && typeof form.description !== 'string') {
      errors.push(`${path}.description must be a string`);
    }
    if (form.layout === undefined) {
      errors.push(`${path}.layout is required (a grid node: { type: "grid", props: { gridTemplateColumns }, children: [...] })`);
    } else {
      validateViewNode(form.layout, `${path}.layout`, known, schemaContext, errors, warnings, true);
    }
  });
}

function validateViewNode(node, path, known, schemaContext, errors, warnings, expectGridRoot, inArrayItem = false) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${path} must be a view node object`);
    return;
  }
  // The classic engine-truth mistake: `ref` instead of `field`.
  if (node.ref !== undefined && node.field === undefined) {
    errors.push(`${path} uses \`ref\` — view field nodes use \`field\` (a dotted schema path), not \`ref\`. Change "ref" to "field".`);
    return;
  }

  // The renderer dispatches on four types and sends EVERYTHING ELSE to the field
  // renderer:
  //   record-view-renderer.component.svelte
  //     {#if grid} {:else if table} {:else if array-field} {:else if element} {:else} ViewField
  //
  // `element` is the newest branch. It hands the WHOLE node to
  // view-element.component.svelte, which renders the seven catalog kinds and
  // evaluates node.rules itself. Before that branch existed an element node fell
  // through to ViewField and its children were dropped, which is what this
  // validator used to warn about — that warning is now wrong and has been
  // replaced by real element validation.
  //
  // The fall-through still matters for legacy data: an omitted type, an empty
  // string, and any unrecognised type all render as a FIELD, and live configs
  // rely on it.
  //
  // Corpus check (2026-07-30, every bundled harvested + authored config): 211
  // "field", 158 "grid", 46 "", 17 "table", 4 "array-field", and exactly ONE
  // "element" — an `element: "card"` in the live sc8DhU6CEXh4gkJPnS_Le config,
  // properly shaped with grid-row children. Zero configs use type "element"
  // without an `element` kind. So that card is the single live element node in
  // existence, and it went from NOT rendering (which is what this validator used
  // to warn about, correctly at the time) to rendering with this release.
  const RENDERER_TYPES = new Set(['grid', 'table', 'array-field', 'field', 'element']);
  const rawType = node.type === '' ? undefined : node.type;
  let normalised = rawType;

  if (rawType === 'element' && node.element === undefined) {
    // type "element" with no `element` kind. view-element derives kind from
    // node.element and its if/else chain has NO final else, so nothing renders.
    // Not seen in any live config, but it is the shape a half-converted field
    // node would take, and the failure is invisible.
    if (node.field !== undefined) {
      warnings.push(
        `${path} has type "element" but no \`element\` kind, and carries a \`field\`. view-element matches on the \`element\` key and its branch chain has no fallback, so this renders NOTHING — it does not fall through to the field renderer any more. Set type to "field".`
      );
      normalised = 'field';
    } else {
      errors.push(
        `${path} has type "element" but no \`element\` kind — an element node needs \`element\` set to one of ${ELEMENT_KINDS.join(', ')}. Without it view-element renders nothing.`
      );
      return;
    }
  } else if (rawType !== undefined && !RENDERER_TYPES.has(rawType)) {
    if (Array.isArray(node.children)) {
      warnings.push(
        `${path} has view node type ${JSON.stringify(rawType)} with children, but the records form renderer only branches on "grid", "table", "array-field" and "element" — anything else falls through to the FIELD renderer, which IGNORES children. Its ${node.children.length} child node(s) will NOT render. Use a "grid" node to group fields, or an "element" container (card / card-collapsable).`
      );
      normalised = 'grid-like-unsupported';
    } else {
      warnings.push(
        `${path} has view node type ${JSON.stringify(rawType)}, which the renderer does not recognise — it falls through to the FIELD renderer and behaves as a field node. Use "field" for clarity (some legacy configs use "").`
      );
      normalised = 'field';
    }
  }

  const type = normalised ?? (node.field !== undefined ? 'field' : node.children !== undefined ? 'grid' : undefined);
  if (expectGridRoot && type !== 'grid') {
    errors.push(`${path} must be a grid node ({ type: "grid", props: { gridTemplateColumns }, children: [...] })`);
    return;
  }

  if (type === 'grid') {
    if (!node.props || typeof node.props.gridTemplateColumns !== 'string') {
      errors.push(`${path}.props.gridTemplateColumns is required for a grid node`);
    }
    if (node.inputType !== undefined) {
      warnings.push(`${path}.inputType is ignored on a grid (container) node — inputType only applies to field nodes`);
    }
    validateRules(node.rules, `${path}`, 'grid', errors, warnings);
    if (!Array.isArray(node.children)) {
      errors.push(`${path}.children must be an array`);
    } else {
      node.children.forEach((child, i) => validateViewNode(child, `${path}.children[${i}]`, known, schemaContext, errors, warnings, false, inArrayItem));
    }
  } else if (type === 'field') {
    if (typeof node.field !== 'string' || node.field === '') {
      errors.push(`${path}.field must be a non-empty dotted schema path`);
    } else if (known.size && !fieldKnown(node.field, known)) {
      warnings.push(`${path} references "${node.field}" which is not defined in schema.properties`);
    }
    validateFieldInputConfig(node, path, errors, warnings, schemaContext, inArrayItem);
    validateRules(node.rules, `${path}`, 'field', errors, warnings);
  } else if (type === 'array-field') {
    validateArrayFieldNode(node, path, known, schemaContext, errors, warnings);
  } else if (type === 'element') {
    validateElementNode(node, path, known, schemaContext, errors, warnings, inArrayItem);
  } else if (type === 'table') {
    warnings.push(
      `${path} is a "table" node inside a form layout — the form renderer only prints a placeholder note for these. Table views belong in views.tables, not views.forms[].layout.`
    );
  } else if (type === 'grid-like-unsupported') {
    // Already warned above. Still walk the children so their own problems are
    // reported rather than hidden behind the unsupported wrapper.
    node.children.forEach((child, i) =>
      validateViewNode(child, `${path}.children[${i}]`, known, schemaContext, errors, warnings, false, inArrayItem)
    );
  } else {
    errors.push(`${path} has no usable view node type ${JSON.stringify(node.type)} — expected "grid", "field", or "array-field"`);
  }
}

// Validate an `element` node: presentational content with no schema binding.
// Truth comes from two files and they do not always agree:
//   * element-catalog.config.ts — gates the BUILDER UI (props, allowedRuleProperties)
//   * view-element.component.svelte — gates RUNTIME (what is actually rendered)
// The renderer wins. Every divergence is called out by name in the message so the
// caller can act on it rather than guess.
function validateElementNode(node, path, known, schemaContext, errors, warnings, inArrayItem) {
  const kind = node.element;

  if (typeof kind !== 'string' || kind === '') {
    errors.push(`${path}.element must name an element kind: ${ELEMENT_KINDS.join(', ')}`);
    return;
  }
  if (!ELEMENT_KIND_SET.has(kind)) {
    errors.push(
      `${path}.element ${JSON.stringify(kind)} is not a known element kind — view-element matches on this key and renders NOTHING for an unknown one. Allowed: ${ELEMENT_KINDS.join(', ')}.`
    );
    return;
  }

  const isContainer = ELEMENT_CONTAINER_SET.has(kind);

  // An element is not schema-bound; a `field` on one is a sign the author meant a
  // field node (or copied one), and the renderer ignores it entirely.
  if (node.field !== undefined) {
    warnings.push(
      `${path}.field is ignored on an element node — elements are not schema-bound and view-element never reads it. If you meant to bind a schema property, use { "type": "field", "field": "${node.field}" }.`
    );
  }
  if (node.inputType !== undefined) {
    warnings.push(`${path}.inputType is ignored on an element node — inputType only applies to field nodes.`);
  }

  // --- children: containers take grid ROWS, leaves take none ---
  if (isContainer) {
    if (!Array.isArray(node.children)) {
      errors.push(
        `${path}.children must be an array of GRID nodes — a ${kind} is a container and its children are rows, laid out exactly like the top level.`
      );
    } else {
      if (node.children.length === 0) {
        warnings.push(`${path} is an empty ${kind} — it renders as a bare panel with nothing in it.`);
      }
      node.children.forEach((child, i) => {
        const childPath = `${path}.children[${i}]`;
        // The structural rule that breaks layouts: a container's children must be
        // rows. A field placed straight into a card skips the row layer and the
        // grid never establishes its columns.
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          const childType = child.type === '' ? undefined : child.type;
          const resolved = childType ?? (child.field !== undefined ? 'field' : child.children !== undefined ? 'grid' : undefined);
          if (resolved !== 'grid') {
            warnings.push(
              `${childPath} is a ${JSON.stringify(resolved ?? child.type)} node directly inside a ${kind}. A container's children must be GRID rows — wrap it in { "type": "grid", "props": { "gridTemplateColumns": "1fr" }, "children": [ ... ] } so the cell layout is established.`
            );
          }
          if (child.type === 'element' && ELEMENT_CONTAINER_SET.has(child.element)) {
            warnings.push(
              `${childPath} nests a ${child.element} inside a ${kind}. Containers are not designed to nest — put each in its own cell of a root-level row.`
            );
          }
        }
        validateViewNode(child, childPath, known, schemaContext, errors, warnings, false, inArrayItem);
      });
    }
  } else if (node.children !== undefined) {
    warnings.push(
      `${path}.children is ignored on a ${kind} — only the container elements (${ELEMENT_CONTAINERS.join(', ')}) render children. Anything nested here is dropped.`
    );
  }

  // --- props ---
  if (node.props !== undefined && (typeof node.props !== 'object' || Array.isArray(node.props))) {
    errors.push(`${path}.props must be an object`);
    return;
  }
  const props = node.props ?? {};
  const allowed = ELEMENT_PROPS.get(kind) ?? new Set();
  const corrections = ELEMENT_PROP_CORRECTIONS[kind] ?? {};

  for (const [key, value] of Object.entries(props)) {
    if (!allowed.has(key)) {
      const hint = corrections[key];
      warnings.push(
        `${path}.props.${key} is not a prop of ${kind} — the renderer ignores it, so it has no effect. ${
          hint ?? `Allowed: ${[...allowed].join(', ')}.`
        }`
      );
      continue;
    }
    const tokens = ELEMENT_ENUM_PROPS[key];
    if (tokens && typeof value === 'string' && !tokens.includes(value)) {
      warnings.push(
        `${path}.props.${key} ${JSON.stringify(value)} is not one of ${tokens.join(', ')} — the component falls back to its default rather than erroring.`
      );
    }
  }

  // helpText is an OBJECT ({ markdown }); a bare string renders nothing.
  if (props.helpText !== undefined && (typeof props.helpText !== 'object' || Array.isArray(props.helpText))) {
    warnings.push(
      `${path}.props.helpText must be an object { "markdown": "..." }, not a ${typeof props.helpText} — a bare string does not render.`
    );
  }

  // Content check: an element whose content prop is missing is invisible.
  const contentProp = ELEMENT_CONTENT_PROP[kind];
  if (contentProp && !isContainer) {
    const hasContent = props[contentProp] !== undefined && props[contentProp] !== '';
    const ruleSuppliesIt = Array.isArray(node.rules)
      && node.rules.some((r) => r?.property === 'text' || r?.property === contentProp);
    if (!hasContent && !ruleSuppliesIt) {
      warnings.push(
        `${path}.props.${contentProp} is empty, so this ${kind} renders as blank space. Set it, or drive it with a "text" rule.`
      );
    }
  }
  if (kind === 'text-link' && (props.href === undefined || props.href === '')) {
    const ruleSuppliesHref = Array.isArray(node.rules) && node.rules.some((r) => r?.property === 'href');
    if (!ruleSuppliesHref) {
      warnings.push(`${path}.props.href is empty — the link renders but goes nowhere.`);
    }
  }

  // --- rules ---
  validateElementRules(node.rules, path, kind, errors, warnings);
}

// Element rules are evaluated by view-element itself (it receives the whole node),
// which is why they work where the repeater's do not. The allowed property set is
// per-kind, and `visible` is honoured at runtime for every kind including the two
// containers the builder catalog omits it from.
function validateElementRules(rules, path, kind, errors, warnings) {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    errors.push(`${path}.rules must be an array of { id, property, logic, description? }`);
    return;
  }
  const allowed = ELEMENT_RULE_PROPS.get(kind) ?? new Set(['visible']);
  rules.forEach((rule, i) => {
    const rulePath = `${path}.rules[${i}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${rulePath} must be an object { id, property, logic, description? }`);
      return;
    }
    if (typeof rule.property !== 'string' || rule.property === '') {
      errors.push(`${rulePath}.property is required`);
    } else if (!allowed.has(rule.property)) {
      warnings.push(
        `${rulePath}.property ${JSON.stringify(rule.property)} is not honoured by a ${kind} — it is stored but never applied. ${kind} supports: ${[...allowed].join(', ')}.`
      );
    }
    if (rule.logic === undefined) {
      errors.push(`${rulePath}.logic is required (a JsonLogic expression, or a bare true/false for an unconditional state)`);
    } else if (
      rule.logic !== true &&
      rule.logic !== false &&
      typeof rule.logic === 'object' &&
      !Array.isArray(rule.logic) &&
      Object.keys(rule.logic).length === 0
    ) {
      warnings.push(`${rulePath}.logic is an empty object — an empty or malformed expression is IGNORED, so the rule silently does nothing.`);
    }
    if (rule.id === undefined || rule.id === '') {
      warnings.push(`${rulePath}.id is missing — convention is "<element kind>.<property>", e.g. "${kind}.${rule.property ?? 'visible'}".`);
    }
    if (rule.description === undefined || rule.description === '') {
      warnings.push(`${rulePath}.description is missing — every rule should state in one sentence what it does.`);
    }
    // The ruleTargets remap: for these two kinds a `text` rule drives `markdown`.
    const targets = ELEMENT_CATALOG[kind]?.rule_targets;
    if (targets && rule.property && targets[rule.property]) {
      warnings.push(
        `${rulePath}: a "${rule.property}" rule on a ${kind} overrides props.${targets[rule.property]} (element-catalog ruleTargets), not props.${rule.property}. That is correct usage — noted so the mapping is not a surprise.`
      );
    }
  });
}

// Validate a repeater (`array-field`) node: bound to an array-of-object schema
// field, with a builder-authored `children` template whose `field` refs are
// ELEMENT-RELATIVE (resolved against the array's `items.properties`), not
// top-level dotted paths (records.types.ts ViewArrayFieldNode).
function validateArrayFieldNode(node, path, known, schemaContext, errors, warnings) {
  if (typeof node.field !== 'string' || node.field === '') {
    errors.push(`${path}.field must be a non-empty dotted path to an array-of-object schema field`);
  } else if (known.size && !fieldKnown(node.field, known)) {
    warnings.push(`${path} references "${node.field}" which is not defined in schema.properties`);
  }
  if (node.props !== undefined && (typeof node.props !== 'object' || Array.isArray(node.props))) {
    errors.push(`${path}.props must be an object (label, itemLabel, required, minItems, maxItems, collapsible, defaultCollapsed)`);
  }
  if (Array.isArray(node.rules) && node.rules.length) {
    warnings.push(`${path}.rules are reserved on array-field (repeater) nodes and are NOT evaluated in v1 — put rules on the child field nodes instead`);
  }

  let itemContext;
  if (typeof node.field === 'string' && node.field !== '') {
    const arrayField = getSchemaFieldAtPath(schemaContext, node.field);
    if (arrayField) {
      const types = Array.isArray(arrayField.type) ? arrayField.type : arrayField.type !== undefined ? [arrayField.type] : [];
      if (types.length && !types.includes('array')) {
        warnings.push(`${path} binds to "${node.field}" which is not schema type "array"`);
      }
      if (arrayField.items && arrayField.items.properties) {
        itemContext = arrayField.items;
      } else {
        warnings.push(`${path} binds to "${node.field}" whose items have no object properties — repeater child \`field\` refs cannot be checked`);
      }
    }
  }

  if (!Array.isArray(node.children)) {
    errors.push(`${path}.children must be an array of view nodes with element-relative \`field\` refs (resolved against the array's items.properties, e.g. child field "title" for array field "products" means "products[].title" — not the top-level path "products.title")`);
    return;
  }
  const itemKnown = itemContext ? collectFieldPaths(itemContext) : new Set();
  node.children.forEach((child, i) => validateViewNode(child, `${path}.children[${i}]`, itemKnown, itemContext, errors, warnings, false, true));

  if (node.props && typeof node.props === 'object' && !Array.isArray(node.props)) {
    const unknown = Object.keys(node.props).filter((k) => !ARRAY_FIELD_PROPS.has(k));
    if (unknown.length) {
      warnings.push(`${path}.props has ${unknown.map((u) => `"${u}"`).join(', ')} which an array-field container does not accept — accepted: ${[...ARRAY_FIELD_PROPS].join(', ')}`);
    }
  }
  if (itemContext) validateArrayItemUi(node, path, itemContext, warnings);
}

// The renderer does NOT read an array-field node's `children`. ViewArray renders
// each item by pointing ViewField at `{ item: field.items }` with no
// nodeInputType and no nodeProps (view-array.component.svelte), so every item
// leaf takes its input config from `items.properties.<leaf>.ui` — the legacy
// fallback — or else the bare type default. Children are still worth emitting
// (the visual builder writes them, and live configs carry them), but without the
// `ui` mirror a repeater's currency fields render as plain numbers, its textareas
// as single-line text, and its enum fields as free-typed text boxes.
function validateArrayItemUi(node, path, itemContext, warnings) {
  const leaves = [];
  const collect = (n, p) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    if (typeof n.field === 'string' && n.field !== '' && !Array.isArray(n.children)) leaves.push({ node: n, path: p });
    if (Array.isArray(n.children)) n.children.forEach((c, i) => collect(c, `${p}.children[${i}]`));
  };
  collect(node, path);

  for (const { node: leaf, path: leafPath } of leaves) {
    const schemaLeaf = getSchemaFieldAtPath(itemContext, leaf.field);
    if (!schemaLeaf) continue;
    const ui = schemaLeaf.ui;
    const mirrorPath = `schema…items.properties.${leaf.field}.ui`;

    // Node config that the renderer will never read.
    const nodeConfig = [];
    if (typeof leaf.inputType === 'string') nodeConfig.push(`inputType "${leaf.inputType}"`);
    const meaningfulProps = leaf.props && typeof leaf.props === 'object' && !Array.isArray(leaf.props)
      ? Object.keys(leaf.props).filter((k) => k !== 'label')
      : [];
    if (meaningfulProps.length) nodeConfig.push(`props ${meaningfulProps.map((k) => `"${k}"`).join(', ')}`);

    if (nodeConfig.length && !ui?.inputType) {
      warnings.push(
        `${leafPath} sets ${nodeConfig.join(' and ')} on an array-field CHILD, but the renderer ignores array-field children — item inputs are read from ${mirrorPath}. As stored, this item leaf falls back to the type default. Mirror the config onto ${mirrorPath} = { inputType, props }.`
      );
    }

    // An enum item leaf needs options on the mirror, not on the child node.
    const enumValues = Array.isArray(schemaLeaf.enum) ? schemaLeaf.enum : undefined;
    if (!enumValues) continue;
    const uiType = ui?.inputType;
    if (!uiType || !CHOICE_INPUT_TYPES.has(uiType)) {
      warnings.push(
        `${leafPath} binds item leaf "${leaf.field}" which has a schema enum (${enumValues.length} values), but ${mirrorPath}.inputType is ${uiType ? `"${uiType}"` : 'unset'} — it renders as a free-typed input. Set ${mirrorPath} = { inputType: "dropdown", props: { label, options } } with options seeded from the enum.`
      );
    } else if (!Array.isArray(ui?.props?.options) || !ui.props.options.length) {
      warnings.push(
        `${leafPath} binds item leaf "${leaf.field}" whose ${mirrorPath}.inputType is "${uiType}" but ${mirrorPath}.props.options is missing — it renders as an EMPTY picker. Seed options from the enum.`
      );
    }
  }
}

// Validate the node-level input config on a field node: `inputType` (against
// the InputType union) and `props` (an object that should carry a `label`).
// The renderer reads these off the NODE (schema `ui` is only a legacy
// fallback), so they are the real form-shape contract.
function validateFieldInputConfig(node, path, errors, warnings, schemaContext, inArrayItem = false) {
  if (node.inputType !== undefined) {
    if (typeof node.inputType !== 'string') {
      errors.push(`${path}.inputType must be a string`);
    } else if (!KNOWN_INPUT_TYPES.has(node.inputType)) {
      warnings.push(`${path}.inputType "${node.inputType}" is not a known InputType — see get_records_reference("input-types")`);
    } else if (AVOID_INPUT_TYPES.has(node.inputType)) {
      // In the union and technically settable, but it degrades to a plain text
      // box or has no records-form implementation, so you do not get the control
      // you asked for. A warning, not an error — nothing rejects it.
      warnings.push(
        `${path}.inputType "${node.inputType}" is in the InputType union but is NOT supported by the records form renderer — it degrades to a plain text box (or renders nothing). Pick one of the renderer-backed types for the field's schema type; see get_records_reference("input-types").`
      );
    }
  }
  if (node.props !== undefined) {
    if (typeof node.props !== 'object' || Array.isArray(node.props)) {
      errors.push(`${path}.props must be an object`);
    } else if (typeof node.props.label !== 'string' || node.props.label === '') {
      warnings.push(`${path}.props.label is recommended so the field renders with a readable label`);
    }
  }
  // A bare { type: "field", field } with no props is legitimate — the label
  // falls back to the schema field's title/key — so absent props is not warned.

  const schemaField =
    typeof node.field === 'string' && node.field !== ''
      ? getSchemaFieldAtPath(schemaContext, node.field)
      : undefined;

  // Effective input: the node wins, then the schema's legacy `ui`, then the
  // type default (view-field.component.svelte:91).
  const effective =
    (typeof node.inputType === 'string' ? node.inputType : undefined) ??
    schemaField?.ui?.inputType ??
    (schemaField ? DEFAULT_INPUT_BY_TYPE[Array.isArray(schemaField.type) ? schemaField.type[0] : schemaField.type] : undefined);

  validateChoiceOptions(node, path, effective, schemaField, warnings, inArrayItem);
  validateKnownProps(node.props, path, effective, warnings);
}

// A choice input must carry `props.options` or it renders with nothing to pick.
// Seed them from the schema `enum`, and keep the two in step.
function validateChoiceOptions(node, path, effective, schemaField, warnings, inArrayItem) {
  const enumValues = Array.isArray(schemaField?.enum) ? schemaField.enum : undefined;
  const nodeProps = node.props && typeof node.props === 'object' && !Array.isArray(node.props) ? node.props : undefined;
  const uiProps = schemaField?.ui?.props && typeof schemaField.ui.props === 'object' && !Array.isArray(schemaField.ui.props)
    ? schemaField.ui.props
    : undefined;

  // Mirror the renderer exactly: `inputProps = nodeProps ?? field.ui.props ?? {}`
  // (view-field.component.svelte:112). It is a WHOLESALE fallback, not a merge —
  // so node props present at all means schema `ui.props` is never consulted.
  const props = nodeProps ?? uiProps;
  const options = Array.isArray(props?.options) ? props.options : undefined;

  // On an array item, ViewArray passes NO nodeProps at all, so the schema `ui` is
  // always what renders and none of the node-level reasoning below applies —
  // validateArrayItemUi covers these leaves instead.
  if (inArrayItem) return;

  // The shadowing trap: a node carrying only a label discards a schema `ui.props`
  // that does have options, because `??` takes the whole object or none of it.
  if (nodeProps && !Array.isArray(nodeProps.options) && Array.isArray(uiProps?.options) && effective && CHOICE_INPUT_TYPES.has(effective)) {
    warnings.push(
      `${path}.props is present but has no \`options\`, and it SHADOWS schema…${node.field}.ui.props wholesale (the renderer does \`nodeProps ?? field.ui.props\` — not a merge), so the ${uiProps.options.length} option(s) defined there are lost and the picker renders EMPTY. Either copy \`options\` onto the node's props or drop the node's props entirely.`
    );
    return;
  }

  // An enum field left on a text-ish default loses the constraint in the UI.
  if (enumValues && effective && !CHOICE_INPUT_TYPES.has(effective)) {
    warnings.push(
      `${path} binds "${node.field}" which has a schema enum (${enumValues.length} values) but renders as "${effective}" — a free-typed input lets a user enter a value the schema will reject. Set inputType "dropdown" and seed props.options from the enum.`
    );
    return;
  }
  if (!effective || !CHOICE_INPUT_TYPES.has(effective)) return;

  if (!options || !options.length) {
    warnings.push(
      enumValues
        ? `${path} is a "${effective}" with no props.options — it renders as an EMPTY picker. Nothing derives options from the schema enum; seed props.options from it: ${JSON.stringify(enumValues.slice(0, 4).map((v) => ({ value: v, text: String(v) })))}${enumValues.length > 4 ? ' …' : ''}`
        : `${path} is a "${effective}" with no props.options — it renders as an EMPTY picker. Choices come only from props.options (nothing is derived from the schema).`
    );
    return;
  }

  const bad = options.filter((o) => !o || typeof o !== 'object' || Array.isArray(o) || o.value === undefined);
  if (bad.length) {
    warnings.push(`${path}.props.options entries must each be { value, text } — ${bad.length} entry/entries have no \`value\``);
  }
  if (enumValues) {
    const optionValues = new Set(options.map((o) => o?.value));
    const missing = enumValues.filter((v) => !optionValues.has(v));
    const extra = [...optionValues].filter((v) => v !== undefined && !enumValues.includes(v));
    if (missing.length) {
      warnings.push(`${path}.props.options is missing enum value(s) ${JSON.stringify(missing)} — those are valid per the schema but unselectable in the form`);
    }
    if (extra.length) {
      warnings.push(`${path}.props.options offers ${JSON.stringify(extra)} which the schema enum does not allow — selecting one produces a record the schema rejects`);
    }
  }
}

// Props are spread onto the input component as-is, so a name no prop editor
// knows is silently dropped — the failure mode that hides a typo or an invented
// prop. Warn, naming the props this input type actually accepts.
function validateKnownProps(props, path, effective, warnings) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return;
  if (!effective) return;
  const allowed = PROPS_BY_INPUT_TYPE.get(effective);
  if (!allowed) return; // an extended-union input with no prop editor — nothing to check against
  const unknown = Object.keys(props).filter((k) => !allowed.has(k));
  if (unknown.length) {
    warnings.push(
      `${path}.props has ${unknown.map((u) => `"${u}"`).join(', ')} which "${effective}" does not accept — silently dropped by the renderer. Accepted: ${[...allowed].join(', ')}`
    );
  }
}

// Validate a node's `rules` array against the node kind. Each rule is
// `{ id, property, logic, description? }`. `property` must be honoured by the
// node kind (field: all five; grid/array-field container: visible only) and
// `logic` must be a json-logic object or a bare boolean.
function validateRules(rules, path, kind, errors, warnings) {
  if (rules === undefined || rules === null) return;
  if (!Array.isArray(rules)) {
    errors.push(`${path}.rules must be an array of { id, property, logic }`);
    return;
  }
  const allowed = RULE_PROPS_BY_KIND[kind] ?? RULE_PROPS_BY_KIND.field;
  rules.forEach((rule, i) => {
    const rp = `${path}.rules[${i}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${rp} must be an object { id, property, logic }`);
      return;
    }
    if (rule.id !== undefined && typeof rule.id !== 'string') {
      errors.push(`${rp}.id must be a string (convention "<FieldPath>.<property>")`);
    } else if (rule.id === undefined) {
      warnings.push(`${rp}.id is missing — stored node rules should carry an id like "<FieldPath>.<property>"`);
    }
    if (typeof rule.property !== 'string' || !KNOWN_RULE_PROPERTIES.has(rule.property)) {
      errors.push(`${rp}.property must be one of ${[...KNOWN_RULE_PROPERTIES].join(', ')}; got ${JSON.stringify(rule.property)}`);
    } else if (!allowed.has(rule.property)) {
      const honoured = RULE_PROPERTIES_BY_NODE[kind] ?? RULE_PROPERTIES_BY_NODE.field;
      warnings.push(`${rp}.property "${rule.property}" is not honoured on a ${kind} node (supports: ${honoured.join(', ')})`);
    }
    if (rule.logic === undefined) {
      errors.push(`${rp}.logic is required (a json-logic expression object, or a bare boolean)`);
    } else if (typeof rule.logic !== 'boolean' && (typeof rule.logic !== 'object' || Array.isArray(rule.logic))) {
      errors.push(`${rp}.logic must be a json-logic object or a boolean`);
    }
    if (rule.description !== undefined && typeof rule.description !== 'string') {
      errors.push(`${rp}.description must be a string`);
    }
  });
}

// Resolve a dotted path against a schema-like object's `properties` (and nested
// `properties`), used to find the schema field an `array-field` node binds to.
function getSchemaFieldAtPath(schemaContext, path) {
  if (!schemaContext || typeof schemaContext !== 'object' || !schemaContext.properties) return undefined;
  const parts = path.split('.');
  let node = schemaContext.properties[parts[0]];
  for (let i = 1; i < parts.length && node; i++) {
    node = node.properties ? node.properties[parts[i]] : undefined;
  }
  return node;
}

function validateTableNode(node, known, errors, warnings) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push('views.table must be a table node object');
    return;
  }
  if (node.type !== undefined && node.type !== 'table') {
    errors.push(`views.table.type must be "table"; got ${JSON.stringify(node.type)}`);
  }
  if (!Array.isArray(node.columns)) {
    errors.push('views.table.columns must be an array of { field, order }');
    return;
  }
  node.columns.forEach((col, i) => {
    if (!col || typeof col !== 'object') {
      errors.push(`views.table.columns[${i}] must be an object { field, order }`);
      return;
    }
    if (typeof col.field !== 'string' || col.field === '') {
      errors.push(`views.table.columns[${i}].field must be a non-empty field name`);
    } else if (known.size && !fieldKnown(col.field, known)) {
      warnings.push(`views.table.columns[${i}] references "${col.field}" which is not defined in schema.properties`);
    }
    if (col.order !== undefined && typeof col.order !== 'number') {
      errors.push(`views.table.columns[${i}].order must be a number`);
    }
  });
}

// Collect dotted paths of every field defined in the schema, so view nodes can
// be checked for dangling references.
function collectFieldPaths(schema) {
  const paths = new Set();
  if (!schema || typeof schema !== 'object' || !schema.properties) return paths;
  const walk = (props, prefix) => {
    for (const [name, field] of Object.entries(props)) {
      const full = prefix ? `${prefix}.${name}` : name;
      paths.add(full);
      if (field && typeof field === 'object' && field.properties) {
        walk(field.properties, full);
      }
    }
  };
  walk(schema.properties, '');
  return paths;
}

function fieldKnown(field, known) {
  if (known.has(field)) return true;
  // Accept a parent path being known (e.g. "address" when "address.city" exists).
  for (const p of known) {
    if (p.startsWith(`${field}.`)) return true;
  }
  return false;
}

// Public entrypoint (mirrors quiva-flows-mcp validate()).
export function validate(config, opts) {
  return validateRecordConfig(config, opts);
}
