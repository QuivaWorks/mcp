// Local validator for workspaces payloads — no API call. Encodes the rules the
// workspaces-service enforces (handler/{spaces,tasks,comments}.go, model/api.go)
// plus lints for the spec-vs-engine gotchas, so mistakes are caught before a
// POST/PATCH.
//
// validate(kind, payload, { requireRequired }) where kind is one of:
//   'space' | 'task' | 'multi_task' | 'comment' | 'reaction' | 'task_action'
// requireRequired defaults to true (create). Pass false for update payloads.

const SPACE_ID_REGEX = /^\w+$/; // letters, numbers, underscore only
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Read-only / server-set fields that should never be sent in a create/update
// body (the engine ignores them; echoing a GET response back is the #1 mistake).
const SPACE_READONLY = ['owner', 'created_at', 'updated_at', 'url'];
const TASK_READONLY = ['created_at', 'updated_at', 'created_by', 'url', 'watchers', 'muted'];
const COMMENT_READONLY = ['author', 'created_at', 'updated_at', 'url', 'reactions'];

const VALID_KINDS = ['space', 'task', 'multi_task', 'comment', 'reaction', 'task_action'];

// Every field the frontend writes on a time log. The backend does no defaulting
// inside time_tracking (model.TimeTracking is stored as sent), so anything the
// client omits is simply absent — and the UI's summary reads these keys directly.
const TIME_LOG_FIELDS = ['id', 'time_spent', 'started_at', 'description', 'user', 'created_at', 'updated_at'];

export function validate(kind, payload, { requireRequired = true } = {}) {
  const errors = [];
  const warnings = [];

  if (!VALID_KINDS.includes(kind)) {
    return { valid: false, errors: [`unknown kind ${JSON.stringify(kind)} — expected one of ${VALID_KINDS.join(', ')}`], warnings };
  }
  if (!isObject(payload)) {
    return { valid: false, errors: [`${kind} payload must be an object`], warnings };
  }

  switch (kind) {
    case 'space': validateSpace(payload, requireRequired, errors, warnings); break;
    case 'task': validateTask(payload, requireRequired, errors, warnings); break;
    case 'multi_task': validateMultiTask(payload, errors, warnings); break;
    case 'comment': validateComment(payload, requireRequired, errors, warnings); break;
    case 'reaction': validateReaction(payload, errors, warnings); break;
    case 'task_action': validateTaskAction(payload, requireRequired, errors, warnings); break;
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

  if (p.statuses !== undefined) validateStatuses(p.statuses, errors);
  arrayOfStrings(p, 'record_config_ids', errors);
  warnReadonly(p, SPACE_READONLY, warnings);
}

function validateStatuses(statuses, errors) {
  if (!Array.isArray(statuses)) {
    errors.push('statuses must be an array of { id, name, color?, order?, is_visible? }');
    return;
  }
  statuses.forEach((s, i) => {
    if (!isObject(s)) { errors.push(`statuses[${i}] must be an object`); return; }
    if (!s.id || typeof s.id !== 'string') errors.push(`statuses[${i}].id is required (string)`);
    if (!s.name || typeof s.name !== 'string') errors.push(`statuses[${i}].name is required (string)`);
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

  warnDateFormat(p, 'due_date', warnings);
  warnDateFormat(p, 'scheduled_at', warnings);
  if (p.time_tracking !== undefined) validateTimeTracking(p.time_tracking, errors, warnings);
  warnReadonly(p, TASK_READONLY, warnings);
}

// model.TimeTracking (workspaces-service/model/api.go) = { estimate?: {time_in_seconds},
// logs: [{ id, time_spent: {time_in_seconds}, started_at, description?, user: {id,name},
// created_at, updated_at? }] }. Totals/remaining/progress are NOT stored — the frontend
// derives them (microstrate/src/components/spaces/tasks/task-time-tracking.utils.ts).
//
// Merge semantics, all verified live on MCP_VERIFICATION_RENEWALS-1 (2026-07-29):
//   time_tracking omitted entirely  -> untouched
//   time_tracking without `logs`    -> existing logs PRESERVED (the nil slice
//                                      marshals as "logs":null but is not destructive)
//   "logs": []                      -> every log CLEARED
//   "logs": [ ... ]                 -> the array is REPLACED wholesale, never appended
// So adding one log means sending the complete set back, which is why the Go comment
// says "the client always sends the complete set".
function validateTimeTracking(tt, errors, warnings) {
  if (!isObject(tt)) {
    errors.push('time_tracking must be an object { estimate?: { time_in_seconds }, logs: [TimeLog] }');
    return;
  }
  for (const key of Object.keys(tt)) {
    if (key !== 'estimate' && key !== 'logs') {
      warnings.push(`time_tracking.${key} is not part of model.TimeTracking (only estimate and logs) — it is stored but nothing reads it. Totals/remaining/progress are derived on the frontend, never sent.`);
    }
  }

  if (tt.estimate !== undefined) validateTimeSpent(tt.estimate, 'time_tracking.estimate', errors);

  if (tt.logs === undefined) {
    warnings.push('time_tracking has no `logs` — verified live that this PRESERVES the existing logs rather than clearing them. To clear them send "logs": [] explicitly.');
    return;
  }
  if (!Array.isArray(tt.logs)) {
    errors.push('time_tracking.logs must be an array of TimeLog objects');
    return;
  }
  if (tt.logs.length > 0) {
    warnings.push(`time_tracking.logs REPLACES the stored array wholesale (verified live) — it does not append. Sending ${tt.logs.length} log(s) discards any log not in this list, so read the task first and send the complete set.`);
  }

  const seen = new Set();
  tt.logs.forEach((log, i) => {
    const label = `time_tracking.logs[${i}]`;
    if (!isObject(log)) { errors.push(`${label} must be an object`); return; }

    if (!log.id || typeof log.id !== 'string') {
      errors.push(`${label}.id is required (string) — the backend never generates one, so an omitted id leaves the log unaddressable in the UI (the frontend mints time_log_<uuid>)`);
    } else if (seen.has(log.id)) {
      errors.push(`${label}.id "${log.id}" is duplicated — ids must be unique within logs[]`);
    } else {
      seen.add(log.id);
    }

    if (log.time_spent === undefined) {
      errors.push(`${label}.time_spent is required — { "time_in_seconds": N }`);
    } else {
      validateTimeSpent(log.time_spent, `${label}.time_spent`, errors);
    }

    requireString(log, 'started_at', true, errors);
    warnRfc3339(log, 'started_at', label, warnings);
    warnRfc3339(log, 'created_at', label, warnings);

    if (log.created_at === undefined) {
      warnings.push(`${label}.created_at is missing — the backend does not set it, so the UI has no timestamp to sort or display the entry by`);
    }
    if (!isObject(log.user)) {
      warnings.push(`${label}.user is missing or not an object — the UI shows the log's author from this snapshot ({ id, name }); the backend does not fill it in from the token`);
    } else {
      if (typeof log.user.id !== 'string' || !log.user.id) warnings.push(`${label}.user.id should be the user's uuid (see list_users)`);
      if (typeof log.user.name !== 'string' || !log.user.name) warnings.push(`${label}.user.name should be the display name — the snapshot deliberately excludes avatar info`);
    }

    for (const key of Object.keys(log)) {
      if (!TIME_LOG_FIELDS.includes(key)) {
        warnings.push(`${label}.${key} is not part of model.TimeLog (${TIME_LOG_FIELDS.join(', ')}) — it is stored but nothing reads it`);
      }
    }
  });
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
// its own subject `ms.workspaces.task-action.{taskID}.{actionID}` — it is NOT a
// field on the task, so it never appears in get_task.
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
    'task actions CANNOT BE READ BACK: GET /workspaces/task/{task_id}/action is mapped to the write resource ' +
      '`microstrate.workspaces.put.task-action`, so it runs the add handler and 400s "description is required". ' +
      'ListTaskActionsHandler exists (registered as get.task-actions) but no gateway route reaches it. ' +
      'The write response is your request echoed back, not the stored aggregate — so nothing about a task action is verifiable today.'
  );
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

function arrayOfStrings(p, key, errors) {
  if (p[key] === undefined) return;
  if (!Array.isArray(p[key])) {
    errors.push(`${key} must be an array of strings`);
    return;
  }
  p[key].forEach((item, i) => {
    if (typeof item !== 'string') errors.push(`${key}[${i}] must be a string`);
  });
}

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

function warnReadonly(p, keys, warnings) {
  const present = keys.filter((k) => p[k] !== undefined);
  if (present.length > 0) {
    warnings.push(`server-set/read-only field(s) ${present.join(', ')} are ignored by the engine — build the payload from scratch, do not echo a GET response.`);
  }
}
