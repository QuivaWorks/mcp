// Local lint for distribution write payloads. Errors mirror what the engine
// refuses; warnings flag what it accepts but ignores, or what depends on the deploy.
import {
  ID_PATTERN,
  DISTRIBUTOR_BUNDLE_CONFIGS,
  ACCEPTED_ACTION_TYPES,
  APP_ACTION_TYPES,
} from './distribution-docs.js';

export const KINDS = ['product', 'amend'];

const PRODUCT_FIELDS = new Set(['code', 'name', 'active', 'record_configs', 'actions']);
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
        // accepted everywhere
      } else if (APP_ACTION_TYPES.includes(type)) {
        warnings.push(`${at}[${i}]: type "${type}" is refused by the engine check added on main in #1441 (only "create" or "list"), though older environments and stored versions accept it. Expect a 400 where that check is deployed.`);
      } else {
        errors.push(`${at}[${i}]: ${JSON.stringify(type ?? '')} is not a type. Use "create" or "list".`);
        return;
      }
      if (seenTypes.has(type)) errors.push(`${at}[${i}] repeats ${type}: a record set carries one button per type.`);
      seenTypes.add(type);
    });
  }

  return { valid: errors.length === 0, errors, warnings };
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
