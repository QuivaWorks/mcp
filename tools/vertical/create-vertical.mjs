// Create a new vertical's folder tree, in BOTH places that matter:
//   1. this repo   — verticals/<id>/<category>/
//   2. the platform — spaces.VERTICAL.<id>.<category>.__meta__.json
//
// The six category names are routing keys read by accounts-service/accounts/
// updateaccount.go (configTypeToEndpointSubject). A folder whose name is not one
// of them deploys NOTHING and reports no error, so they are not free-text.
// `specs` is deliberately the seventh: it never deploys, by design.
//
// usage: node tools/vertical/create-vertical.mjs <vertical_id>

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { open } from './mcp.mjs';

const ROOT = process.env.MCP_REPO ?? process.cwd();
const V = process.argv[2];

if (!V) {
  console.error('usage: node tools/vertical/create-vertical.mjs <vertical_id>');
  process.exit(1);
}
if (!/^[a-z][a-z0-9_]*$/.test(V)) {
  console.error(`invalid vertical id "${V}" — use lowercase letters, digits and underscores, starting with a letter.`);
  process.exit(1);
}

const DEPLOYING = ['assistants', 'document_templates', 'flows', 'meeting_templates', 'record_configs', 'spaces'];
const CATEGORIES = [...DEPLOYING, 'specs'];

// ---- 1. the repo side -------------------------------------------------------
console.log(`repo: verticals/${V}/`);
for (const cat of CATEGORIES) {
  const dir = `${ROOT}/verticals/${V}/${cat}`;
  mkdirSync(dir, { recursive: true });
  const keep = `${dir}/.gitkeep`;
  if (!existsSync(keep)) writeFileSync(keep, '');
  console.log(`  ${cat}/`);
}

// ---- 2. the platform side ---------------------------------------------------
const m = open(`${ROOT}/quiva-workspaces-mcp/bin/run.sh`);
await m.ready;

const rows = [];
const root = await m.call('create_folder', { space_id: 'VERTICAL', folder: V }, 180000);
rows.push({ folder: V, ...root });
for (const cat of CATEGORIES) {
  const r = await m.call('create_folder', { space_id: 'VERTICAL', subfolder: V, folder: cat }, 180000);
  rows.push({ folder: `${V}/${cat}`, ...r });
}

console.log(`\nplatform: spaces.VERTICAL.${V}.*`);
console.log('folder'.padEnd(38), 'existed', 'visible_in_ui');
for (const r of rows) {
  console.log(
    String(r.folder).padEnd(38),
    String(r.already_existed ?? false).padEnd(8),
    String(r.visible_in_ui ?? '-'),
    r._error ? '| ERROR: ' + String(r._error).slice(0, 90) : ''
  );
}

// Folder creation intermittently stores a blank `name` on the index entry. For a
// FOLDER MARKER that only affects the UI file tree: deployVerticals skips markers
// by their .__meta__.json suffix and matches each config file on its own name, so
// the configs inside a blank-named folder still deploy. It matters for CONFIG
// files — check will_deploy there (push-vertical.mjs does).
const invisible = rows.filter((r) => r.visible_in_ui === false);
const failed = rows.filter((r) => r._error);

console.log();
if (failed.length) console.log(`FAILED: ${failed.map((r) => r.folder).join(', ')}`);
if (invisible.length) {
  console.log(`Blank folder name — these will not show in the UI file tree: ${invisible.map((r) => r.folder).join(', ')}`);
  console.log('Cosmetic only: configs inside them still deploy. Re-running sometimes fixes it.');
}
if (!failed.length) {
  console.log(`OK — ${rows.length} folders in the repo and on the platform.`);
  console.log(`Next: put the rough requirements in verticals/${V}/specs/${V}-rough.md`);
}

m.close();
process.exit(failed.length ? 1 : 0);
