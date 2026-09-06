#!/usr/bin/env node
// Create + publish a flow whose entry point is a RECORD trigger, then fire it by
// writing a record — the artefact for checking hub-service's record dispatch in
// the UI.
//
// This exists because the record trigger has two rules you cannot guess:
//
//   1. The trigger node's id MUST be exactly `record.<record_config_id>`.
//      hub-service finds trigger nodes by GLOB on the node subject
//      (`ms.hub.config.workflow-node.*.*.record.<configID>`, service/service.go
//      recordTriggerNodeSubject), and a node subject is the flow subject with
//      ".workflow." swapped for ".workflow-node." plus "." + node.id. Any other
//      id and the trigger silently never fires.
//
//   2. That id contains a dot, which hub-service validate.ValidateID rejects — so
//      the create MUST go out with validate=false or it is refused outright.
//
// And one more that only bites at runtime: the glob has exactly two wildcards
// (collection, flow), so it matches PUBLISHED node subjects only. A draft carries
// an extra ".draft." token and never matches. Hence the publish step.
//
// Usage:
//   node tools/push-record-trigger.mjs            create + publish, leave it live
//   node tools/push-record-trigger.mjs --fire     also write a record to trigger it
//   node tools/push-record-trigger.mjs --cleanup  delete the flow afterwards

import { QuivaClient, subjectToTopics } from '../src/client.js';
import { validate } from '../src/validate.js';
import { applyGeometry } from '../src/geometry.js';

const FIRE = process.argv.includes('--fire');
const CLEANUP = process.argv.includes('--cleanup');

const COLLECTION_ID = '805092869';
const COLLECTION = `ms.hub.config.collection.workflow.${COLLECTION_ID}`;
const RECORD_CONFIG = 'risk_programme';
const FLOW_NAME = 'mcp-verification-record-trigger';
// Rule 1: this is not a free choice.
const TRIGGER_NODE_ID = `record.${RECORD_CONFIG}`;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

// $.trigger is the whole record ({ id, data, folder, space_id, completed,
// created_at, updated_at }), so the eval node proves what the trigger delivered.
const config = {
  nodes: [
    {
      id: TRIGGER_NODE_ID,
      data: {
        id: TRIGGER_NODE_ID,
        name: `On ${RECORD_CONFIG} record`,
        node_type: 'trigger',
        trigger_type: 'record',
        payload: {
          record_config_id: RECORD_CONFIG,
          event_type: ['record-created', 'record-updated'],
        },
      },
    },
    {
      id: 'ECHO_RECORD',
      data: {
        id: 'ECHO_RECORD',
        name: 'Echo the triggering record',
        node_type: 'eval',
        payload: {
          code: '({ received_record_id: r && r.id, received_data: r && r.data, fired: true })',
          params: { r: '$.trigger' },
        },
      },
    },
  ],
  edges: [{ id: 'e_trigger_echo', source: TRIGGER_NODE_ID, target: 'ECHO_RECORD' }],
};

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  console.log(`pushing "${FLOW_NAME}" to ${client.baseUrl}\n`);

  // --- local validation: the dotted id must be a WARNING, not an error ---
  const validation = validate(config);
  check('local validate accepts the dotted record-trigger id', validation.valid, validation.errors.join('; '));
  check(
    'local validate warns that server-side validation will reject it',
    validation.warnings.some((w) => w.includes('server_validate=false')),
    JSON.stringify(validation.warnings)
  );
  if (!validation.valid) process.exit(1);

  const { config: laidOut } = applyGeometry(config);

  // --- create (re-runnable: reuse the existing draft) ---
  const findFlow = async (version) => {
    const listed = await client.get('/hub/workflows', version ? { version } : undefined);
    return (listed?.results ?? []).find((w) => w.name === FLOW_NAME);
  };

  let draftSubject = (await findFlow())?.subject;
  if (draftSubject) {
    console.log(`ok   - flow already exists, updating ${draftSubject}`);
    const { collectionTopic, flowTopic } = subjectToTopics(draftSubject);
    await client.patch(
      `/hub/workflows/${collectionTopic}/${flowTopic}`,
      { subject: draftSubject, config: laidOut },
      // Rule 2 again — an update is refused the same way a create is.
      { validate: 'false', draft: 'true' }
    );
  } else {
    // Rule 2: validate=false or the dotted node id is rejected outright.
    const created = await client.post(
      '/hub/workflows',
      {
        name: FLOW_NAME,
        description:
          'Fires when a risk_programme record is written with completed:true. Proves hub-service record dispatch: the trigger node id must be record.<config_id> and the flow must be PUBLISHED.',
        collection: COLLECTION,
        config: laidOut,
      },
      { validate: 'false' }
    );
    draftSubject = created?.subject ?? created?.body?.subject ?? (await findFlow())?.subject;
  }
  check('draft created/updated', Boolean(draftSubject), JSON.stringify(draftSubject));
  check('the draft subject carries the .draft. segment', String(draftSubject).includes('.draft.'), `got ${draftSubject}`);

  // Prove rule 2 is real rather than assumed: the same config with validation ON
  // must be refused, and for the node id specifically.
  let serverRejected = false;
  let serverError = '';
  try {
    await client.post(
      '/hub/workflows',
      { name: `${FLOW_NAME}-validate-probe`, collection: COLLECTION, config: laidOut },
      { validate: 'true' }
    );
  } catch (err) {
    serverRejected = true;
    serverError = JSON.stringify(err.body ?? err.message).slice(0, 200);
  }
  check(
    'server-side validation REJECTS the dotted trigger node id (so validate=false is mandatory)',
    serverRejected,
    `the create with validate=true SUCCEEDED — ValidateID may have been relaxed; if so the validator warning and docs can be softened. ${serverError}`
  );

  // --- read back the draft and confirm the node id survived verbatim ---
  const draftTopics = subjectToTopics(draftSubject);
  const readDraft = await client.get(
    `/hub/workflows/${draftTopics.collectionTopic}/${draftTopics.flowTopic}`,
    { draft: 'true' }
  );
  const draftCfg = readDraft?.config ?? readDraft?.body?.config ?? readDraft;
  const triggerNode = (draftCfg?.nodes ?? []).find((n) => n.data?.node_type === 'trigger');
  check('trigger node read back', Boolean(triggerNode), JSON.stringify(draftCfg?.nodes?.map((n) => n.id)));
  check(
    `the trigger node id is exactly "${TRIGGER_NODE_ID}"`,
    triggerNode?.id === TRIGGER_NODE_ID && triggerNode?.data?.id === TRIGGER_NODE_ID,
    `got ${JSON.stringify(triggerNode?.id)} / ${JSON.stringify(triggerNode?.data?.id)} — anything else and the glob never matches, so the trigger silently never fires`
  );
  check(
    'trigger_type is "record" and the config id is on the payload',
    triggerNode?.data?.trigger_type === 'record' &&
      triggerNode?.data?.payload?.record_config_id === RECORD_CONFIG,
    JSON.stringify(triggerNode?.data)
  );

  // --- publish: the glob only matches published node subjects ---
  await client.post('/hub/workflows/publish', { subject: draftSubject });
  const published = await findFlow('published');
  check(
    'flow published (a record trigger on a DRAFT never matches the dispatch glob)',
    Boolean(published?.subject) && !published.subject.includes('.draft.'),
    `got ${JSON.stringify(published?.subject)}`
  );
  const publishedSubject = published?.subject;

  // The published NODE subject is what hub-service actually globs against.
  const expectedNodeSubject = `${String(publishedSubject).replace('.workflow.', '.workflow-node.')}.${TRIGGER_NODE_ID}`;
  console.log(`     node subject hub-service will match: ${expectedNodeSubject}`);
  console.log(`     dispatch glob:                       ms.hub.config.workflow-node.*.*.record.${RECORD_CONFIG}`);
  const globParts = expectedNodeSubject.replace('ms.hub.config.workflow-node.', '').split('.');
  check(
    'the published node subject has exactly the 4 segments the glob expects (collection, flow, "record", configId)',
    globParts.length === 4 && globParts[2] === 'record' && globParts[3] === RECORD_CONFIG,
    `got ${globParts.length} segments: ${JSON.stringify(globParts)} — a draft has 5 and never matches`
  );

  // --- fire it by writing a record ---
  if (FIRE) {
    console.log('\nfiring the trigger by creating a record with completed:true');
    const record = await client.post(`/records/${RECORD_CONFIG}`, {
      validate: false,
      completed: true,
      data: { probe: 'record-trigger artefact', fired_at_utc_note: 'see flow run' },
    });
    const recordId = record?.id ?? record?.body?.id;
    check('record created', Boolean(recordId), JSON.stringify(record).slice(0, 200));
    console.log(`     record id: ${recordId}`);
    console.log(
      '     NOTE: the publish is async and fire-and-forget (records-service RepublishRecord\n' +
        '     runs in a goroutine), so the 200 above says nothing about whether a flow ran.\n' +
        '     There is currently NO read channel for an async run: POST /hub/run-logs/search\n' +
        '     does not surface runs that certainly executed (proved by a manual awaited run),\n' +
        '     and workflow history lists config versions, not runs. So confirm this in the UI.'
    );
    console.log(`     Leaving record ${recordId} in place so the run is inspectable.`);
  } else {
    console.log('\n(skipped firing — pass --fire to write a record and trigger the flow)');
  }

  console.log('\nCheck it in the UI:');
  console.log(`  Collection : https://app.microstrate.io/en/hub/flows?collection=${COLLECTION}`);
  console.log(`  Flow name  : ${FLOW_NAME}`);
  console.log(`  Published  : https://app.microstrate.io/en/hub/flows/${String(publishedSubject).split('.').join('+')}`);
  console.log(`  Draft      : https://app.microstrate.io/en/hub/flows/${String(draftSubject).split('.').join('+')}`);
  console.log('  What to look for: the entry node is a Record trigger bound to');
  console.log(`  "${RECORD_CONFIG}" with event types record-created / record-updated, wired`);
  console.log('  into an eval node that echoes the triggering record.');

  if (CLEANUP) {
    console.log('\ncleaning up (deletes are verified, not trusted — delete_workflow once');
    console.log('returned {"message":"success"} while orphaning every draft)');
    // draft=true resolves to the DRAFT subject, which deletes both versions.
    const del = subjectToTopics(draftSubject);
    await client.delete(`/hub/workflows/${del.collectionTopic}/${del.flowTopic}`, { draft: 'true' });
    const stillPublished = await findFlow('published');
    const stillDraft = await findFlow();
    check('flow really gone (published)', !stillPublished, `still listed: ${stillPublished?.subject}`);
    check('flow really gone (draft — the orphan case)', !stillDraft, `still listed: ${stillDraft?.subject}`);
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
  console.error('push failed:', err.message, err.body ? JSON.stringify(err.body).slice(0, 400) : '');
  process.exit(1);
});
