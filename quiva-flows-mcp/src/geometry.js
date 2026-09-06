// Flow-editor geometry.
//
// The hub API stores whatever node/edge JSON you send, but the flow editor
// (microstrate, @xyflow/svelte) needs presentation fields to render a graph:
// nodes want `position`, `type: "custom"` and `measured`; edges want
// `type`/`edgeType: "custom"` plus `sourceHandle`/`targetHandle` (both set to
// the node id — that is the convention every editor-authored flow uses).
//
// Configs built through the API without these render stacked at the origin, so
// create/update fill in anything missing. Existing values are never touched.

const X_SPACING = 296;
const Y_SPACING = 150;
const NODE_SIZE = { width: 96, height: 96 };

function layerNodes(nodes, edges) {
  const ids = nodes.map((n) => n?.data?.id ?? n?.id).filter(Boolean);
  const idSet = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, []]));
  const outgoing = new Map(ids.map((id) => [id, []]));

  for (const edge of edges) {
    const { source, target } = edge ?? {};
    if (!idSet.has(source) || !idSet.has(target)) continue;
    outgoing.get(source).push(target);
    incoming.get(target).push(source);
  }

  // Longest-path depth, iterated to a fixed point. Bounded by node count so a
  // cyclic config (invalid, but we still want to lay it out) cannot spin.
  const depth = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const id of ids) {
      for (const next of outgoing.get(id)) {
        if (depth.get(next) < depth.get(id) + 1) {
          depth.set(next, depth.get(id) + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const layers = new Map();
  for (const id of ids) {
    const d = depth.get(id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(id);
  }
  void incoming;
  return layers;
}

// Fill in missing presentation fields. Returns { config, added } where `added`
// lists what was supplied, so tools can report it instead of hiding it.
export function applyGeometry(config) {
  if (!config || typeof config !== 'object') return { config, added: [] };

  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];
  const added = [];

  const layers = layerNodes(nodes, edges);
  const positionFor = new Map();
  for (const [layerDepth, layerIds] of layers) {
    const offset = ((layerIds.length - 1) * Y_SPACING) / 2;
    layerIds.forEach((id, index) => {
      positionFor.set(id, { x: layerDepth * X_SPACING, y: index * Y_SPACING - offset });
    });
  }

  const outNodes = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const id = node?.data?.id ?? node?.id;
    const next = { ...node };
    if (!next.id && id) next.id = id;
    if (!next.position || typeof next.position !== 'object') {
      next.position = positionFor.get(id) ?? { x: 0, y: 0 };
      added.push(`node ${id}: position`);
    }
    if (!next.type) {
      next.type = 'custom';
      added.push(`node ${id}: type=custom`);
    }
    if (!next.measured) {
      next.measured = { ...NODE_SIZE };
      added.push(`node ${id}: measured`);
    }
    return next;
  });

  const outEdges = edges.map((edge) => {
    if (!edge || typeof edge !== 'object') return edge;
    const { source, target } = edge;
    const next = { ...edge };
    if (!next.id && source && target) {
      next.id = `xy-edge__${source}${source}-${target}${target}`;
      added.push(`edge ${source}->${target}: id`);
    }
    if (!next.sourceHandle && source) {
      next.sourceHandle = source;
      added.push(`edge ${source}->${target}: sourceHandle`);
    }
    if (!next.targetHandle && target) {
      next.targetHandle = target;
      added.push(`edge ${source}->${target}: targetHandle`);
    }
    if (!next.type) {
      next.type = 'custom';
      added.push(`edge ${source}->${target}: type=custom`);
    }
    if (!next.edgeType) {
      next.edgeType = 'custom';
      added.push(`edge ${source}->${target}: edgeType=custom`);
    }
    return next;
  });

  return { config: { ...config, nodes: outNodes, edges: outEdges }, added };
}
