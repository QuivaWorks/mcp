// Hand-rolled test runner for the records config validator (no framework).
// Run: npm test  (or: node test/validate.test.js)
import assert from 'node:assert/strict';
import { readHarvested } from '../src/examples.js';
import { validate } from '../src/validate.js';
import { getReference, GOTCHAS, ELEMENT_CATALOG, ELEMENT_KINDS, ELEMENT_CONTAINERS } from '../src/records-docs.js';
import { config as riskProgramme } from './fixtures/risk-programme.mjs';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

const goodSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    email: { type: 'string', ui: { inputType: 'text', props: { label: 'Email' } } },
    address: {
      type: 'object',
      properties: { city: { type: 'string', ui: { inputType: 'text', props: { label: 'City' } } } },
    },
  },
  required: ['email'],
};

check('valid minimal config passes', () => {
  const r = validate({ id: 'kyc', name: 'KYC', schema: goodSchema });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('missing id fails on create', () => {
  const r = validate({ name: 'KYC', schema: goodSchema });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('id is required')));
});

check('id with spaces/invalid chars fails', () => {
  const r = validate({ id: 'bad id!', name: 'X', schema: goodSchema });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('invalid')));
});

check('missing name fails on create', () => {
  const r = validate({ id: 'kyc', schema: goodSchema });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('name is required')));
});

check('non-object schema type is an error', () => {
  const r = validate({ id: 'kyc', name: 'KYC', schema: { type: 'string' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('schema.type must be "object"')));
});

check('invalid field type is an error', () => {
  const r = validate({
    id: 'kyc', name: 'KYC',
    schema: { type: 'object', properties: { x: { type: 'stringg' } } },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('invalid type')));
});

check('ui without label warns', () => {
  const r = validate({
    id: 'kyc', name: 'KYC',
    schema: { type: 'object', properties: { x: { type: 'string', ui: { inputType: 'text', props: {} } } } },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('label is required')));
});

check('view field node using `ref` instead of `field` is an error', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'field', ref: 'email' }] },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('use `field`')));
});

check('valid views with field + table pass', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      form: {
        type: 'grid', props: { gridTemplateColumns: '1fr 1fr' },
        children: [{ type: 'field', field: 'email' }, { type: 'field', field: 'address.city' }],
      },
      table: { type: 'table', columns: [{ field: 'email', order: 0 }] },
    },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('grid without gridTemplateColumns errors', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: {}, children: [] } },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('gridTemplateColumns')));
});

check('dangling view field reference warns (not error)', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'field', field: 'nope' }] } },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('not defined in schema.properties')));
});

check('update payload without id passes when require_id=false', () => {
  const r = validate({ description: 'new desc' }, { requireId: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('missing schema on create warns but is valid', () => {
  const r = validate({ id: 'kyc', name: 'KYC' });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('no schema')));
});

check('legacy views.form is valid but warns deprecated', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'field', field: 'email' }] } },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('deprecated legacy single form')));
});

check('valid views.forms[] passes with no deprecation warning', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [
        {
          id: 'default', title: 'Default',
          layout: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'field', field: 'email' }] },
        },
      ],
    },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((w) => w.includes('deprecated')));
});

check('views.forms[] missing id/title is an error', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { forms: [{ layout: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [] } }] },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('.id is required')));
  assert.ok(r.errors.some((e) => e.includes('.title is required')));
});

check('duplicate views.forms[].id is an error', () => {
  const layout = { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [] };
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { forms: [{ id: 'default', title: 'A', layout }, { id: 'default', title: 'B', layout }] },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('is duplicated')));
});

const arraySchema = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } } },
    },
  },
};

check('array-field repeater with element-relative refs passes', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: arraySchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{
            type: 'array-field', field: 'products', props: { label: 'Products' },
            children: [{ type: 'field', field: 'title' }, { type: 'field', field: 'price' }],
          }],
        },
      }],
    },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('array-field child using top-level path instead of element-relative warns', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: arraySchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{
            type: 'array-field', field: 'products',
            children: [{ type: 'field', field: 'products.title' }],
          }],
        },
      }],
    },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('not defined in schema.properties')));
});

check('array-field bound to a non-array schema field warns', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{ type: 'array-field', field: 'email', children: [] }],
        },
      }],
    },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('not schema type "array"')));
});

check('node-level inputType + props on a field node pass', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{ type: 'field', field: 'email', inputType: 'text', props: { label: 'Email' } }],
        },
      }],
    },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('unknown inputType on a field node warns', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{ type: 'field', field: 'email', inputType: 'not-a-widget', props: { label: 'Email' } }],
        },
      }],
    },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('not a known InputType')));
});

check('inputType on a grid (container) node warns', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: { type: 'grid', props: { gridTemplateColumns: '1fr' }, inputType: 'text', children: [] },
      }],
    },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('ignored on a grid')));
});

check('a valid required rule on a field node passes', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{
            type: 'field', field: 'email', props: { label: 'Email' },
            rules: [{ id: 'email.required', property: 'required', logic: { '==': [{ var: 'address.city' }, 'London'] }, description: 'x' }],
          }],
        },
      }],
    },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('rule with an invalid property is an error', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{ type: 'field', field: 'email', props: { label: 'Email' }, rules: [{ id: 'email.x', property: 'colour', logic: true }] }],
        },
      }],
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('property must be one of')));
});

check('rule missing logic is an error', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{ type: 'field', field: 'email', props: { label: 'Email' }, rules: [{ id: 'email.visible', property: 'visible' }] }],
        },
      }],
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('logic is required')));
});

check('non-visible rule property on a grid container warns', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          rules: [{ id: 'g.required', property: 'required', logic: true }],
          children: [{ type: 'field', field: 'email', props: { label: 'Email' } }],
        },
      }],
    },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('not honoured on a grid node')));
});

check('rules on an array-field node warn (reserved in v1)', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: arraySchema,
    views: {
      forms: [{
        id: 'default', title: 'Default',
        layout: {
          type: 'grid', props: { gridTemplateColumns: '1fr' },
          children: [{
            type: 'array-field', field: 'products', props: { label: 'Products' },
            rules: [{ id: 'products.visible', property: 'visible', logic: true }],
            children: [{ type: 'field', field: 'title' }],
          }],
        },
      }],
    },
  });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('reserved on array-field')));
});

check('legacy field node with empty-string type is treated as a field', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: '', field: 'email' }] } },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(!r.errors.some((e) => e.includes('unknown view node type')));
});

check('unrecognised view node type is treated as a field (renderer else-branch) and warns', () => {
  // record-view-renderer dispatches grid/table/array-field/element and sends
  // everything else to ViewField, so an unknown type renders as a field rather
  // than failing.
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'widget', field: 'email' }] } },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('falls through to the FIELD renderer')), JSON.stringify(r.warnings));
});

check('type "element" with a field but no element kind no longer falls through — it renders nothing', () => {
  // This changed with the release: view-element derives kind from node.element and
  // its branch chain has NO final else, so a kindless element node renders
  // nothing at all rather than degrading to a field.
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'element', field: 'email' }] } },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('renders NOTHING')), JSON.stringify(r.warnings));
});

check('a node with no usable type at all is still an error', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ props: { label: 'orphan' } }] } },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('no usable view node type')), JSON.stringify(r.errors));
});

check('a table node inside a form layout warns', () => {
  const r = validate({
    id: 'kyc', name: 'KYC', schema: goodSchema,
    views: { form: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'table', columns: [] }] } },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('belong in views.tables')), JSON.stringify(r.warnings));
});

// --- choice inputs need options; props must be real; repeater items need `ui` -
// The renderer never derives a picker's choices from a schema `enum`: InputControl
// gets `{...inputProps}` and `options` defaults to []. And it never reads an
// array-field node's `children` — item inputs come from items.properties.*.ui.
const enumSchema = (extra = {}) => ({
  type: 'object',
  properties: { stage: { type: 'string', title: 'Stage', enum: ['info', 'quote', 'policy'], ...extra } },
});
const formWith = (node, schema) => ({
  id: 'rp', name: 'RP', schema,
  views: { forms: [{ id: 'default', title: 'Default', layout: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [node] } }] },
});

check('dropdown on an enum field with no props.options warns (renders empty)', () => {
  const r = validate(formWith({ type: 'field', field: 'stage', inputType: 'dropdown', props: { label: 'Stage' } }, enumSchema()));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('EMPTY picker')), JSON.stringify(r.warnings));
});

check('dropdown with options seeded from the enum passes clean', () => {
  const r = validate(formWith({
    type: 'field', field: 'stage', inputType: 'dropdown',
    props: { label: 'Stage', options: [{ value: 'info', text: 'Info' }, { value: 'quote', text: 'Quote' }, { value: 'policy', text: 'Policy' }] },
  }, enumSchema()));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('a bare node falling back to schema ui.props.options is NOT warned', () => {
  // Live configs (Client, FACLIENT, goal, …) do exactly this: no node props at
  // all, options on the schema `ui`. `nodeProps ?? field.ui.props` picks up the ui.
  const r = validate(formWith({ type: 'field', field: 'stage' }, enumSchema({
    ui: { inputType: 'dropdown', props: { label: 'Stage', options: [{ value: 'info', text: 'Info' }] } },
  })));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((w) => w.includes('EMPTY picker')), JSON.stringify(r.warnings));
});

check('node props shadowing schema ui.props options warns about the lost options', () => {
  const r = validate(formWith({ type: 'field', field: 'stage', props: { label: 'Stage' } }, enumSchema({
    ui: { inputType: 'dropdown', props: { label: 'Stage', options: [{ value: 'info', text: 'Info' }] } },
  })));
  assert.ok(r.warnings.some((w) => w.includes('SHADOWS')), JSON.stringify(r.warnings));
});

check('options offering a value outside the enum warns', () => {
  const r = validate(formWith({
    type: 'field', field: 'stage', inputType: 'dropdown',
    props: { label: 'Stage', options: [{ value: 'info', text: 'Info' }, { value: 'bound', text: 'Bound' }] },
  }, enumSchema()));
  assert.ok(r.warnings.some((w) => w.includes('does not allow')), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => w.includes('missing enum value')), JSON.stringify(r.warnings));
});

check('an enum field left on the text default warns', () => {
  const r = validate(formWith({ type: 'field', field: 'stage', inputType: 'text', props: { label: 'Stage' } }, enumSchema()));
  assert.ok(r.warnings.some((w) => w.includes('free-typed')), JSON.stringify(r.warnings));
});

check('a prop the input type does not accept warns (fabricated currencyField)', () => {
  const r = validate(formWith(
    { type: 'field', field: 'premium', inputType: 'currency', props: { label: 'Premium', currencyField: 'currency' } },
    { type: 'object', properties: { premium: { type: 'number', title: 'Premium' } } }
  ));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('currencyField') && w.includes('does not accept')), JSON.stringify(r.warnings));
});

check('valid currency props (decimalPlace, min) pass clean', () => {
  const r = validate(formWith(
    { type: 'field', field: 'premium', inputType: 'currency', props: { label: 'Premium', decimalPlace: 2, min: 0 } },
    { type: 'object', properties: { premium: { type: 'number', title: 'Premium' } } }
  ));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

const repeaterSchema = (ui = {}) => ({
  type: 'object',
  properties: {
    limits: {
      type: 'array', title: 'Limits',
      items: {
        type: 'object',
        properties: {
          amount: { type: 'number', title: 'Amount', ...(ui.amount ? { ui: ui.amount } : {}) },
          basis: { type: 'string', title: 'Basis', enum: ['aggregate', 'each claim'], ...(ui.basis ? { ui: ui.basis } : {}) },
        },
      },
    },
  },
});
const repeaterNode = {
  type: 'array-field', field: 'limits', props: { label: 'Limits', itemLabel: 'Limit' },
  children: [
    { type: 'field', field: 'amount', inputType: 'currency', props: { label: 'Amount', decimalPlace: 2 } },
    { type: 'field', field: 'basis', inputType: 'dropdown', props: { label: 'Basis' } },
  ],
};

check('array-field child input config with no schema ui mirror warns', () => {
  const r = validate(formWith(repeaterNode, repeaterSchema()));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('ignores array-field children') && w.includes('amount')), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => w.includes('free-typed') && w.includes('basis')), JSON.stringify(r.warnings));
});

check('array-field with the items.properties.*.ui mirror in place passes clean', () => {
  const r = validate(formWith(repeaterNode, repeaterSchema({
    amount: { inputType: 'currency', props: { label: 'Amount', decimalPlace: 2 } },
    basis: { inputType: 'dropdown', props: { label: 'Basis', options: [{ value: 'aggregate', text: 'Aggregate' }, { value: 'each claim', text: 'Each claim' }] } },
  })));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('a repeater enum leaf whose ui dropdown has no options warns', () => {
  const r = validate(formWith(repeaterNode, repeaterSchema({
    amount: { inputType: 'currency', props: { label: 'Amount' } },
    basis: { inputType: 'dropdown', props: { label: 'Basis' } },
  })));
  assert.ok(r.warnings.some((w) => w.includes('EMPTY picker')), JSON.stringify(r.warnings));
});

check('an array-field container prop that is not accepted warns', () => {
  const r = validate(formWith({ ...repeaterNode, props: { label: 'Limits', gridTemplateColumns: '1fr' } }, repeaterSchema({
    amount: { inputType: 'currency', props: { label: 'Amount' } },
    basis: { inputType: 'dropdown', props: { label: 'Basis', options: [{ value: 'aggregate', text: 'Aggregate' }, { value: 'each claim', text: 'Each' }] } },
  })));
  assert.ok(r.warnings.some((w) => w.includes('gridTemplateColumns') && w.includes('array-field container')), JSON.stringify(r.warnings));
});

check('the risk-programme fixture validates clean (0 errors, 0 warnings)', () => {
  // The fixture is the source of truth for the live `risk_programme` config, so
  // a regression in it fails here rather than on the platform.
  const r = validate(riskProgramme);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('every risk-programme choice input carries options matching its enum', () => {
  const CHOICE = new Set(['dropdown', 'multi-select', 'multi-toggle', 'statuses']);
  const nodes = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.type === 'field') nodes.push(n);
    Object.values(n).forEach(walk);
  };
  walk(riskProgramme.views);
  const choices = nodes.filter((n) => CHOICE.has(n.inputType));
  assert.ok(choices.length >= 8, `expected the programme's enum inputs, found ${choices.length}`);
  for (const n of choices) {
    assert.ok(Array.isArray(n.props?.options) && n.props.options.length, `${n.field} has no props.options`);
  }
  // And every repeater item leaf carries the `ui` mirror the renderer reads.
  for (const [name, prop] of Object.entries(riskProgramme.schema.properties)) {
    if (prop.type !== 'array' || !prop.items?.properties) continue;
    for (const [leaf, lp] of Object.entries(prop.items.properties)) {
      assert.ok(lp.ui?.inputType, `${name}[].${leaf} has no ui.inputType mirror`);
      if (Array.isArray(lp.enum)) {
        assert.ok(Array.isArray(lp.ui.props?.options) && lp.ui.props.options.length, `${name}[].${leaf} enum has no ui options`);
      }
    }
  }
});

// --- golden gate ------------------------------------------------------------
// Every config in examples/harvested/ is a REAL record config living on the
// platform. If the validator rejects one, the VALIDATOR is wrong — that is the
// whole point of this gate. Anything not explained by the allowlist below is a
// bug by definition. (See docs/lessons.md: the flows MCP shipped a wrong rules
// syntax for two weeks because no check like this existed.)

const ALLOWED_GOLDEN_FAILURES = [
  // Populate as real divergences are found, each with a reason. An empty list
  // means every live config validates cleanly.
];

const harvested = readHarvested();

check('golden: examples/harvested/ is populated (run tools/harvest-examples.mjs)', () => {
  assert.ok(harvested.length > 0, 'no harvested configs — the golden gate cannot run');
});

for (const example of harvested) {
  check(`golden: validator accepts real config "${example.slug}"`, () => {
    const result = validate(example.config);
    const unexplained = (result.errors ?? []).filter(
      (e) => !ALLOWED_GOLDEN_FAILURES.some(({ match }) => match.test(e))
    );
    assert.deepEqual(
      unexplained,
      [],
      `live on ${example.source?.environment} as config "${example.slug}", so any error the allowlist does not explain is a validator bug:\n      ${unexplained.join('\n      ')}`
    );
  });
}

check('golden: at least one harvested config has a real form UI to learn from', () => {
  const withForms = harvested.filter((e) => (e.config?.views?.forms ?? []).length > 0);
  assert.ok(withForms.length > 0, 'no harvested config has views.forms — form guidance has no evidence behind it');
});

check('golden: featured form examples carry node-level inputType (not schema ui)', () => {
  const featured = harvested.filter((e) => e.featured);
  assert.ok(featured.length > 0, 'no featured examples');
  for (const example of featured) {
    const nodes = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      nodes.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    for (const form of example.config.views.forms) walk(form.layout);
    const fields = nodes.filter((n) => n.type === 'field');
    assert.ok(fields.length > 0, `${example.slug}: no field nodes`);
    assert.ok(
      fields.some((f) => f.inputType),
      `${example.slug}: no field node carries inputType — the documented node-level contract has no live evidence`
    );
    // The frontend strips schema.*.ui on save; confirm real configs reflect that.
    const uiOnSchema = Object.values(example.config.schema?.properties ?? {}).filter((p) => p?.ui);
    assert.equal(
      uiOnSchema.length,
      0,
      `${example.slug}: schema properties carry "ui" — contradicts the documented "stripped on save" behaviour`
    );
  }
});

// --- element nodes ------------------------------------------------------------
// These RENDER now (record-view-renderer gained an `element` branch). This
// validator previously warned that they never render and dropped their children —
// true then, wrong now. These checks lock in the replacement behaviour.

const withForm = (layout) => ({
  id: 'kyc',
  name: 'KYC',
  schema: goodSchema,
  views: { forms: [{ id: 'default', title: 'Default', layout }] },
});
const row = (...children) => ({ type: 'grid', props: { gridTemplateColumns: '1fr' }, children });
const rootWith = (...cells) => row(...cells);

check('a heading element passes cleanly', () => {
  const r = validate(withForm(rootWith({ type: 'element', element: 'text-heading', props: { text: 'Onboarding', size: 'large' } })));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

check('an unknown element kind is an error (view-element has no fallback branch)', () => {
  const r = validate(withForm(rootWith({ type: 'element', element: 'banner', props: {} })));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('not a known element kind')), JSON.stringify(r.errors));
});

check('an element with no kind at all is an error', () => {
  const r = validate(withForm(rootWith({ type: 'element', props: { text: 'x' } })));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('no `element` kind')), JSON.stringify(r.errors));
});

check('a card without children is an error (containers need grid rows)', () => {
  const r = validate(withForm(rootWith({ type: 'element', element: 'card', props: {} })));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('children must be an array of GRID nodes')), JSON.stringify(r.errors));
});

check('a field placed directly inside a card warns — a container\'s children must be rows', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'card', props: {},
    children: [{ type: 'field', field: 'email', props: { label: 'Email' } }],
  })));
  assert.ok(r.warnings.some((w) => w.includes("container's children must be GRID rows")), JSON.stringify(r.warnings));
});

check('a properly-rowed card passes cleanly', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'card', props: { accent: 'primary', border: 'all', borderRadius: 'all', highlight: true },
    children: [row({ type: 'field', field: 'email', props: { label: 'Email' } })],
  })));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

check('children on a LEAF element warn that they are dropped', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'text-heading', props: { text: 'x' }, children: [row()],
  })));
  assert.ok(r.warnings.some((w) => w.includes('only the container elements')), JSON.stringify(r.warnings));
});

check('nesting a card inside a card warns', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'card', props: {},
    children: [{ type: 'element', element: 'card', props: {}, children: [row()] }],
  })));
  assert.ok(r.warnings.some((w) => w.includes('Containers are not designed to nest')), JSON.stringify(r.warnings));
});

// The three renderer-vs-builder divergences. Each of these is the whole reason the
// catalog cannot be trusted on its own.
check('textAlign on a text-note warns and names `align` — the renderer never reads textAlign there', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'text-note', props: { markdown: 'note', textAlign: 'left' },
  })));
  assert.ok(
    r.warnings.some((w) => w.includes('use `align` on a text-note')),
    'the builder writes textAlign here and the renderer ignores it — the fix must be named'
  );
});

check('align on a text-note is accepted', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'text-note', props: { markdown: 'note', align: 'left', size: 'small' },
  })));
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

check('a visible rule on a card is accepted (runtime honours it even though the catalog omits it)', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'card', props: {},
    children: [row({ type: 'field', field: 'email', props: { label: 'Email' } })],
    rules: [{ id: 'card.visible', property: 'visible', logic: { '!': [{ var: 'email' }] }, description: 'Hidden once an email is present.' }],
  })));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

check('a rule property the element does not honour warns', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'text-heading', props: { text: 'x' },
    rules: [{ id: 'h.required', property: 'required', logic: true, description: 'x' }],
  })));
  assert.ok(r.warnings.some((w) => w.includes('is not honoured by a text-heading')), JSON.stringify(r.warnings));
});

check('a text rule on a text-note is flagged as driving markdown (ruleTargets)', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'text-note', props: { markdown: 'note' },
    rules: [{ id: 'text-note.text', property: 'text', logic: 'computed', description: 'Replaces the note text.' }],
  })));
  assert.ok(r.warnings.some((w) => w.includes('overrides props.markdown')), JSON.stringify(r.warnings));
});

check('an empty logic object warns that the rule is silently ignored', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'alert', props: { title: 'x' },
    rules: [{ id: 'alert.visible', property: 'visible', logic: {}, description: 'x' }],
  })));
  assert.ok(r.warnings.some((w) => w.includes('empty object')), JSON.stringify(r.warnings));
});

check('an element with empty content warns that it renders blank', () => {
  const r = validate(withForm(rootWith({ type: 'element', element: 'text-heading', props: { size: 'large' } })));
  assert.ok(r.warnings.some((w) => w.includes('renders as blank space')), JSON.stringify(r.warnings));
});

check('a text-link with no href warns', () => {
  const r = validate(withForm(rootWith({ type: 'element', element: 'text-link', props: { text: 'Terms' } })));
  assert.ok(r.warnings.some((w) => w.includes('href is empty')), JSON.stringify(r.warnings));
});

check('helpText as a bare string warns (it must be { markdown })', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'text-heading', props: { text: 'x', helpText: 'guidance' },
  })));
  assert.ok(r.warnings.some((w) => w.includes('helpText must be an object')), JSON.stringify(r.warnings));
});

check('a bad enum token warns without erroring', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'alert', props: { title: 'x', severity: 'critical' },
  })));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('is not one of info, success, warning, error, none')), JSON.stringify(r.warnings));
});

check('a schema `field` on an element warns that it is ignored', () => {
  const r = validate(withForm(rootWith({
    type: 'element', element: 'text-heading', field: 'email', props: { text: 'x' },
  })));
  assert.ok(r.warnings.some((w) => w.includes('ignored on an element node')), JSON.stringify(r.warnings));
});

check('the element catalog and the validator cannot drift apart', () => {
  // Both read ELEMENT_CATALOG, so this asserts the catalog itself stays coherent:
  // every kind declares its container-ness, props and rule properties.
  for (const kind of ELEMENT_KINDS) {
    const def = ELEMENT_CATALOG[kind];
    assert.ok(def, `${kind} is listed in ELEMENT_KINDS but missing from ELEMENT_CATALOG`);
    assert.ok(Array.isArray(def.props) && def.props.length, `${kind} has no props`);
    assert.ok(Array.isArray(def.rule_properties) && def.rule_properties.length, `${kind} has no rule properties`);
    assert.equal(def.container, ELEMENT_CONTAINERS.includes(kind), `${kind} container flag disagrees with ELEMENT_CONTAINERS`);
    assert.ok(
      def.rule_properties.includes('visible'),
      `${kind} must allow a visible rule — every branch in view-element is guarded by ruleState.visible`
    );
  }
  // The divergences are the load-bearing part of the reference; losing them is how
  // the next author ends up trusting the builder catalog.
  const ref = getReference('form-elements');
  assert.ok(!ref.error, `form-elements topic missing: ${ref.error}`);
  assert.ok(ref.divergences?.['text-note alignment'], 'the align/textAlign divergence must stay documented');
  assert.ok(ref.divergences?.['card visible rules'], 'the card visible-rule divergence must stay documented');
  assert.ok(ref.divergences?.['repeater visible rules'], 'the inert repeater visible rule must stay documented');
});

check('golden: the one live element node in the corpus validates without errors', () => {
  // sc8DhU6CEXh4gkJPnS_Le carries the only `element` node on staging — an
  // element: "card" with proper grid-row children. It did NOT render before this
  // release, and does now. If the validator rejects it, the validator is wrong.
  const configs = readHarvested();
  const found = [];
  const walk = (n, path, slug) => {
    if (Array.isArray(n)) return n.forEach((c, i) => walk(c, `${path}[${i}]`, slug));
    if (!n || typeof n !== 'object') return;
    if (n.type === 'element') found.push({ slug, path, node: n });
    for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`, slug);
  };
  for (const c of configs) walk(c.config?.views ?? {}, 'views', c.slug);

  assert.ok(
    found.length > 0,
    'no element node anywhere in examples/harvested — the element support in this validator has no live evidence behind it. Re-run tools/harvest-examples.mjs.'
  );
  for (const { slug, path, node } of found) {
    assert.ok(
      typeof node.element === 'string' && ELEMENT_KINDS.includes(node.element),
      `${slug} ${path} has element ${JSON.stringify(node.element)}, which is not in ELEMENT_KINDS — the catalog is missing a kind that exists live`
    );
  }
  for (const c of configs) {
    const hasElement = found.some((f) => f.slug === c.slug);
    if (!hasElement) continue;
    const r = validate(c.config, { requireId: true });
    assert.deepEqual(r.errors, [], `validator rejected live config "${c.slug}":\n  ${r.errors.join('\n  ')}`);
  }
});

// --- records-service #1287: validate / completed / test_flow ------------------
// These are request-only write flags, so the config validator has nothing to
// check — but they change what a write DOES, and both have a silent failure mode.
// These checks exist so the reference cannot quietly lose the explanation.

check('the flow-triggers topic explains that record events are opt-in', () => {
  const ref = getReference('flow-triggers');
  assert.ok(!ref.error, `topic missing: ${ref.error}`);
  assert.ok(
    /opt-in/i.test(ref.summary),
    'the single most surprising thing is that a plain create fires nothing — it must be in the summary'
  );
  assert.ok(
    /draft/i.test(ref.published_only ?? ''),
    'a record trigger never matches a draft flow; that silent failure must be documented'
  );
  assert.ok(
    ref.the_node_id_trap?.includes('record.<config_id>'),
    'the trigger node id rule is what makes or breaks the whole feature'
  );
  assert.ok(
    ref.completed?.on_create && ref.completed?.on_update,
    '`completed` is stored on update but not on create — both halves must be stated'
  );
  assert.ok(
    ref.test_flow?.both_required?.includes('run_id'),
    'a half-filled test_flow silently behaves like `completed`; that must be documented'
  );
});

check('the validation-bypass topic states what validate:false actually skips', () => {
  const ref = getReference('validation-bypass');
  assert.ok(!ref.error, `topic missing: ${ref.error}`);
  assert.ok(/verified live/i.test(ref.summary), 'the claim must be backed by the live probe, not the source alone');
  assert.ok(Array.isArray(ref.consequences) && ref.consequences.length > 0);
  assert.ok(
    ref.not_stored?.includes('test_flow'),
    'the create response echoes the request struct (validate + test_flow: null) rather than the stored record — easy to mistake for state'
  );
});

check('both write flags appear in the gotchas an agent sees first', () => {
  const joined = GOTCHAS.join('\n');
  assert.ok(joined.includes('validate: false'), 'validate:false is a data-integrity footgun and belongs in GOTCHAS');
  assert.ok(joined.includes('hub.trigger.record'), 'the record trigger subject belongs in GOTCHAS');
});


// --- every src module parses -------------------------------------------------
// A syntax error in src/index.js used to be INVISIBLE to this suite: nothing here
// imports the entry point (it would start the server on stdio), so the tests all
// passed while the MCP could not boot. That happened on 2026-08-04 — a stray
// backtick inside the INSTRUCTIONS template literal in quiva-workspaces-mcp/src/
// index.js broke the server, `npm test` still reported 356/356, and the failure
// only surfaced as a "client timeout initialize" in an unrelated build script.
// node --check parses without executing, so it is safe for index.js too.
check('every file in src/ is syntactically valid', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'no src files found — is this test in the right place?');
  for (const f of files) {
    const path = fileURLToPath(new URL(f, srcDir));
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`${f} does not parse:\n${String(err.stderr || err.message).trim()}`);
    }
  }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
