#!/usr/bin/env node
// Pull, diff, push and copy Quiva account configuration over the public API.
// Writes are dry runs unless --yes is passed; secret values are never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Production only. QUIVA_API_URL points the script at another deployment, as the MCP servers do.
const HOST = (process.env.QUIVA_API_URL || 'https://api.quiva.ai').replace(/\/+$/, '');
const CONFIG_DIR = process.env.QUIVA_CONFIG_DIR || path.join(os.homedir(), '.config', 'quiva');
const PROFILES = path.join(CONFIG_DIR, 'profiles.json');
const INBOX = path.join(CONFIG_DIR, 'inbox');
const ROOT = path.resolve(process.env.QUIVA_DIR || '.quiva');
const DRY_RUN = 3;

// ---------- args, output ----------

const VALUE_FLAGS = new Set(['env', 'account', 'as', 'space', 'from-file', 'collection']);
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const [k, v] = a.slice(2).split('=', 2);
  if (v !== undefined) flags[k] = v;
  else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(k)) flags[k] = argv[++i];
  else flags[k] = true;
}
function die(msg, code = 1) { console.error(scrub(`error: ${msg}`)); process.exit(code); }
const secretsInFlight = new Set();
// Every value this process has touched is masked from anything it prints.
function scrub(s) {
  let out = String(s);
  for (const v of secretsInFlight) if (v) out = out.split(v).join('[secret]');
  return out;
}
const say = (s = '') => console.log(scrub(s));
const pretty = (o) => JSON.stringify(sortKeys(o), null, 2) + '\n';
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  return o;
}
const omit = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.includes(k)));
const pick = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => keys.includes(k)));

// ---------- profiles ----------

function loadProfiles() {
  if (!fs.existsSync(PROFILES)) return {};
  const mode = fs.statSync(PROFILES).mode & 0o777;
  if (mode & 0o077) console.error(`warning: ${PROFILES} is mode ${mode.toString(8)}; run: chmod 600 ${PROFILES}`);
  return JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
}
function saveProfiles(p) {
  fs.mkdirSync(path.dirname(PROFILES), { recursive: true, mode: 0o700 });
  fs.writeFileSync(PROFILES, JSON.stringify(p, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(PROFILES, 0o600);
}
function profile(name) {
  if (!name) die('profile name required');
  const p = loadProfiles()[name];
  if (!p) die(`no profile "${name}". Ask the user to run, in their own terminal:\n  node ${rel(process.argv[1])} profile add ${name}`);
  const key = process.env[`QUIVA_API_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || p.api_key;
  if (!key) die(`profile "${name}" has no api_key`);
  if ((p.env || 'production') !== 'production') die(`profile "${name}" has env "${p.env}"; only production is supported`);
  secretsInFlight.add(key);
  return { name, env: 'production', account: p.account, host: HOST, key };
}
const rel = (f) => path.relative(process.cwd(), f) || f;

async function hiddenPrompt(label) {
  if (!process.stdin.isTTY) die('this needs an interactive terminal; the user must run it themselves');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let v = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); return; }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') v = v.slice(0, -1); else v += c;
      }
    };
    const done = () => {
      process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
      process.stdout.write('\n'); resolve(v.trim());
    };
    process.stdin.on('data', onData);
  });
}

// ---------- http ----------

// The account behind a key, from GET /accounts/info; null when it can't be read.
async function whoami(p) {
  try {
    const r = await api(p, 'GET', '/accounts/info');
    const a = r.ok ? (r.json?.data ?? r.json) : null;
    return a?.id ? { id: String(a.id), name: a.display_name || a.name || '' } : null;
  } catch { return null; }
}

async function api(p, method, urlPath, { query, body } = {}) {
  const url = new URL(p.host + urlPath);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': p.key, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
  return { status: res.status, ok: res.ok, json, text };
}
async function must(p, method, urlPath, opts) {
  const r = await api(p, method, urlPath, opts);
  if (!r.ok) {
    // A plain-text 404 means the gateway has no route; a JSON 404 came from the service.
    const hint = r.status === 401 ? ' (key expired or wrong account?)' : r.status === 404 && r.json === undefined ? ' (no gateway route for this path)' : '';
    die(`${method} ${urlPath} on ${p.name} -> ${r.status}${hint}: ${r.text.slice(0, 500)}`);
  }
  return r.json;
}
const results = (j) => (Array.isArray(j) ? j : j?.results ?? j?.data?.results ?? []);

// ---------- kinds ----------

// read(p,id) -> object; write(p,id,local,base) -> request; create(p,id,obj) -> request; del(p,id) -> requests.
const VOLATILE = ['created_at', 'updated_at', 'modified', 'resolved_version', 'revision', 'version', 'sequence'];
const SPACE_PATCH = ['id', 'name', 'description', 'default_status', 'statuses', 'owner', 'record_configs', 'default_record_config_id', 'logo', 'logo_bg_color', 'priorities', 'tags', 'records', 'tasks', 'files', 'default_view', 'base_record', 'organisation_record', 'custom_tab', 'hidden_tabs', 'view', 'modules'];
const CONFIG_PUT = ['name', 'description', 'label', 'schema', 'views', 'index_fields', 'client_access', 'assistant_write_forbidden', 'assistant_write_values', 'history', 'collection_id', 'source'];

function flowId(id) {
  const parts = String(id).split('.');
  if (parts.length < 2) die(`flow id is "<collection topic>.<flow topic>" or a full subject, got "${id}"`);
  return parts.slice(-2);
}
function stripFlowStamps(config) {
  const c = structuredClone(config || {});
  for (const n of [...(c.nodes || []), ...(c.edges || [])]) { delete n.subject; delete n.modified; }
  return c;
}

const KINDS = {
  'record-config': {
    list: (p) => must(p, 'GET', '/records/config', { query: { limit: 1000 } }).then(results),
    read: (p, id) => must(p, 'GET', `/records/config/${enc(id)}`),
    exists: async (p, id) => (await api(p, 'GET', `/records/config/${enc(id)}`)).ok,
    write: (p, id, local, base) => {
      const body = pick(local, CONFIG_PUT);
      // Views merge per key; a key removed locally must be unset explicitly.
      const gone = Object.keys(base?.views || {}).filter((k) => !(k in (local.views || {})));
      if (gone.length) body.unset_views = gone;
      return { method: 'PUT', path: `/records/config/${enc(id)}`, body };
    },
    create: (p, id, obj) => ({ method: 'POST', path: '/records/config', body: { ...omit(obj, [...VOLATILE, 'resolution_error']), id } }),
    del: (p, id) => [{ method: 'DELETE', path: `/records/config/${enc(id)}` }],
  },
  'config-collection': {
    list: (p) => must(p, 'GET', '/records/config-collections').then(results),
    read: (p, id) => must(p, 'GET', `/records/config-collections/${enc(id)}`),
    exists: async (p, id) => (await api(p, 'GET', `/records/config-collections/${enc(id)}`)).ok,
    write: (p, id, local) => ({ method: 'PUT', path: `/records/config-collections/${enc(id)}`, body: omit(local, ['id', ...VOLATILE]) }),
    create: (p, id, obj) => ({ method: 'POST', path: '/records/config-collections', body: { ...omit(obj, VOLATILE), id } }),
    del: (p, id) => [{ method: 'DELETE', path: `/records/config-collections/${enc(id)}` }],
  },
  space: {
    list: (p) => must(p, 'GET', '/workspaces/spaces').then(results),
    read: (p, id) => must(p, 'GET', `/workspaces/space/${enc(id)}`),
    exists: async (p, id) => (await api(p, 'GET', `/workspaces/space/${enc(id)}`)).ok,
    write: (p, id, local) => ({ method: 'PATCH', path: `/workspaces/space/${enc(id)}`, body: { ...pick(local, SPACE_PATCH), id } }),
    // owner, url and the uploaded logo belong to the source account.
    create: (p, id, obj) => ({ method: 'POST', path: '/workspaces/space', body: { ...omit(obj, [...VOLATILE, 'owner', 'url', 'logo']), id } }),
    del: (p, id) => [{ method: 'DELETE', path: `/workspaces/space/${enc(id)}` }],
  },
  'task-template': {
    list: (p) => must(p, 'GET', '/workspaces/task-templates').then(results),
    read: (p, id) => must(p, 'GET', `/workspaces/task-template/${enc(id)}`),
    exists: async (p, id) => (await api(p, 'GET', `/workspaces/task-template/${enc(id)}`)).ok,
    write: (p, id, local) => ({ method: 'PATCH', path: `/workspaces/task-template/${enc(id)}`, body: omit(local, ['account_id', 'owner', ...VOLATILE]) }),
    create: (p, id, obj) => ({ method: 'POST', path: '/workspaces/task-template', body: { ...omit(obj, ['account_id', 'owner', ...VOLATILE]), id } }),
    del: (p, id) => [{ method: 'DELETE', path: `/workspaces/task-template/${enc(id)}` }],
  },
  flow: {
    // Edits go to the draft; `publish` makes them live.
    list: async (p) => (await must(p, 'GET', '/hub/workflows', { query: { limit: 500 } })).results || [],
    read: (p, id) => { const [c, f] = flowId(id); return must(p, 'GET', `/hub/workflows/${c}/${f}`, { query: { draft: 'true' } }); },
    exists: async (p, id) => { const [c, f] = flowId(id); return (await api(p, 'GET', `/hub/workflows/${c}/${f}`, { query: { draft: 'true' } })).ok; },
    write: (p, id, local) => { const [c, f] = flowId(id); return { method: 'PATCH', path: `/hub/workflows/${c}/${f}`, body: local }; },
    del: (p, id) => { const [c, f] = flowId(id); return [false, true].map((d) => ({ method: 'DELETE', path: `/hub/workflows/${c}/${f}?draft=${d}` })); },
  },
  records: {
    // id is "<config_id>@<space_id>"; the file is the row array.
    read: async (p, id) => {
      const [config, space] = recId(id);
      // Large pages time out at the gateway (504), so read 200 at a time by offset.
      const rows = [];
      let total;
      for (let offset = 0; rows.length < 5000; offset += 200) {
        const j = await must(p, 'GET', '/records', { query: { config_id: config, space_id: space, limit: 200, offset } });
        const page = results(j);
        total = j?.total_hits ?? j?.results_total;
        rows.push(...page);
        if (page.length < 200 || (typeof total === 'number' && rows.length >= total)) break;
      }
      const out = rows.map((r) => pick(r, ['id', 'data', 'completed'])).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (typeof total === 'number' && total > rows.length) {
        console.error(`warning: ${config}@${space} has ${total} rows, only ${rows.length} returned (GET /records cannot page)`);
        Object.defineProperties(out, { truncated: { value: true }, total: { value: total } });
      }
      return out;
    },
  },
};
const enc = encodeURIComponent;
function recId(id) {
  const [config, space] = String(id).split('@');
  if (!config || !space) die(`records id is "<config_id>@<space_id>", got "${id}"`);
  return [config, space];
}
function kind(k) { return KINDS[k] || die(`unknown kind "${k}"; one of: ${Object.keys(KINDS).join(', ')}`); }

// ---------- files ----------

const fileFor = (prof, k, id) => path.join(ROOT, prof, k, `${id}.json`);
const baseFor = (prof, k, id) => path.join(ROOT, prof, k, '.base', `${id}.json`);
function parseFile(f) {
  const r = path.relative(ROOT, path.resolve(f)).split(path.sep);
  if (r.length !== 3 || r[0].startsWith('..')) die(`${f} is not a pulled file (${rel(ROOT)}/<profile>/<kind>/<id>.json)`);
  return { prof: r[0], k: r[1], id: r[2].replace(/\.json$/, '') };
}
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, pretty(o)); }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const same = (a, b) => pretty(stripVolatile(a)) === pretty(stripVolatile(b));
function stripVolatile(o) {
  if (Array.isArray(o)) return o.map(stripVolatile);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).filter(([k]) => !VOLATILE.includes(k)).map(([k, v]) => [k, stripVolatile(v)]));
  return o;
}
function showDiff(a, b, la, lb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiva-'));
  const fa = path.join(dir, 'a.json'), fb = path.join(dir, 'b.json');
  fs.writeFileSync(fa, pretty(stripVolatile(a))); fs.writeFileSync(fb, pretty(stripVolatile(b)));
  const r = spawnSync('diff', ['-u', '--label', la, '--label', lb, fa, fb], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout || '(no differences)\n';
}
function backup(prof, k, id, obj) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const f = path.join(ROOT, prof, 'backups', ts, k, `${id}.json`);
  writeJson(f, obj);
  return f;
}
function banner(p) { return `${p.name} (${p.env}, ${p.host}, account ${p.account})`; }
function gate(what) {
  if (flags.yes) return;
  say(`\nDRY RUN: nothing was written. Re-run with --yes to ${what}.`);
  process.exit(DRY_RUN);
}

// ---------- commands ----------

const COMMANDS = {
  async 'profile'() {
    const [sub, name] = pos.slice(1);
    const all = loadProfiles();
    if (sub === 'list') {
      for (const [n, p] of Object.entries(all)) say(`${n}\t${p.env || 'production'}\taccount ${p.account || '?'}\tkey ${p.api_key ? 'set' : 'MISSING'}`);
      return;
    }
    if (sub === 'remove') { if (!all[name]) die(`no profile "${name}"`); delete all[name]; saveProfiles(all); say(`removed ${name}`); return; }
    if (sub === 'add') {
      if (!name) die('profile add <name> [--account <account id>]');
      const key = await hiddenPrompt(`API key for ${name} (input hidden): `);
      if (!key) die('empty key');
      secretsInFlight.add(key);
      // The key identifies its account, so --account is optional and only checked against it.
      const who = await whoami({ name, host: HOST, key });
      if (!who && !flags.account) die('could not look up the account for this key (expired or wrong key?). Pass --account <account id> to save it anyway.');
      if (who && flags.account && String(flags.account) !== who.id) die(`the key belongs to account ${who.id}, not ${flags.account}`);
      all[name] = { env: 'production', account: who?.id || String(flags.account), api_key: key };
      saveProfiles(all);
      say(`saved ${name} to ${PROFILES}${who ? `: account ${who.id}${who.name ? ` (${who.name})` : ''}` : ' (account not verified)'}`);
      return;
    }
    die('profile add|list|remove');
  },

  async check() {
    const p = profile(pos[1]);
    const who = await whoami(p);
    if (who) { say(`${banner(p)}: ok, account ${who.id}${who.name ? ` (${who.name})` : ''}`); return; }
    const r = await api(p, 'GET', '/records/config', { query: { limit: 1 } });
    say(`${banner(p)}: ${r.status} ${r.ok ? 'ok (account lookup unavailable)' : r.text.slice(0, 200)}`);
    if (!r.ok) process.exit(1);
  },

  async get() {
    const p = profile(pos[1]);
    const urlPath = pos[2] || die('get <profile> <path> [k=v ...]');
    // GET /secrets/{key} and ?reveal=true both return values.
    if (/^\/?secrets\b/.test(urlPath)) die('use `secrets list`; this route can return secret values');
    const query = Object.fromEntries(pos.slice(3).filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2)));
    process.stdout.write(scrub(pretty(await must(p, 'GET', urlPath, { query }))));
  },

  async list() {
    const p = profile(pos[1]);
    const k = pos[2];
    const ks = kind(k);
    if (!ks.list) die(`${k} has no list; for records use: pull <profile> records <config_id>@<space_id>`);
    for (const x of await ks.list(p)) say([x.id ?? x.subject, x.name].filter(Boolean).join('\t'));
  },

  async pull() {
    const p = profile(pos[1]);
    const [k, id] = [pos[2], pos[3]];
    const ks = kind(k);
    if (!id) die('pull <profile> <kind> <id>');
    const obj = await ks.read(p, id);
    writeJson(fileFor(p.name, k, id), obj);
    writeJson(baseFor(p.name, k, id), obj);
    say(`pulled ${k} ${id} from ${banner(p)}\n  -> ${rel(fileFor(p.name, k, id))}`);
  },

  async diff() {
    const f = pos[1] || die('diff <file>');
    const { prof, k, id } = parseFile(f);
    const p = profile(prof);
    const live = await kind(k).read(p, id);
    process.stdout.write(scrub(showDiff(live, readJson(f), `live ${k}/${id} @ ${p.name}`, `local ${rel(f)}`)));
  },

  async push() {
    const f = pos[1] || die('push <file> [--yes]');
    const { prof, k, id } = parseFile(f);
    const p = profile(prof);
    const ks = kind(k);
    const local = readJson(f);
    const bf = baseFor(prof, k, id);
    const base = fs.existsSync(bf) ? readJson(bf) : die(`no base for ${f}; pull it first`);
    const live = await ks.read(p, id);
    if (!same(live, base)) die(`${k} ${id} changed on ${p.name} since it was pulled. Pull again and re-apply the edit:\n${showDiff(base, live, 'pulled base', 'live now')}`);
    say(`push ${k} ${id} to ${banner(p)}\n`);
    process.stdout.write(scrub(showDiff(live, local, `live ${k}/${id}`, `local ${rel(f)}`)));
    if (same(live, local)) { say('nothing to push'); return; }

    const reqs = k === 'records' ? recordRequests(id, local, base) : [ks.write(p, id, local, base)];
    for (const r of reqs) say(`${r.method} ${r.path}`);
    if (k === 'records') {
      const keep = new Set(local.map((r) => r.id));
      const dropped = base.filter((r) => r.id && !keep.has(r.id)).map((r) => r.id);
      if (dropped.length) say(`not deleted (use \`delete ${p.name} record ${recId(id)[0]}/<id>\`): ${dropped.join(', ')}`);
    }
    gate('apply');
    say(`backup -> ${rel(backup(p.name, k, id, live))}`);
    for (const r of reqs) await must(p, r.method, r.path, { body: r.body });
    const after = await ks.read(p, id);
    writeJson(f, after); writeJson(bf, after);
    say(same(after, local) ? 'pushed; live now matches local' : `pushed; live differs from what was sent (server-side defaults or merges):\n${showDiff(local, after, 'sent', 'live now')}`);
  },

  async copy() {
    const [from, to, k, id] = pos.slice(1);
    if (!id) die('copy <from-profile> <to-profile> <kind> <id> [--as <new id>] [--space <space>] [--yes]');
    const src = profile(from), dst = profile(to);
    const ks = kind(k);
    const obj = await ks.read(src, id);
    const newId = flags.as || id;
    say(`copy ${k} ${id} from ${banner(src)}\n  to ${newId} in ${banner(dst)}\n`);

    if (k === 'records') return copyRecords(src, dst, id, obj);
    if (k === 'flow') return copyFlow(src, dst, id, obj);

    if (await ks.exists(dst, newId)) die(`${k} ${newId} already exists in ${dst.name}. Pull it there and push an edit instead, or pass --as <new id>.`);
    const req = ks.create(dst, newId, obj);
    say(`${req.method} ${req.path}`);
    const lines = scrub(pretty(req.body)).split('\n');
    say(lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n… ${lines.length - 60} more lines` : ''));
    warnCrossAccount(obj);
    gate('create it');
    const r = await api(dst, req.method, req.path, { body: req.body });
    if (r.json?.code === 'config_id_reserved') die(`${r.json.error}\nCopy it under another id with --as <new id>, or hold it as a reference (source.publisher_account_id).`);
    if (!r.ok) die(`${req.method} ${req.path} -> ${r.status}: ${r.text.slice(0, 500)}`);
    const after = await ks.read(dst, newId);
    const expected = req.body;
    const differing = Object.keys(expected).filter((key) => key !== 'id' && pretty(after[key] ?? null) !== pretty(expected[key] ?? null));
    say(differing.length ? `created; these keys differ from the source: ${differing.join(', ')}` : 'created; read back matches the source');
  },

  // A new flow from a local file ({name, description, config}), as a draft in an existing collection.
  async create() {
    const [, name, k, file] = pos;
    if (k === 'record-config' && file) {
      const p = profile(name);
      const obj = readJson(file);
      const id = obj.id || die(`${file} has no id`);
      if (await KINDS['record-config'].exists(p, id)) die(`record-config ${id} already exists in ${p.name}; pull and push it instead`);
      const req = KINDS['record-config'].create(p, id, obj);
      say(`create record-config ${id} on ${banner(p)}\n${req.method} ${req.path}`);
      gate('create the record set');
      await must(p, req.method, req.path, { body: req.body });
      const after = await KINDS['record-config'].read(p, id);
      say(same(after.schema, obj.schema) ? 'created; schema reads back as sent' : 'created; the schema read back differs from what was sent');
      return;
    }
    if (k !== 'flow' || !file || !flags.collection) die('create <profile> flow <file> --collection <collection topic> [--yes]\n       create <profile> record-config <file> [--yes]');
    const p = profile(name);
    const flow = readJson(file);
    if (!flow.name || !flow.config) die(`${file} has no name or config`);
    const cols = results(await must(p, 'GET', '/hub/collections', { query: { collection_type: 'workflow' } }));
    const col = cols.find((x) => x.topic === String(flags.collection)) || die(`collection ${flags.collection} not found in ${p.name}`);
    const existing = (await KINDS.flow.list(p)).filter((x) => x.name === flow.name);
    if (existing.length) die(`a flow named ${flow.name} already exists in ${p.name}: ${existing.map((x) => x.subject).join(', ')}`);
    const missing = await missingSecrets(p, flow);
    say(`create ${flow.name} in collection "${col.name}" on ${banner(p)}`);
    say(`POST /hub/workflows  (draft, auto_publish:false, ${flow.config.nodes?.length ?? 0} nodes)`);
    if (missing.length) say(`warning: ${p.name} lacks secrets ${missing.join(', ')}; every run fails until they exist`);
    warnCrossAccount(flow);
    gate('create the draft');
    await createDraft(p, flow, col.subject);
  },

  async publish() {
    const p = profile(pos[1]);
    const id = pos[2] || die('publish <profile> <collection>.<flow> [--yes]');
    const [c, f] = flowId(id);
    const draft = await KINDS.flow.read(p, id);
    const missing = await missingSecrets(p, draft);
    if (missing.length && !flags['allow-missing-secrets']) die(`${draft.name} references secrets ${p.name} does not have: ${missing.join(', ')}.\nAn unresolvable SECRET:: fails the whole run. Add them (secrets set), then publish.`);
    say(`publish ${draft.name} (${draft.subject}) on ${banner(p)}`);
    gate('publish');
    await must(p, 'POST', '/hub/workflows/publish', { body: { subject: `ms.hub.config.workflow.draft.${c}.${f}` } });
    const live = (await KINDS.flow.list(p)).find((x) => x.subject === `ms.hub.config.workflow.${c}.${f}`);
    say(live ? `published: ${live.subject}` : 'publish returned OK but no published subject is listed; check the flow in the app');
  },

  async delete() {
    const p = profile(pos[1]);
    const [k, id] = [pos[2], pos[3]];
    if (!id) die('delete <profile> <kind> <id> --yes   (kind "record" takes <config_id>/<row id>)');
    let reqs, obj;
    if (k === 'record') {
      const [config, row] = id.split('/');
      obj = await must(p, 'GET', `/records/${enc(config)}/${enc(row)}`);
      reqs = [{ method: 'DELETE', path: `/records/${enc(config)}/${enc(row)}` }];
    } else {
      const ks = kind(k);
      if (!ks.del) die(`${k} cannot be deleted here`);
      obj = await ks.read(p, id);
      reqs = ks.del(p, id);
    }
    say(`delete ${k} ${id} on ${banner(p)}`);
    for (const r of reqs) say(`${r.method} ${r.path}`);
    gate('delete it');
    say(`backup -> ${rel(backup(p.name, k, id.replace(/\//g, '__'), obj))}`);
    for (const r of reqs) {
      const res = await api(p, r.method, r.path);
      say(`${r.method} ${r.path} -> ${res.status}${res.ok ? '' : ' ' + res.text.slice(0, 200)}`);
    }
  },

  async secrets() {
    const sub = pos[1];
    const handler = SECRETS[sub] || die(`secrets ${Object.keys(SECRETS).join('|')}`);
    await handler();
  },
};

function recordRequests(id, local, base) {
  const [config, space] = recId(id);
  const before = new Map(base.map((r) => [r.id, r]));
  const reqs = [];
  for (const row of local) {
    const old = row.id && before.get(row.id);
    if (!old) reqs.push({ method: 'POST', path: `/records/${enc(config)}`, body: { ...pick(row, ['id', 'data', 'completed']), space_id: space, validate: false } });
    else if (!same(old, row)) reqs.push({ method: 'PUT', path: `/records/${enc(config)}/${enc(row.id)}`, body: { data: row.data, completed: row.completed, space_id: space, replace: true, validate: false } });
  }
  return reqs;
}

async function copyRecords(src, dst, id, rows) {
  const [config, space] = recId(id);
  const dstSpace = flags.space || space;
  const dstConfig = flags.as || config;
  if (!(await KINDS['record-config'].exists(dst, dstConfig))) die(`record set ${dstConfig} does not exist in ${dst.name}; copy the record-config first`);
  if (rows.truncated && !flags.partial) die(`only ${rows.length} of ${rows.total} rows are readable through GET /records; pass --partial to copy just those`);
  const existing = new Set((await KINDS.records.read(dst, `${dstConfig}@${dstSpace}`)).map((r) => r.id));
  const todo = rows.filter((r) => !existing.has(r.id));
  say(`${rows.length} rows in source; ${rows.length - todo.length} already in target (skipped); ${todo.length} to create in ${dstConfig}@${dstSpace}`);
  gate(`create ${todo.length} rows`);
  let ok = 0;
  for (const r of todo) {
    const res = await api(dst, 'POST', `/records/${enc(dstConfig)}`, { body: { ...pick(r, ['id', 'data', 'completed']), space_id: dstSpace, validate: false } });
    if (res.ok) ok++; else say(`row ${r.id}: ${res.status} ${res.text.slice(0, 200)}`);
  }
  say(`created ${ok}/${todo.length}`);
}

async function copyFlow(src, dst, id, flow) {
  const [c] = flowId(id);
  const srcCols = results(await must(src, 'GET', '/hub/collections', { query: { collection_type: 'workflow' } }));
  const colName = srcCols.find((x) => x.topic === c)?.name || die(`collection ${c} not found in ${src.name}`);
  const dstCols = results(await must(dst, 'GET', '/hub/collections', { query: { collection_type: 'workflow' } }));
  let col = dstCols.find((x) => x.name === colName)?.subject;
  const existing = (await KINDS.flow.list(dst)).filter((x) => x.name === flow.name);
  if (existing.length) die(`a flow named ${flow.name} already exists in ${dst.name}: ${existing.map((x) => x.subject).join(', ')}`);
  const missing = await missingSecrets(dst, flow);
  say(`${col ? 'into existing' : 'CREATE'} workflow collection "${colName}"`);
  say(`POST /hub/workflows  ${flow.name}  (draft, auto_publish:false, ${flow.config?.nodes?.length ?? 0} nodes)`);
  if (missing.length) say(`warning: ${dst.name} lacks secrets ${missing.join(', ')}; every run fails until they exist`);
  warnCrossAccount(flow);
  gate('create the draft');
  if (!col) col = (await must(dst, 'POST', '/hub/collections', { body: { name: colName, collection_type: 'workflow', description: '' } })).subject;
  await createDraft(dst, flow, col);
}

async function createDraft(dst, flow, col) {
  const body = { name: flow.name, description: flow.description, config: stripFlowStamps(flow.config), collection: col, auto_publish: false };
  const res = await api(dst, 'POST', '/hub/workflows', { body });
  if (res.status === 409) die(`name taken in that collection: ${res.text.slice(0, 300)}`);
  if (!res.ok) die(`POST /hub/workflows -> ${res.status}: ${res.text.slice(0, 500)}`);
  const made = (await KINDS.flow.list(dst)).find((x) => x.name === flow.name && x.subject.includes('.draft.'));
  say(made ? `created draft ${made.subject}\npublish with: publish ${dst.name} ${made.subject.split('.').slice(-2).join('.')}` : 'created; draft not yet listed');
}

function warnCrossAccount(obj) {
  const s = JSON.stringify(obj);
  const gateways = [...new Set(s.match(/https:\/\/[A-Za-z0-9]{8,}\.quiva\.ai\/[^"\\ ]*/g) || [])];
  if (gateways.length) say(`warning: points at an account gateway, which stays the source's after a copy:\n  ${gateways.join('\n  ')}`);
}

// ---------- secrets ----------

const secretRefs = (o) => [...new Set([...JSON.stringify(o).matchAll(/SECRET::([^:"\\]+)::/g)].map((m) => m[1]))];
async function secretNames(p, user = false) {
  const j = await must(p, 'GET', user ? '/secrets/user' : '/secrets', { query: { reveal: 'false', limit: 5000 } });
  if (j?.truncated) console.error('warning: secret list truncated');
  return results(j).map((x) => x.key);
}
async function missingSecrets(p, o) {
  const have = new Set(await secretNames(p));
  return secretRefs(o).filter((n) => !n.startsWith('user.') && !have.has(n));
}
function checkValue(v, name) {
  if (!v) die(`${name}: empty value`);
  if (v.includes('"')) die(`${name}: values containing " are corrupted on read; refusing`);
}
async function putSecret(p, name, value) {
  secretsInFlight.add(value);
  const scope = flags.user ? 'user' : 'account';
  const r = await api(p, 'PUT', '/secrets', { body: { key: name, value, scope } });
  if (r.status === 403) die(`${p.name}: writing a shared secret needs an admin's API key`);
  if (!r.ok) die(`PUT /secrets ${name} on ${p.name} -> ${r.status}: ${r.text.slice(0, 300)}`);
}
const validName = (n) => /^[A-Za-z0-9_-]+$/.test(n) || die(`invalid secret name "${n}"`);

const SECRETS = {
  async list() {
    const p = profile(pos[2]);
    for (const n of await secretNames(p, !!flags.user)) say(n);
  },
  async check() {
    const p = profile(pos[2]);
    const target = pos[3] || die('secrets check <profile> <pulled flow file | collection.flow>');
    const flow = fs.existsSync(target) ? readJson(target) : await KINDS.flow.read(p, target);
    const refs = secretRefs(flow);
    const missing = await missingSecrets(p, flow);
    say(`references: ${refs.join(', ') || '(none)'}`);
    say(missing.length ? `MISSING in ${p.name}: ${missing.join(', ')}` : `all present in ${p.name}`);
    if (missing.length) process.exit(1);
  },
  async set() {
    const p = profile(pos[2]);
    const name = pos[3] || die('secrets set <profile> <NAME> (--from-file <path> | --prompt) [--yes]');
    validName(name);
    let value, file;
    if (flags.prompt) value = await hiddenPrompt(`value for ${name} (input hidden): `);
    else {
      file = typeof flags['from-file'] === 'string' ? flags['from-file'] : path.join(INBOX, name);
      if (!fs.existsSync(file)) die(`no value file. Ask the user to write the value to ${file} (one line, nothing else), then re-run.`);
      value = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    }
    secretsInFlight.add(value);
    checkValue(value, name);
    const exists = (await secretNames(p, !!flags.user)).includes(name);
    say(`${exists ? 'OVERWRITE' : 'create'} secret ${name} on ${banner(p)} (scope ${flags.user ? 'user' : 'shared'})`);
    gate('write it');
    await putSecret(p, name, value);
    if (file) fs.rmSync(file);
    say(`set ${name}${file ? `; removed ${file}` : ''}`);
  },
  async delete() {
    const p = profile(pos[2]);
    const name = pos[3] || die('secrets delete <profile> <NAME> --yes');
    validName(name);
    say(`delete secret ${name} on ${banner(p)}. There is no backup: values are never written to disk.`);
    gate('delete it');
    await must(p, 'DELETE', `/secrets/${enc(name)}${flags.user ? '?scope=user' : ''}`);
    say(`deleted ${name}`);
  },
};

// ---------- main ----------

const cmd = COMMANDS[pos[0]];
if (!cmd) {
  say(`usage: quiva.mjs <command>
  profile add <name> [--account <id>]   (user runs it; hidden key prompt; account is looked up from the key)
  profile list | profile remove <name>
  check <profile>
  get <profile> <path> [k=v ...]
  list <profile> <kind>
  pull <profile> <kind> <id>
  diff <pulled file>
  push <pulled file> [--yes]
  copy <from> <to> <kind> <id> [--as <new id>] [--space <space>] [--yes]
  create <profile> flow <file> --collection <collection topic> [--yes]
  publish <profile> <collection>.<flow> [--yes]
  delete <profile> <kind> <id> [--yes]
  secrets list|check|set|delete …
env: QUIVA_API_KEY_<PROFILE> overrides a profile's key; QUIVA_API_URL, QUIVA_CONFIG_DIR, QUIVA_DIR (default ./.quiva) are optional
kinds: ${Object.keys(KINDS).join(', ')}`);
  process.exit(pos[0] ? 1 : 0);
}
await cmd().catch((e) => die(e?.message || e));
