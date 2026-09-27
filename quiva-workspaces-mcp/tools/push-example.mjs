#!/usr/bin/env node
// Push the authored example and read it back: a write response is not proof (docs/lessons.md).
// --cleanup also deletes it and verifies it is gone. Refuses production without --allow-production.

import { QuivaClient } from '../src/client.js';
import { getExample } from '../src/examples.js';
import { validate } from '../src/validate.js';

const CLEANUP = process.argv.includes('--cleanup');
const PRODUCTION = 'https://api.quiva.ai';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `read` until `done(value)` or the timeout; returns the last value.
async function until(read, done, timeoutMs = 20_000) {
  const started = Date.now();
  let value = await read();
  while (!done(value) && Date.now() - started < timeoutMs) {
    await sleep(1500);
    value = await read();
  }
  return value;
}

// The example's people are placeholders. Strip them rather than assign a real
// colleague, which would notify them.
function withoutPeople(task) {
  const { assignees, reporter, _people_note, ...rest } = task;
  return rest;
}

async function main() {
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  if (client.baseUrl === PRODUCTION && !process.argv.includes('--allow-production')) {
    console.error('Refusing to write test data to production. Point QUIVA_API_URL at staging.');
    process.exit(1);
  }
  const example = getExample('review-board');
  const spaceId = example.space.id.toUpperCase();
  const ui = `${client.baseUrl.replace('//api.', '//app.')}/en/hub/spaces`;
  console.log(`pushing "${example.slug}" to ${client.baseUrl}\n`);

  for (const [kind, payload] of [
    ['space', example.space],
    ['task', example.task],
    ['task', example.subtask],
    ['task', example.identity_task],
    ['comment', example.comment],
    ['task_action', example.task_action],
    ['contact', example.contact],
    ...example.time_logs.map((l) => ['time_log', l]),
  ]) {
    const result = validate(kind, payload, { requireRequired: true });
    check(`local validate: ${kind}`, result.valid, result.errors.join('; '));
    if (!result.valid) process.exit(1);
  }

  // --- space ---
  try {
    await client.post('/workspaces/space', example.space);
    console.log(`ok   - created space ${spaceId}`);
  } catch (err) {
    if (err.status === 409) console.log(`ok   - space ${spaceId} already exists, reusing`);
    else throw err;
  }
  const space = await client.get(`/workspaces/space/${spaceId}`);
  check('space read back with its uppercased id', space?.id === spaceId, `got ${JSON.stringify(space?.id)}`);
  const roles = Object.fromEntries((space?.statuses ?? []).map((s) => [s.id, s.role]));
  check(
    'status roles persisted',
    example.space.statuses.every((s) => (s.role ?? undefined) === (roles[s.id] ?? undefined)),
    `got ${JSON.stringify(roles)}`
  );
  check(
    'base_record persisted with create_login_on_create false',
    space?.base_record?.config_id === example.space.base_record.config_id && space.base_record.create_login_on_create === false,
    `got ${JSON.stringify(space?.base_record)}`
  );

  // --- task ---
  const createdTask = await client.post('/workspaces/task', withoutPeople(example.task));
  const taskId = createdTask?.id;
  check('task id is {SPACEID}-{n}', typeof taskId === 'string' && taskId.startsWith(`${spaceId}-`), `got ${JSON.stringify(taskId)}`);
  let task = await client.get(`/workspaces/task/${taskId}`);
  check('task read back with the status we set', task?.status === example.task.status, `got ${JSON.stringify(task?.status)}`);
  check(
    'estimate stored and hydrated with spent 0',
    task?.time_tracking?.estimate?.time_in_seconds === 7200 && task?.time_tracking?.spent?.time_in_seconds === 0,
    `got ${JSON.stringify(task?.time_tracking)}`
  );

  // --- time logs ---
  const [first, second] = example.time_logs;
  const afterFirst = await client.put(`/workspaces/task/${taskId}/time-log`, first);
  // The second carries client-minted fields on purpose: the server must ignore them.
  const afterSecond = await client.put(`/workspaces/task/${taskId}/time-log`, { ...second, id: 'client_minted', user: { id: 'nobody', name: 'Nobody' } });
  check('add_time_log returns the hydrated view', Array.isArray(afterFirst?.logs) && afterFirst.logs.length === 1, `got ${JSON.stringify(afterFirst)}`);
  const logs = afterSecond?.logs ?? [];
  check('two logs, both with server-minted tl_ ids', logs.length === 2 && logs.every((l) => /^tl_/.test(l.id)), `got ${JSON.stringify(logs.map((l) => l.id))}`);
  check('client-sent id and user were ignored', !logs.some((l) => l.id === 'client_minted' || l.user?.id === 'nobody'));
  check('user stamped from the credential', logs.every((l) => l.user?.id), `got ${JSON.stringify(logs.map((l) => l.user?.id ? 'set' : 'empty'))}`);
  check(
    'totals hydrated server-side: spent 5400, remaining 1800, progress 75',
    afterSecond?.spent?.time_in_seconds === 5400 && afterSecond?.remaining?.time_in_seconds === 1800 && afterSecond?.progress_percent === 75,
    `got ${JSON.stringify({ spent: afterSecond?.spent, remaining: afterSecond?.remaining, progress: afterSecond?.progress_percent })}`
  );
  const listed = await client.get(`/workspaces/task/${taskId}/time-log`);
  check('list_time_logs returns both', listed?.results_total === 2, `got ${JSON.stringify(listed?.results_total)}`);
  task = await client.get(`/workspaces/task/${taskId}`);
  check('get_task hydrates the same logs', task?.time_tracking?.logs?.length === 2);
  let rejected = '';
  try {
    await client.put(`/workspaces/task/${taskId}/time-log`, { time_spent: { time_in_seconds: 0 }, started_at: first.started_at });
  } catch (err) {
    rejected = `${err.status} ${err.body?.error ?? ''}`;
  }
  check('a zero-second log is refused', rejected.startsWith('400'), `got ${rejected || 'success'}`);

  // --- task actions move the status by role (the write is async to the status) ---
  const readStatus = async () => (await client.get(`/workspaces/task/${taskId}`))?.status;
  await client.put(`/workspaces/task/${taskId}/action`, example.task_action);
  let status = await until(readStatus, (s) => s === 'awaiting_info');
  check('one open action -> the todo role (awaiting_info)', status === 'awaiting_info', `got ${status}`);
  await client.put(`/workspaces/task/${taskId}/action`, { ...example.task_action, done: true });
  status = await until(readStatus, (s) => s === 'approved');
  check('all actions done -> the done role (approved)', status === 'approved', `got ${status}`);
  await client.put(`/workspaces/task/${taskId}/action`, { id: 'ta_second', description: 'A second check' });
  status = await until(readStatus, (s) => s === 'in_review');
  check('some actions done -> the working role (in_review)', status === 'in_review', `got ${status}`);
  task = await client.get(`/workspaces/task/${taskId}`);
  check('get_task returns both actions', (task?.task_actions ?? []).length === 2);
  const viaRoute = await client.get(`/workspaces/task/${taskId}/action`).catch((err) => ({ error: `${err.status} ${err.body?.error ?? ''}` }));
  check('GET .../action returns the list', viaRoute?.results_total === 2, `got ${JSON.stringify(viaRoute).slice(0, 200)}`);

  // --- sub-task ---
  const sub = await client.post('/workspaces/task', { ...example.subtask, parent: taskId });
  check('sub-task created with parent', sub?.parent === taskId, `got ${JSON.stringify(sub?.parent)}`);
  let nestedRejected = '';
  try {
    await client.post('/workspaces/task', { space_id: spaceId, title: 'mcp-test nested', parent: sub.id });
  } catch (err) {
    nestedRejected = `${err.status} ${err.body?.error ?? ''}`;
  }
  check('a sub-task of a sub-task is refused (one level)', nestedRejected.startsWith('400'), `got ${nestedRejected || 'success'}`);
  const children = await until(
    () => client.get(`/workspaces/space/${spaceId}/tasks`, { parent: taskId }),
    (r) => (r?.results ?? []).some((t) => t.id === sub.id)
  );
  check('list_tasks parent= finds the sub-task', (children?.results ?? []).some((t) => t.id === sub.id));

  // --- contact + identity task ---
  check('the space does not enrol contacts', space?.base_record?.create_login_on_create === false);
  let contact = null;
  try {
    contact = await client.post('/workspaces/client', example.contact);
  } catch (err) {
    check('create_contact', false, `${err.status} ${JSON.stringify(err.body)}`);
  }
  if (contact) {
    check('contact written with a folder and record id', Boolean(contact.folder && contact.id), `got ${JSON.stringify({ id: contact.id, folder: contact.folder })}`);
    check('no sign-in created', contact.login_created === false, `got ${JSON.stringify({ login_created: contact.login_created, login_skipped: contact.login_skipped })}`);
    const linked = await client.post('/workspaces/task', example.identity_task);
    check('identity task linked without base_record_skipped', !linked?.base_record_skipped, `skipped: ${linked?.base_record_skipped}`);
    check(
      'identity task landed on the contact\'s folder',
      linked?.folder === `spaces.${spaceId}.${contact.folder}`,
      `task folder ${JSON.stringify(linked?.folder)} vs contact ${JSON.stringify(contact.folder)} — no folder and no base_record_skipped means the deployed build ignores \`identity\``
    );
    contact.identityTaskId = linked?.id;
  }

  // --- comment + reaction ---
  const comment = await client.post(`/workspaces/task/${taskId}/comment`, example.comment);
  await client.post(`/workspaces/task/${taskId}/comment/${comment.id}/reaction`, example.reaction);
  const readComment = await client.get(`/workspaces/task/${taskId}/comment/${comment.id}`);
  check('comment and reaction read back', readComment?.body === example.comment.body && Object.keys(readComment?.reactions ?? {}).length > 0);

  console.log(`\nBoard: ${ui}/${spaceId}/tasks  Task: ${ui}/${spaceId}/tasks?task=${taskId}`);

  if (CLEANUP) {
    console.log('\ncleaning up (deletes are verified, not trusted)');
    if (contact?.identityTaskId) await client.delete(`/workspaces/task/${contact.identityTaskId}`);
    await client.delete(`/workspaces/task/${taskId}`, { delete_subtasks: 'true' });
    const gone = async (id) => client.get(`/workspaces/task/${id}`).then((t) => !t?.id, () => true);
    check('task deleted', await gone(taskId));
    check('sub-task deleted with delete_subtasks', await gone(sub.id));
    if (contact?.id) {
      await client.delete(`/records/${example.space.base_record.config_id}/${contact.id}`);
      const recordGone = await client.get(`/records/${example.space.base_record.config_id}/${contact.id}`).then((r) => !r?.id && !r?.data, () => true);
      check('contact record deleted', recordGone);
    }
    await client.delete(`/workspaces/space/${spaceId}`);
    const spaces = (await client.get('/workspaces/spaces'))?.results ?? [];
    check('space deleted', !spaces.some((s) => s.id === spaceId));
  } else {
    console.log('\nLeft in place. Re-run with --cleanup to remove it.');
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
