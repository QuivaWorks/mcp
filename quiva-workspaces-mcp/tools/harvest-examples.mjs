#!/usr/bin/env node
// Harvest real spaces, tasks and comments from the platform into
// examples/harvested/.
//
// Why: reference examples an agent learns from must be payloads that demonstrably
// work. Hand-written examples are exactly the pattern that shipped a wrong
// condition syntax in the flows MCP (see docs/lessons.md). These harvested files
// also serve as the golden fixtures for `npm test`: the local validator must
// accept every space/task/comment that is already live.
//
// They answer a second question too, the one flows had to learn the hard way:
// WHICH FIELDS DOES THE UI NEED THAT THE API DOES NOT REQUIRE? A flow built
// without node `position` rendered stacked at the origin. The board equivalent is
// space.statuses[].{color,order,complete,is_visible} and space.priorities[].{icon,
// icon_type,icon_color} — see the coverage report this script prints.
//
// PII: user identifiers (owner, created_by, reporter, author, assignees) and any
// email address are replaced. Task titles/descriptions are kept — they are the
// teaching content and this environment holds test data only.
//
// Usage: node tools/harvest-examples.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuivaClient } from '../src/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'examples', 'harvested');

// How many tasks to keep per space. Enough to show status/priority variety
// without turning the corpus into a data dump.
const TASKS_PER_SPACE = 4;

const REDACTED_USER = '<<REDACTED:user-id>>';
const REDACTED_EMAIL = '<<REDACTED:email>>';

const REDACTED_NAME = '<<REDACTED:person-name>>';

const USER_ID_KEYS = new Set(['owner', 'created_by', 'reporter', 'author', 'user_id', 'deleted_by']);
const USER_ID_ARRAY_KEYS = new Set(['assignees', 'watchers', 'mentions']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// Objects that are a USER SNAPSHOT rather than a resource: their `name` is a real
// person's name, not a label. time_tracking.logs[].user is the live example
// (model.TimeLogUser = { id, name }) — the id-and-email sweep alone left the name
// behind, which is how a colleague's name ended up in a harvested file on the
// first run. A space/status/priority `name` must NOT be caught by this, so match
// on the object's shape (exactly id + name) under a `user`-ish key, not on `name`
// anywhere.
const USER_OBJECT_KEYS = new Set(['user', 'author', 'created_by_user', 'assignee', 'owner']);

let redactions = 0;

function isUserSnapshot(key, value) {
  if (!USER_OBJECT_KEYS.has(key)) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.includes('name') && keys.every((k) => k === 'id' || k === 'name');
}

function redact(value, key = '') {
  if (isUserSnapshot(key, value)) {
    redactions += 2;
    return { ...(value.id !== undefined ? { id: REDACTED_USER } : {}), name: REDACTED_NAME };
  }
  if (typeof value === 'string') {
    if (USER_ID_KEYS.has(key) && value !== '') {
      redactions++;
      return REDACTED_USER;
    }
    if (EMAIL_RE.test(value)) {
      redactions++;
      return value.replace(EMAIL_RE, REDACTED_EMAIL);
    }
    if (UUID_RE.test(value)) {
      redactions++;
      return REDACTED_USER;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (USER_ID_ARRAY_KEYS.has(key)) {
      redactions += value.length;
      return value.map(() => REDACTED_USER);
    }
    return value.map((v) => redact(v, key));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

// --- what a space demonstrates, derived from the space itself ---------------

const STATUS_PRESENTATION = ['color', 'order', 'complete', 'is_visible'];
const PRIORITY_PRESENTATION = ['icon', 'icon_type', 'icon_color'];

function describeSpace(space) {
  const traits = [];
  const statuses = space.statuses ?? [];
  traits.push(`${statuses.length} custom board statuses (columns)`);

  const statusFields = new Set();
  for (const s of statuses) for (const k of Object.keys(s)) statusFields.add(k);
  const presentation = STATUS_PRESENTATION.filter((f) => statusFields.has(f));
  if (presentation.length) {
    traits.push(
      `statuses carry the board's presentation fields (${presentation.join(', ')}) — the API does not require them, the board reads them`
    );
  }
  if (statuses.some((s) => s.complete)) traits.push('a status flagged `complete: true` (the done state)');
  if (space.default_status) traits.push('default_status naming the column new tasks land in');
  if (space.priorities?.length) {
    traits.push(`${space.priorities.length} custom task priorities with icon presentation (${PRIORITY_PRESENTATION.join(', ')})`);
  }
  if (space.record_config_ids?.length) {
    traits.push(`record_config_ids linking the space to records configs (${space.record_config_ids.join(', ')})`);
  }
  if (space.tags?.length) traits.push('space-level tag vocabulary');
  if (space.default_view) traits.push(`default_view: "${space.default_view}"`);
  if (space.logo) traits.push('a logo');
  traits.push('read-only fields a create/update body must NOT echo back: owner, created_at, updated_at, url');
  return traits;
}

function describeTasks(tasks) {
  const traits = [`${tasks.length} real tasks with server-generated ids ({SPACEID}-{n})`];
  const fields = new Set();
  for (const t of tasks) for (const k of Object.keys(t)) fields.add(k);
  const notable = ['priority', 'status', 'folder', 'order', 'time_tracking', 'due_date', 'description', 'reporter'].filter((f) => fields.has(f));
  if (notable.length) traits.push(`task fields in live use: ${notable.join(', ')}`);
  const statuses = [...new Set(tasks.map((t) => t.status).filter(Boolean))];
  if (statuses.length) traits.push(`status values reference the SPACE's status ids: ${statuses.join(', ')}`);
  const priorities = [...new Set(tasks.map((t) => t.priority).filter(Boolean))];
  if (priorities.length) traits.push(`priority values reference the SPACE's priority ids: ${priorities.join(', ')}`);
  if (tasks.some((t) => t.url)) traits.push('url is server-built: /en/hub/spaces/{SPACE}/tasks?task={TASK-ID}');
  return traits;
}

function describeComments(comments) {
  const traits = [`${comments.length} real comment(s) with server-generated ids (c_<nanoid>)`];
  if (comments.some((c) => c.reactions !== undefined)) {
    traits.push('reactions is a map, `{}` when empty (react_to_comment writes { "<emoji>": true|false })');
  }
  if (comments.some((c) => c.subject)) traits.push('subject: ms.workspaces.task-comment.{TASK-ID}.{COMMENT-ID}');
  if (comments.some((c) => c.url)) traits.push('url anchors the comment: ...?task={TASK-ID}#comment-{COMMENT-ID}');
  traits.push('read-only fields a create/update body must NOT echo back: author, created_at, updated_at, url, reactions');
  return traits;
}

function write(slug, doc) {
  writeFileSync(join(OUT_DIR, `${slug}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  console.error(`  ${slug}`);
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.error(`harvesting from ${client.baseUrl}/workspaces`);

  const listed = await client.get('/workspaces/spaces');
  const spaces = listed?.results ?? [];
  if (spaces.length === 0) {
    console.error('no spaces on this environment — nothing to harvest');
    process.exit(1);
  }

  // Coverage of the presentation fields the board needs but the API does not
  // require. This is the number that justifies a validator warning.
  // Counted PER FIELD, not all-or-nothing: the fields differ in how load-bearing
  // they are, and an all-or-nothing number hides that.
  const coverage = {
    spaces: 0,
    statusesTotal: 0,
    prioritiesTotal: 0,
    status: Object.fromEntries(STATUS_PRESENTATION.map((f) => [f, 0])),
    priority: Object.fromEntries(PRIORITY_PRESENTATION.map((f) => [f, 0])),
    // Newer task fields (workspaces-service #1281). Sweeping the whole corpus is
    // how we learn whether an example that uses them is representative or the
    // first of its kind — the flows MCP shipped a wrong rules syntax precisely
    // because nobody counted.
    tasksTotal: 0,
    withTimeTracking: 0,
    withTimeLogs: 0,
    withEstimate: 0,
    withoutStatus: 0,
    spacesWithDefaultStatus: 0,
  };

  for (const space of spaces) {
    coverage.spaces++;
    if (space.default_status) coverage.spacesWithDefaultStatus++;
    for (const s of space.statuses ?? []) {
      coverage.statusesTotal++;
      for (const f of STATUS_PRESENTATION) if (s[f] !== undefined) coverage.status[f]++;
    }
    for (const p of space.priorities ?? []) {
      coverage.prioritiesTotal++;
      for (const f of PRIORITY_PRESENTATION) if (p[f] !== undefined) coverage.priority[f]++;
    }

    const clean = redact(space);
    write(`space-${space.id}`, {
      slug: `space-${space.id}`,
      kind: 'space',
      source: {
        environment: client.baseUrl,
        id: space.id,
        url: `https://app.microstrate.io/en/hub/spaces/${space.id}/tasks`,
        harvested_from: 'GET /workspaces/spaces',
      },
      teaches: describeSpace(space),
      config: clean,
    });

    // --- tasks in this space ---
    let tasks = [];
    try {
      const res = await client.get(`/workspaces/space/${encodeURIComponent(space.id)}/tasks`);
      tasks = res?.results ?? (Array.isArray(res) ? res : []);
    } catch (err) {
      console.error(`  (tasks for ${space.id}: ${err.message.slice(0, 80)})`);
    }
    for (const t of tasks) {
      coverage.tasksTotal++;
      if (!t.status) coverage.withoutStatus++;
      if (t.time_tracking) {
        coverage.withTimeTracking++;
        if (t.time_tracking.logs?.length) coverage.withTimeLogs++;
        if (t.time_tracking.estimate) coverage.withEstimate++;
      }
    }

    if (tasks.length === 0) continue;

    // Prefer variety: one task per distinct status, then fill.
    const bySpread = [];
    const seenStatus = new Set();
    for (const t of tasks) {
      if (!seenStatus.has(t.status)) {
        seenStatus.add(t.status);
        bySpread.push(t);
      }
    }
    for (const t of tasks) if (bySpread.length < TASKS_PER_SPACE && !bySpread.includes(t)) bySpread.push(t);
    const kept = bySpread.slice(0, TASKS_PER_SPACE);

    write(`tasks-${space.id}`, {
      slug: `tasks-${space.id}`,
      kind: 'tasks',
      source: {
        environment: client.baseUrl,
        space_id: space.id,
        harvested_from: `GET /workspaces/space/${space.id}/tasks (${kept.length} of ${tasks.length} kept)`,
      },
      teaches: describeTasks(kept),
      tasks: kept.map((t) => redact(t)),
    });

    // --- comments on those tasks ---
    for (const task of kept) {
      let comments = [];
      try {
        const res = await client.get(`/workspaces/task/${encodeURIComponent(task.id)}/comments`);
        comments = res?.results ?? (Array.isArray(res) ? res : []);
      } catch {
        continue;
      }
      if (comments.length === 0) continue;
      write(`comments-${task.id}`, {
        slug: `comments-${task.id}`,
        kind: 'comments',
        source: {
          environment: client.baseUrl,
          task_id: task.id,
          space_id: space.id,
          url: `https://app.microstrate.io/en/hub/spaces/${space.id}/tasks?task=${task.id}`,
          harvested_from: `GET /workspaces/task/${task.id}/comments`,
        },
        teaches: describeComments(comments),
        comments: comments.map((c) => redact(c)),
      });
      break; // one comment thread per space is enough
    }
  }

  console.error(`\n  ${coverage.spaces} space(s) harvested, ${redactions} value(s) redacted -> examples/harvested/`);
  console.error('\n  Board presentation-field coverage across live spaces (per field):');
  for (const f of STATUS_PRESENTATION) {
    console.error(`    statuses[].${f.padEnd(10)} ${coverage.status[f]}/${coverage.statusesTotal}`);
  }
  for (const f of PRIORITY_PRESENTATION) {
    console.error(`    priorities[].${f.padEnd(8)} ${coverage.priority[f]}/${coverage.prioritiesTotal}`);
  }
  console.error(
    '    -> The API requires only { id, name } on a status. Read the ratios before\n' +
      '       claiming a field is mandatory: a field set on EVERY live status is one an\n' +
      '       MCP-authored space should also set (omitting it makes the board render\n' +
      '       differently from every other space — the flow-editor-geometry defect\n' +
      '       again), while a field the platform itself omits is genuinely optional.'
  );

  console.error('\n  Newer task fields across the same corpus:');
  console.error(`    tasks scanned                    ${coverage.tasksTotal}`);
  console.error(`    with time_tracking               ${coverage.withTimeTracking}/${coverage.tasksTotal}`);
  console.error(`      ...with at least one log       ${coverage.withTimeLogs}/${coverage.tasksTotal}`);
  console.error(`      ...with an estimate            ${coverage.withEstimate}/${coverage.tasksTotal}`);
  console.error(`    with NO status                   ${coverage.withoutStatus}/${coverage.tasksTotal}`);
  console.error(`    spaces with a default_status     ${coverage.spacesWithDefaultStatus}/${coverage.spaces}`);
  console.error(
    '    -> time_tracking is new, so a low count means the field is young, not\n' +
      '       optional. `with NO status` is the population that createTask\'s new\n' +
      '       default_status fallback would now fill in — those tasks predate the\n' +
      '       change and still sit outside every board column.\n' +
      '    -> Task ACTIONS cannot be counted at all: the only GET route is misrouted\n' +
      '       at the write resource (see get_workspaces_reference("task-actions")),\n' +
      '       so there is no way to sweep them. Nothing here covers them.'
  );
}

main().catch((err) => {
  console.error('harvest failed:', err.message);
  process.exit(1);
});
