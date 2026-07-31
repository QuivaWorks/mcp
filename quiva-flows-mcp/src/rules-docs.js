// The Quiva flows RULES DSL (rule-engine v2) — reference and validation.
//
// Engine truth, in order of authority:
//   1. hub-service/jseval/rules.go — the embedded rule-engine v2 bundle that
//      actually evaluates rules (base64 const R). `calculatingOperations` +
//      `expressionOperators` there define the ONLY operators that work.
//   2. hub-service/runner/graph.go — handleConditionNode (:1133) feeds the
//      condition node's whole payload in as `{ <NODE_ID>: payload }`;
//      handleRulesNode (:1182) uses `{ rules, facts, context }`.
//   3. microstrate/src/utils/json-schema.utilts.ts:242 `rulesInputJSONSchema`
//      — the flow editor's JSON-Schema validation for rules payloads.
//   4. microstrate/src/types/rule.types.ts `OperatorType` — the operator list
//      the visual condition builder offers.
//
// (3) and (4) are NARROWER than (1) and disagree with each other, so the
// validator errors on (1) and warns on (3)/(4). See OPERATOR NOTES below.

// ---------------------------------------------------------------------------
// Operator vocabularies
// ---------------------------------------------------------------------------

// (1) Runtime truth — every key of `calculatingOperations` in the engine
// bundle, plus the special `fact` operator handled before operator dispatch.
export const ENGINE_OPERATORS = new Set([
  'fact',
  // arithmetic
  '+', '-', '*', '/', '%', 'mod', 'power', 'pow', '^',
  'ceil', 'floor', 'round', 'trunc', 'e', 'log', 'baseLog', 'min', 'max',
  // comparison
  '=', 'equal', 'equals',
  '!=', '<>', 'notEqual', 'notEquals',
  '>', 'greaterThan', '>=', 'greaterThanInclusive', 'greaterThanOrEqual',
  '<', 'lessThan', '<=', 'lessThanInclusive', 'lessThanOrEqual',
  // membership
  'hasOptions', 'options-in', 'optionsIn',
  'inArray', 'in', 'notInArray', 'notIn',
  // string
  'substring', 'concat', 'join', 'stringTemplate', 'regex',
  'stringContain', 'stringContains', 'stringNotContain', 'stringNotContains',
  // array
  'contain', 'contains', 'arrayContain', 'arrayContains',
  'notContain', 'notContains', 'arrayNotContain', 'arrayNotContains',
  'concat-array', 'sort', 'sortString', 'split', 'empty', 'notEmpty',
  'generateArray', 'generate-array', 'array.generate',
  // data
  'jPath', 'jsonPath', 'jsonParse', 'jsonStringify',
  'map', 'lookup', 'numberFormat', 'between', 'notBetween',
  // date
  'today', 'now', 'addDate', 'subtractDate', 'dateDiff', 'dateFormat',
  'timeNow', 'toISO',
  // logic
  'and', '&', '&&', 'or', '|', '||', 'not', '!',
  // composition
  'expression', 'exp',
]);

// (3) The flow editor validates rules payloads against this enum. Anything
// outside it still RUNS, but the editor's JSON-Schema check flags it — the
// production "Builders Risk Product Selection" flow trips this with `jPath`.
export const EDITOR_SCHEMA_OPERATORS = new Set([
  '@today', '@now', '+', '-', '*', '/', '=', '!=', '^', '%',
  'floor', 'ceil', 'round', 'trunc', 'or', 'and', 'not', 'in', 'notIn',
  '>', '<', '>=', 'lookup', 'stringContains', 'stringTemplate',
  'between', 'notBetween', 'dateDiff', 'addDate', 'subtractDate',
  'expression', 'split', 'join', 'numberFormat',
]);

// (4) The visual condition builder's dropdown. Six entries here are NOT
// implemented by the engine — picking them in the UI produces a rule that
// silently evaluates to undefined.
export const VISUAL_BUILDER_ONLY = new Set([
  'doesNotContain', 'string-contains', 'stringFormat', 'boolean', 'condition', ' !',
]);

export const OPERATOR_GROUPS = {
  logic: ['and (& &&)', 'or (| ||)', 'not (!)'],
  comparison: [
    '= (equal, equals)', '!= (<>, notEqual, notEquals)',
    '> (greaterThan)', '>= (greaterThanOrEqual, greaterThanInclusive)',
    '< (lessThan)', '<= (lessThanOrEqual, lessThanInclusive)',
    'between', 'notBetween',
  ],
  membership: [
    'in (inArray)', 'notIn (notInArray)',
    'contains (contain, arrayContains, arrayContain)',
    'notContains (notContain, arrayNotContains, arrayNotContain)',
    'hasOptions (options-in, optionsIn)',
    'stringContains (stringContain)', 'stringNotContains (stringNotContain)',
    'empty', 'notEmpty', 'regex',
  ],
  arithmetic: [
    '+', '-', '*', '/', '% (mod)', '^ (power, pow)',
    'ceil', 'floor', 'round', 'trunc', 'min', 'max', 'e', 'log', 'baseLog',
  ],
  string: ['concat', 'join', 'split', 'substring', 'stringTemplate', 'numberFormat'],
  array: ['sort', 'sortString', 'concat-array', 'generate-array (generateArray, array.generate)'],
  data: ['jPath (jsonPath)', 'jsonParse', 'jsonStringify', 'map (lookup)'],
  date: ['today', 'now', 'timeNow', 'toISO', 'addDate', 'subtractDate', 'dateDiff', 'dateFormat'],
  composition: ['expression (exp) — infix chain: [a, "op", b, "op", c]'],
  special: ['fact — resolve a fact by key; normally written as the string "@fact:<key>"'],
};

// ---------------------------------------------------------------------------
// Reference topic text
// ---------------------------------------------------------------------------

export const RULES_SYNTAX = `
THE FLOWS RULES DSL (rule-engine v2)
====================================

Used by: "condition" nodes, "rules" nodes, and rules-running compute functions.
NOT the same engine as records FORM rules (those are json-logic-engine
{ property, logic } — a different dialect; never mix them).

--- 1. The IF / ELSE IF / ELSE trap -------------------------------------------

The flow editor labels condition branches IF, ELSE IF and ELSE, so
"{ if, then, else }" feels like the natural payload. IT IS NOT. On the wire a
branch is { condition, outcome }. A payload containing if/then/else is not
recognised as a rule, the whole payload becomes the "outcome", and the run dies
with: value has to be a string or an array of strings.

    UI label        wire form
    IF          ->  { "condition": <expression>, "outcome": <value> }
    ELSE IF     ->  { "condition": <expression>, "outcome": <value> }   (later in the array)
    ELSE        ->  { "outcome": <value> }                              (last, no condition)

--- 2. A rule ("ConditionalChain") -------------------------------------------

An ORDERED ARRAY of branches, evaluated top to bottom; the FIRST branch whose
condition is truthy wins. A final branch with NO condition is the catch-all.
If no branch matches, the rule produces nothing — for a condition node that
means the run fails with "failed to determine next steps".

    [
      { "condition": { "operator": "=", "input": ["$.CHECK.duplicate_exists", false] },
        "outcome": "CREATE_FOLDER" },
      { "condition": { "operator": "=", "input": ["$.CHECK.duplicate_exists", true] },
        "outcome": "CONFLICT_RESPONSE" },
      { "outcome": "RESOLVE_ERROR" }
    ]

A branch may also carry "outcomeMessage" (string or expression) for a
human-readable explanation. A rule can also be a bare literal, a bare
"@fact:x" reference, or a single expression object when no branching is needed.

--- 3. Expressions ("DynamicValue") -----------------------------------------

Either an object { "operator": <name>, "input": [ ...operands ] } — operands may
be literals, "@fact:<key>" strings, or nested expression objects — or the string
short forms:

    "@fact:<key>"   resolve a fact          (regex ^@fact:[a-zA-Z_][a-zA-Z0-9_.]*$)
    "@today"        today                   ("@<operator>" with no input)
    "@<op>:<input>" single-input operator

"input" must be an ARRAY (minItems 1) and the object takes no other keys.

--- 4. condition node vs rules node -----------------------------------------

CONDITION node — the payload IS the chain (an array), nothing wraps it. The
engine evaluates it as { <NODE_ID>: payload }. facts and context are passed as
EMPTY, so "@fact:" is useless here: reference upstream data with plain JSONPath
("$.NODE.field"), which is resolved BEFORE the rule runs. Every "outcome" must
be a node id, or the reserved RESOLVE_SUCCESS (end the flow successfully) /
RESOLVE_ERROR (fail the flow). An outcome may also be an array of node ids to
activate several branches at once. Anything else fails with "next step not
found". Still add real edges condition -> target so merge-node bookkeeping
works when a branch is skipped.

RULES node — payload is { rules, facts, context }, where "rules" is a MAP of
rule name -> rule. Facts are declared in "facts" (values may be JSONPath) and
referenced as "@fact:<name>". Rules CHAIN: a later rule may reference an
earlier rule's key with "@fact:". The node returns { <ruleName>: <outcome> },
read downstream as $.<NODE_ID>.<ruleName> or $.<NODE_ID>..outcome.

    {
      "facts": { "state.value": "$.GEOCODE.state" },
      "rules": {
        "productDecision.value": [
          { "condition": { "operator": "in", "input": ["@fact:state.value", ["CA","FL","NY"]] },
            "outcome": "Product1" },
          { "outcome": "Product3" }
        ]
      },
      "context": {}
    }

Reading rule results (verified live):
  $.<ID>                        the whole { ruleName: outcome } map — always works
  $.<ID>.<ruleName>             works ONLY for dot-free rule names
  $.<ID>.Avatar.visible         does NOT read the rule named "Avatar.visible" —
                                the resolver walks Avatar -> visible and yields []
So keep a rule name dot-free if a downstream node must reference it directly,
or read the whole map and pick the key in an eval node.

The same { facts, rules, context } payload is also accepted by the shared
rules compute function (a "function" node with a ms.compute.* subject) — that
is how the production Builders Risk flow runs its underwriting rules. Careful:
the rules NODE unwraps to bare outcomes, while the compute FUNCTION returns the
raw engine output ({ outcome: ... } wrappers), which is why that flow reads
$.NODE..outcome. Same payload in, different shape out.

Not the records form dialect. A records FORM rule is json-logic-engine:
{ "id": "AvatarUrl.visible", "property": "visible", "logic": { ">=": [ { "var": "Age" }, 18 ] } }.
The same intent as a flows rule is:
  "AvatarUrl.visible": [
    { "condition": { "operator": ">=", "input": ["@fact:Age", 18] }, "outcome": true },
    { "outcome": false }
  ]
Translate; never paste one into the other.

--- 5. Operators -------------------------------------------------------------

An operator the engine does not implement does NOT raise an error: it logs a
warning, yields undefined, the branch is skipped, and you get a misleading
"failed to determine next steps". Get the name right.

${Object.entries(OPERATOR_GROUPS).map(([k, v]) => `${k.padEnd(12)} ${v.join(', ')}`).join('\n')}

Three vocabularies exist and they disagree:
  - ENGINE (above) is what runs. The validator ERRORS on anything else.
  - The flow editor's JSON-Schema check accepts a narrower list; using an
    engine-only operator (e.g. jPath, generate-array, <=, regex) still runs but
    may be flagged in the editor. The validator WARNS.
  - The visual builder additionally offers ${[...VISUAL_BUILDER_ONLY].map((o) => `"${o}"`).join(', ')}
    which the ENGINE DOES NOT IMPLEMENT — never emit these.
`.trim();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LEGACY_KEYS = ['if', 'then', 'else'];

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isExpression = (v) =>
  (isPlainObject(v) && typeof v.operator === 'string') ||
  (typeof v === 'string' && v.startsWith('@'));
const isBranch = (v) =>
  isPlainObject(v) &&
  v.outcome !== undefined &&
  (v.condition === undefined || isExpression(v.condition));

export { isBranch, isExpression };

// Walk an expression, reporting unknown/narrower operators and shape errors.
function checkExpression(expr, path, label, errors, warnings) {
  if (typeof expr === 'string') {
    if (!expr.startsWith('@')) return;
    const match = expr.match(/^@(.*?)(?::(.*))?$/);
    const op = match?.[1];
    if (!op) {
      errors.push(`${label}: ${path} is "${expr}" — an "@" short form needs an operator, e.g. "@fact:my_key" or "@today"`);
      return;
    }
    if (op === 'fact' && !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(match[2] ?? '')) {
      errors.push(`${label}: ${path} fact key "${match[2] ?? ''}" is invalid — must match ^[a-zA-Z_][a-zA-Z0-9_.]*$`);
    }
    checkOperatorName(op, path, label, errors, warnings, expr);
    return;
  }

  if (!isPlainObject(expr)) return; // a literal operand

  if (typeof expr.operator !== 'string') return;

  checkOperatorName(expr.operator, path, label, errors, warnings, expr);

  if (expr.input === undefined) {
    errors.push(`${label}: ${path} expression { operator: "${expr.operator}" } is missing "input" (an array of operands)`);
  } else if (!Array.isArray(expr.input)) {
    // The engine wraps a lone operand: resolveDynamicValue does
    // `if (!Array.isArray(params) && operator !== "not") params = [params]`.
    // So a scalar RUNS — and reads naturally for unary operators like `empty`
    // (the live "Authorise CIP Test" flow does exactly this). The editor's
    // rulesInputJSONSchema does require an array, hence a warning not an error.
    warnings.push(
      `${label}: ${path} expression "input" is a ${typeof expr.input}, not an array — the engine wraps a single operand into [value] so this runs, but the flow editor's rule schema requires an array. Prefer "input": [${JSON.stringify(expr.input)}].`
    );
    checkExpression(expr.input, `${path}.input`, label, errors, warnings);
  } else {
    if (expr.input.length === 0) {
      warnings.push(`${label}: ${path} expression "${expr.operator}" has an empty "input" array — it will resolve to nothing`);
    }
    expr.input.forEach((operand, i) => checkExpression(operand, `${path}.input[${i}]`, label, errors, warnings));
  }

  for (const key of Object.keys(expr)) {
    if (key !== 'operator' && key !== 'input') {
      warnings.push(`${label}: ${path} expression has unexpected key "${key}" — only "operator" and "input" are read`);
    }
  }
}

function checkOperatorName(op, path, label, errors, warnings, source) {
  if (ENGINE_OPERATORS.has(op)) {
    if (!EDITOR_SCHEMA_OPERATORS.has(op) && !EDITOR_SCHEMA_OPERATORS.has(`@${op}`)) {
      warnings.push(
        `${label}: ${path} uses operator "${op}" which the engine supports but the flow editor's rule schema does not list — it will run, but may be flagged in the UI`
      );
    }
    return;
  }
  const hint = VISUAL_BUILDER_ONLY.has(op)
    ? ` The visual builder offers "${op}" but the engine does not implement it`
    : '';
  errors.push(
    `${label}: ${path} operator "${op}" is not implemented by the rules engine — it silently resolves to undefined, so the branch is skipped and the run fails with "failed to determine next steps".${hint} See get_flows_reference("rules-syntax") for the operator list.`
  );
  void source;
}

// Validate a rule value (chain / branch / expression / literal).
// Returns the branch outcomes so callers can check condition targets.
export function checkRule(rule, path, label, errors, warnings) {
  const outcomes = [];

  const legacy = (obj) => LEGACY_KEYS.filter((k) => obj[k] !== undefined);

  if (Array.isArray(rule)) {
    if (rule.length === 0) {
      errors.push(`${label}: ${path} is an empty array — a rule needs at least one { condition, outcome } branch`);
      return outcomes;
    }
    rule.forEach((branch, i) => outcomes.push(...checkRule(branch, `${path}[${i}]`, label, errors, warnings)));

    const bad = rule.filter((b) => !isBranch(b)).length;
    if (bad === 0) {
      const lastHasCondition = rule[rule.length - 1]?.condition !== undefined;
      if (lastHasCondition) {
        warnings.push(
          `${label}: ${path} has no catch-all branch — add a final { "outcome": ... } with no "condition", otherwise a run where nothing matches fails with "failed to determine next steps"`
        );
      }
      rule.forEach((b, i) => {
        if (i < rule.length - 1 && b?.condition === undefined) {
          warnings.push(
            `${label}: ${path}[${i}] has no "condition" but is not last — it always matches, so every later branch is dead`
          );
        }
      });
    }
    return outcomes;
  }

  if (isPlainObject(rule)) {
    const legacyKeys = legacy(rule);
    if (legacyKeys.length > 0) {
      errors.push(
        `${label}: ${path} uses { ${legacyKeys.join(', ')} } — that shape is NOT understood by the rules engine. Use { "condition": { "operator": ..., "input": [...] }, "outcome": "<value>" } and put the else-branch last as { "outcome": "<value>" } with no condition. See get_flows_reference("rules-syntax").`
      );
      return outcomes;
    }

    if (rule.outcome !== undefined) {
      if (rule.condition !== undefined) {
        if (!isExpression(rule.condition)) {
          errors.push(
            `${label}: ${path}.condition must be an expression object { operator, input } or an "@..." string — a bare ${
              typeof rule.condition === 'string' ? 'JSONPath/text string' : typeof rule.condition
            } makes the whole rule unrecognisable and the run fails with "value has to be a string or an array of strings"`
          );
        } else {
          checkExpression(rule.condition, `${path}.condition`, label, errors, warnings);
        }
      }
      if (rule.outcomeMessage !== undefined && typeof rule.outcomeMessage !== 'string' && !isExpression(rule.outcomeMessage)) {
        errors.push(`${label}: ${path}.outcomeMessage must be a string or an expression object`);
      }
      for (const key of Object.keys(rule)) {
        if (!['condition', 'outcome', 'outcomeMessage'].includes(key)) {
          warnings.push(`${label}: ${path} branch has unexpected key "${key}" — only condition, outcome and outcomeMessage are read`);
        }
      }
      outcomes.push({ value: rule.outcome, path });
      if (isExpression(rule.outcome)) {
        checkExpression(rule.outcome, `${path}.outcome`, label, errors, warnings);
      }
      return outcomes;
    }

    if (typeof rule.operator === 'string') {
      checkExpression(rule, path, label, errors, warnings);
      return outcomes;
    }

    errors.push(
      `${label}: ${path} is an object but not a rule — a branch needs "outcome" (plus optional "condition"), or use { operator, input } for a bare expression. Keys found: ${Object.keys(rule).join(', ') || '(none)'}`
    );
    return outcomes;
  }

  if (typeof rule === 'string' && rule.startsWith('@')) {
    checkExpression(rule, path, label, errors, warnings);
  }
  return outcomes;
}
