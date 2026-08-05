// Local validator for workspaces payloads — no API call. Encodes the rules the
// workspaces-service enforces (handler/{spaces,tasks,comments}.go, model/api.go)
// plus lints for the spec-vs-engine gotchas, so mistakes are caught before a
// POST/PATCH.
//
// validate(kind, payload, { requireRequired }) where kind is one of:
//   'space' | 'task' | 'multi_task' | 'comment' | 'reaction' | 'task_action'
// requireRequired defaults to true (create). Pass false for update payloads.

import { VERTICAL_SPACE_ID, VERTICAL_CONFIG_TYPES, FOLDER_MARKERS, VERTICAL_NON_DEPLOYING_FOLDERS } from './workspaces-docs.js';

const SPACE_ID_REGEX = /^\w+$/; // letters, numbers, underscore only
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Read-only / server-set fields that should never be sent in a create/update
// body (the engine ignores them; echoing a GET response back is the #1 mistake).
const SPACE_READONLY = ['owner', 'created_at', 'updated_at', 'url'];
const TASK_READONLY = ['created_at', 'updated_at', 'created_by', 'url', 'watchers', 'muted'];
const COMMENT_READONLY = ['author', 'created_at', 'updated_at', 'url', 'reactions'];

const VALID_KINDS = ['space', 'task', 'multi_task', 'comment', 'reaction', 'task_action', 'folder', 'file'];

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
    case 'folder': validateFolder(payload, errors, warnings); break;
    case 'file': validateFile(payload, errors, warnings); break;
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
        `vertical id "${segs[2]}" is not lower_snake_case. Existing verticals are (financial_advisor, insurance_broker, uig), and accounts-service derives the flow COLLECTION name by splitting the id on "_" and title-casing each part — so anything else produces an odd collection name.`
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
