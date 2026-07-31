// Local validator for agent configs — no API call. Encodes the rules the
// hub-service enforces (handler/agents.go, model/agents.go) plus lints for the
// spec-vs-engine gotchas, so mistakes are caught before a POST/PUT.
//
// This validates the AGENT DEFINITION (the inner `config` object). If you pass
// the wrapped form { config: {...} } it is unwrapped automatically.

import { PROVIDERS, AGENT_TYPES, SHARED, TOOL_SCHEMES, KNOWLEDGE_SCHEMES } from './agents-docs.js';

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const PROVIDER_SET = new Set(PROVIDERS);
const AGENT_TYPE_SET = new Set(AGENT_TYPES);
const SHARED_SET = new Set(SHARED);
const API_KEY_SOURCE_SET = new Set(['personal', 'system']);

// Validate an agent definition. Returns { valid, errors, warnings }.
// For create pass { requireRequired: true } (name/llm_provider/model required);
// for update pass { requireRequired: false } (everything optional).
export function validateAgentConfig(input, { requireRequired = true } = {}) {
  const errors = [];
  const warnings = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['config must be an object'], warnings };
  }

  // Unwrap the { config: {...} } wrapper if that is what was passed.
  let config = input;
  if (
    input.config &&
    typeof input.config === 'object' &&
    !Array.isArray(input.config) &&
    input.name === undefined &&
    input.llm_provider === undefined
  ) {
    config = input.config;
    warnings.push('received a wrapped { config: {...} } object — validating the inner definition. create_agent/update_agent build the wrapper for you, so pass the inner definition directly.');
  }

  // --- required-for-create fields ---
  requireString(config, 'name', requireRequired, errors);
  requireString(config, 'model', requireRequired, errors);

  // --- llm_provider ---
  if (config.llm_provider !== undefined) {
    if (typeof config.llm_provider !== 'string' || !PROVIDER_SET.has(config.llm_provider)) {
      errors.push(`llm_provider ${JSON.stringify(config.llm_provider)} is not invokable — hub-service accepts only ${PROVIDERS.map((p) => `"${p}"`).join(' or ')} (others return 400 "unsupported provider")`);
    }
  } else if (requireRequired) {
    errors.push('llm_provider is required and must be one of ' + PROVIDERS.map((p) => `"${p}"`).join(', '));
  }

  // --- behaviour (system prompt) ---
  if (config.behaviour === undefined || config.behaviour === '') {
    if (requireRequired) {
      warnings.push('no `behaviour` (system prompt) set — the agent will run with only internal defaults; set one to define what it does');
    }
  } else if (typeof config.behaviour !== 'string') {
    errors.push('behaviour must be a string (the system prompt)');
  }

  // --- id (a label, not the identifier) ---
  if (config.id !== undefined) {
    if (typeof config.id !== 'string' || !ID_REGEX.test(config.id)) {
      errors.push(`id ${JSON.stringify(config.id)} is invalid — allowed characters: letters, numbers, underscore, hyphen (^[a-zA-Z0-9_-]+$)`);
    }
  }

  // --- agent_type ---
  if (config.agent_type !== undefined && !AGENT_TYPE_SET.has(config.agent_type)) {
    errors.push(`agent_type ${JSON.stringify(config.agent_type)} is invalid — allowed: "" (standard) or "deep-research"`);
  }

  // --- shared ---
  if (config.shared !== undefined && !SHARED_SET.has(config.shared)) {
    errors.push(`shared ${JSON.stringify(config.shared)} is invalid — allowed: ${SHARED.map((s) => `"${s}"`).join(', ')}`);
  }

  // --- api_key_source ---
  if (config.api_key_source !== undefined && !API_KEY_SOURCE_SET.has(config.api_key_source)) {
    errors.push(`api_key_source ${JSON.stringify(config.api_key_source)} is invalid — allowed: "personal", "system"`);
  }

  // --- has_tools ---
  if (config.has_tools !== undefined && typeof config.has_tools !== 'boolean') {
    errors.push('has_tools must be a boolean');
  }

  // --- output_schema ---
  if (config.output_schema !== undefined && (typeof config.output_schema !== 'object' || Array.isArray(config.output_schema))) {
    errors.push('output_schema must be an object (a description of the response structure)');
  }

  // --- tools[] / knowledge[] URI schemes ---
  validateUriArray(config.tools, 'tools', TOOL_SCHEMES, errors, warnings);
  validateUriArray(config.knowledge, 'knowledge', KNOWLEDGE_SCHEMES, errors, warnings);

  // --- numeric ranges (documented bounds in model/agents.go) ---
  checkRange(config.ai_summary_threshold, 'ai_summary_threshold', 0.5, 0.95, errors);
  checkRange(config.preserve_most_recent, 'preserve_most_recent', 2, 20, errors);
  checkRange(config.invocation_depth, 'invocation_depth', 0, 1, errors);
  if (config.llm_config !== undefined) {
    if (typeof config.llm_config !== 'object' || Array.isArray(config.llm_config)) {
      errors.push('llm_config must be an object { temperature?, max_tokens?, max_turns? }');
    } else {
      checkRange(config.llm_config.temperature, 'llm_config.temperature', 0, 2, errors);
      checkThinkingBudget(config.llm_config, warnings);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function requireString(config, key, required, errors) {
  if (config[key] === undefined || config[key] === '') {
    if (required) errors.push(`${key} is required and must be a non-empty string`);
  } else if (typeof config[key] !== 'string') {
    errors.push(`${key} must be a string`);
  }
}

function validateUriArray(value, key, schemes, errors, warnings) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array of strings`);
    return;
  }
  value.forEach((item, i) => {
    if (typeof item !== 'string') {
      errors.push(`${key}[${i}] must be a string`);
    } else if (!schemes.some((s) => item.startsWith(s))) {
      warnings.push(`${key}[${i}] "${item}" does not start with a known URI scheme (${schemes.join(', ')}) — it may be ignored`);
    }
  });
}

// The agent service injects a thinking budget the caller never asked for, and does
// not reconcile it with max_tokens:
//
//   // bellerophon-workforce/cmd/agent-service/service/process_invoke.go:893-902
//   defaultThinkingEnabled := true
//   defaultThinkingBudget  := 8000
//   if llmConfig.ThinkingEnabled == nil { llmConfig.ThinkingEnabled = &defaultThinkingEnabled }
//   if llmConfig.ThinkingTokens  == nil { llmConfig.ThinkingTokens  = &defaultThinkingBudget }
//
// It only fills fields left nil, and it never compares the budget against
// max_tokens. So a config with max_tokens <= 8000 and no explicit thinking_tokens
// stores and reads back perfectly, then fails at INVOKE with
// "thinking_tokens must be less than max_tokens (thinking=8000, max=1024)".
//
// Hit live 2026-07-29 with max_tokens: 1024. 8 of the 144 live configs carrying an
// llm_config are in this state and cannot currently be invoked.
//
// A warning, not an error: the injection is gated on the service's
// ENABLE_NATIVE_THINKING flag and on the model supporting thinking, so it is not
// unconditional — but it is on for staging today.
const DEFAULT_THINKING_BUDGET = 8000;

function checkThinkingBudget(llmConfig, warnings) {
  const maxTokens = llmConfig.max_tokens;
  if (typeof maxTokens !== 'number' || maxTokens > DEFAULT_THINKING_BUDGET) return;
  if (llmConfig.thinking_tokens !== undefined) return;
  warnings.push(
    `llm_config.max_tokens ${maxTokens} is at or below the ${DEFAULT_THINKING_BUDGET}-token thinking budget the agent service injects when thinking_tokens is unset, ` +
      `so invoke_agent will fail with 400 "thinking_tokens must be less than max_tokens (thinking=${DEFAULT_THINKING_BUDGET}, max=${maxTokens})" even though this config stores fine. ` +
      `Fix it by raising max_tokens above ${DEFAULT_THINKING_BUDGET}, setting llm_config.thinking_tokens below max_tokens explicitly, or omitting max_tokens.`
  );
}

function checkRange(value, key, min, max, errors) {
  if (value === undefined) return;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.push(`${key} must be a number`);
    return;
  }
  if (value < min || value > max) {
    errors.push(`${key} ${value} is out of range — must be between ${min} and ${max}`);
  }
}

// Public entrypoint (mirrors quiva-records-mcp / quiva-flows-mcp validate()).
export function validate(config, opts) {
  return validateAgentConfig(config, opts);
}
