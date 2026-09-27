// Builds one McpServer holding every loaded package's tools under its prefix.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DENYLIST } from './packages.js';

export const SERVER_INFO = { name: 'quiva', version: '0.1.0' };

export function buildInstructions(loaded) {
  const lines = loaded.map((p) => `- ${p.prefix}* — ${p.covers}`);
  return [
    'Tools for the Quiva platform, grouped by prefix:',
    ...lines,
    '',
    'Each group documents its own contracts and gotchas: call <prefix>list_reference_topics, then the',
    "group's get_*_reference tool, before building anything. <prefix>list_examples / get_example return real",
    'configs to copy. Validate locally with the validate_* tools before any create or update.',
  ].join('\n');
}

// Filters denylisted tools and records names, so callers can check uniqueness.
function registrar(server, names) {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool' || prop === 'tool') {
        return (name, ...rest) => {
          if (DENYLIST.has(name)) return undefined;
          names.push(name);
          return target[prop](name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// `credential` is { apiKey } or { bearerToken }; each package gets its own client.
export function buildServer(loaded, { apiUrl, credential }) {
  const server = new McpServer(SERVER_INFO, { instructions: buildInstructions(loaded) });
  const names = [];
  const shim = registrar(server, names);
  for (const pkg of loaded) {
    const client = new pkg.QuivaClient({ apiUrl, ...credential });
    pkg.registerTools(shim, client, { prefix: pkg.prefix });
  }
  return { server, names };
}

// Startup check: throws on a duplicate name and returns the per-prefix counts.
export function assertUniqueTools(loaded, apiUrl) {
  const counts = {};
  const seen = new Set();
  for (const pkg of loaded) {
    const { names } = buildServer([pkg], { apiUrl, credential: { apiKey: 'startup-check' } });
    for (const name of names) {
      if (seen.has(name)) throw new Error(`duplicate tool name "${name}" (from ${pkg.dir})`);
      if (!name.startsWith(pkg.prefix)) throw new Error(`tool "${name}" from ${pkg.dir} lacks prefix ${pkg.prefix}`);
      seen.add(name);
    }
    counts[pkg.prefix] = names.length;
  }
  return counts;
}
