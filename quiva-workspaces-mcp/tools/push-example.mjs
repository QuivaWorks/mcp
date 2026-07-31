#!/usr/bin/env node
// Push the authored write-payload example onto the platform, then READ IT BACK
// and diff it, so the artefact can be checked in the UI.
//
// A write response is not proof: quiva-flows-mcp's delete_workflow returned
// {"message":"success"} while orphaning every draft (docs/quiva-mcp-handoff.md).
// So everything here is verified by re-reading, never by the write's own reply.
//
// Usage:
//   node tools/push-example.mjs            create + verify, LEAVE it on staging
//   node tools/push-example.mjs --cleanup  create + verify + delete + verify gone

import { QuivaClient } from '../src/client.js';
import { getExample } from '../src/examples.js';
import { validate } from '../src/validate.js';

const CLEANUP = process.argv.includes('--cleanup');
const UI = 'https://app.microstrate.io/en/hub/spaces';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const PLACEHOLDER_USER_ID = '00000000-0000-0000-0000-000000000000';

// A TimeLog's `user` is a snapshot the CLIENT supplies — the backend never fills
// it from the token (model.TimeLogUser is stored verbatim). So the example ships a
// placeholder rather than a real person's identity, and the live artefact gets the
// authenticated account substituted in here.
//
// `createdBy` is the task's created_by, i.e. the account this credential resolves
// to; list_users turns that uuid into the display name the UI expects.
async function withRealUser(client, timeTracking, createdBy) {
  let user = null;
  try {
    const listed = await client.get('/accounts/users/list');
    const users = listed?.data ?? listed?.results ?? [];
    const match =
      users.find((u) => u.id === createdBy) ??
      users.find((u) => u.id && u.id !== PLACEHOLDER_USER_ID);
    if (match) {
      const name = [match.first_name, match.last_name].filter(Boolean).join(' ') || match.email;
      user = { id: match.id, name };
    }
  } catch (err) {
    console.error(`  (could not resolve a real user: ${err.message.slice(0, 80)})`);
  }
  if (!user && createdBy) user = { id: createdBy, name: createdBy };
  if (!user) return timeTracking;

  return {
    estimate: timeTracking.estimate,
    logs: timeTracking.logs.map((log) => ({ ...log, user })),
  };
}

// Resolve the placeholder assignee/reporter uuids in the example onto real
// accounts. Same reasoning as withRealUser: an example file must not carry a
// colleague's identity, but the live artefact has to reference real users or the
// board shows an unassigned task.
//
// Matched on EMAIL, not name — staging has two accounts under one colleague's
// name (one role=admin, one role=client) and picking by name gets the wrong one.
async function withRealPeople(client, task, createdBy) {
  let users = [];
  try {
    const listed = await client.get('/accounts/users/list');
    users = listed?.data ?? listed?.results ?? [];
  } catch (err) {
    console.error(`  (could not resolve users: ${err.message.slice(0, 80)})`);
    return task;
  }
  if (!users.length) return task;

  const admins = users.filter((u) => u.role === 'admin' && u.id);
  // Assignee: the account this credential belongs to (whoever created the task).
  const assignee = users.find((u) => u.id === createdBy) ?? admins[0] ?? users[0];
  if (!assignee) return task;

  // Reporter: the account named by QUIVA_EMAIL, i.e. whoever is running this.
  //
  // It must be DETERMINISTIC. An earlier version picked "any admin that is not the
  // assignee", which silently reassigned the reporter to a different person on
  // every run as the account list changed — it overwrote a deliberately-set
  // reporter twice. If QUIVA_EMAIL is not set there is no principled choice, so
  // leave `reporter` alone rather than inventing one.
  const runnerEmail = (process.env.QUIVA_EMAIL ?? '').trim().toLowerCase();
  const reporter = runnerEmail
    ? users.find((u) => (u.email ?? '').toLowerCase() === runnerEmail)
    : undefined;
  if (!reporter) {
    console.log(
      `     (reporter left unchanged — set QUIVA_EMAIL to have it resolved${runnerEmail ? `; no account matches ${runnerEmail}` : ''})`
    );
    return {
      ...task,
      assignees: [assignee.id],
      reporter: undefined,
      _resolved_people: { assignee: assignee.email, reporter: null },
    };
  }

  return {
    ...task,
    assignees: [assignee.id],
    reporter: reporter.id,
    _resolved_people: {
      assignee: assignee.email,
      reporter: reporter.email,
    },
  };
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  const example = getExample('renewal-review-board');
  const spaceId = example.space.id.toUpperCase();
  console.log(`pushing "${example.slug}" to ${client.baseUrl}\n`);

  // --- local validation first: never send something the validator rejects ---
  for (const [kind, payload] of [
    ['space', example.space],
    ['task', example.task],
    ['task', { ...example.task, time_tracking: example.time_tracking }],
    ['comment', example.comment],
    ['task_action', example.task_action],
  ]) {
    const result = validate(kind, payload, { requireRequired: true });
    check(`local validate: ${kind}`, result.valid, result.errors.join('; '));
    if (!result.valid) process.exit(1);
  }

  // --- space ---
  // A space id that already exists returns 409; treat that as "reuse it" so the
  // script is re-runnable.
  try {
    await client.post('/workspaces/space', example.space);
    console.log(`ok   - created space ${spaceId}`);
  } catch (err) {
    if (err.status === 409) console.log(`ok   - space ${spaceId} already exists, reusing`);
    else throw err;
  }

  const readSpace = await client.get(`/workspaces/space/${spaceId}`);
  const space = readSpace?.results?.[0] ?? readSpace?.body ?? readSpace;
  check('space read back', space?.id === spaceId, `got ${JSON.stringify(space?.id)}`);
  check(
    'space id was uppercased server-side',
    space?.id === example.space.id.toUpperCase() && example.space.id !== space?.id,
    'the example deliberately sends a lowercase id'
  );
  check(
    'all 5 statuses persisted with their presentation fields',
    (space?.statuses ?? []).length === example.space.statuses.length &&
      (space?.statuses ?? []).every((s) => s.color !== undefined && s.order !== undefined && s.complete !== undefined),
    `statuses: ${JSON.stringify(space?.statuses)}`
  );
  check(
    'the Bound status kept complete: true (the board\'s done state)',
    (space?.statuses ?? []).some((s) => s.id === 'bound' && s.complete === true)
  );
  check(
    'all 3 priorities persisted with icon + icon_type + icon_color',
    (space?.priorities ?? []).length === 3 &&
      (space?.priorities ?? []).every((p) => p.icon && p.icon_type && p.icon_color),
    `priorities: ${JSON.stringify(space?.priorities)}`
  );

  // --- task ---
  // Re-runnable: task ids are server-generated from a per-space counter, so a
  // blind create on every run leaves -1, -2, -3... cluttering the board. Reuse
  // the one this example already made.
  const existingTasks = (await client.get(`/workspaces/space/${spaceId}/tasks`))?.results ?? [];
  const existing = existingTasks.find((t) => t.title === example.task.title);
  let taskId;
  if (existing) {
    taskId = existing.id;
    console.log(`ok   - task ${taskId} already exists for this example, reusing`);
  } else {
    const createdTask = await client.post('/workspaces/task', example.task);
    taskId = createdTask?.id ?? createdTask?.body?.id ?? createdTask?.results?.[0]?.id;
  }
  check('task has a server-generated id of the form {SPACEID}-{n}', typeof taskId === 'string' && taskId.startsWith(`${spaceId}-`), `got ${JSON.stringify(taskId)}`);

  const readTask = await client.get(`/workspaces/task/${taskId}`);
  const task = readTask?.results?.[0] ?? readTask?.body ?? readTask;
  check('task read back with the status we set', task?.status === example.task.status, `got ${JSON.stringify(task?.status)}`);
  check('task read back with the priority we set', task?.priority === example.task.priority, `got ${JSON.stringify(task?.priority)}`);
  check('task landed in the right space', task?.space_id === spaceId, `got ${JSON.stringify(task?.space_id)}`);

  // --- time tracking (workspaces-service #1281) ---
  // Four merge cases, each proved by re-reading rather than by the PATCH reply.
  // The order matters: the destructive cases are checked BEFORE the final state
  // is written, so the task is left holding the full example at the end.
  // The example ships a placeholder user snapshot on purpose — user.id/name are
  // client-supplied and the backend never derives them from the token, so an
  // example file must not hard-code a real person. Resolve the authenticated
  // account here instead, otherwise the UI attributes the entries to nobody.
  const timeTracking = await withRealUser(client, example.time_tracking, task?.created_by);
  check(
    'the placeholder user snapshot was replaced with a real account before sending',
    timeTracking.logs.every((l) => l.user?.id && l.user.id !== '00000000-0000-0000-0000-000000000000'),
    `still placeholder: ${JSON.stringify(timeTracking.logs.map((l) => l.user))}`
  );

  const readTimeTracking = async () => {
    const t = await client.get(`/workspaces/task/${taskId}`);
    return (t?.results?.[0] ?? t?.body ?? t)?.time_tracking ?? null;
  };
  const patchTask = (body) => client.patch(`/workspaces/task/${taskId}`, body);

  await patchTask({ time_tracking: timeTracking });
  let tt = await readTimeTracking();
  check(
    'time_tracking round-tripped with both logs and the estimate',
    tt?.estimate?.time_in_seconds === timeTracking.estimate.time_in_seconds &&
      (tt?.logs ?? []).length === timeTracking.logs.length,
    `got ${JSON.stringify(tt)}`
  );
  check(
    'the logs kept their client-supplied ids (the backend generates none)',
    timeTracking.logs.every((l) => (tt?.logs ?? []).some((s) => s.id === l.id)),
    `got ids ${JSON.stringify((tt?.logs ?? []).map((l) => l.id))}`
  );
  check(
    'nothing derived came back — total/remaining/progress are frontend-only',
    Object.keys(tt ?? {}).every((k) => k === 'estimate' || k === 'logs'),
    `got keys ${JSON.stringify(Object.keys(tt ?? {}))}`
  );

  // Case: time_tracking present but WITHOUT logs. The Go struct has no omitempty
  // on Logs, so this marshals as "logs":null — which LOOKS destructive and is not.
  await patchTask({ time_tracking: { estimate: { time_in_seconds: 10800 } } });
  tt = await readTimeTracking();
  check(
    'a time_tracking PATCH with no `logs` key PRESERVES the existing logs',
    (tt?.logs ?? []).length === timeTracking.logs.length && tt?.estimate?.time_in_seconds === 10800,
    `logs are load-bearing user data — if this ever fails the platform started dropping them. got ${JSON.stringify(tt)}`
  );

  // Case: logs[] replaces rather than appends. This is the trap the validator warns about.
  const [firstLog] = timeTracking.logs;
  await patchTask({ time_tracking: { logs: [firstLog] } });
  tt = await readTimeTracking();
  check(
    'sending one log REPLACES the array rather than appending to it',
    (tt?.logs ?? []).length === 1 && tt.logs[0].id === firstLog.id,
    `if this returns 2 logs the semantics changed to append and the docs/validator warning must be revised. got ${JSON.stringify((tt?.logs ?? []).map((l) => l.id))}`
  );

  // Restore the full example so the task is left in the state the docs describe.
  await patchTask({ time_tracking: timeTracking });
  tt = await readTimeTracking();
  check(
    'final state restored to the full example (estimate + both logs)',
    (tt?.logs ?? []).length === timeTracking.logs.length &&
      tt?.estimate?.time_in_seconds === timeTracking.estimate.time_in_seconds,
    `got ${JSON.stringify(tt)}`
  );

  // --- assignee + reporter ---
  // The example ships placeholder uuids; resolve them to real accounts here.
  // Verify on BOTH read routes: some live tasks store the `asignees` typo (one s),
  // which list_tasks surfaces and get_task does not, so agreement between the two
  // is the only proof the correct key was written.
  const people = await withRealPeople(client, example.task, task?.created_by);
  if (people._resolved_people) {
    const patch = { assignees: people.assignees };
    if (people.reporter) patch.reporter = people.reporter;
    await patchTask(patch);
    const viaGet = await client.get(`/workspaces/task/${taskId}`);
    const g = viaGet?.results?.[0] ?? viaGet?.body ?? viaGet;
    const viaList = ((await client.get(`/workspaces/space/${spaceId}/tasks`))?.results ?? []).find((t) => t.id === taskId);
    check(
      'assignee round-tripped on get_task',
      g?.assignees?.[0] === people.assignees[0],
      `got assignees=${JSON.stringify(g?.assignees)}`
    );
    if (people.reporter) {
      check('reporter round-tripped on get_task', g?.reporter === people.reporter, `got ${JSON.stringify(g?.reporter)}`);
    }
    check(
      'get_task and list_tasks AGREE on the assignee (proves `assignees` was written, not the `asignees` typo)',
      viaList?.assignees?.[0] === g?.assignees?.[0],
      `get_task=${JSON.stringify(g?.assignees)} list_tasks=${JSON.stringify(viaList?.assignees)} — a mismatch means the typo key was stored`
    );
    check(
      'the `asignees` typo key is absent',
      g?.asignees === undefined && viaList?.asignees === undefined,
      `get_task.asignees=${JSON.stringify(g?.asignees)} list_tasks.asignees=${JSON.stringify(viaList?.asignees)}`
    );
    console.log(`       assignee: ${people._resolved_people.assignee}  reporter: ${people._resolved_people.reporter ?? '(unchanged)'}`);
  }

  // --- default_status inheritance (behaviour change in the same release) ---
  const defaultStatusTitle = 'Renewal review — status inherited from the space default';
  let defaultStatusTaskId = existingTasks.find((t) => t.title === defaultStatusTitle)?.id;
  if (!defaultStatusTaskId) {
    const created = await client.post('/workspaces/task', {
      space_id: spaceId,
      title: defaultStatusTitle,
      description:
        'Created with NO `status` field. createTask now reads the space and fills in default_status, so this lands in Awaiting Info instead of outside every column.',
      priority: 'routine',
    });
    defaultStatusTaskId = created?.id ?? created?.body?.id;
  }
  const defaultStatusTask = await client.get(`/workspaces/task/${defaultStatusTaskId}`);
  const dst = defaultStatusTask?.results?.[0] ?? defaultStatusTask?.body ?? defaultStatusTask;
  check(
    'a task created with no `status` inherited the space default_status',
    dst?.status === space?.default_status && Boolean(dst?.status),
    `expected "${space?.default_status}", got ${JSON.stringify(dst?.status)} — before workspaces-service #1281 this was ""`
  );

  // --- task action (write-only; see below) ---
  await client.put(`/workspaces/task/${taskId}/action`, example.task_action);
  console.log('ok   - task action written (PUT returned 200)');
  let actionGetFailed = false;
  let actionGetError = '';
  try {
    await client.get(`/workspaces/task/${taskId}/action`);
  } catch (err) {
    actionGetFailed = true;
    actionGetError = err.body?.error ?? err.message ?? '';
  }
  check(
    'GET .../action still 400s "description is required" — it is mapped at the WRITE resource',
    actionGetFailed && /description is required/.test(actionGetError),
    `got ${actionGetFailed ? actionGetError : 'a SUCCESSFUL response'}. If this GET now works, the gateway mapping was fixed: point it at get.task-actions, drop the "write-only" language from the docs, and add a list_task_actions tool.`
  );
  console.log('       -> so the action above is UNVERIFIED: there is no read path for it.');

  const actionDeleted = await client.delete(
    `/workspaces/task/${taskId}/action/${example.task_action.id}`
  );
  check(
    'the action can at least be deleted by the id we supplied',
    actionDeleted?.message === 'success' || actionDeleted?.body?.message === 'success',
    `got ${JSON.stringify(actionDeleted)}`
  );
  // Re-write it so the artefact carries one, even though nothing can read it.
  await client.put(`/workspaces/task/${taskId}/action`, example.task_action);

  // --- comment + reaction ---
  const existingComments = (await client.get(`/workspaces/task/${taskId}/comments`))?.results ?? [];
  const reusedComment = existingComments.find((c) => c.body === example.comment.body);
  let commentId;
  if (reusedComment) {
    commentId = reusedComment.id;
    console.log(`ok   - comment ${commentId} already exists for this example, reusing`);
  } else {
    const createdComment = await client.post(`/workspaces/task/${taskId}/comment`, example.comment);
    commentId = createdComment?.id ?? createdComment?.body?.id ?? createdComment?.results?.[0]?.id;
  }
  check('comment has a c_<nanoid> id', typeof commentId === 'string' && commentId.startsWith('c_'), `got ${JSON.stringify(commentId)}`);

  await client.post(`/workspaces/task/${taskId}/comment/${commentId}/reaction`, example.reaction);
  const readComments = await client.get(`/workspaces/task/${taskId}/comments`);
  const comments = readComments?.results ?? (Array.isArray(readComments) ? readComments : []);
  const comment = comments.find((c) => c.id === commentId);
  check('comment read back', comment?.body === example.comment.body);
  check(
    'reaction read back on the comment',
    Boolean(comment?.reactions) && Object.keys(comment.reactions).length > 0,
    `reactions: ${JSON.stringify(comment?.reactions)}`
  );

  console.log(`\nCheck it in the UI:`);
  console.log(`  Board : ${UI}/${spaceId}/tasks`);
  console.log(`  Task  : ${UI}/${spaceId}/tasks?task=${taskId}`);
  console.log(`  Task 2: ${UI}/${spaceId}/tasks?task=${defaultStatusTaskId}`);
  console.log(`  What to look for:`);
  console.log(`    - five columns in order (Awaiting Info, In Review, Referred to`);
  console.log(`      Underwriter, Quoted, Bound) with their colours, Bound as the`);
  console.log(`      completed column`);
  console.log(`    - the main task in In Review with an Urgent priority icon and one`);
  console.log(`      comment carrying an eyes reaction`);
  console.log(`    - open that task: a 2h estimate, 1h30m logged across two entries,`);
  console.log(`      and a progress bar — all derived in the browser from time_tracking`);
  console.log(`    - the second task sits in Awaiting Info although it was created with`);
  console.log(`      no status at all (the new default_status inheritance)`);
  console.log(`    - the task action is NOT visible anywhere: no component reads them`);
  console.log(`      yet, and the API has no working route to list them`);

  if (CLEANUP) {
    console.log('\ncleaning up (deletes are verified, not trusted)');
    await client.delete(`/workspaces/task/${defaultStatusTaskId}`);
    await client.delete(`/workspaces/task/${taskId}`);
    let taskGone = false;
    try {
      const after = await client.get(`/workspaces/task/${taskId}`);
      const t = after?.results?.[0] ?? after?.body ?? after;
      taskGone = !t || !t.id;
    } catch {
      taskGone = true;
    }
    check('task really deleted (verified by re-read, not by the success message)', taskGone);

    await client.delete(`/workspaces/space/${spaceId}`);
    const spaces = (await client.get('/workspaces/spaces'))?.results ?? [];
    check('space really deleted', !spaces.some((s) => s.id === spaceId));
  } else {
    console.log('\nLeft on staging. Re-run with --cleanup to remove it.');
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err) => {
  console.error('push failed:', err.message, err.body ? JSON.stringify(err.body).slice(0, 300) : '');
  process.exit(1);
});
