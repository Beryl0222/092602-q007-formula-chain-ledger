/**
 * 召回影响传播演算（纯函数、确定性、可重复）。
 *
 * 算法版本固定为 bfs-lineage-v1：
 *  1. 从触发节点做广度优先下游遍历，邻接按节点编号排序，遍历顺序确定；
 *  2. 在可达子图上做 Kahn 拓扑 DP，计算源批次对每个节点的投入贡献比例
 *     （菱形合流时多路径累加）；
 *  3. 逐节点判定处置：源节点隔离；已监管放行或已售/已消费的节点不在控制
 *     范围内，不冻结，只生成风险通知；其余冻结；
 *  4. 解释“为何未波及相邻批次”：与受影响节点同处一个合批事件、但血缘上
 *     不是源节点下游的并列投入批次，列为排除邻居并给出原因；
 *  5. 对整个计划做规范化哈希：同一账本状态、同一触发源，永远得到同一结果。
 */
import { createHash } from "node:crypto";

export const ALGORITHM = "bfs-lineage-v1";

/** 第一阶段：确定性 BFS，返回访问顺序与深度。可按 order 切片做断点续传。 */
export function downstreamBfs(graph, source) {
  if (!graph.nodes.has(source)) throw new Error(`触发节点不存在：${source}`);
  const order = [];
  const depth = new Map([[source, 0]]);
  const firstParent = new Map([[source, null]]);
  const queue = [source];
  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    const children = (graph.outgoing.get(node) ?? [])
      .map((edge) => edge.to)
      .sort()
      .filter((id, index, arr) => index === 0 || id !== arr[index - 1]);
    for (const child of children) {
      if (!depth.has(child)) {
        depth.set(child, depth.get(node) + 1);
        firstParent.set(child, node);
        queue.push(child);
      }
    }
    queue.sort();
  }
  return { order, depth, firstParent };
}

/** 第二阶段：拓扑 DP 计算贡献比例（多路径求和）。 */
export function contributionRatios(graph, order) {
  const reachable = new Set(order);
  const indegree = new Map();
  const parents = new Map();
  for (const id of order) {
    const ups = (graph.incoming.get(id) ?? [])
      .filter((edge) => reachable.has(edge.from))
      .sort((a, b) => a.from.localeCompare(b.from) || a.event_id.localeCompare(b.event_id));
    indegree.set(id, ups.length);
    parents.set(id, ups);
  }
  const ready = order.filter((id) => indegree.get(id) === 0).sort();
  const topo = [];
  while (ready.length) {
    const id = ready.shift();
    topo.push(id);
    for (const edge of (graph.outgoing.get(id) ?? []).filter((e) => reachable.has(e.to))) {
      indegree.set(edge.to, indegree.get(edge.to) - 1);
      if (indegree.get(edge.to) === 0) {
        ready.push(edge.to);
        ready.sort();
      }
    }
  }
  if (topo.length !== order.length) throw new Error("血缘图存在环，传播中止");

  const contribution = new Map(order.map((id) => [id, 0]));
  contribution.set(order[0], 1);
  for (const id of topo) {
    for (const edge of (graph.outgoing.get(id) ?? []).filter((e) => reachable.has(e.to))) {
      contribution.set(edge.to, contribution.get(edge.to) + contribution.get(id) * edge.ratio);
    }
  }
  return { contribution, parents };
}

/** 查询节点当前是否仍在企业控制范围内。 */
export function controlStatus(repo, graph, nodeId) {
  const kind = graph.nodes.get(nodeId)?.kind;
  // 罐码：看罐码自身处置，再看罐批是否已被监管放行。
  if (kind === "can") {
    const disposition = repo.find("disposition", (d) => d.ref_kind === "can_code" && d.ref_id === nodeId)
      .sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    if (disposition) return { controllable: false, reason_code: `ALREADY_${disposition.stage.toUpperCase()}`, evidence: disposition.id };
    const canLotId = graph.incoming.get(nodeId)?.[0]?.from;
    if (canLotId) {
      const lotDisposition = repo.find("disposition", (d) => d.ref_kind === "lot" && d.ref_id === canLotId)
        .sort((a, b) => a.at.localeCompare(b.at)).at(-1);
      if (lotDisposition) return { controllable: false, reason_code: `ALREADY_${lotDisposition.stage.toUpperCase()}`, evidence: lotDisposition.id };
      const release = repo.find("regulator_release", (r) => r.lot_id === canLotId)
        .sort((a, b) => a.released_at.localeCompare(b.released_at)).at(-1);
      if (release) return { controllable: false, reason_code: "LAWFULLY_RELEASED", evidence: release.release_id };
    }
  }
  const lotDisposition = repo.find("disposition", (d) => d.ref_kind === "lot" && d.ref_id === nodeId)
    .sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (lotDisposition) return { controllable: false, reason_code: `ALREADY_${lotDisposition.stage.toUpperCase()}`, evidence: lotDisposition.id };
  const release = repo.find("regulator_release", (r) => r.lot_id === nodeId)
    .sort((a, b) => a.released_at.localeCompare(b.released_at)).at(-1);
  if (release) return { controllable: false, reason_code: "LAWFULLY_RELEASED", evidence: release.release_id };
  return { controllable: true, reason_code: "IN_CONTROL", evidence: null };
}

/** 既有且未解除的隔离/冻结指令（解除是追加事件，不修改原指令）。 */
export function existingQuarantine(repo, nodeId) {
  const lifted = new Set(repo.list("quarantine_lift").map((lift) => lift.order_id));
  return repo.find("quarantine_order", (q) => q.node_id === nodeId && !lifted.has(q.order_id))
    .sort((a, b) => a.issued_at.localeCompare(b.issued_at)).at(-1) ?? null;
}

const SOURCE_REASON = {
  device_conflict: "SOURCE_DEVICE_CONFLICT",
  test_correction: "SOURCE_TEST_CORRECTED",
  manual: "SOURCE_QUALITY_FAULT",
};

/**
 * 完整召回计划。纯计算，不写账本；服务层据此逐步落检查点与指令。
 * @param now 隔离/通知时间，由服务层注入以保证可重复。
 */
export function planRecall(repo, graph, { source, triggerEventId, triggerKind = "manual", now = new Date().toISOString() }) {
  const { order, depth, firstParent } = downstreamBfs(graph, source);
  const { contribution, parents } = contributionRatios(graph, order);

  const decisions = order.map((nodeId) => {
    const control = controlStatus(repo, graph, nodeId);
    const prior = existingQuarantine(repo, nodeId);
    let level;
    let reason_code;
    if (nodeId === source) {
      level = "isolated";
      reason_code = prior ? "SOURCE_ALREADY_QUARANTINED" : (SOURCE_REASON[triggerKind] ?? "SOURCE_QUALITY_FAULT");
    } else if (!control.controllable) {
      level = "notice";
      reason_code = control.reason_code;
    } else {
      level = "frozen";
      reason_code = prior ? "DOWNSTREAM_ALREADY_QUARANTINED" : "DOWNSTREAM_IN_CONTROL";
    }
    return {
      node_id: nodeId,
      node_kind: graph.nodes.get(nodeId)?.kind ?? "lot",
      depth: depth.get(nodeId),
      parent: firstParent.get(nodeId),
      contribution_ratio: round9(contribution.get(nodeId)),
      incoming_paths: [...parents.get(nodeId)].map((edge) => ({
        from: edge.from, event_id: edge.event_id, ratio: edge.ratio,
      })),
      decision: nodeId === source ? "isolate" : (control.controllable ? "freeze" : "notify"),
      level, reason_code,
      control_evidence: control.evidence,
      prior_order_id: prior?.order_id ?? null,
    };
  });

  const affected = new Set(order);
  const frozen = decisions.filter((d) => d.decision === "freeze").map((d) => d.node_id);
  const isolated = decisions.filter((d) => d.decision === "isolate").map((d) => d.node_id);
  const noticed = decisions.filter((d) => d.decision === "notify").map((d) => d.node_id);

  // 需重新发布二维码快照的罐码：存在快照且本 run 尚未换发（执行时判定）。
  const qrReissue = order.filter((id) => graph.nodes.get(id)?.kind === "can"
    && repo.find("qr_snapshot", (q) => q.can_code === id).length > 0).sort();
  // 需换发出口证明：证明直接引用批次或罐码且尚无换发事件（执行时判定）。
  const certReissue = order.filter((id) => repo.find("export_cert", (c) => c.ref_id === id).length > 0).sort();

  // 相邻但未波及：同一合批事件的并列投入，且不在源的下游。
  const neighborExcluded = [];
  const eventIds = new Set();
  for (const id of order) {
    for (const edge of graph.incoming.get(id) ?? []) eventIds.add(edge.event_id);
  }
  for (const eventId of eventIds) {
    const group = graph.eventGroups.get(eventId);
    if (group.kind !== "merge") continue;
    for (const edge of group.edges) {
      if (!affected.has(edge.from)) {
        neighborExcluded.push({
          node_id: edge.from, shared_event: eventId,
          reason_code: "SIBLING_INPUT_NO_LINEAGE",
          reason: "仅为同一合批事件的并列投入，不包含触发节点的任何下游血缘，故不受本次处置影响。",
        });
      }
    }
  }
  neighborExcluded.sort((a, b) => a.node_id.localeCompare(b.node_id) || a.shared_event.localeCompare(b.shared_event));

  const plan = {
    algorithm: ALGORITHM,
    trigger: { event_id: String(triggerEventId), kind: String(triggerKind), source: String(source) },
    planned_at: now,
    order,
    decisions,
    result: {
      affected: [...order].sort(),
      frozen: frozen.sort(),
      isolated: isolated.sort(),
      noticed: noticed.sort(),
      qr_reissue: qrReissue,
      cert_reissue: certReissue,
      neighbors_excluded: neighborExcluded,
    },
  };
  plan.checksum = checksum(plan);
  return plan;
}

/** 规范化校验和：键排序、无多余空白，使任何语言/进程重算一致。 */
export function checksum(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => k !== "checksum").sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function round9(value) {
  return Math.round(value * 1e9) / 1e9;
}
