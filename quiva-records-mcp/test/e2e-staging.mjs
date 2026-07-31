#!/usr/bin/env node
// Live end-to-end check for the records MCP, driven over stdio so it exercises
// the real tool surface. Creates the Risk Programme config (schema + two form
// UIs), verifies the form ROUND-TRIPS intact, creates and updates a record
// against it, and includes negative controls for the documented traps.
//
// Usage: node test/e2e-staging.mjs            (deletes what it creates)
//        KEEP=1 node test/e2e-staging.mjs     (leave it for UI inspection)
//        CONFIG=<path.mjs> to supply a different config module

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_SH = join(HERE, '..', 'bin', 'run.sh');
const CONFIG_MODULE = process.env.CONFIG || join(HERE, 'fixtures', 'risk-programme.mjs');

let pass = 0;
let fail = 0;
const step = (ok, name, detail = '') => {
  if (ok) {
    pass++;
    console.log(`ok   ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
};

class McpStdio {
  constructor() {
    this.child = spawn('sh', [RUN_SH], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const r = this.pending.get(msg.id);
        if (r) {
          this.pending.delete(msg.id);
          r(msg);
        }
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 120000);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return p;
  }

  async call(name, args = {}) {
    const res = await this.send('tools/call', { name, arguments: args });
    const text = res?.result?.content?.[0]?.text ?? '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { data, isError: Boolean(res?.result?.isError), text };
  }

  close() {
    this.child.kill();
  }
}

// Walk a form layout collecting field nodes.
const fieldNodes = (layout) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'field') out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(layout);
  return out;
};

async function main() {
  const { config } = await import(CONFIG_MODULE);
  const mcp = new McpStdio();
  let created = false;

  try {
    await mcp.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-records', version: '0' },
    });

    // 1. Tool surface + harvested examples are reachable
    const tools = await mcp.send('tools/list', {});
    const names = (tools?.result?.tools ?? []).map((t) => t.name);
    for (const t of ['list_examples', 'get_example']) step(names.includes(t), `tool registered: ${t}`);
    const examples = await mcp.call('list_examples');
    step((examples.data?.featured ?? []).length > 0, 'harvested examples include a featured form config', examples.text.slice(0, 200));

    // 2. Local validation is clean before anything is sent
    const check = await mcp.call('validate_record_config', { config });
    step(check.data?.valid === true, 'validate_record_config: no errors', JSON.stringify(check.data?.errors));
    step((check.data?.warnings ?? []).length === 0, 'validate_record_config: no warnings', JSON.stringify(check.data?.warnings));

    // 3. Negative controls for the documented traps
    const withRef = JSON.parse(JSON.stringify(config));
    withRef.views.forms[0].layout.children[0].children[0] = { type: 'field', ref: 'type' };
    const refCheck = await mcp.call('validate_record_config', { config: withRef });
    step(refCheck.data?.valid === false, 'NEGATIVE: `ref` instead of `field` is rejected', JSON.stringify(refCheck.data?.errors));

    const flowsRule = JSON.parse(JSON.stringify(config));
    flowsRule.views.forms[0].layout.children[0].children[0].rules = [
      { condition: { operator: '=', input: ['$.type', 'policy'] }, outcome: true },
    ];
    const dialect = await mcp.call('validate_record_config', { config: flowsRule });
    step(
      dialect.data?.valid === false,
      'NEGATIVE: a flows-style { condition, outcome } rule is rejected in a form rule',
      JSON.stringify(dialect.data?.errors)
    );

    // 4. Create
    const create = await mcp.call('create_record_config', config);
    step(!create.isError && create.data?.created !== false, 'create_record_config succeeded', create.text.slice(0, 400));
    created = !create.isError;
    if (!created) throw new Error('cannot continue without the config');

    // 5. ROUND-TRIP — the check flows' original E2E lacked
    const fetched = await mcp.call('get_record_config', { id: config.id });
    const stored = fetched.data?.results?.[0] ?? fetched.data;
    step(Object.keys(stored?.schema?.properties ?? {}).length === Object.keys(config.schema.properties).length,
      `round-trip: all ${Object.keys(config.schema.properties).length} schema properties survived`,
      String(Object.keys(stored?.schema?.properties ?? {}).length));
    step((stored?.views?.forms ?? []).length === config.views.forms.length, 'round-trip: both forms survived');

    const sentFields = fieldNodes(config.views.forms[0].layout);
    const storedFields = fieldNodes(stored?.views?.forms?.[0]?.layout);
    step(storedFields.length === sentFields.length, `round-trip: ${sentFields.length} field nodes survived`, String(storedFields.length));
    step(storedFields.every((f) => f.inputType), 'round-trip: every field node kept its node-level inputType');
    step(storedFields.every((f) => f.props?.label), 'round-trip: every field node kept props.label');

    const storedRules = storedFields.filter((f) => Array.isArray(f.rules) && f.rules.length);
    step(storedRules.length >= 3, `round-trip: field-level form rules survived (${storedRules.length})`);
    step(
      storedRules.every((f) => f.rules.every((r) => r.property && r.logic !== undefined)),
      'round-trip: rules kept { property, logic }'
    );

    // Container-level visible rules (address/asset/payment groups)
    const containerRules = [];
    const walkGrids = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'grid' && Array.isArray(n.rules)) containerRules.push(...n.rules);
      for (const c of n.children ?? []) walkGrids(c);
    };
    walkGrids(stored?.views?.forms?.[0]?.layout);
    step(containerRules.length >= 3, `round-trip: container "visible" rules survived (${containerRules.length})`);
    step(containerRules.every((r) => r.property === 'visible'), 'round-trip: container rules are visible-only, as documented');

    // 6. A record against the config
    const record = {
      config_id: config.id,
      data: {
        type: 'policy',
        status: 'current',
        coverage_class: 'Commercial Property',
        inception_date: '2026-08-01',
        renewal_date: '2027-08-01',
        currency: 'AUD',
        subject_type: 'address',
        risk_address: { line1: '10 Collins St', suburb: 'Melbourne', state: 'VIC', postcode: '3000', country: 'Australia' },
        coverage_limits: [{ name: 'Material damage', amount: 25000000, basis: 'any one claim' }],
        excesses: [{ name: 'Material damage', amount: 10000, basis: 'each and every claim' }],
        insurers: [
          { insurer_name: 'Insurer A', share_pct: 60, is_lead: true, policy_number: 'POL-A-1' },
          { insurer_name: 'Insurer B', share_pct: 40, is_lead: false, policy_number: 'POL-B-1' },
        ],
        placed_by: 'Broking Team',
        premium: 48500,
        taxes: 4850,
        stamp_duty: 4365,
        fire_levy: 1200,
        brokerage_fee: 7275,
        payment_status: 'invoiced',
        payment_due_date: '2026-09-01',
      },
    };
    const createdRecord = await mcp.call('create_record', record);
    step(!createdRecord.isError, 'create_record against the new config succeeded', createdRecord.text.slice(0, 400));
    const recordId = createdRecord.data?.id ?? createdRecord.data?.results?.[0]?.id;
    step(Boolean(recordId), 'record id was server-generated', JSON.stringify(createdRecord.data).slice(0, 200));

    if (recordId) {
      const got = await mcp.call('get_record', { config_id: config.id, id: recordId });
      const gotData = got.data?.results?.[0]?.data ?? got.data?.data ?? got.data;
      step(gotData?.insurers?.length === 2, 'round-trip: the co-insurance panel stored both insurers', JSON.stringify(gotData?.insurers));
      step(
        gotData?.insurers?.reduce((s, i) => s + i.share_pct, 0) === 100,
        'co-insurance shares total 100%'
      );
      step(gotData?.risk_address?.postcode === '3000', 'nested object (risk_address) round-tripped');

      // PUT is a partial merge (documented engine truth) — prove it
      const updated = await mcp.call('update_record', {
        config_id: config.id,
        id: recordId,
        data: { payment_status: 'paid' },
      });
      step(!updated.isError, 'update_record (partial) succeeded', updated.text.slice(0, 300));
      const after = await mcp.call('get_record', { config_id: config.id, id: recordId });
      const afterData = after.data?.results?.[0]?.data ?? after.data?.data ?? after.data;
      step(afterData?.payment_status === 'paid', 'partial update applied');
      step(afterData?.coverage_class === 'Commercial Property', 'PUT MERGED rather than replaced (untouched fields survive)');

      if (!process.env.KEEP) {
        const del = await mcp.call('delete_record', { config_id: config.id, id: recordId });
        step(!del.isError, 'cleanup: record deleted');
      }
    }
  } catch (err) {
    fail++;
    console.error(`FAIL harness: ${err.message}`);
  } finally {
    if (created && !process.env.KEEP) {
      const del = await mcp.call('delete_record_config', { id: config.id });
      step(!del.isError, 'cleanup: config deleted');
      const list = await mcp.call('list_record_configs');
      const gone = !(list.data?.results ?? []).some((c) => c.id === config.id);
      step(gone, 'cleanup VERIFIED: config no longer listed');
    } else if (created) {
      console.log(`     KEEP=1 — config "${config.id}" left on the platform for UI inspection`);
    }
    mcp.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
