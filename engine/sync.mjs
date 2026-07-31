#!/usr/bin/env node
// Keeps this repo's claims about the Quiva engine honest.
//
// The MCP docs, validators and examples in this repo encode ENGINE TRUTH — how
// the platform actually behaves, as opposed to what its OpenAPI spec says. Every
// one of those claims was established by reading a specific file in
// myevari/evari-olympus, and each cites that file by path. Those citations are
// the only thing standing between "verified" and "was verified once".
//
// This script resolves every cited path against evari-olympus main and compares
// it to the pinned blob sha in provenance.json.
//
//   node engine/sync.mjs            # report drift (exit 1 if any) — the CI check
//   node engine/sync.mjs --pin      # re-pin to current main, after re-reading
//   node engine/sync.mjs --list     # just show what is cited, and by whom
//
// Requires the `gh` CLI authenticated as a user with read access to
// myevari/evari-olympus. No clone, no submodule: 20-odd files fetched by API.
// See engine/fetch.sh to read one file's contents.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MANIFEST = join(HERE, 'provenance.json');

const SERVERS = [
  'quiva-flows-mcp',
  'quiva-records-mcp',
  'quiva-documents-mcp',
  'quiva-workspaces-mcp',
  'quiva-agents-mcp',
];

// A citation is a path into one of the engine's source trees. Kept deliberately
// narrow: only paths ending in a real source extension, so prose mentions of a
// service name are not mistaken for a verifiable claim.
const CITATION =
  /(?:workspaces-service|records-service|hub-service|file-generator-service|datahub-js-nodes|microstrate\/src)[A-Za-z0-9/._-]*\.(?:go|ts|svelte)/g;

// The OpenAPI specs our docs argue with now live in THIS repo, at
// specs/openapi/. They were never on evari-olympus main — they were authored on
// the brack-vertical-mcp branch alongside the MCP work — so there is no upstream
// copy to drift against, and checking them here would report a permanent false
// MISSING. Resolved locally instead: a citation must name a file we actually have.
const SPEC_CITATION =
  /\bquiva-(?:flows|records|documents|workspace|agents|endpoints)\.json\b/g;
const SPEC_DIR = join(ROOT, 'specs', 'openapi');

const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|json|md)$/.test(entry)) out.push(full);
  }
  return out;
}

// Which spec files we actually hold, so a citation naming one we do not have is
// caught rather than silently reading as verified.
const localSpecs = new Set(
  (() => {
    try {
      return readdirSync(SPEC_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  })()
);
const missingSpecs = new Set();

// path -> Set of repo-relative files that cite it
function collectCitations() {
  const cited = new Map();
  const roots = [...SERVERS.map((s) => join(ROOT, s)), join(ROOT, 'docs')];
  for (const root of roots) {
    let files;
    try {
      files = walk(root);
    } catch {
      continue;
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const rel = file.slice(ROOT.length + 1);
      for (const match of text.matchAll(CITATION)) {
        if (!cited.has(match[0])) cited.set(match[0], new Set());
        cited.get(match[0]).add(rel);
      }
      for (const match of text.matchAll(SPEC_CITATION)) {
        if (!localSpecs.has(match[0])) missingSpecs.add(`${match[0]} (cited by ${rel})`);
      }
    }
  }
  return cited;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function requireGh() {
  try {
    gh(['auth', 'status']);
  } catch {
    console.error(
      'engine/sync.mjs needs the `gh` CLI authenticated with read access to\n' +
        'myevari/evari-olympus. Run `gh auth login`, or set GH_TOKEN to a\n' +
        'fine-grained token with Contents: Read on that repository.'
    );
    process.exit(2);
  }
}

// Resolve the blob sha of every path in one request per directory, rather than
// one per file: the tree API returns the whole tree, which is cheaper and means
// a renamed file shows up as missing rather than as a fetch error.
function fetchTree(repo, ref) {
  const raw = gh(['api', `repos/${repo}/git/trees/${ref}?recursive=1`]);
  const tree = JSON.parse(raw);
  if (tree.truncated) {
    console.error('warning: the tree response was truncated; sha comparison may be incomplete');
  }
  const map = new Map();
  for (const node of tree.tree) if (node.type === 'blob') map.set(node.path, node.sha);
  return map;
}

function headSha(repo, branch) {
  return JSON.parse(gh(['api', `repos/${repo}/commits/${branch}`])).sha;
}

const mode = process.argv.includes('--pin')
  ? 'pin'
  : process.argv.includes('--list')
    ? 'list'
    : 'check';

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const { repo, branch } = manifest;
const cited = collectCitations();

// Not every path-shaped string is a claim about existing source. The docs also
// name files we PROPOSE to create (a drafted regression test, say). Those would
// otherwise report as MISSING for ever, which is exactly how a check trains
// people to ignore it. Suppressed here, with a reason, rather than silently.
for (const path of Object.keys(manifest.ignore ?? {})) cited.delete(path);

if (mode === 'list') {
  const rows = [...cited.entries()].sort((a, b) => b[1].size - a[1].size);
  console.log(`${rows.length} engine files are cited by this repo:\n`);
  for (const [path, by] of rows) {
    console.log(`  ${path}`);
    for (const f of [...by].sort()) console.log(`      ← ${f}`);
  }
  process.exit(0);
}

requireGh();
const sha = headSha(repo, branch);
const tree = fetchTree(repo, sha);

const drifted = [];
const missing = [];
const fresh = [];
const added = [];

for (const [path, by] of cited) {
  const current = tree.get(path);
  const pinned = manifest.files[path]?.sha;
  const cited_by = [...by].sort();
  if (!current) {
    missing.push({ path, cited_by });
  } else if (!pinned) {
    added.push({ path, sha: current, cited_by });
  } else if (pinned !== current) {
    drifted.push({ path, pinned, current, cited_by });
  } else {
    fresh.push({ path, sha: current, cited_by });
  }
}

if (mode === 'pin') {
  const files = {};
  for (const { path, cited_by } of [...fresh, ...added, ...drifted].sort((a, b) =>
    a.path.localeCompare(b.path)
  )) {
    files[path] = { sha: tree.get(path), cited_by };
  }
  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ ...manifest, pinned_at: sha, ignore: manifest.ignore ?? {}, files }, null, 2)}\n`
  );
  console.log(`Re-pinned ${Object.keys(files).length} files to ${repo}@${sha.slice(0, 12)}.`);
  if (missing.length) {
    console.log(`\n${missing.length} cited path(s) do NOT exist on ${branch} and were NOT pinned:`);
    for (const m of missing) console.log(`  ${m.path}\n      cited by ${m.cited_by.join(', ')}`);
  }
  process.exit(0);
}

// --- check ---------------------------------------------------------------
console.log(`${repo}@${branch} is at ${sha.slice(0, 12)}`);
console.log(`pinned at                ${String(manifest.pinned_at).slice(0, 12)}`);
console.log(`${cited.size} cited file(s): ${fresh.length} unchanged, ${drifted.length} changed, ${missing.length} missing, ${added.length} unpinned`);
console.log(`${localSpecs.size} platform spec(s) held locally in specs/openapi/ (not drift-checked — never on ${branch})\n`);

if (missingSpecs.size) {
  console.log('MISSING SPEC — a doc cites a spec file this repo does not hold:');
  for (const s of [...missingSpecs].sort()) console.log(`  ${s}`);
  console.log('');
}
if (missing.length) {
  console.log('MISSING — cited path does not exist on main (moved, renamed or deleted):');
  for (const m of missing) console.log(`  ${m.path}\n      cited by ${m.cited_by.join(', ')}`);
  console.log('');
}
if (drifted.length) {
  console.log('CHANGED — the file backing these claims has been edited since it was read:');
  for (const d of drifted) {
    console.log(`  ${d.path}  ${d.pinned.slice(0, 12)} -> ${d.current.slice(0, 12)}`);
    console.log(`      cited by ${d.cited_by.join(', ')}`);
    console.log(`      diff: gh api repos/${repo}/compare/${manifest.pinned_at}...${sha} --jq '.files[] | select(.filename=="${d.path}") | .patch'`);
  }
  console.log('');
}
if (added.length) {
  console.log('UNPINNED — newly cited, never pinned. Run --pin after verifying:');
  for (const a of added) console.log(`  ${a.path}\n      cited by ${a.cited_by.join(', ')}`);
  console.log('');
}

if (!drifted.length && !missing.length && !added.length && !missingSpecs.size) {
  console.log('No drift. Every cited engine file is byte-identical to when it was read.');
  process.exit(0);
}

console.log(
  'A changed file does NOT mean a claim is wrong — it means the claim is no longer\n' +
    'verified. Re-read the file (engine/fetch.sh <path>), correct whatever moved, then\n' +
    'run `node engine/sync.mjs --pin` to record the new baseline.'
);
process.exit(1);
