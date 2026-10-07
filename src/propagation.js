/**
 * 影响传播演算（纯函数规划器）。
 *
 * 设计要点：
 *  - 完全由“截至某 seq 的事实快照 + 触发点”决定结果，同样输入必然得到同样的
 *    有序处置清单（可重复、可解释）；
 *  - 处置只有两种：仍在控制范围内 → quarantine（冻结）；已依法放行或已消费 →
 *    notify（风险通知补充），任何节点都不会被删除；
 *  - 每个节点的处置都附带证据路径与原因，service 负责把动作落账并写检查点，
 *    崩溃后从最后检查点继续、不重复落账。
 */

/**
 * @param {ReturnType<import('./genealogy.js').buildGraph>} graph
 * @param {(nodeId: string, path: object[]) => {action:'quarantine'|'notify', statuses: object}} resolve
 * @param {string} rootId 触发隔离的关键节点
 */
export function planPropagation(graph, resolve, rootId) {
  const paths = graph.reachableFrom(rootId);
  if (!paths.has(rootId)) return [];

  // 确定性顺序：按深度、再按节点 id。
  const ordered = [...paths.entries()]
    .map(([node_id, path]) => ({ node_id, path, depth: path.length }))
    .sort((a, b) => a.depth - b.depth || a.node_id.localeCompare(b.node_id));

  const plan = [];
  for (const step of ordered) {
    const { action, statuses } = resolve(step.node_id, step.path);
    plan.push({
      node_id: step.node_id,
      depth: step.depth,
      path: step.path.map((edge) => ({ from: edge.from, to: edge.to, ratio: edge.ratio, via: edge.ref, kind: edge.kind })),
      action,
      statuses,
    });
  }
  return plan;
}

/** 汇总处置计数，用于运行结束摘要与解释。 */
export function summarize(plan) {
  return plan.reduce(
    (acc, step) => {
      acc[step.action === "quarantine" ? "quarantined" : "notified"] += 1;
      return acc;
    },
    { quarantined: 0, notified: 0, total: plan.length }
  );
}

/**
 * 解释单条处置：为什么这个节点是冻结而不是通知（或反之）。
 */
export function explainStep(step) {
  const chain = step.path.map((edge) => `${edge.from}→${edge.to}`).join("，") || "（触发节点本身）";
  if (step.action === "notify") {
    const why = step.statuses.consumed
      ? "产品已被消费者购买，脱离控制范围"
      : step.statuses.released
        ? `已有监管放行（${step.statuses.release_refs?.join("、") ?? "出口证明"}），依法不能冻结`
        : "已脱离控制范围";
    return `影响经 ${chain} 到达该节点；${why}，仅补发风险通知，记录保留不删除。`;
  }
  return `影响经 ${chain} 到达该节点；该批次仍在企业控制范围内且无法定放行/消费记录，执行冻结。`;
}
