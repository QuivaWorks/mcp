// Bundled reference examples.
//
// examples/harvested/  — real record configs pulled off the platform by
//                        tools/harvest-examples.mjs. These demonstrably work, so
//                        they are the shapes to copy and the golden fixtures the
//                        validator must accept.
// examples/authored/   — hand-written teaching fixtures. Useful as minimal
//                        illustrations, but NOT evidence: a hand-written example
//                        is how the flows MCP shipped a wrong rules syntax.
//                        Prefer harvested ones whenever both exist.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

function readDir(kind) {
  const dir = join(EXAMPLES_DIR, kind);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((file) => {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return { kind, file, ...parsed };
  });
}

export function readHarvested() {
  return readDir('harvested');
}

export function listExamples() {
  const harvested = readHarvested();
  const authored = readDir('authored');

  if (harvested.length === 0 && authored.length === 0) {
    return { examples: [], note: 'No examples bundled. Run tools/harvest-examples.mjs.' };
  }

  const describe = (e) => ({
    slug: e.slug ?? e.file.replace(/\.json$/, ''),
    kind: e.kind,
    name: e.config?.name ?? e.name,
    featured: Boolean(e.featured),
    fields: Object.keys(e.config?.schema?.properties ?? e.schema?.properties ?? {}).length,
    forms: (e.config?.views?.forms ?? e.views?.forms ?? []).length,
    teaches: e.teaches,
  });

  const featured = harvested.filter((e) => e.featured).map((e) => e.slug);

  return {
    examples: [...harvested, ...authored].map(describe),
    featured,
    note: `harvested = REAL configs from the platform (known to work); authored = hand-written illustrations (not evidence). For a form UI, start with the featured harvested configs: ${featured.join(', ') || 'none'}. Fetch one with get_example(slug).`,
  };
}

export function getExample(slug) {
  const all = [...readHarvested(), ...readDir('authored')];
  const found = all.find((e) => (e.slug ?? e.file.replace(/\.json$/, '')) === slug);
  if (!found) {
    throw new Error(
      `Unknown example "${slug}". Available: ${all.map((e) => e.slug ?? e.file.replace(/\.json$/, '')).join(', ') || '(none — run tools/harvest-examples.mjs)'}`
    );
  }
  return found;
}
