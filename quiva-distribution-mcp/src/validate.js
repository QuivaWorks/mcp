// Local lint for distribution write payloads. Errors mirror what the engine
// refuses; warnings flag what it accepts but ignores, or what depends on the deploy.
import {
  ID_PATTERN,
  DISTRIBUTOR_BUNDLE_CONFIGS,
  ACCEPTED_ACTION_TYPES,
  RETIRED_ACTION_TYPES,
  MAX_SLA_BUSINESS_DAYS,
  MAX_FRONT_PAGE_LAYOUTS,
  MAX_FRONT_PAGE_LAYOUTS_BYTES,
} from './distribution-docs.js';

export const KINDS = ['product', 'amend'];

const PRODUCT_FIELDS = new Set([
  'code', 'name', 'type', 'active', 'record_configs', 'actions',
  'sla_business_days', 'entity_config', 'distributor_front_page_layouts',
]);
const ENTITY_CONFIG_FIELDS = new Set(['config_id', 'identity_fields', 'label', 'display_fields']);
const PRODUCT_SERVER_FIELDS = new Set(['version', 'publisher_account_id', 'published_at']);
const AMEND_FIELDS = new Set(['distributor_account_id', 'status', 'reason', 'grant_products', 'withdraw_products']);
const AMEND_STATUSES = ['active', 'suspended', 'revoked'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const trim = (v) => (typeof v === 'string' ? v.trim() : v);

export function validate(kind, payload) {
  if (kind === 'product') return validateProduct(payload);
  if (kind === 'amend') return validateAmend(payload);
  return { valid: false, errors: [`Unknown kind "${kind}". One of: ${KINDS.join(', ')}`], warnings: [] };
}

// Mirrors accounts-service/model/product.go ValidateProductDefinition.
export function validateProduct(product) {
  const errors = [];
  const warnings = [];
  if (!isObject(product)) return { valid: false, errors: ['a product definition object is required'], warnings };

  for (const key of Object.keys(product)) {
    if (PRODUCT_SERVER_FIELDS.has(key)) warnings.push(`${key} is set by the service on publish; the value you send is overwritten.`);
    else if (!PRODUCT_FIELDS.has(key)) warnings.push(`${key} is not a product field and is dropped.`);
  }

  const code = trim(product.code);
  if (typeof code !== 'string' || !ID_PATTERN.test(code)) {
    errors.push(`code ${JSON.stringify(product.code ?? '')} is not usable: letters, digits, "_" or "-", up to 64.`);
  }
  if (typeof product.name !== 'string' || product.name.trim() === '') {
    errors.push('name is required.');
  }
  if (product.active !== undefined && typeof product.active !== 'boolean') {
    errors.push('active must be a boolean when present (absent means active).');
  }

  const type = typeof product.type === 'string' ? product.type.trim().toLowerCase() : product.type;
  if (type !== undefined && type !== null && !['', 'quote', 'workitem'].includes(type)) {
    errors.push(`type ${JSON.stringify(product.type)} is not a product type: "quote" or "workitem".`);
  }
  if (type === 'workitem' && Array.isArray(product.record_configs) && product.record_configs.length > 0) {
    errors.push('a workitem product declares no record_configs: work items travel as tasks.');
  }
  validateSla(product.sla_business_days, errors);

  const installable = new Set(DISTRIBUTOR_BUNDLE_CONFIGS);
  const own = new Set();
  if (product.record_configs !== undefined && product.record_configs !== null && !Array.isArray(product.record_configs)) {
    errors.push('record_configs must be an array of { id, label }.');
  }
  (Array.isArray(product.record_configs) ? product.record_configs : []).forEach((config, i) => {
    const id = trim(typeof config === 'string' ? config : config?.id);
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      errors.push(`record_configs[${i}]: ${JSON.stringify(id ?? '')} is not a record set id.`);
      return;
    }
    if (own.has(id)) errors.push(`record_configs[${i}] repeats ${id}.`);
    own.add(id);
    installable.add(id);
    if (typeof config === 'string') warnings.push(`record_configs[${i}] is a bare id; send { id, label } so a label is stored.`);
  });

  validateEntityConfig(product.entity_config, own, errors, warnings);
  validateFrontPageLayouts(product.distributor_front_page_layouts, installable, errors);

  if (product.actions !== undefined && product.actions !== null && !isObject(product.actions)) {
    errors.push('actions must be an object keyed by record set id.');
  }
  const seenKeys = new Set();
  for (const [rawKey, list] of Object.entries(isObject(product.actions) ? product.actions : {})) {
    const key = rawKey.trim();
    const at = `actions[${JSON.stringify(rawKey)}]`;
    if (key === '') {
      errors.push(`${at}: the key is the record set the buttons act on, and is required.`);
      continue;
    }
    if (!installable.has(key)) {
      errors.push(`${at}: ${key} is not one of this product's record_configs or a platform bundle config, so the buttons would open a set the distributor never receives.`);
    }
    if (seenKeys.has(key)) errors.push(`${at} repeats ${key}: list all of a record set's buttons under one key.`);
    seenKeys.add(key);
    if (!Array.isArray(list)) {
      errors.push(`${at} must be an array of { type, label?, icon? }.`);
      continue;
    }
    const seenTypes = new Set();
    list.forEach((action, i) => {
      const type = trim(action?.type);
      if (ACCEPTED_ACTION_TYPES.includes(type)) {
        // accepted on main
      } else if (RETIRED_ACTION_TYPES.includes(type)) {
        warnings.push(`${at}[${i}]: type "${type}" is refused on main since #1544 (accounts-service/model/product.go IsProductActionType), though an older deploy and stored versions carry it. Expect a 400 where that change is deployed.`);
      } else {
        errors.push(`${at}[${i}]: ${JSON.stringify(type ?? '')} is not a type. One of ${ACCEPTED_ACTION_TYPES.join(', ')}.`);
        return;
      }
      if (seenTypes.has(type)) errors.push(`${at}[${i}] repeats ${type}: a record set carries one button per type.`);
      seenTypes.add(type);
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

const isWhole = (n) => typeof n === 'number' && Number.isInteger(n);

// ValidateProductDefinition: *int, 0..MaxSLABusinessDays. null is absent.
function validateSla(days, errors) {
  if (days === undefined || days === null) return;
  if (!isWhole(days)) {
    errors.push('sla_business_days must be a whole number; anything else fails to decode.');
  } else if (days < 0 || days > MAX_SLA_BUSINESS_DAYS) {
    errors.push(`sla_business_days ${days} is out of range: a whole number of business days from 0 to ${MAX_SLA_BUSINESS_DAYS}.`);
  }
}

// A list of field names as validateEntityConfig's fieldNames reads it.
function fieldNameList(at, list, errors) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    errors.push(`${at} must be an array of field names.`);
    return [];
  }
  const names = [];
  list.forEach((name, i) => {
    if (typeof name !== 'string') errors.push(`${at}[${i}] must be a string.`);
    else if (!ID_PATTERN.test(name.trim())) errors.push(`${at}[${i}]: ${JSON.stringify(name)} is not a field name.`);
    else names.push(name.trim());
  });
  return names;
}

// Mirrors model.validateEntityConfig. config_id must be one of the product's OWN record_configs (bundle configs do not count).
function validateEntityConfig(entity, ownConfigs, errors, warnings) {
  if (entity === undefined || entity === null) return;
  if (!isObject(entity)) {
    errors.push('entity_config must be an object { config_id, identity_fields, label?, display_fields? }.');
    return;
  }
  for (const key of Object.keys(entity)) {
    if (!ENTITY_CONFIG_FIELDS.has(key)) warnings.push(`entity_config.${key} is not an entity_config field and is dropped.`);
  }
  if (typeof entity.config_id !== 'string') errors.push('entity_config.config_id is required and must be a string.');
  else if (!ownConfigs.has(entity.config_id.trim())) {
    errors.push(`entity_config.config_id ${JSON.stringify(entity.config_id)} must be one of this product's record_configs.`);
  }
  const identity = fieldNameList('entity_config.identity_fields', entity.identity_fields, errors);
  if (!Array.isArray(entity.identity_fields) ? entity.identity_fields == null : entity.identity_fields.length === 0) {
    errors.push('entity_config.identity_fields is required: it is how one entity is told from another.');
  }
  if (new Set(identity).size < identity.length) warnings.push('entity_config.identity_fields repeats a field; the service stores it as a sorted set.');
  fieldNameList('entity_config.display_fields', entity.display_fields, errors);
  if (entity.label !== undefined && entity.label !== null && typeof entity.label !== 'string') {
    errors.push('entity_config.label must be a string.');
  }
}

// Mirrors model.validateFrontPageLayouts: size, count, id and config_id only.
// The layout body is workspaces' to validate; this check cannot see it.
function validateFrontPageLayouts(layouts, installable, errors) {
  if (layouts === undefined || layouts === null) return;
  const at = 'distributor_front_page_layouts';
  if (!Array.isArray(layouts)) {
    errors.push(`${at} must be an array of layouts.`);
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(layouts));
  if (bytes > MAX_FRONT_PAGE_LAYOUTS_BYTES) errors.push(`${at} is ${bytes} bytes; the cap is ${MAX_FRONT_PAGE_LAYOUTS_BYTES}.`);
  if (layouts.length > MAX_FRONT_PAGE_LAYOUTS) errors.push(`${at} has ${layouts.length} layouts; the cap is ${MAX_FRONT_PAGE_LAYOUTS}.`);
  const seen = new Set();
  layouts.forEach((layout, i) => {
    if (!isObject(layout)) {
      errors.push(`${at}[${i}] is not a layout object.`);
      return;
    }
    const id = typeof layout.id === 'string' ? layout.id : '';
    if (!ID_PATTERN.test(id)) errors.push(`${at}[${i}]: id ${JSON.stringify(layout.id ?? '')} must be letters, digits, "_" or "-", up to 64.`);
    else if (seen.has(id)) errors.push(`${at}[${i}] repeats id ${id}.`);
    else if (!installable.has(layout.config_id)) {
      errors.push(`${at}[${i}]: config_id ${JSON.stringify(layout.config_id ?? '')} is not a record set the distributor holds (one of record_configs or a platform bundle config).`);
    }
    seen.add(id);
  });
}

// Mirrors accounts-service/accounts/distributionregister.go AmendDistributionHandler's pre-write checks.
export function validateAmend(body) {
  const errors = [];
  const warnings = [];
  if (!isObject(body)) return { valid: false, errors: ['an amendment object is required'], warnings };

  for (const key of Object.keys(body)) {
    if (key === 'confirm') continue;
    if (!AMEND_FIELDS.has(key)) warnings.push(`${key} is not an amendment field and is dropped.`);
  }
  if (typeof body.distributor_account_id !== 'string' || body.distributor_account_id.trim() === '') {
    errors.push('distributor_account_id is required.');
  }

  const grants = Array.isArray(body.grant_products) ? body.grant_products : [];
  const withdraws = Array.isArray(body.withdraw_products) ? body.withdraw_products : [];
  if (body.grant_products !== undefined && !Array.isArray(body.grant_products)) errors.push('grant_products must be an array of { product_id, version? }.');
  if (body.withdraw_products !== undefined && !Array.isArray(body.withdraw_products)) errors.push('withdraw_products must be an array of product ids.');

  if (!body.status && grants.length === 0 && withdraws.length === 0) {
    errors.push('nothing to amend: supply a status, grant_products or withdraw_products.');
  }
  if (body.status && !AMEND_STATUSES.includes(body.status)) {
    errors.push(`status must be one of ${AMEND_STATUSES.join(', ')}.`);
  }
  if (body.status === 'revoked') warnings.push('revoked is TERMINAL: the grant can never be restored or granted another product.');
  if (body.reason && !body.status) warnings.push('reason is stored only alongside a status change; on its own it is ignored.');

  const seen = new Set();
  grants.forEach((product, i) => {
    const id = trim(product?.product_id);
    if (!id) {
      errors.push(`grant_products[${i}] needs a product_id.`);
      return;
    }
    if (!ID_PATTERN.test(id)) errors.push(`grant_products[${i}]: product_id ${JSON.stringify(id)} may only use letters, digits, "_" and "-".`);
    if (seen.has(id.toLowerCase())) errors.push(`grant_products[${i}]: ${id} is listed twice.`);
    seen.add(id.toLowerCase());
    if (product?.version !== undefined && typeof product.version !== 'string') {
      errors.push(`grant_products[${i}].version must be a string such as "2"; a number fails to decode.`);
    }
    const version = trim(product?.version);
    if (typeof version === 'string' && version && !/^v?[1-9]\d*$/.test(version)) {
      errors.push(`grant_products[${i}].version ${JSON.stringify(product.version)} is not a version: a whole number (optionally "v"-prefixed), or empty to track the latest. The amendment does not check it, and the distributor then cannot resolve the product.`);
    }
    if (product?.product_name !== undefined) warnings.push(`grant_products[${i}].product_name is ignored; the service stamps names itself.`);
  });
  withdraws.forEach((id, i) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) errors.push(`withdraw_products[${i}]: ${JSON.stringify(id)} is not a product id.`);
    else if (seen.has(id.toLowerCase())) warnings.push(`${id} is both withdrawn and granted; the grant is applied last, so it ends up granted.`);
  });

  return { valid: errors.length === 0, errors, warnings };
}
