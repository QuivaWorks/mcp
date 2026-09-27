// The servers composed into the remote build. Paths are relative to the repo root.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PACKAGES = [
  { dir: 'quiva-flows-mcp', prefix: 'flows_', covers: 'workflows: build, validate, publish, run and debug flows' },
  { dir: 'quiva-records-mcp', prefix: 'records_', covers: 'record configs (schema + form views) and the records in them' },
  { dir: 'quiva-documents-mcp', prefix: 'documents_', covers: 'document templates, generated documents and e-signatures' },
  { dir: 'quiva-workspaces-mcp', prefix: 'workspaces_', covers: 'spaces, tasks, comments and space files' },
  { dir: 'quiva-agents-mcp', prefix: 'assistants_', covers: 'assistant configurations, and invoking an assistant' },
  { dir: 'quiva-distribution-mcp', prefix: 'distribution_', covers: 'distribution: products, product definitions, invites and messages' },
  { dir: 'quiva-coworker-mcp', prefix: 'coworker_', covers: 'Abbie, the AI coworker: skills, todos, org memory, profile and corrections' },
];

// Tools that touch the local filesystem or spawn processes. None do today;
// add the prefixed name here if one appears (test/safety.test.js flags it).
export const DENYLIST = new Set([]);

// Loads each package's registerTools and QuivaClient. A missing or malformed
// package is skipped and reported, never fatal.
export async function loadPackages({ packages = PACKAGES, root = REPO_ROOT, log = console.error } = {}) {
  const loaded = [];
  for (const pkg of packages) {
    const base = join(root, pkg.dir, 'src');
    try {
      const mod = await import(pathToFileURL(join(base, 'index.js')).href);
      const { QuivaClient } = await import(pathToFileURL(join(base, 'client.js')).href);
      if (typeof mod.registerTools !== 'function') throw new Error('no registerTools export');
      if (typeof QuivaClient !== 'function') throw new Error('no QuivaClient export');
      loaded.push({ ...pkg, registerTools: mod.registerTools, QuivaClient });
    } catch (err) {
      log(`[quiva-mcp-remote] skipping ${pkg.dir}: ${String(err.message).split('\n')[0]}`);
    }
  }
  return loaded;
}
