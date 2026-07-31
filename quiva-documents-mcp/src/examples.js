// Bundled reference examples.
//
// examples/harvested/  — real templates and generated-document records pulled off
//                        the platform by tools/harvest-examples.mjs. These
//                        demonstrably work, so they are the shapes to copy and the
//                        golden fixtures the validator must accept. Document
//                        examples are PII-scrubbed and kept for their SHAPE only.
// examples/authored/   — hand-written teaching fixtures. Useful as fuller
//                        illustrations, but NOT evidence: a hand-written example
//                        is how the flows MCP shipped a wrong rules syntax
//                        (docs/lessons.md). Prefer harvested ones where both exist.

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

const slugOf = (e) => e.slug ?? e.file.replace(/\.json$/, '');

// Harvested TEMPLATES only — the golden gate validates templates, and a
// generated-document record is not a template config.
export function readHarvestedTemplates() {
  return readDir('harvested').filter((e) => e.kind === 'template' || e.config?.source || e.config?.signatories);
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
    slug: slugOf(e),
    source: e.kind === 'harvested' || e.source ? 'harvested (real, on the platform)' : 'authored (illustration only)',
    of: e.config?.signatures !== undefined ? 'document' : 'template',
    label: e.label ?? e.config?.label,
    signatories: (e.config?.signatories ?? []).length,
    sub_templates: (e.config?.sub_templates ?? []).length,
    teaches: e.teaches,
  });

  return {
    examples: [...harvested.map((e) => ({ ...describe(e), kind: 'harvested' })), ...authored.map((e) => ({ ...describe(e), kind: 'authored' }))],
    note:
      'harvested = REAL templates/documents from the platform (known to work); authored = hand-written illustrations (not evidence). ' +
      'For the full template surface (output.name expressions, filters, sub_template conditions) start with the authored "certificate-of-currency" — and read its conditions_warning, because this MCP\'s own docs describe the wrong conditions syntax. Fetch one with get_example(slug).',
  };
}

export function getExample(slug) {
  const all = [...readHarvested(), ...readDir('authored')];
  const found = all.find((e) => slugOf(e) === slug);
  if (!found) {
    throw new Error(
      `Unknown example "${slug}". Available: ${all.map(slugOf).join(', ') || '(none — run tools/harvest-examples.mjs)'}`
    );
  }
  return found;
}
