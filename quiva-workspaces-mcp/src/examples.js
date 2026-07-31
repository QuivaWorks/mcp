// Bundled reference examples.
//
// examples/harvested/  — real spaces, tasks and comments pulled off the platform
//                        by tools/harvest-examples.mjs. These demonstrably work,
//                        so they are the shapes to copy and the golden fixtures
//                        the validator must accept. They are READ responses, so
//                        they carry server-set fields a write body must not send.
// examples/authored/   — hand-written WRITE payloads. A create body is a different
//                        shape from a read, which is the one thing a harvested
//                        example cannot teach. Not evidence: a hand-written
//                        example is how the flows MCP shipped a wrong rules
//                        syntax (docs/lessons.md).

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
    return { kind: 'harvested', file, ...parsed, group: kind };
  });
}

const slugOf = (e) => e.slug ?? e.file.replace(/\.json$/, '');

export function readHarvested() {
  return readDir('harvested');
}

// Every harvested payload flattened into { kind, payload } pairs the validator
// can be pointed at — a space file holds one space, a tasks file holds several.
export function harvestedPayloads() {
  const out = [];
  for (const example of readHarvested()) {
    if (example.config) out.push({ slug: example.slug, kind: 'space', payload: example.config });
    for (const task of example.tasks ?? []) out.push({ slug: `${example.slug}/${task.id}`, kind: 'task', payload: task });
    for (const comment of example.comments ?? []) {
      out.push({ slug: `${example.slug}/${comment.id}`, kind: 'comment', payload: comment });
    }
  }
  return out;
}

export function listExamples() {
  const harvested = readHarvested();
  const authored = readDir('authored');

  if (harvested.length === 0 && authored.length === 0) {
    return { examples: [], note: 'No examples bundled. Run tools/harvest-examples.mjs.' };
  }

  const describe = (e) => ({
    slug: slugOf(e),
    kind: e.group === 'harvested' ? 'harvested (real, on the platform)' : 'authored (illustration only)',
    of: e.kind,
    space_id: e.config?.id ?? e.source?.space_id,
    statuses: (e.config?.statuses ?? []).length || undefined,
    tasks: (e.tasks ?? []).length || undefined,
    comments: (e.comments ?? []).length || undefined,
    teaches: e.teaches,
  });

  return {
    examples: [...harvested, ...authored].map(describe),
    note:
      'harvested = REAL spaces/tasks/comments from the platform (known to work), but they are READ responses — do not echo one back as a create body. ' +
      'authored = hand-written WRITE payloads, which is the shape you actually send. Start with "renewal-review-board" for a create_space -> create_task -> create_comment set, then compare against any harvested space to see the presentation fields the board reads. Fetch one with get_example(slug).',
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
