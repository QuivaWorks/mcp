// Bundled examples: harvested/ holds redacted real reads (evidence); authored/ holds write bodies (illustration only).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

function readDir(group) {
  let files;
  try {
    files = readdirSync(join(EXAMPLES_DIR, group)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((file) => {
    const parsed = JSON.parse(readFileSync(join(EXAMPLES_DIR, group, file), 'utf8'));
    return { slug: file.replace(/\.json$/, ''), ...parsed, kind: group };
  });
}

export const readHarvested = () => readDir('harvested');
export const readAuthored = () => readDir('authored');

export function listExamples() {
  const all = [...readHarvested(), ...readAuthored()];
  return {
    examples: all.map((e) => ({ slug: e.slug, kind: e.kind, of: e.of, teaches: e.teaches })),
    note:
      'harvested = real READ responses from the platform, with every identity replaced by a <<PLACEHOLDER>>. Never send one back as a write body. ' +
      'authored = hand-written WRITE bodies (create-product, amend-*) and neutralised reads; they illustrate and prove nothing.',
  };
}

export function getExample(slug) {
  const all = [...readHarvested(), ...readAuthored()];
  const found = all.find((e) => e.slug === slug);
  if (!found) throw new Error(`Unknown example "${slug}". Available: ${all.map((e) => e.slug).join(', ')}`);
  return found;
}
