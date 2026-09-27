// Hand-rolled test runner for the records config validator (no framework).
// Run: npm test  (or: node test/validate.test.js)
import assert from 'node:assert/strict';
import { readHarvested } from '../src/examples.js';
import { validate } from '../src/validate.js';
import { getReference, GOTCHAS, ELEMENT_CATALOG, ELEMENT_KINDS, ELEMENT_CONTAINERS } from '../src/records-docs.js';
import { config as riskProgramme } from './fixtures/risk-programme.mjs';
import { readdirSync, readFileSync } from 'node:fs';
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

check('an array-field visible rule is accepted silently; other properties warn (record-view-renderer)', () => {
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
  assert.ok(!r.warnings.some((w) => w.includes('array-field (repeater)')), JSON.stringify(r.warnings));
  const req = validate({
    id: 'kyc', name: 'KYC', schema: arraySchema,
    views: { forms: [{ id: 'default', title: 'Default', layout: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{
      type: 'array-field', field: 'products', props: { label: 'Products' },
      rules: [{ id: 'products.required', property: 'required', logic: true }],
      children: [{ type: 'field', field: 'title' }],
    }] } }] },
  });
  assert.ok(req.warnings.some((w) => w.includes('is not applied on an array-field')), JSON.stringify(req.warnings));
});

check('multi-property set/otherwise rules need no property (records.types.ts ElementRule)', () => {
  const withRule = (rule) => validate({
    id: 'r', name: 'R', schema: { type: 'object', properties: { title: { type: 'string' } } },
    views: { forms: [{ id: 'default', title: 'Default', layout: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [
      { type: 'field', field: 'title', props: { label: 'Title' }, rules: [rule] },
    ] } }] },
  });
  const ok = withRule({ id: 'title.lock', logic: { '==': [{ var: 'title' }, 'x'] }, set: { disabled: true }, otherwise: { disabled: false } });
  assert.deepEqual(ok.errors, []);
  const bad = withRule({ id: 'title.lock', logic: true, set: { colour: 'red' } });
  assert.ok(bad.errors.some((e) => e.includes('set/otherwise must be one of')), JSON.stringify(bad.errors));
  const none = withRule({ id: 'title.x', logic: true });
  assert.ok(none.errors.some((e) => e.includes('.property must be one of')), JSON.stringify(none.errors));
});

check('email is a builder input type for strings (records.utils.ts inputOptionsForType)', () => {
  const r = validate({
    id: 'r', name: 'R', schema: { type: 'object', properties: { contact: { type: 'string' } } },
    views: { forms: [{ id: 'default', title: 'Default', layout: { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [
      { type: 'field', field: 'contact', inputType: 'email', props: { label: 'Contact' } },
    ] } }] },
  });
  assert.ok(!r.warnings.some((w) => w.includes('not a known InputType')), JSON.stringify(r.warnings));
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
    'create and update publish different events — both halves must be stated'
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


// --- index_fields, table views, flow, source (records-service 2026-09) ----------
// Each rule mirrors a server-side refusal; the cited file is the source.

const base = { id: 'tasks', name: 'Tasks', schema: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string' }, budget: { type: 'number' }, due_date: { type: 'string' } } } };
const withViews = (views, extra = {}) => validate({ ...base, ...extra, views });
const hasError = (r, re) => r.errors.some((e) => re.test(e));
const hasWarning = (r, re) => r.warnings.some((w) => re.test(w));

check('index_fields: every engine type and alias is accepted (payload-fields.go indexFieldTypes)', () => {
  const types = ['', 'keyword', 'text', 'text_sortable', 'number', 'numeric', 'date', 'datetime'];
  const r = validate({ ...base, index_fields: types.map((type, i) => ({ field: `f${i}`, type })) });
  assert.deepEqual(r.errors, []);
});

check('index_fields: "key" is accepted as a synonym for "field"', () => {
  assert.equal(validate({ ...base, index_fields: [{ key: 'status' }] }).valid, true);
});

check('index_fields: unknown type, bad segment, missing field and dot/underscore collision are errors', () => {
  assert.ok(hasError(validate({ ...base, index_fields: [{ field: 'x', type: 'integer' }] }), /unknown type "integer"/));
  assert.ok(hasError(validate({ ...base, index_fields: [{ field: 'a-b' }] }), /not a usable path/));
  assert.ok(hasError(validate({ ...base, index_fields: [{ field: 'a.b' }, { field: 'a_b' }] }), /both index as/));
  assert.ok(hasError(validate({ ...base, index_fields: [{ type: 'text' }] }), /field is required/));
});

check('views.tables: id, title and uniqueness are enforced (config.go validateTableViews)', () => {
  const cols = [{ field: 'title', order: 0 }];
  assert.ok(hasError(withViews({ tables: [{ id: 'bad id', title: 'X', columns: cols }] }), /id must contain only/));
  assert.ok(hasError(withViews({ tables: [{ id: 'a', columns: cols }] }), /title is required/));
  assert.ok(hasError(withViews({ tables: [{ id: 'a', title: 'A', columns: cols }, { id: 'a', title: 'B', columns: cols }] }), /duplicate view id/));
  assert.ok(hasError(withViews({ tables: { id: 'a' } }), /must be an array/));
});

check('views.tables: a well-formed saved view with a nested OR filter validates cleanly', () => {
  const r = withViews(
    {
      tables: [
        {
          id: 'open_urgent',
          title: 'Open, urgent',
          columns: [{ field: 'title', order: 0, sortable: true }, { field: 'status', order: 1, filterable: false }],
          filter: [{ field: 'status', keyword: 'open' }, { operator: 'OR', conditions: [{ field: 'budget', min: 1, max: 5000 }, { field: 'created_at', date_start: '2026-01-01' }] }],
          sort: '-due_date',
        },
      ],
    },
    { index_fields: [{ field: 'status' }, { field: 'budget', type: 'number' }, { field: 'due_date', type: 'date' }] }
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.filter((w) => /index_fields|sort/.test(w)), []);
});

check('table filter: the query path\'s refusals are errors (record_query.go checkFilterLeaf)', () => {
  const t = (filter) => withViews({ table: { type: 'table', columns: [{ field: 'title', order: 0 }], filter } });
  assert.ok(hasError(t([{ field: 'budget', min: 0, max: 10 }]), /min or max of 0/));
  assert.ok(hasError(t([{ field: 'budget', min: 100 }]), /min with no max/));
  assert.ok(hasError(t([{ field: 'budget' }]), /needs one of keyword/));
  assert.ok(hasError(t([{ field: 'budget', exact: 3, max: 9 }]), /exact cannot be combined/));
  assert.ok(hasError(t([{ field: 'due_date', date_start: '2026-01-01', min: 1, max: 2 }]), /date window and a numeric range/));
  assert.ok(hasError(t([{ operator: 'NOT', conditions: [{ field: 'status', keyword: 'x' }] }]), /AND or OR/));
  assert.ok(hasError(t([{ field: 'status', keyword: 'x', conditions: [{ field: 'status', keyword: 'y' }] }]), /never both/));
  assert.ok(hasError(t([{ field: 'bad-name', keyword: 'x' }]), /not a usable field name/));
  const deep = [{ conditions: [{ conditions: [{ conditions: [{ conditions: [{ field: 'status', keyword: 'x' }] }] }] }] }];
  assert.ok(hasError(t(deep), /nested more than 4/));
  const many = Array.from({ length: 51 }, () => ({ field: 'status', keyword: 'x' }));
  assert.ok(hasError(t(many), /more than 50 conditions/));
});

check('table sort and columns: bad names are errors, undeclared or unsortable fields warn', () => {
  assert.ok(hasError(withViews({ table: { columns: [{ field: 'a b', order: 0 }] } }), /not a usable field name/));
  assert.ok(hasError(withViews({ table: { columns: [], sort: '--x' } }), /sort/));
  assert.ok(hasError(withViews({ table: { columns: [{ field: 'title', order: 0, sortable: 'yes' }] } }), /sortable must be a boolean/));
  const idx = { index_fields: [{ field: 'status' }] };
  assert.ok(hasWarning(withViews({ table: { columns: [], filter: [{ field: 'title', keyword: 'x' }] } }, idx), /not declared in index_fields/));
  assert.ok(hasWarning(withViews({ table: { columns: [], sort: 'status' } }, idx), /cannot be sorted on/));
  assert.ok(!hasWarning(withViews({ table: { columns: [], sort: '-created_at' } }, idx), /index_fields|sorted/), 'record fields need no declaration');
});

check('views.table with type "" validates (the seeded contact config stores it)', () => {
  assert.equal(withViews({ table: { type: '', columns: [{ field: 'title', order: 0 }] } }).valid, true);
});

check('views: an unknown view key warns that the service drops it', () => {
  assert.ok(hasWarning(withViews({ tableViews: [] }), /drops silently/));
});

const flowForm = {
  id: 'default',
  title: 'Default',
  layout: {
    type: 'grid',
    props: { gridTemplateColumns: '1fr' },
    children: [
      { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'field', field: 'title' }] },
      { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'element', element: 'text-heading', props: { text: 'Money' } }] },
      { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'field', field: 'budget' }] },
      { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'field', field: 'due_date' }] },
    ],
  },
};
const flowOf = (sections, extra = {}) => withViews({ forms: [flowForm], flow: { id: 'wiz', title: 'Wizard', form: 'default', sections, ...extra } });

check('views.flow: a well-formed wizard validates (validate.go ValidateFlowSections)', () => {
  const r = flowOf([{ title: 'Basics' }, { title: 'Money', start_field: 'budget', say: 'Now the budget.' }, { title: 'Dates', start_field: 'due_date' }]);
  assert.deepEqual(r.errors, []);
});

check('views.flow: required keys and section anchors are enforced', () => {
  assert.ok(hasError(withViews({ forms: [flowForm], flow: { title: 'x', form: 'default', sections: [{ title: 'a' }] } }), /flow\.id is required/));
  assert.ok(hasError(flowOf([]), /at least one section/));
  assert.ok(hasError(flowOf([{ title: 'a', start_field: 'title' }]), /sections\[0\]\.start_field must be empty/));
  assert.ok(hasError(flowOf([{ title: 'a' }, { title: 'b' }]), /start_field is required/));
  assert.ok(hasError(flowOf([{ title: 'a' }, { title: 'b', start_field: 'nope' }]), /not a bound field/));
  assert.ok(hasError(flowOf([{ title: 'a' }, { title: 'b', start_field: 'due_date' }, { title: 'c', start_field: 'budget' }]), /does not come after/));
  assert.ok(hasError(flowOf([{ title: 'a' }, { title: 'b', start_field: 'budget' }, { title: 'c', start_field: 'budget' }]), /already used/));
  assert.ok(hasError(flowOf([{ title: 'a' }], { form: 'other' }), /does not match any views\.forms/));
});

check('views.flow: a heading row attaches downward, so it can empty section 0', () => {
  const form = structuredClone(flowForm);
  form.layout.children.splice(0, 1, { type: 'grid', props: { gridTemplateColumns: '1fr' }, children: [{ type: 'element', element: 'text-heading', props: { text: 'Intro' } }] });
  const r = withViews({ forms: [form], flow: { id: 'w', title: 'W', form: 'default', sections: [{ title: 'a' }, { title: 'b', start_field: 'budget' }] } });
  assert.ok(hasError(r, /leaving section 0 empty/), r.errors.join('; '));
});

check('views.flow: a required property no section binds is an error', () => {
  const r = validate({ ...base, schema: { ...base.schema, required: ['status'] }, views: { forms: [flowForm], flow: { id: 'w', title: 'W', form: 'default', sections: [{ title: 'a' }] } } });
  assert.ok(hasError(r, /required schema property "status"/));
});

check('views.flow: camelCase startField warns, and a flow without forms in the payload warns', () => {
  assert.ok(hasWarning(flowOf([{ title: 'a' }, { title: 'b', startField: 'budget', start_field: 'budget' }]), /use start_field/));
  assert.ok(hasWarning(withViews({ flow: { id: 'w', title: 'W', form: 'default', sections: [{ title: 'a' }] } }), /cannot be checked against its form/));
});

check('source: ids must be subject-safe, and local definition fields warn they are shadowed', () => {
  assert.ok(hasError(validate({ id: 'q', name: 'Q', source: { publisher_account_id: 'a.b', config_id: 'c' } }), /publisher_account_id/));
  const r = validate({ id: 'q', name: 'Q', schema: base.schema, source: { publisher_account_id: 'pub', config_id: 'quote' } });
  assert.deepEqual(r.errors, []);
  assert.ok(hasWarning(r, /reference/));
});

check('update-only unset flags: unknown view key and unset_source without schema are errors', () => {
  assert.ok(hasError(validate({ id: 'q', unset_views: ['tableViews'] }, { requireId: false }), /unknown view key/));
  assert.ok(hasError(validate({ id: 'q', unset_source: true }, { requireId: false }), /needs a schema/));
  assert.equal(validate({ id: 'q', unset_views: ['flow', 'tables'] }, { requireId: false }).valid, true);
  assert.equal(validate({ id: 'q', unset_source: true, schema: base.schema }, { requireId: false }).valid, true);
});

check('reference topics exist for every new surface; stale claims stay gone', () => {
  for (const topic of ['table-views', 'flow', 'index-fields', 'config-source', 'bulk-operations', 'endpoints']) {
    assert.ok(!getReference(topic).error, `topic missing: ${topic}`);
  }
  const types = JSON.stringify(getReference('index-fields').types);
  assert.ok(/number/.test(types) && /date/.test(types), 'index_fields docs must cover number and date');
  assert.ok(!/OPAQUE/i.test(JSON.stringify(getReference('views'))), 'views.tables is typed now');
  assert.ok(/deleted/.test(getReference('endpoints').dead_or_unsupported.join(' ')), 'the dead get.records route must be named');
  assert.ok(!/API key alone is rejected/.test(GOTCHAS.join(' ')), 'query-records accepts an API key (the gateway swaps it for a JWT)');
});

// --- tool handlers, against a fake client -------------------------------------

const { registerTools } = await import('../src/index.js');
function harness(routes) {
  const handlers = {};
  const calls = [];
  const server = { registerTool: (name, _meta, fn) => { handlers[name] = fn; } };
  const reply = (method) => async (path, a, b) => {
    const hasBody = method === 'POST' || method === 'PUT';
    const query = hasBody ? b : a;
    calls.push({ method, path, query, body: hasBody ? a : undefined });
    const out = routes(method, path, query ?? {});
    if (out instanceof Error) throw out;
    return out;
  };
  registerTools(server, { get: reply('GET'), post: reply('POST'), put: reply('PUT'), delete: reply('DELETE') });
  const raw = (name, args) => handlers[name](args);
  const run = async (name, args) => {
    const res = await raw(name, args);
    if (res.isError) throw new Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
  };
  return { run, raw, calls };
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

await checkAsync('list_records: a scoped call is one query-records call, never the deleted GET /records/{config_id}', async () => {
  const h = harness(() => ({ results: [{ id: 'r1' }], results_total: 1, total_hits: 1 }));
  await h.run('list_records', { config_id: 'tasks', space_id: 'OPS', fields: ['title', 'status'] });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/records');
  assert.equal(h.calls[0].query.config_id, 'tasks');
  assert.equal(h.calls[0].query.fields, 'title,status');
  assert.equal(h.calls[0].query.limit, 100);
});

await checkAsync('list_records: unscoped fans out over spaces and reports records outside any space', async () => {
  const h = harness((method, path, q) => {
    if (path === '/records/count') return { tasks: 5 };
    if (path === '/workspaces/spaces') return { results: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] };
    if (q.space_id === 'A') return { results: [{ id: '1' }, { id: '2' }], total_hits: 2 };
    if (q.space_id === 'B') return { results: [{ id: '3' }], total_hits: 1 };
    return { results: [], total_hits: 0 };
  });
  const out = await h.run('list_records', { config_id: 'tasks' });
  assert.equal(out.total_hits, 3);
  assert.equal(out.record_count, 5);
  assert.equal(out.complete, false);
  assert.deepEqual(out.hits_by_space, { A: 2, B: 1 });
  assert.equal(out.results.length, 3);
  assert.ok(!h.calls.some((c) => c.path === '/records/tasks'));
});

await checkAsync('list_records: a failing space makes the fan-out incomplete instead of failing it', async () => {
  const h = harness((method, path, q) => {
    if (path === '/records/count') return { tasks: 1 };
    if (path === '/workspaces/spaces') return { results: [{ id: 'A' }, { id: 'B' }] };
    if (q.space_id === 'B') return new Error('boom');
    return { results: [{ id: '1' }], total_hits: 1 };
  });
  const out = await h.run('list_records', { config_id: 'tasks' });
  assert.equal(out.complete, false);
  assert.ok(out.errors_by_space.B);
});

await checkAsync('list_records: complete:false notes that the count may include deleted keys', async () => {
  const h = harness((method, path, q) => {
    if (path === '/records/count') return { tasks: 2 };
    if (path === '/workspaces/spaces') return { results: [{ id: 'A' }] };
    return { results: [{ id: '1' }], total_hits: 1 };
  });
  const out = await h.run('list_records', { config_id: 'tasks' });
  assert.equal(out.complete, false);
  assert.match(out.note, /may include deleted keys/);
});

await checkAsync('delete_record_config: refuses without confirm: true and sends nothing', async () => {
  const h = harness(() => ({ message: 'success' }));
  assert.equal((await h.raw('delete_record_config', { id: 'tasks' })).isError, true);
  assert.equal(h.calls.length, 0);
  await h.run('delete_record_config', { id: 'tasks', confirm: true });
  assert.equal(h.calls[0].method, 'DELETE');
  assert.equal(h.calls[0].path, '/records/config/tasks');
});

await checkAsync('query_records: a min with no max is sent but warned (the query path accepts it)', async () => {
  const h = harness(() => ({ results: [], total_hits: 0 }));
  const out = await h.run('query_records', { space_id: 'OPS', filter: [{ operator: 'OR', conditions: [{ field: 'budget', min: 100 }] }] });
  assert.equal(h.calls.length, 1);
  assert.ok(out.warnings.some((w) => /min with no max/.test(w)));
  const ok = await h.run('query_records', { space_id: 'OPS', filter: [{ field: 'budget', min: 100, max: 200 }] });
  assert.equal(ok.warnings, undefined);
});

await checkAsync('query_records: fields, parent_folder and filter reach the query string', async () => {
  const h = harness(() => ({ results: [], results_total: 0, total_hits: 0 }));
  await h.run('query_records', { space_id: 'OPS', parent_folder: 'org-1', fields: 'title', filter: [{ field: 'status', keyword: 'open' }] });
  const q = h.calls[0].query;
  assert.equal(q.parent_folder, 'org-1');
  assert.equal(q.fields, 'title');
  assert.equal(q.filter, JSON.stringify([{ field: 'status', keyword: 'open' }]));
});

await checkAsync('purge_records: refuses without confirm: true and sends nothing', async () => {
  const h = harness(() => ({ purged: 0 }));
  assert.equal((await h.raw('purge_records', { config_id: 'tasks', confirm: false })).isError, true);
  assert.equal(h.calls.length, 0);
  await h.run('purge_records', { config_id: 'tasks', space_id: 'OPS', confirm: true });
  assert.equal(h.calls[0].method, 'DELETE');
  assert.equal(h.calls[0].path, '/records/tasks/purge');
  assert.equal(h.calls[0].query.space_id, 'OPS');
});

await checkAsync('csv_import and export_records refuse a call with no space or folder', async () => {
  const h = harness(() => ({}));
  assert.equal((await h.raw('csv_import', { config_id: 't', key: 'k.csv' })).isError, true);
  assert.equal((await h.raw('export_records', { config_id: 't' })).isError, true);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.raw('export_records', { config_id: 't', space_id: 'OPS', confirm: true })).isError, true, 'no default recipient');
  assert.equal((await h.raw('export_records', { config_id: 't', space_id: 'OPS', email: 'ops@example.com' })).isError, true, 'confirm required');
  assert.equal(h.calls.length, 0);
  await h.run('export_records', { config_id: 't', space_id: 'OPS', email: 'ops@example.com', confirm: true, filter: [{ field: 'status', keyword: 'x' }] });
  assert.equal(typeof h.calls[0].body.filter, 'string', 'export takes the filter as a JSON string');
});

await checkAsync('update_record forwards revision, replace, parent_folder, hidden_fields, suppress_events', async () => {
  const h = harness(() => ({}));
  await h.run('update_record', { config_id: 't', id: 'r', data: { a: 1 }, revision: 7, replace: true, parent_folder: '', hidden_fields: ['x'], suppress_events: true });
  assert.deepEqual(h.calls[0].body, { data: { a: 1 }, parent_folder: '', replace: true, revision: 7, hidden_fields: ['x'], suppress_events: true });
});

await checkAsync('update_record_config: unset_source without a schema is stopped locally', async () => {
  const h = harness(() => ({}));
  const out = await h.run('update_record_config', { id: 'q', unset_source: true, skip_local_validation: false });
  assert.equal(out.updated, false);
  assert.equal(h.calls.length, 0);
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

check('the index_fields filter comment above filterCondition is at most 3 lines', () => {
  const lines = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('const filterCondition'));
  let n = 0;
  for (let i = at - 1; i >= 0 && lines[i].startsWith('//'); i--) n++;
  assert.ok(n >= 1 && n <= 3, `${n} comment lines`);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
