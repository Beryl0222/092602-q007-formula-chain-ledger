/**
 * 批次谱系图。
 *
 * 从账本事实重建有向投料图：原奶批次 → 运输封签 → 加工/合批产出 → 成品罐。
 * 边上带投入比例，支持：
 *  - descendants 正向可达（影响传播的候选集合）；
 *  - ancestors 反向归因（任意罐码反查经过的节点及原料占比）；
 *  - divergence 解释相邻批次为何未被波及（在哪一个合批/拆批点分流）。
 */
import { inputRatios } from "./domain.js";

export function buildGraph(facts) {
  const nodes = new Map();
  const edges = [];

  const touch = (id, kind, seq) => {
    if (!id) return;
    if (!nodes.has(id)) nodes.set(id, { id, kind, seq });
  };

  for (const fact of facts) {
    switch (fact.type) {
      case "raw_milk_batch":
        touch(fact.batch_id, "raw_milk_batch", fact.seq);
        break;
      case "shipment":
        touch(fact.shipment_id, "shipment", fact.seq);
        for (const batchId of fact.batch_ids) {
          touch(batchId, "raw_milk_batch", null);
          edges.push({ from: batchId, to: fact.shipment_id, ratio: 1, kind: "shipment", seq: fact.seq, ref: fact.shipment_id });
        }
        break;
      case "transform": {
        touch(fact.output_id, fact.output_kind || "product_lot", fact.seq);
        const ratios = inputRatios(fact.inputs);
        for (const input of ratios) {
          touch(input.id, "product_lot", null);
          edges.push({ from: input.id, to: fact.output_id, ratio: input.ratio, kind: "transform", seq: fact.seq, ref: fact.run_id });
        }
        break;
      }
      case "can_pack":
        touch(fact.can_code, "can", fact.seq);
        touch(fact.lot_id, "product_lot", null);
        edges.push({ from: fact.lot_id, to: fact.can_code, ratio: 1, kind: "pack", seq: fact.seq, ref: fact.can_code });
        break;
    }
  }

  const forward = new Map();
  const reverse = new Map();
  for (const edge of edges) {
    if (!forward.has(edge.from)) forward.set(edge.from, []);
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    forward.get(edge.from).push(edge);
    reverse.get(edge.to).push(edge);
  }

  /** 正向可达：返回节点 id -> 一条来自触发点的路径（边序列）。路径按确定性顺序选取。 */
  function reachableFrom(rootId) {
    const paths = new Map();
    paths.set(rootId, []);
    const queue = [rootId];
    while (queue.length) {
      const current = queue.shift();
      const outs = (forward.get(current) ?? []).slice().sort((a, b) => a.to.localeCompare(b.to));
      for (const edge of outs) {
        if (!paths.has(edge.to)) {
          paths.set(edge.to, [...paths.get(current), edge]);
          queue.push(edge.to);
        }
      }
    }
    return paths;
  }

  /** 反向祖先：返回节点 id -> {path, share}，share 为沿路径投入比例连乘。 */
  function ancestorsOf(nodeId) {
    const result = new Map();
    const walk = (id, path, share) => {
      const ins = (reverse.get(id) ?? []).slice().sort((a, b) => a.from.localeCompare(b.from));
      for (const edge of ins) {
        if (result.has(edge.from)) continue;
        const nextShare = Number((share * edge.ratio).toFixed(6));
        const nextPath = [edge, ...path];
        result.set(edge.from, { path: nextPath, share: nextShare });
        walk(edge.from, nextPath, nextShare);
      }
    };
    walk(nodeId, [], 1);
    return result;
  }

  /** 从触发点到某后代的单条解释路径（边序列），无路径返回 null。 */
  function pathTo(rootId, targetId) {
    return reachableFrom(rootId).get(targetId) ?? null;
  }

  /**
   * 解释相邻罐/批次为何未受触发点波及：
   * 无共享祖先 → 来源完全不同；否则给出最近的共同祖先与两侧分流的投料边。
   */
  function divergence(triggerId, neighborId) {
    const triggerAncestors = ancestorsOf(triggerId);
    const neighborAncestors = ancestorsOf(neighborId);
    triggerAncestors.set(triggerId, { path: [], share: 1 });
    neighborAncestors.set(neighborId, { path: [], share: 1 });

    let shared = null;
    for (const id of triggerAncestors.keys()) {
      if (neighborAncestors.has(id) && (!shared || triggerAncestors.get(id).path.length < triggerAncestors.get(shared).path.length)) {
        shared = id;
      }
    }
    if (!shared) {
      return { related: false, reason: "no_shared_origin", detail: "与触发节点没有共同上游，原料来源完全不同" };
    }
    if (shared === triggerId || shared === neighborId) {
      return { related: true, reason: "lineal", detail: "存在直系投料关系，应在影响范围内" };
    }
    const triggerEdge = triggerAncestors.get(shared).path[0] ?? null; // 共同祖先 → 触发侧的第一条边
    const neighborEdge = neighborAncestors.get(shared).path[0] ?? null;
    return {
      related: false,
      reason: "split_after_shared_origin",
      shared_node: shared,
      trigger_branch: triggerEdge ? { via: triggerEdge.ref, into: triggerEdge.to, ratio: triggerEdge.ratio } : null,
      neighbor_branch: neighborEdge ? { via: neighborEdge.ref, into: neighborEdge.to, ratio: neighborEdge.ratio } : null,
      detail: `共同上游为 ${shared}，其后在不同投料/加工分支分流，未进入受波及产线`,
    };
  }

  /**
   * 给定污染根 rootId（已确认 affectedId 在其影响范围内、neighborId 不在），
   * 解释邻居为何未波及：沿 affectedId 与 neighborId 的共同上游，定位分流点，
   * 并判定分流发生在污染点之前（邻居安全）还是完全不同来源。
   */
  function explainAgainstRoot(rootId, affectedId, neighborId) {
    const fromRoot = reachableFrom(rootId);
    if (fromRoot.has(neighborId)) {
      return { related: true, reason: "downstream_after_merge", detail: `邻居同样位于污染根 ${rootId} 的下游，属于同一影响范围` };
    }
    const aAnc = ancestorsOf(affectedId);
    const nAnc = ancestorsOf(neighborId);
    aAnc.set(affectedId, { path: [], share: 1 });
    nAnc.set(neighborId, { path: [], share: 1 });

    // rootId → affectedId 路径经过的节点（含根）。
    const rootPathNodes = new Set([rootId]);
    (fromRoot.get(affectedId) ?? []).forEach((e) => rootPathNodes.add(e.to));

    // 距 affectedId 由近到远找第一个共同上游。
    let split = null;
    for (const id of [affectedId, ...aAnc.keys()]) {
      if (nAnc.has(id)) { split = id; break; }
    }
    if (!split) {
      return { related: false, reason: "no_shared_origin", detail: "与受影响产线没有共同上游，原料来源完全不同" };
    }
    if (rootPathNodes.has(split)) {
      // 分流点位于 root→affected 路径上，却是 neighbor 的祖先而 neighbor 不在 root 下游，
      // 仅当分流点本身就是污染根之前的共同祖先：说明污染发生在分流之后。
      const aEdge = aAnc.get(split).path[0] ?? null;
      const nEdge = nAnc.get(split).path[0] ?? null;
      return {
        related: false,
        reason: "split_before_contamination",
        split_node: split,
        affected_branch: aEdge ? { via: aEdge.ref, into: aEdge.to, ratio: aEdge.ratio } : null,
        neighbor_branch: nEdge ? { via: nEdge.ref, into: nEdge.to, ratio: nEdge.ratio } : null,
        detail: `共同上游 ${split} 在污染点 ${rootId} 之前即分流：受影响侧经 ${aEdge?.to ?? "-"}，邻居侧经 ${nEdge?.to ?? "-"}，邻居未经过污染节点`,
      };
    }
    // 共同上游不在污染路径上：污染是 affectedId 独有的更晚分支引入。
    const nEdge = nAnc.get(split).path[0] ?? null;
    return {
      related: false,
      reason: "contamination_after_split",
      split_node: split,
      neighbor_branch: nEdge ? { via: nEdge.ref, into: nEdge.to, ratio: nEdge.ratio } : null,
      detail: `双方在 ${split} 之后早已分流，污染点 ${rootId} 位于本罐独有的后续支路上，邻居侧未经过`,
    };
  }

  return { nodes, edges, forward, reverse, reachableFrom, ancestorsOf, pathTo, divergence, explainAgainstRoot };
}
