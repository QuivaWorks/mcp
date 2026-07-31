// Local validator for document templates — no API call. Encodes the rules the
// file-generator service enforces (file-generator-service/src/type/template.ts
// TemplateCodec, template-trigger.ts, utils/docx) plus the angular-expression
// tag rules from the spec's x-agent-syntax-rules, so mistakes are caught before
// a POST/PATCH/trigger.

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_CONTENT_TYPE = 'application/pdf';
const OUTPUT_CONTENT_TYPES = new Set([PDF_CONTENT_TYPE, DOCX_CONTENT_TYPE]);

// Validate a template: { key, label?, source?, output?, signatories?, sub_templates? }.
// Returns { valid, errors, warnings }. `key` is required for create (POST) and
// optional for a partial update (pass { requireKey: false }).
export function validateTemplate(template, { requireKey = true } = {}) {
  const errors = [];
  const warnings = [];

  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return { valid: false, errors: ['template must be an object'], warnings };
  }

  // --- key ---
  if (requireKey) {
    if (!template.key || typeof template.key !== 'string') {
      errors.push('key is required and must be a non-empty string');
    }
  } else if (template.key !== undefined && typeof template.key !== 'string') {
    errors.push('key must be a string');
  }
  if (typeof template.key === 'string' && /[^a-zA-Z0-9._\- ]/.test(template.key)) {
    warnings.push(
      `key "${template.key}" contains characters that are re-encoded in the messaging subject (space -> _, other special chars -> uXXXX); prefer letters, numbers, "-" and "_"`
    );
  }

  // --- source ---
  let sourceType;
  if (template.source !== undefined) {
    const s = template.source;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push('source must be an object { key, content_type }');
    } else {
      if (typeof s.key !== 'string' || s.key === '') {
        errors.push('source.key is required (a storage path like "invoice.docx" or "obj://bucket/path.docx")');
      }
      if (typeof s.content_type !== 'string' || s.content_type === '') {
        errors.push('source.content_type is required');
      } else {
        sourceType = s.content_type;
      }
    }
  }

  // --- output ---
  if (template.output !== undefined) {
    const o = template.output;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      errors.push('output must be an object');
    } else {
      if (o.content_type !== undefined && !OUTPUT_CONTENT_TYPES.has(o.content_type)) {
        errors.push(
          `output.content_type must be "${PDF_CONTENT_TYPE}" or "${DOCX_CONTENT_TYPE}"; got ${JSON.stringify(o.content_type)}`
        );
      }
      // PDF sources cannot be rendered to DOCX (file-generator: PDF->DOCX not supported).
      if (sourceType === PDF_CONTENT_TYPE && o.content_type === DOCX_CONTENT_TYPE) {
        errors.push('a PDF source cannot output DOCX — PDF->DOCX conversion is not supported');
      }
      if (o.name !== undefined) {
        if (typeof o.name !== 'string') errors.push('output.name must be a string (an expression template)');
        else lintExpressionInto(o.name, 'output.name', errors, warnings);
      }
      if (o.name !== undefined && typeof o.name === 'string' && /\.(pdf|docx)$/i.test(o.name)) {
        warnings.push('output.name should NOT include a .pdf/.docx extension — it is appended automatically from content_type');
      }
    }
  }

  // --- signatories ---
  if (template.signatories !== undefined) {
    if (!Array.isArray(template.signatories)) {
      errors.push('signatories must be an array');
    } else {
      template.signatories.forEach((sig, i) => {
        const p = `signatories[${i}]`;
        if (!sig || typeof sig !== 'object' || Array.isArray(sig)) {
          errors.push(`${p} must be an object { name, email, validity }`);
          return;
        }
        if (typeof sig.name !== 'string' || sig.name === '') errors.push(`${p}.name is required`);
        else lintExpressionInto(sig.name, `${p}.name`, errors, warnings);
        if (typeof sig.email !== 'string' || sig.email === '') errors.push(`${p}.email is required`);
        else lintExpressionInto(sig.email, `${p}.email`, errors, warnings);
        if (sig.validity === undefined || typeof sig.validity !== 'object' || Array.isArray(sig.validity)) {
          errors.push(`${p}.validity is required and must be an object { day?, week?, month?, year? }`);
        }
        if (sig.order !== undefined && typeof sig.order !== 'number') {
          errors.push(`${p}.order must be a number`);
        }
      });
    }
  }

  // --- sub_templates ---
  if (template.sub_templates !== undefined) {
    if (!Array.isArray(template.sub_templates)) {
      errors.push('sub_templates must be an array');
    } else {
      template.sub_templates.forEach((st, i) => {
        const p = `sub_templates[${i}]`;
        if (!st || typeof st !== 'object' || Array.isArray(st)) {
          errors.push(`${p} must be an object { key, conditions? }`);
          return;
        }
        if (typeof st.key !== 'string' || st.key === '') errors.push(`${p}.key is required`);
        if (st.conditions !== undefined) {
          if (typeof st.conditions !== 'object' || Array.isArray(st.conditions)) {
            errors.push(
              `${p}.conditions must be a rule-engine v2 expression OBJECT, e.g. { "operator": "=", "input": ["@fact:client_region.value", "EU"] } (type/template.ts:64 types it as record(string, unknown))`
            );
          } else {
            lintConditionsInto(st.conditions, p, errors, warnings);
          }
        }
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// sub_templates[].conditions linter.
//
// The engine evaluates conditions with rule-engine v2:
//
//   // file-generator-service/src/consumer/template-trigger.ts:274
//   resolveRulesV2({ rules: { trigger: x.conditions }, facts })?.['trigger']?.outcome === true
//
// so a condition must be something resolveRulesV2 recognises AND whose resolved
// outcome is `true`. A json-rules-engine object ({ all: [ { fact, operator,
// value } ] }) has no `outcome`, so isRuleCellV2 rejects it, the whole object
// becomes the outcome, and `outcome === true` is false — the sub-template is
// dropped from the generated document with no error anywhere.
//
// PROVEN LIVE on staging 2026-07-29: three documents from the same template,
// compared byte-for-byte in object storage. The v2 form included the
// sub-template when true (46551 bytes) and omitted it when false (44582). The
// { all: [...] } form with a condition that was MET produced 44582 bytes —
// byte-identical to the excluded case. See
// examples/authored/certificate-of-currency.json -> conditions_proven_live.
// ---------------------------------------------------------------------------

// Operator vocabulary of rule-engine v2, transcribed from
// file-generator-service/src/utils/rule-engine/calculating-operations.ts.
// Kept as a warning rather than an error: this list is hand-transcribed and will
// drift, and blocking on it would repeat the flows MCP's mistake of enforcing a
// vocabulary the engine did not agree with.
const V2_OPERATORS = new Set([
  '=', '==', '!=', '>', '>=', '<', '<=',
  'and', 'or', 'not', 'in', 'notIn', 'contains', 'notContains',
  'empty', 'notEmpty', 'present', 'blank',
  'startsWith', 'endsWith', 'match',
  '+', '-', '*', '/', '%',
  'split', 'join', 'jPath', 'numberFormat', 'dateFormat', 'length',
  'generate-array', 'if', 'coalesce',
]);

function lintConditionsInto(conditions, label, errors, warnings) {
  const keys = Object.keys(conditions);

  // The exact shape that is silently dropped.
  if ('all' in conditions || 'any' in conditions) {
    errors.push(
      `${label}.conditions uses the json-rules-engine shape { ${'all' in conditions ? 'all' : 'any'}: [...] }. ` +
        'The engine evaluates conditions with rule-engine v2 and requires the resolved cell to have outcome === true; ' +
        'this shape has no `outcome`, so the SUB-TEMPLATE IS SILENTLY DROPPED from the generated document (verified live 2026-07-29). ' +
        'Use an expression object instead, e.g. { "operator": "=", "input": ["@fact:client_region.value", "EU"] }.'
    );
    return;
  }

  if (Array.isArray(conditions.rules) || 'rules' in conditions) {
    warnings.push(
      `${label}.conditions should be the expression itself, not a { rules: ... } wrapper — template-trigger.ts builds the wrapper for you.`
    );
  }

  if (!('operator' in conditions) && !('outcome' in conditions) && keys.length > 0) {
    warnings.push(
      `${label}.conditions has neither an \`operator\` nor an \`outcome\` (keys: ${keys.join(', ')}). ` +
        'rule-engine v2 will not recognise it as a rule cell, the whole object becomes the outcome, and the sub-template will be dropped.'
    );
  }

  if (typeof conditions.operator === 'string' && !V2_OPERATORS.has(conditions.operator)) {
    warnings.push(
      `${label}.conditions.operator "${conditions.operator}" is not in the transcribed rule-engine v2 operator set — check ` +
        'file-generator-service/src/utils/rule-engine/calculating-operations.ts before relying on it.'
    );
  }

  if (conditions.input !== undefined && !Array.isArray(conditions.input)) {
    warnings.push(
      `${label}.conditions.input is usually an array of operands; the engine wraps a lone scalar, so this runs, but the array form is what live configs use.`
    );
  }

  // Facts are derived from the trigger payload as `<key>.value`
  // (template-trigger.ts:266), so a fact reference without .value silently
  // resolves to nothing.
  const factRefs = JSON.stringify(conditions).match(/@fact:[\w.]+/g) ?? [];
  for (const ref of factRefs) {
    if (!ref.endsWith('.value') && !ref.includes('.value.')) {
      warnings.push(
        `${label}.conditions references "${ref}" — facts are auto-derived from the trigger payload as \`<key>.value\`, so this should probably be "${ref}.value".`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Angular-expression / docxtemplater tag linter.
// Encodes the spec's x-agent-syntax-rules: single-brace tags, balanced
// section/loop blocks ({#...}...{/}), and positional filter arguments.
// Returns { errors, warnings }.
// ---------------------------------------------------------------------------
export function lintExpression(text) {
  const errors = [];
  const warnings = [];
  lintExpressionInto(text, 'expression', errors, warnings);
  return { errors, warnings };
}

function lintExpressionInto(text, label, errors, warnings) {
  if (typeof text !== 'string' || text === '') return;

  // Extract every {...} tag (no brace nesting in this syntax).
  const tags = [];
  const stripped = text.replace(/\{([^{}]*)\}/g, (_m, inner) => {
    tags.push(inner);
    return '';
  });

  // Any brace left over means an unclosed / stray tag.
  if (stripped.includes('{') || stripped.includes('}')) {
    errors.push(`${label}: unbalanced braces — every "{" must be matched by a "}" (no nested braces)`);
    return;
  }

  const stack = [];
  for (const raw of tags) {
    const inner = raw.trim();
    if (inner === '') {
      warnings.push(`${label}: empty tag "{}"`);
      continue;
    }
    if (inner.startsWith('#') || inner.startsWith('^')) {
      // Section / loop open — name is the first token after the marker.
      const name = inner.slice(1).trim().split(/\s+/)[0];
      stack.push(name);
    } else if (inner.startsWith('/')) {
      // Close — {/} (implicit) or {/name}.
      const name = inner.slice(1).trim();
      if (stack.length === 0) {
        errors.push(`${label}: close tag "{${inner}}" has no matching open tag`);
      } else {
        const open = stack.pop();
        if (name !== '' && name !== open) {
          warnings.push(`${label}: close tag "{/${name}}" does not match the open section "{#${open}}"`);
        }
      }
    } else if (inner.includes('|')) {
      lintFilter(inner, label, warnings);
    }
  }
  if (stack.length > 0) {
    errors.push(`${label}: unclosed section/loop tag(s): ${stack.map((s) => `{#${s}}`).join(', ')} — close with {/} or {/${stack[stack.length - 1]}}`);
  }
}

// Filter args are positional and ALL required (spec critical_rule).
function lintFilter(inner, label, warnings) {
  const parts = inner.split('|').map((p) => p.trim());
  for (let i = 1; i < parts.length; i++) {
    const [fname, ...rest] = parts[i].split(':');
    const name = fname.trim();
    const args = rest.length;
    if (name === 'formatdate' && args < 3) {
      warnings.push(`${label}: formatdate needs 3 positional args (pattern:TIMEZONE:LOCALE), e.g. {date | formatdate:"yyyy-MM-dd":-5:en-US}`);
    }
    if (name === 'formatcurrency' && args < 3) {
      warnings.push(`${label}: formatcurrency needs 3 positional args (CURRENCY:LOCALE:DECIMALS), e.g. {total | formatcurrency:USD:en-US:true}`);
    }
  }
}

// Public entrypoint (mirrors quiva-records-mcp validate()).
export function validate(template, opts) {
  return validateTemplate(template, opts);
}
