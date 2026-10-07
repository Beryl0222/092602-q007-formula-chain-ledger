/**
 * 从仅追加账本构建批次血缘图（纯函数，无副作用）。
 *
 * 节点：原奶批次 -> 粉批次（加工/合批产出、拆批产出）-> 成品罐批 -> 罐码。
 * 边记录投入比例与产生事件；合批边额外冻结当时有效的检测结论快照。
 * 邻接表按节点编号排序，保证召回演算的遍历顺序完全确定。
 */

export function buildGraph(repo) {
  const nodes = new Map();
  const edges = [];
  const outgoing = new Map();
  const incoming = new Map();
  const eventGroups = new Map();

  function ensureNode(id, kind, ownerId, at, extra = {}) {
    const existing = nodes.get(id);
    if (existing) {
      Object.assign(existing.meta, extra);
      return existing;
    }
    const node = { id, kind, owner_party_id: ownerId, at, meta: extra };
    nodes.set(id, node);
    outgoing.set(id, []);
    incoming.set(id, []);
    return node;
  }

  function addEdge(from, to, edge) {
    edges.push(edge);
    outgoing.get(from).push(edge);
    incoming.get(to).push(edge);
    const group = eventGroups.get(edge.event_id) ?? { edges: [], kind: edge.event_kind };
    group.edges.push(edge);
    eventGroups.set(edge.event_id, group);
  }

  for (const raw of repo.list("raw_milk_lot")) {
    ensureNode(raw.raw_id, "raw_lot", raw.ranch_id, raw.produced_at, { raw });
  }

  for (const evt of repo.list("process").concat(repo.list("merge"))) {
    ensureNode(evt.output_lot_id, "powder_lot", evt.plant_id, evt.at, { produced_by: evt.event_id });
    for (const part of [...evt.inputs].sort((a, b) => a.lot_id.localeCompare(b.lot_id))) {
      ensureNode(part.lot_id, "lot", null, evt.at);
      addEdge(part.lot_id, evt.output_lot_id, {
        event_id: evt.event_id,
        event_kind: evt.kind,
        from: part.lot_id, to: evt.output_lot_id,
        ratio: part.ratio, qty: part.qty, unit: part.unit,
        conclusion_snapshot: evt.conclusion_snapshot.find((s) => s.lot_id === part.lot_id) ?? null,
      });
    }
  }

  for (const split of repo.list("split")) {
    ensureNode(split.input_lot_id, "lot", split.plant_id, split.at);
    for (const part of [...split.outputs].sort((a, b) => a.lot_id.localeCompare(b.lot_id))) {
      ensureNode(part.lot_id, "powder_lot", split.plant_id, split.at, { produced_by: split.split_id });
      addEdge(split.input_lot_id, part.lot_id, {
        event_id: split.split_id, event_kind: "split",
        from: split.input_lot_id, to: part.lot_id,
        ratio: part.ratio, qty: part.qty, unit: part.unit, conclusion_snapshot: null,
      });
    }
  }

  for (const pack of repo.list("packing")) {
    ensureNode(pack.source_lot_id, "powder_lot", pack.plant_id, pack.packed_at);
    ensureNode(pack.can_lot_id, "can_lot", pack.plant_id, pack.packed_at, { packing: pack });
    addEdge(pack.source_lot_id, pack.can_lot_id, {
      event_id: pack.can_lot_id, event_kind: "packing",
      from: pack.source_lot_id, to: pack.can_lot_id,
      ratio: 1, qty: pack.qty, unit: pack.unit, conclusion_snapshot: null,
    });
  }

  for (const can of repo.list("can")) {
    const packNode = nodes.get(can.can_lot_id);
    ensureNode(can.can_code, "can", packNode?.owner_party_id ?? null, packNode?.at ?? null, { can });
    addEdge(can.can_lot_id, can.can_code, {
      event_id: can.can_code, event_kind: "can",
      from: can.can_lot_id, to: can.can_code,
      ratio: 1, qty: 1, unit: "can", conclusion_snapshot: null,
    });
  }

  for (const list of outgoing.values()) {
    list.sort((a, b) => (a.to.localeCompare(b.to)) || a.event_id.localeCompare(b.event_id));
  }
  for (const list of incoming.values()) {
    list.sort((a, b) => (a.from.localeCompare(b.from)) || a.event_id.localeCompare(b.event_id));
  }

  return { nodes, edges, outgoing, incoming, eventGroups };
}

/** 从任意节点向上游反查，返回到每个原奶源头的路径与累乘投入比例。 */
export function upstreamOrigins(graph, nodeId) {
  const results = [];
  (function walk(id, path, ratio) {
    const ups = graph.incoming.get(id) ?? [];
    if (ups.length === 0) {
      results.push({ source: id, ratio_path: ratio, path });
      return;
    }
    for (const edge of ups) {
      walk(edge.from, [...path, edge], ratio * edge.ratio);
    }
  })(nodeId, [], 1);
  results.sort((a, b) => a.source.localeCompare(b.source));
  return results;
}
