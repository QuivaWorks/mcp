// Bundled reference examples.
//
// examples/harvested/  — real agent configs pulled off the platform by
//                        tools/harvest-examples.mjs, chosen as a spread over
//                        traits (tools, knowledge, output_schema, each provider
//                        in live use). These demonstrably work, so they are the
//                        shapes to copy and the golden fixtures the validator
//                        must accept.
// examples/authored/   — hand-written teaching fixtures. NOT evidence: a
//                        hand-written example is how the flows MCP shipped a
//                        wrong rules syntax (docs/lessons.md).
//
// A ten-file spread cannot tell you whether a validator RULE is wrong — for that
// run tools/sweep-validate.mjs over all ~189 live configs.

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
    return { group: kind, file, ...parsed };
  });
}

const slugOf = (e) => e.slug ?? e.file.replace(/\.json$/, '');

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
    kind: e.group === 'harvested' ? 'harvested (real, on the platform)' : 'authored (illustration only)',
    name: e.config?.name ?? e.source?.name,
    llm_provider: e.config?.llm_provider,
    model: e.config?.model,
    tools: (e.config?.tools ?? []).length || undefined,
    knowledge: (e.config?.knowledge ?? []).length || undefined,
    teaches: e.teaches,
  });

  return {
    examples: [...harvested, ...authored].map(describe),
    note:
      'harvested = REAL agent configs from the platform (known to be stored and served); authored = hand-written illustrations (not evidence). ' +
      'Start with "agent-minimal-claude" for the smallest shape that runs, "agent-with-tools-and-knowledge" for tool/knowledge URIs, and "agent-with-output-schema" for the output_schema map (it is NOT JSON Schema). ' +
      'The agent-provider-* examples exist to prove that STORING a non-Claude provider works even though invoke_agent rejects it — the local validator currently treats that as a create-time error. Fetch one with get_example(slug).',
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
