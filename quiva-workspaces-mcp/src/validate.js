// Local validator for workspaces payloads — no API call. Encodes the rules the
// workspaces-service enforces (handler/{spaces,tasks,comments}.go, model/api.go)
// plus lints for the spec-vs-engine gotchas, so mistakes are caught before a
// POST/PATCH.
//
// validate(kind, payload, { requireRequired }) — kind is one of VALID_KINDS.
// requireRequired defaults to true (create). Pass false for update payloads.

import {
  VERTICAL_SPACE_ID, VERTICAL_CONFIG_TYPES, FOLDER_MARKERS, VERTICAL_NON_DEPLOYING_FOLDERS,
  STATUS_ROLES, TERMINAL_STATUS_ROLES, SPACE_TABS, SPACE_MODULES,
} from './workspaces-docs.js';

const SPACE_ID_REGEX = /^\w+$/; // letters, numbers, underscore only
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Read-only / server-set fields that should never be sent in a create/update
// body (the engine ignores them; echoing a GET response back is the #1 mistake).
const SPACE_READONLY = ['owner', 'created_at', 'updated_at', 'url'];
const TASK_READONLY = ['created_at', 'updated_at', 'created_by', 'url', 'watchers', 'muted', 'subtasks', 'task_actions', 'base_record_skipped', 'version', 'activity_at'];
const COMMENT_READONLY = ['author', 'created_at', 'updated_at', 'url', 'reactions'];

const VALID_KINDS = ['space', 'task', 'multi_task', 'comment', 'reaction', 'task_action', 'time_log', 'contact', 'task_template', 'folder', 'file', 'case_folder'];

// Server-owned on a time log (handler/task_time_logs.go AddTaskTimeLogHandler).
const TIME_LOG_SERVER_FIELDS = ['id', 'user', 'created_at', 'updated_at'];
// Response-only on time_tracking (model/api.go TimeTracking, hydrateTimeTracking).
const TIME_TRACKING_HYDRATED = ['logs', 'spent', 'remaining', 'progress_percent'];

export function validate(kind, payload, { requireRequired = true, current } = {}) {
  const errors = [];
  const warnings = [];

  if (!VALID_KINDS.includes(kind)) {
    return { valid: false, errors: [`unknown kind ${JSON.stringify(kind)} — expected one of ${VALID_KINDS.join(', ')}`], warnings };
  }
  if (!isObject(payload)) {
    return { valid: false, errors: [`${kind} payload must be an object`], warnings };
  }

  switch (kind) {
    case 'space': validateSpace(payload, requireRequired, errors, warnings); if (current) warnBaseRecordSwap(payload, current, warnings); break;
    case 'task': validateTask(payload, requireRequired, errors, warnings); break;
    case 'multi_task': validateMultiTask(payload, errors, warnings); break;
    case 'comment': validateComment(payload, requireRequired, errors, warnings); break;
    case 'reaction': validateReaction(payload, errors, warnings); break;
    case 'task_action': validateTaskAction(payload, requireRequired, errors, warnings); break;
    case 'time_log': validateTimeLog(payload, errors, warnings); break;
    case 'contact': validateContact(payload, errors, warnings); break;
    case 'task_template': validateTaskTemplate(payload, requireRequired, errors, warnings); break;
    case 'folder': validateFolder(payload, errors, warnings); break;
    case 'file': validateFile(payload, errors, warnings); break;
    case 'case_folder': validateCaseFolder(payload, errors, warnings); break;
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateSpace(p, required, errors, warnings) {
  // id — required on create, ^\w+$, uppercased server-side.
  if (p.id === undefined || p.id === '') {
    if (required) errors.push('id is required for create_space and must be a non-empty string (the spec example that omits it would 400)');
  } else if (typeof p.id !== 'string' || !SPACE_ID_REGEX.test(p.id)) {
    errors.push(`id ${JSON.stringify(p.id)} is invalid — allowed characters: letters, numbers, underscore only (^\\w+$). No spaces or hyphens.`);
  } else if (p.id !== p.id.toUpperCase()) {
    warnings.push(`id "${p.id}" will be UPPERCASED server-side to "${p.id.toUpperCase()}" — reference the space (and its task ids) by the uppercased form.`);
  }

  requireString(p, 'name', required, errors);

  if (p.statuses !== undefined) validateStatuses(p.statuses, 'statuses', errors, warnings);
  if (p.upsert_statuses !== undefined) validateStatuses(p.upsert_statuses, 'upsert_statuses', errors, warnings, { upsert: true });
  validateIdList(p, 'upsert_priorities', errors);
  validateIdList(p, 'upsert_tags', errors);
  for (const key of ['remove_statuses', 'remove_priorities', 'remove_tags']) arrayOfStrings(p, key, errors);

  const listEdits = ['upsert_statuses', 'remove_statuses', 'upsert_priorities', 'remove_priorities', 'upsert_tags', 'remove_tags'].filter((k) => p[k] !== undefined);
  if (required && listEdits.length) {
    warnings.push(`${listEdits.join(', ')} ${listEdits.length > 1 ? 'are' : 'is'} update-only — create_space ignores ${listEdits.length > 1 ? 'them' : 'it'} (model.Space has no such field). Put the entries in statuses/priorities/tags instead.`);
  }
  if (!required) {
    for (const list of ['statuses', 'priorities', 'tags']) {
      if (p[list] !== undefined) {
        warnings.push(`${list} REPLACES the stored list — any entry not in it is deleted. To add or change one entry without knowing the rest, use upsert_${list} / remove_${list}.`);
      }
    }
  }

  if (p.base_record !== undefined) validateBaseRecord(p.base_record, 'base_record', errors, warnings);
  if (p.organisation_record !== undefined) validateBaseRecord(p.organisation_record, 'organisation_record', errors, warnings);
  if (isObject(p.base_record) && isObject(p.organisation_record) && p.base_record.config_id && p.base_record.config_id === p.organisation_record.config_id) {
    errors.push('base_record and organisation_record name the same config_id — the person and the firm must be different record configs, or every contact and firm write collides.');
  }

  if (p.modules !== undefined) validateModules(p.modules, errors, warnings);
  if (p.custom_tab !== undefined) validateCustomTab(p.custom_tab, p, errors, warnings);
  if (p.hidden_tabs !== undefined) validateHiddenTabs(p.hidden_tabs, errors, warnings);
  if (p.view !== undefined && !isObject(p.view)) errors.push('view must be an object { tasks: { board: { card: { fields: {...} } } } }');
  else if (isObject(p.view) && p.view.front_page !== undefined) validateFrontPage(p.view.front_page, errors, warnings, { update: !required });

  if (p.staging !== undefined) {
    if (typeof p.staging !== 'boolean') errors.push('staging must be a boolean');
    else warnings.push('staging is root/admin only (403 for anyone else, and for an integration). A staging space can be reset and is a safe place to test task sync.');
  }

  if (p.editing_disabled !== undefined) {
    if (typeof p.editing_disabled !== 'boolean') {
      errors.push('editing_disabled must be a boolean');
    } else if (!required) {
      warnings.push('editing_disabled is CREATE-ONLY — it is absent from UpdateSpaceRequest, so sending it on update_space does nothing.');
    } else if (p.editing_disabled) {
      warnings.push('editing_disabled: true is IRREVERSIBLE — the space will refuse every update and delete (403) and there is no unlock.');
    }
  }

  arrayOfStrings(p, 'record_config_ids', errors);
  warnReadonly(p, SPACE_READONLY, warnings);
}

function validateStatuses(statuses, label, errors, warnings, { upsert = false } = {}) {
  if (!Array.isArray(statuses)) {
    errors.push(`${label} must be an array of { id, name, color?, order?, complete?, is_visible?, role? }`);
    return;
  }
  const roleAt = new Map();
  statuses.forEach((s, i) => {
    if (!isObject(s)) { errors.push(`${label}[${i}] must be an object`); return; }
    if (!s.id || typeof s.id !== 'string') errors.push(`${label}[${i}].id is required (string)`);
    // An upsert of a stored id carries its name over (carryStatus), so name is optional there.
    if (!upsert && (!s.name || typeof s.name !== 'string')) errors.push(`${label}[${i}].name is required (string)`);
    if (s.complete !== undefined && typeof s.complete !== 'boolean') errors.push(`${label}[${i}].complete must be a boolean`);
    if (s.role === undefined || s.role === null || s.role === '') return;
    if (typeof s.role !== 'string') { errors.push(`${label}[${i}].role must be a string`); return; }
    // Hand-transcribed from model/api.go, and nothing validates it server-side: warn.
    if (!STATUS_ROLES.includes(s.role)) {
      warnings.push(`${label}[${i}].role "${s.role}" is not a known status role (${STATUS_ROLES.join(', ')}) — automation resolves roles by exact match, so nothing will ever address it.`);
    }
    if (TERMINAL_STATUS_ROLES.includes(s.role) && s.complete !== true) {
      warnings.push(`${label}[${i}].role "${s.role}" ends the workflow, so the status should carry complete: true — otherwise the board shows a finished task as open.`);
    }
    if (roleAt.has(s.role)) {
      warnings.push(`${label}[${i}] repeats role "${s.role}" (also ${label}[${roleAt.get(s.role)}]) — a role must be unique in a space; automation resolves the first one.`);
    } else {
      roleAt.set(s.role, i);
    }
  });
}

function validateIdList(p, key, errors) {
  if (p[key] === undefined) return;
  if (!Array.isArray(p[key])) { errors.push(`${key} must be an array of objects with an id`); return; }
  p[key].forEach((e, i) => {
    if (!isObject(e) || !e.id || typeof e.id !== 'string') errors.push(`${key}[${i}].id is required (string) — entries are matched by id`);
  });
}

// model/api.go BaseRecord. The two flags belong to different records.
function validateBaseRecord(b, label, errors, warnings) {
  if (!isObject(b)) { errors.push(`${label} must be an object { config_id, identity_fields[], ... }`); return; }
  if (!b.config_id || typeof b.config_id !== 'string') {
    errors.push(`${label}.config_id is required (string) — the record config the entity is stored in. A base record with no config_id is treated as none at all.`);
  }
  if (b.identity_fields === undefined || (Array.isArray(b.identity_fields) && b.identity_fields.length === 0)) {
    warnings.push(`${label}.identity_fields is empty — nothing keys the record, so the platform falls back to its built-in identity fields. Name the field(s) that identify one, e.g. ["email"].`);
  }
  arrayOfStrings(b, 'identity_fields', errors, label);
  arrayOfStrings(b, 'display_fields', errors, label);
  for (const flag of ['create_login_on_create', 'enable_distribution']) {
    if (b[flag] !== undefined && typeof b[flag] !== 'boolean') errors.push(`${label}.${flag} must be a boolean`);
  }
  if (label === 'base_record' && b.create_login_on_create === true) {
    warnings.push('base_record.create_login_on_create is true — every create_contact with an email in this space will ALSO create a client-role portal sign-in for that address.');
  }
  if (label === 'base_record' && b.enable_distribution === true) {
    warnings.push('enable_distribution belongs on organisation_record — on base_record (the person) it does nothing.');
  }
  if (label === 'organisation_record' && b.create_login_on_create === true) {
    warnings.push('create_login_on_create belongs on base_record — an organisation is not a person, so it is never enrolled (contact_login.go refuses it).');
  }
  if (label === 'base_record' && (b.parent_config_id !== undefined || b.parent_label !== undefined)) {
    warnings.push('base_record.parent_config_id / parent_label is the legacy way to name the organisation. Declare organisation_record instead — it keys the firm on its own identity fields.');
  }
  validateLegacyConfigIds(b, label, errors, warnings);
}

// workspaces-service/handler/space_resolve.go carryLegacyConfigIDs (lands with evari-olympus #1560).
function validateLegacyConfigIds(b, label, errors, warnings) {
  if (b.legacy_config_ids === undefined) return;
  if (!Array.isArray(b.legacy_config_ids) || b.legacy_config_ids.some((id) => typeof id !== 'string')) {
    errors.push(`${label}.legacy_config_ids must be an array of config ids ([] clears; omit to fold the previous config in)`);
    return;
  }
  if (b.legacy_config_ids.length === 0) {
    warnings.push(`${label}.legacy_config_ids: [] CLEARS the list — the previous config is no longer folded in, so entities stored under it stop being found by this base record. Intended only when swapping the base config on purpose.`);
  } else if (b.legacy_config_ids.includes(b.config_id)) {
    warnings.push(`${label}.legacy_config_ids names config_id itself — it adds nothing.`);
  }
}

// Base-record swap: an omitted legacy_config_ids folds the previous config (and its legacy ids)
// into the new one on every update; only an explicit [] stops that. `current` is the stored space.
function warnBaseRecordSwap(p, current, warnings) {
  for (const key of ['base_record', 'organisation_record']) {
    const next = p[key];
    const previous = current?.[key];
    if (!isObject(next) || !next.config_id || !isObject(previous) || !previous.config_id) continue;
    if (next.config_id !== previous.config_id && next.legacy_config_ids === undefined) {
      warnings.push(`${key}.config_id changes from "${previous.config_id}" to "${next.config_id}" without legacy_config_ids: [] — the server FOLDS "${previous.config_id}" (and its legacy ids) into the new base record's legacy list. Send legacy_config_ids: [] to drop it, or leave it out to keep old entities findable.`);
    }
  }
  if (isObject(p.base_record) && isObject(current?.base_record)) {
    warnings.push('base_record is REPLACED WHOLESALE on update — send every field the space keeps (label, display_fields, parent_label, icons), copied from get_space, or they are cleared.');
  }
}

function validateModules(m, errors, warnings) {
  if (!isObject(m)) { errors.push(`modules must be an object { ${SPACE_MODULES.join('?, ')}? } of booleans`); return; }
  for (const [key, value] of Object.entries(m)) {
    if (!SPACE_MODULES.includes(key)) warnings.push(`modules.${key} is not a module (${SPACE_MODULES.join(', ')}) — it is stored and ignored.`);
    else if (typeof value !== 'boolean') errors.push(`modules.${key} must be a boolean`);
  }
}

// Mirrors model/api.go ValidateDisplay, which 400s on each of these.
function validateCustomTab(tab, space, errors, warnings) {
  if (!isObject(tab)) { errors.push('custom_tab must be an object { name?, cards: [...] }'); return; }
  if (tab.cards === undefined) return;
  if (!Array.isArray(tab.cards)) { errors.push('custom_tab.cards must be an array'); return; }
  const declared = Array.isArray(space.record_configs) ? space.record_configs.map((c) => c?.id) : null;
  const seen = new Map();
  tab.cards.forEach((card, i) => {
    const label = `custom_tab.cards[${i}]`;
    if (!isObject(card)) { errors.push(`${label} must be an object`); return; }
    const configId = typeof card.config_id === 'string' ? card.config_id.trim() : '';
    if (!configId) errors.push(`${label}.config_id is required — a card acts on one record config`);
    const action = typeof card.action === 'string' ? card.action.trim() : '';
    if (!action) errors.push(`${label}.action is required — "create" or "list"`);
    else if (action !== 'create' && action !== 'list') errors.push(`${label}.action "${card.action}" is not an action — it is "create" or "list"`);
    if (card.detail !== undefined && card.detail !== '' && !['form', 'lifecycle'].includes(card.detail)) {
      errors.push(`${label}.detail "${card.detail}" is not a detail surface — use "form" or "lifecycle"`);
    }
    if (action === 'create') {
      if (card.view) errors.push(`${label}.view is meaningless on a create card — a create card opens the form, not a queue`);
      if (card.detail) errors.push(`${label}.detail is meaningless on a create card — declare it on the list card for the same config`);
      if (Array.isArray(card.actions) && card.actions.length) errors.push(`${label}.actions are meaningless on a create card — move them to the list card, or use on_submit`);
    }
    const key = [card.product_id ?? '', configId, action, card.view ?? ''].join('\u0000');
    if (seen.has(key)) errors.push(`${label} repeats card ${seen.get(key)} — one config gets one card per action and view within a product`);
    else seen.set(key, i);
    if (configId && declared && !declared.includes(configId)) {
      warnings.push(`${label}.config_id "${configId}" is not in this payload's record_configs — the Records tab is built from the space's own configs, so the card would open an empty list.`);
    }
  });
}

function validateHiddenTabs(tabs, errors, warnings) {
  if (!Array.isArray(tabs)) { errors.push('hidden_tabs must be an array of tab keys'); return; }
  tabs.forEach((tab, i) => {
    const key = typeof tab === 'string' ? tab.trim() : tab;
    if (typeof key !== 'string') errors.push(`hidden_tabs[${i}] must be a string`);
    else if (key === 'overview') errors.push('hidden_tabs cannot hold "overview" — every unknown panel falls back to it (400 server-side)');
    // The engine 400s on an unknown key, but the list is transcribed, so warn.
    else if (!SPACE_TABS.includes(key)) warnings.push(`hidden_tabs[${i}] "${tab}" is not a known tab (${SPACE_TABS.join(', ')}) — the engine refuses unknown keys with a 400.`);
  });
}

function validateTask(p, required, errors, warnings) {
  requireString(p, 'title', required, errors);

  if (p.space_id !== undefined) {
    if (typeof p.space_id !== 'string') {
      errors.push('space_id must be a string');
    } else if (p.space_id && p.space_id !== p.space_id.toUpperCase()) {
      warnings.push(`space_id "${p.space_id}" is uppercased server-side to "${p.space_id.toUpperCase()}"; the space must already exist or create_task returns 400 "space not found".`);
    }
  }

  arrayOfStrings(p, 'assignees', errors);
  arrayOfStrings(p, 'attachments', errors);
  arrayOfStrings(p, 'tags', errors);

  if (p.archived !== undefined && typeof p.archived !== 'boolean') {
    errors.push('archived must be a boolean');
  }

  if (required && (p.space_id === undefined || p.space_id === '')) {
    warnings.push('no space_id — the task lands in the built-in ESCALATE space. Name the space it belongs to.');
  }

  warnDateFormat(p, 'due_date', warnings);
  warnDateFormat(p, 'scheduled_at', warnings);
  if (p.time_tracking !== undefined) validateTimeTracking(p.time_tracking, errors, warnings);
  validateSubtaskFields(p, required, errors, warnings);
  validatePipelineFields(p, errors, warnings);
  validateIdentity(p, required, errors, warnings);
  if (p.suppress_events !== undefined && typeof p.suppress_events !== 'boolean') errors.push('suppress_events must be a boolean');
  if (p.external_id !== undefined) {
    const msg = externalIdProblem(p.external_id);
    if (msg) errors.push(msg);
  }
  warnReadonly(p, TASK_READONLY, warnings);
}

// Mirrors the server rule: at most 256 bytes of UTF-8, no "/".
export function externalIdProblem(id) {
  if (typeof id !== 'string' || id === '') return 'external_id must be a non-empty string';
  if (id.includes('/')) return 'external_id must not contain "/"';
  if (Buffer.byteLength(id, 'utf8') > 256) return 'external_id must be at most 256 bytes of UTF-8';
  return null;
}

// handler/tasks.go validateParent: one level, must exist, not self.
function validateSubtaskFields(p, required, errors, warnings) {
  if (p.parent !== undefined) {
    if (typeof p.parent !== 'string') errors.push('parent must be a task id string ("" detaches)');
    else if (/[.*> \t\r\n]/.test(p.parent.trim())) errors.push(`parent ${JSON.stringify(p.parent)} is not a task id`);
    else if (p.id && p.parent === p.id) errors.push('a task cannot be its own parent');
  }
  if (p.move_subtasks !== undefined) {
    if (typeof p.move_subtasks !== 'boolean') errors.push('move_subtasks must be a boolean');
    else if (required) warnings.push('move_subtasks is update-only — create_task ignores it.');
    else if (p.move_subtasks && p.space_id === undefined && p.folder === undefined) {
      warnings.push('move_subtasks does nothing unless the same update changes space_id or folder.');
    }
  }
}

function validatePipelineFields(p, errors, warnings) {
  if (p.value !== undefined && p.value !== null && (typeof p.value !== 'number' || Number.isNaN(p.value))) {
    errors.push('value must be a number');
  }
  for (const key of ['source', 'source_detail', 'currency', 'expected_close']) {
    if (p[key] !== undefined && typeof p[key] !== 'string') errors.push(`${key} must be a string`);
  }
  if (typeof p.expected_close === 'string' && p.expected_close && !/^\d{4}-\d{2}-\d{2}/.test(p.expected_close)) {
    warnings.push(`expected_close "${p.expected_close}" is not an ISO date — it is indexed as a date and range-filtered, so a loose value never matches.`);
  }
  if (p.value !== undefined && p.value !== null && p.currency === undefined) {
    warnings.push('value without currency — nothing converts between currencies, so an unlabelled amount cannot be compared later.');
  }
}

// CreateTaskRequest.Identity keys the space's base record; UpdateTaskRequest has none.
function validateIdentity(p, required, errors, warnings) {
  if (p.identity === undefined) return;
  if (!isObject(p.identity)) { errors.push('identity must be an object of strings, e.g. { "email": "sam@example.com" }'); return; }
  for (const [k, v] of Object.entries(p.identity)) {
    if (typeof v !== 'string') errors.push(`identity.${k} must be a string`);
  }
  if (!required) warnings.push('identity is create-only — update_task ignores it.');
  else warnings.push('identity links the task to the space\'s base record, but the task is created even if the link fails — check `base_record_skipped` in the response, and read the task back: a build without the feature ignores identity silently (no folder, no base_record_skipped).');
}

// Only `estimate` is persisted on the task (model/api.go TimeTracking); the rest
// is hydrated from time-log records, so anything else sent is dead data.
function validateTimeTracking(tt, errors, warnings) {
  if (!isObject(tt)) {
    errors.push('time_tracking must be an object { estimate?: { time_in_seconds } }');
    return;
  }
  if (tt.estimate !== undefined) validateTimeSpent(tt.estimate, 'time_tracking.estimate', errors);

  if (tt.logs !== undefined) {
    warnings.push('time_tracking.logs is stored on the task and NEVER READ — logs are hydrated from time-log records (since #1292). Log time with add_time_log, one entry per call.');
  }
  const hydrated = TIME_TRACKING_HYDRATED.filter((k) => k !== 'logs' && tt[k] !== undefined);
  if (hydrated.length) {
    warnings.push(`time_tracking.${hydrated.join(', ')} ${hydrated.length > 1 ? 'are' : 'is'} computed server-side on every read — never send ${hydrated.length > 1 ? 'them' : 'it'}.`);
  }
  for (const key of Object.keys(tt)) {
    if (key !== 'estimate' && !TIME_TRACKING_HYDRATED.includes(key)) {
      warnings.push(`time_tracking.${key} is not part of model.TimeTracking — only estimate is writable.`);
    }
  }
}

// model.AddTimeLogRequest; AddTaskTimeLogHandler 400s on the first two checks.
function validateTimeLog(p, errors, warnings) {
  if (p.time_spent === undefined) {
    errors.push('time_spent is required — { "time_in_seconds": N }');
  } else {
    validateTimeSpent(p.time_spent, 'time_spent', errors);
    if (isObject(p.time_spent) && p.time_spent.time_in_seconds === 0) {
      errors.push('time_spent.time_in_seconds must be greater than zero (the handler 400s on 0)');
    }
  }
  requireString(p, 'started_at', true, errors);
  warnRfc3339(p, 'started_at', 'time_log', warnings);
  if (p.description !== undefined && typeof p.description !== 'string') errors.push('description must be a string');
  const owned = TIME_LOG_SERVER_FIELDS.filter((k) => p[k] !== undefined);
  if (owned.length) {
    warnings.push(`${owned.join(', ')} ${owned.length > 1 ? 'are' : 'is'} server-owned on a time log (id tl_<random>, user from the JWT, timestamps now) — what you send is ignored.`);
  }
}

function validateTimeSpent(value, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object { "time_in_seconds": N }`);
    return;
  }
  if (typeof value.time_in_seconds !== 'number' || Number.isNaN(value.time_in_seconds)) {
    errors.push(`${label}.time_in_seconds is required and must be a number of SECONDS (not minutes/hours — the UI parses "2h 30m" into seconds before sending)`);
  } else if (value.time_in_seconds < 0) {
    errors.push(`${label}.time_in_seconds must not be negative`);
  }
}

// A task action (handler/task_actions.go) is a checklist item hung off a task on
// its own subject; get_task returns it in task_actions[].
function validateTaskAction(p, required, errors, warnings) {
  // `description` is the only server-enforced requirement, on every write:
  // AddTaskActionHandler 400s with "description is required" even when you are
  // only flipping `done`, because the handler validates before any merge.
  requireString(p, 'description', true, errors);
  if (!required && p.id === undefined) {
    warnings.push('no `id` — a task-action write without an id creates a NEW action (ta_<random>) rather than updating one. Pass the id you want to change.');
  }

  if (p.id !== undefined && typeof p.id !== 'string') {
    errors.push('id must be a string (server default: ta_<random>)');
  }
  if (p.done !== undefined && typeof p.done !== 'boolean') {
    errors.push('done must be a boolean');
  }

  if (p.resources !== undefined) {
    if (!Array.isArray(p.resources)) {
      errors.push('resources must be an array of { resource_id, resource_type, metadata? }');
    } else {
      p.resources.forEach((r, i) => {
        if (!isObject(r)) { errors.push(`resources[${i}] must be an object`); return; }
        requireString(r, 'resource_id', true, errors);
        requireString(r, 'resource_type', true, errors);
        if (r.metadata !== undefined && !isObject(r.metadata)) {
          errors.push(`resources[${i}].metadata must be an object`);
        }
      });
    }
  }

  warnings.push(
    'a task-action write RECOMPUTES the task status by status role (none done -> todo, some -> working, all -> done), ' +
      'falling back to default_status / the first complete non-outcome status. It never writes an id the space lacks, and leaves the status alone when no role matches. ' +
      'Chat actions do not count. Read the result back with get_task.'
  );
  if (p.suppress_events !== undefined && typeof p.suppress_events !== 'boolean') errors.push('suppress_events must be a boolean');
}

// model.ClientProfile; handler/client.go validateContactProfile.
function validateContact(p, errors, warnings) {
  requireString(p, 'space_id', true, errors);
  for (const key of ['first_name', 'last_name', 'name', 'email', 'phone', 'address', 'dob', 'config_id', 'parent_folder', 'entity_type', 'parent_entity']) {
    if (p[key] !== undefined && typeof p[key] !== 'string') errors.push(`${key} must be a string`);
  }
  if (typeof p.email === 'string' && p.email.trim() && !CONTACT_EMAIL_REGEX.test(p.email.trim().toLowerCase())) {
    errors.push(`${JSON.stringify(p.email)} is not a valid email address (400 server-side)`);
  }
  if (typeof p.parent_folder === 'string' && p.parent_folder.includes('.')) {
    errors.push(`parent_folder ${JSON.stringify(p.parent_folder)} must be a single folder, not a dotted path`);
  }
  if (p.extra_data !== undefined && !isObject(p.extra_data)) errors.push('extra_data must be an object');
  if (!p.email && !p.phone && !p.name && !p.first_name && !p.last_name) {
    errors.push('a name, email or phone is required to label the contact');
  }
  if (typeof p.email === 'string' && p.email.trim()) {
    warnings.push('if the space\'s base_record has create_login_on_create: true, this creates a client-role PORTAL SIGN-IN for this email. create_contact checks the space and reports it; use example.com addresses for tests.');
  }
}

// handler/task_templates.go validateTaskTemplateActions.
function validateTaskTemplate(p, required, errors, warnings) {
  // workspaces-service/handler/task_templates.go:173-175: a body id overrides the path id.
  if (!required && p.id !== undefined) errors.push('id must not be in an update body: it overrides the id in the path, so the write lands on another template');
  requireString(p, 'name', required, errors);
  arrayOfStrings(p, 'tags', errors);
  arrayOfStrings(p, 'assignees', errors);
  if (p.estimate !== undefined) validateTimeSpent(p.estimate, 'estimate', errors);
  for (const key of ['status', 'due_date', 'space_id']) {
    if (p[key] !== undefined) warnings.push(`${key} is not a template field — a new task gets it fresh, so the template ignores it.`);
  }
  if (p.task_actions === undefined) return;
  if (!Array.isArray(p.task_actions)) { errors.push('task_actions must be an array'); return; }
  p.task_actions.forEach((a, i) => {
    const label = `task_actions[${i}]`;
    if (!isObject(a)) { errors.push(`${label} must be an object`); return; }
    if (!a.description) errors.push(`${label}.description is required`);
    switch (a.kind) {
      case 'form':
        if (!a.config_id && !(Array.isArray(a.configs) && a.configs.length)) errors.push(`${label}: config_id or configs is required for a form action`);
        break;
      case 'document': {
        const source = a.document_source || 'generate';
        if (source === 'knowledge') { if (!a.knowledge_key) errors.push(`${label}: knowledge_key is required for a knowledge-sourced document action`); }
        else if (source === 'generate') { if (!a.document_template_id) errors.push(`${label}: document_template_id is required for a document action`); }
        else errors.push(`${label}: document_source must be "generate" or "knowledge"`);
        break;
      }
      case 'chat':
        if (!a.agent_subject && !a.flow_config_id) errors.push(`${label}: agent_subject or flow_config_id is required for a chat action`);
        break;
      default:
        errors.push(`${label}: kind must be "form", "document" or "chat"`);
    }
  });
}

function validateMultiTask(p, errors, warnings) {
  if (!Array.isArray(p.tasks)) {
    errors.push('multi_task requires a `tasks` array of task updates');
    return;
  }
  if (p.tasks.length === 0) {
    errors.push('`tasks` must contain at least one task update');
    return;
  }
  p.tasks.forEach((t, i) => {
    if (!isObject(t)) { errors.push(`tasks[${i}] must be an object`); return; }
    if (!t.id || typeof t.id !== 'string') {
      errors.push(`tasks[${i}].id is required — batch update targets tasks by id`);
    }
    const sub = validate('task', t, { requireRequired: false });
    sub.errors.forEach((e) => errors.push(`tasks[${i}]: ${e}`));
    sub.warnings.forEach((w) => warnings.push(`tasks[${i}]: ${w}`));
  });
  warnings.push('update_multi_task returns an OBJECT keyed by request index (not an array); any single failure fails the whole call with per-index errors.');
}

function validateComment(p, required, errors, warnings) {
  if (required) {
    requireString(p, 'body', true, errors);
  } else if (
    (p.body === undefined || p.body === '') &&
    p.reply_id === undefined
  ) {
    errors.push('update_comment requires at least one of `body` or `reply_id`');
  } else if (p.body !== undefined && typeof p.body !== 'string') {
    errors.push('body must be a string');
  }
  warnReadonly(p, COMMENT_READONLY, warnings);
}

function validateReaction(p, errors, warnings) {
  if (!isObject(p.reaction) || Object.keys(p.reaction).length === 0) {
    errors.push('reaction is required and must be a non-empty map of `{ "<emoji>": true|false }` (true = add, false = remove)');
    return;
  }
  for (const [emoji, active] of Object.entries(p.reaction)) {
    if (typeof active !== 'boolean') {
      errors.push(`reaction["${emoji}"] must be a boolean (true = add, false = remove)`);
    }
    if (emoji.includes(':')) {
      warnings.push(`colons in reaction key "${emoji}" are stripped server-side`);
    }
    // The key is stored VERBATIM and rendered as-is. A shortcode NAME is not
    // translated to a glyph anywhere — verified live 2026-07-30: posting
    // { "eyes": true } stored the literal string "eyes" and the UI showed it as
    // an invalid reaction, while { "👀": true } stored "👀" and rendered.
    if (!containsEmoji(emoji)) {
      errors.push(
        `reaction key ${JSON.stringify(emoji)} is not an emoji character. The key is stored VERBATIM and rendered as-is — nothing converts a shortcode name into a glyph, so "${emoji}" renders as broken/invalid in the UI. Pass the emoji itself, e.g. { "👀": true } not { "eyes": true } (verified live 2026-07-30).`
      );
    }
  }
}

// Does the string contain at least one pictographic character? Deliberately loose:
// the platform does not validate the key at all, so this only has to separate "an
// actual emoji" from "a word someone typed instead of one".
function containsEmoji(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    return /\p{Extended_Pictographic}/u.test(value);
  } catch {
    // Very old runtimes without Unicode property escapes: fall back to
    // "anything outside the BMP or in the misc-symbols range".
    return /[←-⯿☀-➿️\u{1F000}-\u{1FAFF}]/u.test(value);
  }
}

// --- helpers ---

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function requireString(p, key, required, errors) {
  if (p[key] === undefined || p[key] === '') {
    if (required) errors.push(`${key} is required and must be a non-empty string`);
  } else if (typeof p[key] !== 'string') {
    errors.push(`${key} must be a string`);
  }
}

function arrayOfStrings(p, key, errors, prefix = '') {
  if (p[key] === undefined) return;
  const label = prefix ? `${prefix}.${key}` : key;
  if (!Array.isArray(p[key])) {
    errors.push(`${label} must be an array of strings`);
    return;
  }
  p[key].forEach((item, i) => {
    if (typeof item !== 'string') errors.push(`${label}[${i}] must be a string`);
  });
}

// Mirrors handler/client.go contactEmailRe.
const CONTACT_EMAIL_REGEX = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

const RFC3339_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function warnRfc3339(obj, key, label, warnings) {
  if (typeof obj[key] === 'string' && obj[key] && !RFC3339_REGEX.test(obj[key])) {
    warnings.push(`${label}.${key} "${obj[key]}" is not an ISO 8601 / RFC3339 timestamp — the UI formats these directly, so a loose value renders as an invalid date.`);
  }
}

function warnDateFormat(p, key, warnings) {
  if (typeof p[key] === 'string' && DATE_ONLY_REGEX.test(p[key])) {
    warnings.push(`${key} "${p[key]}" is date-only — the engine parses it as RFC3339 on read and a date-only value can fail to round-trip. Prefer a full timestamp like "${p[key]}T00:00:00Z".`);
  }
}

// --- Folders and files -----------------------------------------------------
//
// Object keys are DOTTED paths (`spaces.<SPACE_ID>.<folder>...<name>.<ext>`), so
// `.` is the hierarchy separator and a dot inside a name silently creates an
// extra level. Everything below either encodes a rule the engine enforces, or
// lints a failure the engine accepts SILENTLY — the second group is the reason
// this validator exists.

// A dotted path with an empty segment (leading/trailing dot, or "..") produces a
// key the tree walker cannot place.
function lintDottedPath(label, value, errors) {
  if (String(value).split('.').some((s) => s === '')) {
    errors.push(
      `${label} ${JSON.stringify(value)} has an empty path segment — "." is the hierarchy separator, so it cannot start or end with a dot, or contain "..".`
    );
    return false;
  }
  return true;
}

// Would deployVerticals actually forward this key to an endpoint?
//
// It matches the prefix `spaces.VERTICAL.<vertical>.`, takes the FIRST path segment
// after it as the config type, looks that up in configTypeToEndpointSubject, and
// `continue`s when the lookup misses — no error, no log line, nothing deployed
// (accounts-service/accounts/updateaccount.go).
//
// write_file's `will_deploy` used to report only whether the index entry had a name.
// That made a file in a MISSPELLED category folder — `flow/`, `record_config/` —
// come back will_deploy=true and then deploy nothing, silently, which is precisely
// the failure the field exists to catch. It also claimed true for specs/, which
// never deploys by design, so the pusher's own summary contradicted itself.
//
// Only VERTICAL-space keys are judged: a file written elsewhere is not a vertical
// config and the question does not apply.
export function verticalRouting(key) {
  const parts = String(key).split('.');
  if (parts[0] !== 'spaces' || parts[1] !== VERTICAL_SPACE_ID) {
    return { deploys: true, reason: null };
  }
  const category = parts[3];
  if (!category) {
    return {
      deploys: false,
      reason: `"${key}" has no category segment — expected spaces.${VERTICAL_SPACE_ID}.<vertical>.<category>.<name>.<ext>.`,
    };
  }
  if (Object.prototype.hasOwnProperty.call(VERTICAL_CONFIG_TYPES, category)) {
    return { deploys: true, reason: null };
  }
  if (VERTICAL_NON_DEPLOYING_FOLDERS.includes(category)) {
    return {
      deploys: false,
      reason: `"${category}" never deploys by design — a notes folder, not a routing key. The file is stored and indexed; deployVerticals skips it.`,
    };
  }
  return {
    deploys: false,
    reason:
      `"${category}" is NOT a recognised config type, so deployVerticals will SILENTLY skip this file — ` +
      'it looks the category up in configTypeToEndpointSubject and `continue`s on a miss, with no error anywhere. ' +
      `Expected one of: ${Object.keys(VERTICAL_CONFIG_TYPES).sort().join(', ')} ` +
      `(or ${VERTICAL_NON_DEPLOYING_FOLDERS.join(', ')} for notes). Check for a typo or a singular/plural slip.`,
  };
}

// Warn when a VERTICAL category folder is not one of the six accounts-service
// will route. A WARNING and not an error: the list is transcribed from
// accounts-service/accounts/updateaccount.go and can grow upstream without us
// noticing, and a non-deploying folder may well be deliberate.
function lintVerticalCategory(category, warnings) {
  if (!category) return;
  if (Object.prototype.hasOwnProperty.call(VERTICAL_CONFIG_TYPES, category)) return;
  // Deliberately non-deploying folders (`specs`) are meant to fall out of the
  // dispatch loop. Warning about them would be noise on every correct call.
  if (VERTICAL_NON_DEPLOYING_FOLDERS.includes(category)) return;
  warnings.push(
    `"${category}" is not one of the six folder names accounts-service deploys from (${Object.keys(VERTICAL_CONFIG_TYPES).join(', ')}). ` +
      'The category folder is the ROUTING KEY, and an unrecognised name is skipped SILENTLY — no error, no log entry, nothing deploys from it. ' +
      `If it is meant not to deploy, the intentional ones are: ${VERTICAL_NON_DEPLOYING_FOLDERS.join(', ')}.`
  );
}

function validateFolder(p, errors, warnings) {
  const hasPair = p.space_id !== undefined || p.folder !== undefined;

  // The engine only 400s when space_id, folder AND full_path are all present, or
  // all three absent — so `{ space_id }` alone passes server-side validation and
  // writes a malformed `spaces.<ID>..<marker>.json`. Catch both locally.
  if (p.full_path !== undefined && p.full_path !== '' && hasPair) {
    errors.push(
      'send EITHER full_path OR space_id + folder, not both — the engine only rejects the case where all three are present, so a mixed payload silently uses full_path and ignores the rest.'
    );
  }

  if (p.full_path !== undefined && p.full_path !== '') {
    if (typeof p.full_path !== 'string') {
      errors.push('full_path must be a string');
    } else {
      if (!p.full_path.startsWith('spaces.')) {
        errors.push(`full_path ${JSON.stringify(p.full_path)} must start with "spaces.<SPACE_ID>." — every space file key is rooted there.`);
      }
      lintDottedPath('full_path', p.full_path, errors);
    }
  } else {
    if (p.space_id === undefined || p.space_id === '') {
      errors.push('space_id is required (or send full_path instead)');
    } else if (typeof p.space_id !== 'string' || !SPACE_ID_REGEX.test(p.space_id)) {
      errors.push(`space_id ${JSON.stringify(p.space_id)} is invalid — letters, numbers and underscore only (^\\w+$).`);
    } else if (p.space_id !== p.space_id.toUpperCase()) {
      warnings.push(`space_id "${p.space_id}" will be UPPERCASED server-side to "${p.space_id.toUpperCase()}" — the stored key uses the uppercase form.`);
    }

    // The gap above: without this the engine writes `spaces.<ID>..<marker>.json`.
    if (p.folder === undefined || p.folder === '') {
      errors.push(
        'folder is required — the engine does NOT reject a payload carrying only space_id (it only errors when space_id, folder and full_path are ALL empty), and would write a malformed key `spaces.<ID>..__meta__.json`.'
      );
    } else if (typeof p.folder !== 'string' || p.folder.includes('.')) {
      errors.push(`folder ${JSON.stringify(p.folder)} must be a single dot-free segment — a dot would create an extra level. Use subfolder for a parent path.`);
    }

    if (p.subfolder !== undefined && p.subfolder !== '') {
      if (typeof p.subfolder !== 'string') {
        errors.push('subfolder must be a string');
      } else {
        // subfolder is the PARENT prefix, not a child: the engine builds
        // `spaces.<space_id>.<subfolder>.<folder>`. It may itself be dotted for
        // deeper nesting.
        lintDottedPath('subfolder', p.subfolder, errors);
      }
    }
  }

  // Marker names are managed by the engine — naming a folder after one produces
  // a doubled marker like `...__meta__.__meta__.json`.
  const bareMarkers = FOLDER_MARKERS.map((m) => m.replace(/\.json$/, ''));
  if (typeof p.folder === 'string' && bareMarkers.includes(p.folder)) {
    warnings.push(`folder "${p.folder}" collides with a folder-marker name (${FOLDER_MARKERS.join(', ')}) — the engine appends the marker itself, so this would store a doubled marker key.`);
  }

  // model.CreateFolderRequest.Metadata is map[string]string: a nested object or
  // a number fails to unmarshal and the whole call 400s.
  if (p.metadata !== undefined) {
    if (!isObject(p.metadata)) {
      errors.push('metadata must be an object');
    } else {
      const bad = Object.entries(p.metadata).filter(([, v]) => typeof v !== 'string');
      if (bad.length) {
        errors.push(`metadata values must all be STRINGS (the engine field is map[string]string) — non-string value(s) for: ${bad.map(([k]) => k).join(', ')}`);
      }
      for (const reserved of ['created_at', 'created_by']) {
        if (p.metadata[reserved] !== undefined) {
          warnings.push(`metadata.${reserved} is overwritten by the engine — yours is discarded.`);
        }
      }
    }
  }

  // Vertical-specific layout lint.
  const resolved = p.full_path && p.full_path !== ''
    ? p.full_path
    : `spaces.${p.space_id}${p.subfolder ? '.' + p.subfolder : ''}.${p.folder}`;
  const segs = String(resolved).split('.');
  if (segs[1] === VERTICAL_SPACE_ID) {
    // spaces.VERTICAL.<vertical>            -> a vertical root (segs.length 3)
    // spaces.VERTICAL.<vertical>.<category> -> a category folder (segs.length 4)
    if (segs.length === 4) lintVerticalCategory(segs[3], warnings);
    if (segs.length === 3 && segs[2] !== 'SHARED' && !/^[a-z0-9_]+$/.test(segs[2])) {
      warnings.push(
        `vertical id "${segs[2]}" is not lower_snake_case. Existing verticals are lower_snake_case (e.g. financial_advisor), and accounts-service derives the flow COLLECTION name by splitting the id on "_" and title-casing each part — so anything else produces an odd collection name.`
      );
    }
  }

  warnReadonly(p, ['created_at', 'created_by', 'owner'], warnings);
}

function validateFile(p, errors, warnings) {
  if (p.key === undefined || p.key === '') {
    errors.push('key is required — the full dotted object key, e.g. "spaces.VERTICAL.my_vertical.spaces.myhub.json"');
    return;
  }
  if (typeof p.key !== 'string') {
    errors.push('key must be a string');
    return;
  }
  if (!p.key.startsWith('spaces.')) {
    errors.push(`key ${JSON.stringify(p.key)} must start with "spaces.<SPACE_ID>." — every space file key is rooted there.`);
  }
  lintDottedPath('key', p.key, errors);

  if (p.content !== undefined && typeof p.content !== 'string') {
    errors.push('content must be a string (JSON should be stringified before sending)');
  }

  const segs = p.key.split('.');
  if (segs.length < 4) {
    errors.push(`key ${JSON.stringify(p.key)} is too shallow — expected at least spaces.<SPACE_ID>.<name>.<ext>.`);
  }

  // Writing a marker by hand creates a folder the engine did not make, and
  // create_folder would then 409 on it.
  if (FOLDER_MARKERS.some((m) => p.key.endsWith('.' + m))) {
    warnings.push(
      `key ends in a folder marker (${FOLDER_MARKERS.join(' / ')}) — markers are written by create_folder, and hand-writing one creates a folder the engine did not register consistently. Use create_folder instead.`
    );
  }

  if (segs[1] !== VERTICAL_SPACE_ID) return;

  // --- VERTICAL template-library rules ---
  const category = segs[3];
  lintVerticalCategory(category, warnings);

  const ext = segs[segs.length - 1].toLowerCase();

  // `specs` is documentation, not config — markdown is the point, and nothing
  // deploys from it, so none of the config-shape lints below apply.
  if (VERTICAL_NON_DEPLOYING_FOLDERS.includes(category)) {
    if (ext === 'json') {
      warnings.push(`a file in "${category}" is not deployed anywhere — if this is meant to be a config, it belongs in one of: ${Object.keys(VERTICAL_CONFIG_TYPES).join(', ')}.`);
    }
    return;
  }

  if (category === 'document_templates') {
    if (ext === 'json') {
      warnings.push('document_templates config is forwarded verbatim to microstrate.file-generator.post.template — confirm it is a template CONFIG body and not a raw source document.');
    }
  } else if (Object.prototype.hasOwnProperty.call(VERTICAL_CONFIG_TYPES, category) && ext !== 'json') {
    warnings.push(`a "${category}" config is POSTed verbatim to ${VERTICAL_CONFIG_TYPES[category]}, which expects a JSON body — a ".${ext}" file would fail to unmarshal at deploy time.`);
  }

  // Content-shape lints, only when the content is parseable JSON.
  if (typeof p.content !== 'string' || ext !== 'json') return;
  let parsed;
  try {
    parsed = JSON.parse(p.content);
  } catch (err) {
    errors.push(`content is not valid JSON but the key ends in .json — deployment would fail to unmarshal it: ${err.message}`);
    return;
  }
  if (!isObject(parsed)) return;

  if (category === 'assistants' && parsed.config === undefined) {
    errors.push(
      'an assistants config must be WRAPPED as { "config": { ... } } — accounts-service unmarshals into a { config } struct, so a flat agent payload yields an EMPTY config and deploys a hollow assistant. (It also FORCES config.shared to "team", whatever you set.)'
    );
  }

  if (category === 'spaces') {
    if (parsed.id === undefined || parsed.id === '') {
      errors.push('a spaces config needs an `id` — it is POSTed to microstrate.workspaces.post.space, which requires one.');
    }
    if (parsed.name === undefined || parsed.name === '') {
      warnings.push('a spaces config with no `name` renders unnamed on the board.');
    }
    // The finding this lint exists for: record_configs WINS on read, and the
    // legacy ids array is only consulted when it is absent. Keeping one of them
    // in sync by hand is exactly how a config gets silently dropped.
    const ids = Array.isArray(parsed.record_config_ids) ? parsed.record_config_ids : null;
    const objs = Array.isArray(parsed.record_configs) ? parsed.record_configs.map((c) => c?.id) : null;
    if (ids && objs) {
      const missing = ids.filter((id) => !objs.includes(id));
      const extra = objs.filter((id) => !ids.includes(id));
      if (missing.length || extra.length) {
        warnings.push(
          `record_config_ids and record_configs DISAGREE (only in ids: ${missing.join(', ') || 'none'}; only in record_configs: ${extra.join(', ') || 'none'}). ` +
            '`record_configs` WINS on read and `record_config_ids` is consulted only when it is absent (space-record-configs.utils.ts), so anything listed only in the ids array is silently ignored. Write both, identically.'
        );
      }
    } else if (ids && !objs) {
      warnings.push(
        'this space uses only the LEGACY `record_config_ids`. It still reads correctly today (it is the fallback), but the UI persists `record_configs` and DELETES the ids array on save — so add `record_configs: [{ id }]` alongside it.'
      );
    }
  }
}

function warnReadonly(p, keys, warnings) {
  const present = keys.filter((k) => p[k] !== undefined);
  if (present.length > 0) {
    warnings.push(`server-set/read-only field(s) ${present.join(', ')} are ignored by the engine — build the payload from scratch, do not echo a GET response.`);
  }
}

// --- view.front_page.layouts ---------------------------------------------------
// Mirrors workspaces-service/handler/front_page_layouts_validate.go (lands with
// evari-olympus #1560). Structural rules are errors. Anything that needs the record
// schemas (paths, config/form ids, index fields) is a warning: the server checks it.
export const LAYOUT_LIMITS = { layouts: 20, headerFields: 30, actions: 12, tabs: 12, tabFields: 50, tabColumns: 12, pageSize: 100 };
export const LAYOUT_TONES = ['neutral', 'info', 'success', 'warning', 'danger'];
export const LAYOUT_TAB_TYPES = ['fields', 'tasks', 'files', 'records', 'form', 'list', 'comments', 'history'];
const LAYOUT_SCHEMA_NOTE = 'paths, config/form ids and index-field checks are made by the server against the record configs (it answers 400 with the failing path).';

// Which tab types may carry each field. Anything else is refused: a setting that did not take.
const TAB_FIELD_HOMES = {
  fields: ['fields'],
  config_id: ['records', 'form'],
  record_id_path: ['form'],
  columns: ['records', 'list'],
  page_size: ['records'],
  latest_by: ['records'],
  date_field: ['records'],
  search_fields: ['records'],
  scope: ['records'],
  form_id: ['form'],
  highlight_field: ['form'],
  path: ['list'],
  task_external_id_template: ['comments', 'history'],
  task_source: ['comments', 'history'],
  metadata_key: ['tasks', 'files'],
};

const isSet = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && !(Array.isArray(v) && v.length === 0);

export function validateFrontPage(frontPage, errors, warnings, { update = false } = {}) {
  if (frontPage === null && update) { warnings.push('view.front_page: null CLEARS the whole front page, layouts included.'); return; }
  if (!isObject(frontPage)) { errors.push('view.front_page must be an object'); return; }
  if (update && frontPage.sections === undefined && frontPage.metrics === undefined && frontPage.people === undefined) {
    warnings.push('view.front_page is REPLACED WHOLESALE on update (handler/space_view.go mergeView): this payload carries no sections, metrics or people, so any the space has are DELETED. Copy them from get_space beside layouts.');
  }
  if (frontPage.layouts === undefined) return;
  const before = errors.length;
  validateLayouts(frontPage.layouts, errors, warnings);
  if (Array.isArray(frontPage.layouts) && frontPage.layouts.length && errors.length === before) {
    warnings.push(`view.front_page.layouts: ${LAYOUT_SCHEMA_NOTE}`);
  }
}

function validateLayouts(layouts, errors, warnings) {
  const at = 'view.front_page.layouts';
  if (!Array.isArray(layouts)) { errors.push(`${at} must be an array`); return; }
  if (layouts.length > LAYOUT_LIMITS.layouts) { errors.push(`${at}: too many layouts (max ${LAYOUT_LIMITS.layouts})`); return; }
  const ids = new Set();
  const keys = new Map();
  layouts.forEach((layout, i) => {
    const lp = `${at}[${i}]`;
    if (!isObject(layout)) { errors.push(`${lp} must be an object`); return; }
    if (!layout.id) errors.push(`${lp}.id is required`);
    else if (ids.has(layout.id)) errors.push(`${lp}.id "${layout.id}" is a duplicate`);
    ids.add(layout.id);
    if (!layout.config_id) errors.push(`${lp}.config_id is required`);
    if (!layout.variant_field !== !layout.variant_value) {
      errors.push(`${lp}.variant_field and variant_value are set together or not at all`);
    }
    const key = `${layout.config_id ?? ''}\u0000${layout.variant_value ?? ''}`;
    if (keys.has(key)) errors.push(`${lp}: layouts[${keys.get(key)}] already covers this config_id and variant_value — the first match wins, so the later one never shows`);
    keys.set(key, i);
    validateLayoutHeader(`${lp}.header`, layout.header, errors);
    validateLayoutActions(`${lp}.actions`, layout.actions, errors);
    validateLayoutTabs(`${lp}.tabs`, layout.tabs, errors);
  });
}

function layoutFields(path, fields, max, errors) {
  if (fields === undefined) return;
  if (!Array.isArray(fields)) { errors.push(`${path} must be an array of { path, label?, group? }`); return; }
  if (fields.length > max) { errors.push(`${path}: too many fields (max ${max})`); return; }
  fields.forEach((f, i) => {
    if (!isObject(f) || typeof f.path !== 'string' || !f.path) errors.push(`${path}[${i}].path is required`);
  });
}

function validateLayoutHeader(path, header, errors) {
  if (header === undefined) return;
  if (!isObject(header)) { errors.push(`${path} must be an object { fields?, status? }`); return; }
  layoutFields(`${path}.fields`, header.fields, LAYOUT_LIMITS.headerFields, errors);
  const status = header.status;
  if (status === undefined || status === null) return;
  if (!isObject(status)) { errors.push(`${path}.status must be an object { path, tones? }`); return; }
  if (typeof status.path !== 'string' || !status.path) errors.push(`${path}.status.path is required`);
  if (status.tones !== undefined) {
    if (!isObject(status.tones)) errors.push(`${path}.status.tones must map a field value to a tone`);
    else for (const [value, tone] of Object.entries(status.tones)) {
      if (!LAYOUT_TONES.includes(tone)) errors.push(`${path}.status.tones[${value}]: unknown tone "${tone}" — one of ${LAYOUT_TONES.join(', ')}`);
    }
  }
}

function validateLayoutActions(path, actions, errors) {
  if (actions === undefined) return;
  if (!Array.isArray(actions)) { errors.push(`${path} must be an array`); return; }
  if (actions.length > LAYOUT_LIMITS.actions) { errors.push(`${path}: too many actions (max ${LAYOUT_LIMITS.actions})`); return; }
  const all = new Set(actions.map((a) => a?.id));
  const seen = new Set();
  actions.forEach((a, i) => {
    const ap = `${path}[${i}]`;
    if (!isObject(a)) { errors.push(`${ap} must be an object`); return; }
    if (!a.id) errors.push(`${ap}.id is required`);
    else if (seen.has(a.id)) errors.push(`${ap}.id "${a.id}" is a duplicate`);
    seen.add(a.id);
    if (typeof a.label !== 'string' || !a.label.trim()) errors.push(`${ap}.label is required`);
    if (a.placement !== 'primary' && a.placement !== 'more') errors.push(`${ap}.placement must be primary or more`);
    if (a.kind === 'form') {
      if (!a.form_id) errors.push(`${ap}.form_id is required for a form action`);
      if (isSet(a.flow_ref)) errors.push(`${ap}.flow_ref is not used by a form action`);
      for (const k of ['preview', 'refer_action', 'input_config_id']) {
        if (a[k]) errors.push(`${ap}.${k} is only used by a flow action`);
      }
    } else if (a.kind === 'flow') {
      if (!a.flow_ref) errors.push(`${ap}.flow_ref is required for a flow action`);
      if (isSet(a.form_id)) errors.push(`${ap}.form_id is not used by a flow action`);
      if (a.refer_action && a.refer_action === a.id) errors.push(`${ap}.refer_action cannot name the action itself`);
      else if (a.refer_action && !all.has(a.refer_action)) errors.push(`${ap}.refer_action "${a.refer_action}" does not name an action of this layout`);
      if (a.preview !== undefined && typeof a.preview !== 'boolean') errors.push(`${ap}.preview must be a boolean`);
    } else {
      errors.push(`${ap}.kind must be form or flow`);
    }
    if (a.disabled_when !== undefined && a.disabled_when !== null && !isObject(a.disabled_when)) {
      errors.push(`${ap}.disabled_when must be a json-logic object`);
    }
    for (const k of ['requires', 'confirm']) {
      if (a[k] !== undefined && typeof a[k] !== 'string') errors.push(`${ap}.${k} must be a string`);
    }
  });
}

function validateLayoutTabs(path, tabs, errors) {
  if (tabs === undefined) return;
  if (!Array.isArray(tabs)) { errors.push(`${path} must be an array`); return; }
  if (tabs.length > LAYOUT_LIMITS.tabs) { errors.push(`${path}: too many tabs (max ${LAYOUT_LIMITS.tabs})`); return; }
  const seen = new Set();
  tabs.forEach((tab, i) => {
    const tp = `${path}[${i}]`;
    if (!isObject(tab)) { errors.push(`${tp} must be an object`); return; }
    if (!tab.id) errors.push(`${tp}.id is required`);
    else if (seen.has(tab.id)) errors.push(`${tp}.id "${tab.id}" is a duplicate`);
    seen.add(tab.id);
    if (typeof tab.label !== 'string' || !tab.label.trim()) errors.push(`${tp}.label is required`);
    if (!LAYOUT_TAB_TYPES.includes(tab.type)) {
      errors.push(`${tp}.type "${tab.type}" is unknown — one of ${LAYOUT_TAB_TYPES.join(', ')}`);
      return;
    }
    for (const [field, homes] of Object.entries(TAB_FIELD_HOMES)) {
      if (isSet(tab[field]) && !homes.includes(tab.type)) errors.push(`${tp}.${field} is only used by a ${homes.join(' or ')} tab`);
    }
    const t = tab.type;
    if (t === 'fields') {
      if (!Array.isArray(tab.fields) || tab.fields.length === 0) errors.push(`${tp}.fields is required`);
      layoutFields(`${tp}.fields`, tab.fields, LAYOUT_LIMITS.tabFields, errors);
    } else if (t === 'records') {
      if (!tab.config_id) errors.push(`${tp}.config_id is required`);
      if (Array.isArray(tab.columns) && tab.columns.length > LAYOUT_LIMITS.tabColumns) errors.push(`${tp}.columns: too many columns (max ${LAYOUT_LIMITS.tabColumns})`);
      if (tab.latest_by !== undefined && tab.latest_by !== null) {
        if (!isObject(tab.latest_by)) errors.push(`${tp}.latest_by must be { group_field, order_field }`);
        else for (const k of ['group_field', 'order_field']) {
          if (typeof tab.latest_by[k] !== 'string' || !tab.latest_by[k]) errors.push(`${tp}.latest_by.${k} is required`);
        }
      }
      if (tab.scope !== undefined && tab.scope !== '' && tab.scope !== 'case' && tab.scope !== 'parent') errors.push(`${tp}.scope must be case or parent`);
      if (tab.page_size !== undefined && (!Number.isInteger(tab.page_size) || tab.page_size < 0 || tab.page_size > LAYOUT_LIMITS.pageSize)) {
        errors.push(`${tp}.page_size must be 0-${LAYOUT_LIMITS.pageSize}`);
      }
    } else if (t === 'form') {
      if (!tab.form_id) errors.push(`${tp}.form_id is required`);
      if (!tab.config_id !== !tab.record_id_path) errors.push(`${tp}.record_id_path and config_id are set together or not at all`);
    } else if (t === 'list') {
      if (!tab.path) errors.push(`${tp}.path is required`);
      if (!Array.isArray(tab.columns) || tab.columns.length === 0) errors.push(`${tp}.columns is required`);
      else if (tab.columns.length > LAYOUT_LIMITS.tabColumns) errors.push(`${tp}.columns: too many columns (max ${LAYOUT_LIMITS.tabColumns})`);
    } else if (t === 'comments' || t === 'history') {
      if (t === 'comments' && !tab.task_external_id_template && !tab.task_source) {
        errors.push(`${tp}.task_external_id_template is required (or task_source) on a comments tab`);
      }
      if (tab.task_external_id_template) {
        const problem = taskTemplateProblem(tab.task_external_id_template);
        if (problem) errors.push(`${tp}.task_external_id_template: ${problem}`);
      }
    }
    for (const k of ['count']) if (tab[k] !== undefined && typeof tab[k] !== 'boolean') errors.push(`${tp}.${k} must be a boolean`);
  });
}

// {path} tokens must balance and not nest; whether each resolves is the server's check.
function taskTemplateProblem(tmpl) {
  for (let rest = String(tmpl); ;) {
    const open = rest.search(/[{}]/);
    if (open < 0) return null;
    if (rest[open] === '}') return 'unbalanced braces';
    const end = rest.indexOf('}', open);
    if (end < 0) return 'unbalanced braces';
    if (rest.slice(open + 1, end).includes('{')) return 'unbalanced braces';
    rest = rest.slice(end + 1);
  }
}

// --- case-folder -----------------------------------------------------------------
// Mirrors workspaces-service/handler/case_folder.go validateCaseFolderRequest (lands with
// evari-olympus #1560). Whether identity keys are the base record's identity_fields, and
// display keys its display_fields, needs the space, so the server checks those.
const CASE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const CASE_RESERVED_METADATA = ['type', 'case_id', 'primary_config', 'primary_record_id', 'created_at', 'created_by'];
export const CASE_FOLDER_LIMITS = { metadataKeys: 20, valueLength: 512 };

function validateCaseFolder(p, errors, warnings) {
  if (typeof p.space_id !== 'string' || !p.space_id) errors.push('space_id is required');
  if (!isObject(p.identity) || Object.keys(p.identity).length === 0) {
    errors.push('identity is required: { <identity field>: <value> } using the space base_record\'s identity_fields');
  } else {
    if (Object.values(p.identity).some((v) => typeof v !== 'string')) errors.push('identity values must be strings (a number is refused, and an ABN-style id must not lose leading zeros)');
    else if (!Object.values(p.identity).some((v) => v.trim())) errors.push('identity has no value');
  }
  if (p.email !== undefined && p.email !== '' && !(typeof p.email === 'string' && CONTACT_EMAIL_REGEX.test(p.email.trim().toLowerCase()))) {
    errors.push(`email "${p.email}" is not a valid email address`);
  }
  if (typeof p.case_config_id !== 'string' || !CASE_ID_REGEX.test(p.case_config_id)) {
    errors.push('case_config_id is required and may hold only letters, digits, underscores and hyphens');
  }
  const key = p.case_key;
  if (!isObject(key) || typeof key.field !== 'string' || !CASE_ID_REGEX.test(key.field) || typeof key.value !== 'string' || !key.value.trim()) {
    errors.push('case_key needs a field name (letters, digits, _ -) and a non-blank string value: it is hashed into the case folder id');
  }
  if (!p.primary_config !== !p.primary_record_id) errors.push('primary_config and primary_record_id are set together or not at all');
  for (const k of ['primary_config', 'primary_record_id']) {
    if (p[k] && !CASE_ID_REGEX.test(p[k])) errors.push(`${k} "${p[k]}" is not a valid id`);
  }
  if (p.metadata !== undefined) {
    if (!isObject(p.metadata)) errors.push('metadata must be an object of string values');
    else {
      const keys = Object.keys(p.metadata);
      if (keys.length > CASE_FOLDER_LIMITS.metadataKeys) errors.push(`too many metadata keys (max ${CASE_FOLDER_LIMITS.metadataKeys})`);
      for (const k of keys) {
        if (typeof p.metadata[k] !== 'string') errors.push(`metadata.${k} must be a string (the marker is a map[string]string)`);
        else if (p.metadata[k].length > CASE_FOLDER_LIMITS.valueLength) errors.push(`metadata.${k} is too long (max ${CASE_FOLDER_LIMITS.valueLength} characters)`);
        if (CASE_RESERVED_METADATA.includes(k) || k === key?.field) errors.push(`metadata key "${k}" is reserved (the server sets ${CASE_RESERVED_METADATA.join(', ')} and the case_key field)`);
      }
    }
  }
  if (p.display !== undefined) {
    if (!isObject(p.display)) errors.push('display must be an object of string values keyed by the base record\'s display_fields');
    else for (const [k, v] of Object.entries(p.display)) {
      if (typeof v !== 'string' || v.length > CASE_FOLDER_LIMITS.valueLength) errors.push(`display.${k} must be a string of at most ${CASE_FOLDER_LIMITS.valueLength} characters`);
    }
  }
  warnings.push('identity keys must be identity fields of the space\'s base_record and display keys its display_fields; the server checks both (400 otherwise).');
  warnings.push('an existing case marker is NEVER rewritten — a repeat call returns created_case: false and keeps the original primary_* and metadata.');
}
