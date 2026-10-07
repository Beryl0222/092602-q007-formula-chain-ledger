/**
 * 奶粉批次全链责任应用服务。
 *
 * 关键规则集中在此层：
 *  - 设备上报按业务键去重；同业务键不同测值即冲突，自动隔离整条依赖链；
 *  - 合批/加工在事件发生时冻结投入比例与各投入批次当时有效的检测结论；
 *  - 提交检测的人不得批准自己提交检测的例外（职责分离）；
 *  - 隔离只冻结仍在控制范围内的下游；已依法放行/已售/已消费只追加风险通知；
 *  - 任何更正都不删除旧记录，二维码与出口证明以新版本/换发事件留痕；
 *  - 影响传播逐步落检查点，服务重开后从未完成节点继续，且计划校验和必须一致。
 */
import * as domain from "./domain.js";
import { Repository } from "./repository.js";
import { buildGraph, upstreamOrigins } from "./graph.js";
import { planRecall, existingQuarantine } from "./recall.js";

export class Service {
  #repo;
  #clock;
  #onStep;

  constructor(repository = new Repository(), { clock = () => new Date().toISOString(), onStep = null } = {}) {
    this.#repo = repository instanceof Repository ? repository : new Repository();
    this.#clock = clock;
    this.#onStep = typeof onStep === "function" ? onStep : null;
  }

  get repository() { return this.#repo; }

  health() { return { service: "formula_chain_ledger", status: "ok", algorithm: "bfs-lineage-v1" }; }

  /* ------------------------------- 基线兼容 ------------------------------- */

  register(payload) { return this.#repo.add(domain.createRecord(payload)); }

  find(recordId) {
    const id = String(recordId);
    return this.#repo.get("generic_record", id)
      ?? this.#repo.list().find((record) => record.id === id)
      ?? null;
  }

  /* ----------------------------- 主数据登记 ------------------------------ */

  registerParty(p) { return this.#repo.add(domain.registerParty(p)); }
  registerMembership(p) { return this.#repo.add(domain.registerCoopMembership(p)); }
  registerQualification(p) { return this.#repo.add(domain.registerRanchQualification(p)); }
  registerStandard(p) { return this.#repo.add(domain.registerStandardVersion(p)); }

  registerRawMilk(p) {
    const payload = { ...p, produced_at: p.produced_at ?? this.#clock() };
    const raw = domain.registerRawMilkLot(payload);
    // 牧场必须在挤奶时点持有有效资格。
    const qual = this.#effectiveQualification(raw.ranch_id, raw.produced_at);
    if (!qual || qual.status !== "qualified") {
      throw new Error(`牧场 ${raw.ranch_id} 在 ${raw.produced_at} 无有效合格资格，原奶不得入账`);
    }
    return this.#repo.add(raw);
  }

  registerTransport(p) {
    const t = domain.registerTransport({ ...p, sealed_at: p.sealed_at ?? this.#clock(), arrived_at: p.arrived_at ?? this.#clock() });
    return this.#repo.add(t);
  }

  /** 加工投料 / 合批：冻结投入比例与当时有效检测结论。 */
  registerFeeding(p) {
    const at = p.at ?? this.#clock();
    const candidate = domain.registerFeeding({ ...p, at });
    const graph = buildGraph(this.#repo);
    for (const part of candidate.inputs) {
      if (!graph.nodes.has(part.lot_id)) throw new Error(`投入批次不存在：${part.lot_id}`);
      if (part.lot_id === candidate.output_lot_id) throw new Error("产出批次不能同时是投入批次");
      if (this.#repo.get("raw_milk_lot", part.lot_id)) {
        const transport = this.#repo.find("transport_seal", (t) => t.raw_id === part.lot_id
          && t.arrived_at <= at).sort((a, b) => b.arrived_at.localeCompare(a.arrived_at))[0];
        if (!transport) throw new Error(`原奶 ${part.lot_id} 缺少运输封签记录，不得投料`);
        if (!transport.arrival_seal_intact) throw new Error(`原奶 ${part.lot_id} 到货封签破损，不得投料`);
      }
    }
    if (this.#repo.get("process", candidate.event_id) || this.#repo.get("merge", candidate.event_id)) {
      throw new Error("投料事件编号已存在");
    }
    if (graph.nodes.has(candidate.output_lot_id)) throw new Error(`产出批次已由其他事件产生：${candidate.output_lot_id}`);
    // 已隔离/冻结的批次不得继续投料或合批。
    for (const part of candidate.inputs) {
      const active = existingQuarantine(this.#repo, part.lot_id);
      if (active) throw new Error(`投入批次 ${part.lot_id} 处于${active.level === "isolated" ? "隔离" : "冻结"}状态（${active.order_id}），不得投料/合批`);
    }
    const snapshot = candidate.inputs.map((part) => Object.freeze({
      lot_id: part.lot_id,
      conclusions: this.#effectiveConclusions(part.lot_id, at),
    }));
    // 投料时点存在未豁免的不合格/无效结论，禁止投料。
    for (const snap of snapshot) {
      for (const conclusion of snap.conclusions) {
        if (conclusion.result !== "pass" && !this.#approvedExceptionFor(conclusion.test_id)) {
          throw new Error(`投入批次 ${snap.lot_id} 的指标 ${conclusion.metric} 当时结论为 ${conclusion.result}，且无已批准例外，不得投料`);
        }
      }
    }
    return this.#repo.add(domain.registerFeeding({ ...p, at, conclusion_snapshot: snapshot }));
  }

  registerSplit(p) {
    const at = p.at ?? this.#clock();
    const split = domain.registerSplit({ ...p, at });
    if (!this.#nodeExists(split.input_lot_id)) throw new Error(`被拆批次不存在：${split.input_lot_id}`);
    const active = existingQuarantine(this.#repo, split.input_lot_id);
    if (active) throw new Error(`被拆批次 ${split.input_lot_id} 处于隔离/冻结状态，不得拆批`);
    for (const part of split.outputs) {
      if (this.#nodeExists(part.lot_id)) throw new Error(`拆批产出编号已存在：${part.lot_id}`);
    }
    return this.#repo.add(split);
  }

  registerPacking(p) {
    const pack = domain.registerPacking({ ...p, packed_at: p.packed_at ?? this.#clock() });
    if (!this.#nodeExists(pack.source_lot_id)) throw new Error(`装罐来源批次不存在：${pack.source_lot_id}`);
    const active = existingQuarantine(this.#repo, pack.source_lot_id);
    if (active) throw new Error(`来源批次 ${pack.source_lot_id} 处于隔离/冻结状态，不得装罐`);
    return this.#repo.add(pack);
  }

  registerCan(p) {
    const can = domain.registerCan(p);
    if (!this.#repo.get("packing", can.can_lot_id)) throw new Error(`罐批不存在：${can.can_lot_id}`);
    return this.#repo.add(can);
  }

  /* -------------------------------- 检测 -------------------------------- */

  /**
   * 设备/实验室检测上报。
   * 同业务键 + 同测值：幂等去重，返回既有记录；
   * 同业务键 + 不同测值：冲突上报入账，立即触发整条依赖链隔离；
   * correction_of 指向旧记录：更正入账，并从旧结论所在批次触发传播。
   */
  reportTest(p) {
    const testedAt = p.tested_at ?? this.#clock();
    const candidate = domain.registerTest({ ...p, tested_at: testedAt });

    // 显式更正：同业务键的新值是“更正”而非“设备冲突”，旧结论保留并触发传播。
    if (candidate.correction_of) {
      const old = this.#repo.get("test", candidate.correction_of);
      if (!old) throw new Error(`被更正的检测不存在：${candidate.correction_of}`);
      const saved = this.#repo.add(candidate);
      const run = this.#runPropagation({
        source: old.lot_id, triggerEventId: saved.test_id, triggerKind: "test_correction",
      });
      return { deduplicated: false, corrected: true, record: saved, ...run };
    }

    const prior = this.#repo.find("test", (t) => t.business_key === candidate.business_key && !t.conflict);
    // repo.find 已按写入顺序返回，首条即该业务键的首次上报。

    if (prior.length) {
      const first = prior[0];
      if (first.metric === candidate.metric && first.value === candidate.value
        && first.result === candidate.result && first.standard_version === candidate.standard_version) {
        return { deduplicated: true, record: first };
      }
      const conflict = this.#repo.add(domain.registerTest({
        ...p, tested_at: testedAt, conflict: true,
        test_id: `conflict:${candidate.business_key}:${this.#repo.seq}`,
      }));
      const run = this.#runPropagation({
        source: conflict.lot_id, triggerEventId: conflict.test_id, triggerKind: "device_conflict",
      });
      return { deduplicated: false, conflict: true, record: conflict, ...run };
    }

    const saved = this.#repo.add(candidate);
    return { deduplicated: false, record: saved };
  }

  /* -------------------------------- 例外 -------------------------------- */

  requestException(p) {
    const req = domain.registerExceptionRequest({ ...p, at: p.at ?? this.#clock() });
    if (!this.#repo.get("test", req.test_id)) throw new Error(`例外关联的检测不存在：${req.test_id}`);
    return this.#repo.add(req);
  }

  decideException(p) {
    const at = p.at ?? this.#clock();
    const decision = domain.registerExceptionApproval({ ...p, at });
    const request = this.#repo.get("exception_request", decision.exception_id);
    if (!request) throw new Error(`例外申请不存在：${decision.exception_id}`);
    const prior = this.#repo.find("exception_approval", (a) => a.exception_id === decision.exception_id);
    if (prior.length) throw new Error(`例外 ${decision.exception_id} 已有处置决定（${prior.at(-1).decision}），结论不可更改，只能另立新申请`);
    const test = this.#repo.get("test", request.test_id);
    // 职责分离：提交检测的人不得批准自己的例外；申请人也不得自批。
    if (decision.decision === "approved"
      && (decision.approved_by === test.submitted_by || decision.approved_by === request.requested_by)) {
      throw new Error("职责分离冲突：检测提交人/申请人不得批准该例外");
    }
    return this.#repo.add(decision);
  }

  /* ------------------------------ 监管与流通 ----------------------------- */

  registerRelease(p) {
    const release = domain.registerRegulatorRelease({ ...p, released_at: p.released_at ?? this.#clock() });
    if (!this.#nodeExists(release.lot_id)) throw new Error(`放行批次不存在：${release.lot_id}`);
    const active = existingQuarantine(this.#repo, release.lot_id);
    if (active) throw new Error(`批次 ${release.lot_id} 处于${active.level === "isolated" ? "隔离" : "冻结"}状态，不得监管放行`);
    return this.#repo.add(release);
  }

  registerExportCert(p) {
    const cert = domain.registerExportCert({ ...p, issued_at: p.issued_at ?? this.#clock() });
    if (!this.#referenceExists(cert)) throw new Error(`出口证明引用对象不存在：${cert.ref_kind}:${cert.ref_id}`);
    return this.#repo.add(cert);
  }

  /** 换发出口证明：登记新证明并追加换发事件，旧证明保留可审计。 */
  reissueExportCert({ old_cert_id, cert_id, issued_by, cert_no, run_id, at } = {}) {
    const old = this.#repo.get("export_cert", old_cert_id);
    if (!old) throw new Error(`旧出口证明不存在：${old_cert_id}`);
    const time = at ?? this.#clock();
    const fresh = this.#repo.add(domain.registerExportCert({
      cert_id, cert_no: cert_no ?? `${old.cert_no}-R`, issued_by: issued_by ?? old.issued_by,
      issued_at: time, [old.ref_kind === "can_code" ? "can_code" : "lot_id"]: old.ref_id,
      supersedes: old.cert_id,
    }));
    return this.#repo.add(domain.registerCertReissue({
      reissue_id: `${cert_id}:reissue`, old_cert_id, new_cert_id: cert_id,
      run_id, reason_code: "UPSTREAM_TEST_CHANGED", at: time,
    }));
  }

  registerDisposition(p) {
    const d = domain.registerDisposition({ ...p, at: p.at ?? this.#clock() });
    if (!this.#referenceExists({ ref_kind: d.ref_kind, ref_id: d.ref_id })) {
      throw new Error(`流通处置对象不存在：${d.ref_kind}:${d.ref_id}`);
    }
    const active = existingQuarantine(this.#repo, d.ref_id);
    if (active) throw new Error(`${d.ref_kind}:${d.ref_id} 处于隔离/冻结状态，不得登记${d.stage === "sold" ? "销售" : "消费"}`);
    return this.#repo.add(d);
  }

  registerQrSnapshot(p) {
    const snap = domain.registerQrSnapshot({ ...p, captured_at: p.captured_at ?? this.#clock() });
    if (!this.#repo.get("can", snap.can_code)) throw new Error(`罐码不存在：${snap.can_code}`);
    return this.#repo.add(snap);
  }

  registerRiskNotice(p) {
    const notice = domain.registerRiskNotice({ ...p, issued_at: p.issued_at ?? this.#clock() });
    return this.#repo.add(notice);
  }

  /** 人工隔离某关键节点（例如牧场资格被暂停）。 */
  quarantineNode({ node_id, reason_code, issued_at } = {}) {
    if (!this.#nodeExists(node_id)) throw new Error(`隔离节点不存在：${node_id}`);
    return this.#runPropagation({
      source: node_id, triggerEventId: `manual:${node_id}:${this.#repo.seq}`,
      triggerKind: "manual", now: issued_at,
    });
  }

  /** 解除隔离/冻结：追加解除事件，保留原指令全部痕迹。 */
  liftQuarantine({ order_id, lifted_by, reason, at } = {}) {
    const order = this.#repo.get("quarantine_order", order_id);
    if (!order) throw new Error(`隔离指令不存在：${order_id}`);
    const lifted = this.#repo.list("quarantine_lift").some((lift) => lift.order_id === order_id);
    if (lifted) throw new Error(`隔离指令 ${order_id} 已解除，不可重复解除`);
    const time = at ?? this.#clock();
    return this.#repo.add(domain.registerQuarantineLift({
      lift_id: `lift:${order_id}`, order_id, node_id: order.node_id,
      lifted_by, reason, at: time,
    }));
  }

  /* ------------------------------ 召回与传播 ----------------------------- */

  /** 预览召回计划（纯读，不落任何记录），用于复核与解释。 */
  previewRecall({ source, trigger_kind = "manual", trigger_event_id = null, now = this.#clock() } = {}) {
    const graph = buildGraph(this.#repo);
    return planRecall(this.#repo, graph, {
      source, triggerKind: trigger_kind, triggerEventId: trigger_event_id ?? `preview:${source}`, now,
    });
  }

  /**
   * 执行影响传播。运行编号由触发事件确定性导出，崩溃后可用同编号继续。
   * 计划在运行开始时整份冻结进账本；执行只按冻结计划追加结果，绝不重算，
   * 因此本 run 已写入的隔离/通知不会改变后续判定（可重复、可恢复）。
   * @param onStep 每处理完一个节点后回调，测试/演练可在此注入中断。
   */
  #runPropagation({ source, triggerEventId, triggerKind, now = this.#clock(), onStep = null }) {
    const runId = `run:${triggerEventId}`;
    const run = this.#repo.get("propagation_run", runId);
    let plan;
    if (!run) {
      plan = planRecall(this.#repo, buildGraph(this.#repo), { source, triggerEventId, triggerKind, now });
      this.#repo.add(domain.registerPropagationRun({
        run_id: runId, trigger_event_id: triggerEventId, trigger_kind: triggerKind,
        source_node: source, log_seq: this.#repo.seq,
        plan_checksum: plan.checksum, frozen_plan: plan, created_at: now,
      }));
    } else {
      plan = run.frozen_plan;
    }
    return this.#executePlan(runId, plan, onStep ?? this.#onStep);
  }

  #executePlan(runId, plan, onStep = null) {
    const now = plan.planned_at;
    const doneSteps = new Set(this.#repo.find("propagation_step", (s) => s.run_id === runId).map((s) => s.node_id));
    for (const decision of plan.decisions) {
      if (doneSteps.has(decision.node_id)) continue;
      this.#applyDecision(decision, runId, now);
      this.#repo.add(domain.registerPropagationStep({
        run_id: runId, node_id: decision.node_id, depth: decision.depth,
        parent: decision.parent ? { node_id: decision.parent, ratio_path: decision.contribution_ratio } : null,
        decision: decision.decision, reason_code: decision.reason_code,
      }));
      if (onStep) onStep(decision);
    }

    // 公开二维码页：为受影响罐码发布新版快照（旧版保留），换发事件与本 run 绑定。
    for (const canCode of plan.result.qr_reissue) {
      if (!this.#repo.get("qr_reissue", `qrre:${runId}:${canCode}`)) {
        this.#reissueQr(canCode, runId, this.#clock(), plan);
      }
    }

    if (!this.#repo.get("propagation_completion", runId)) {
      this.#repo.add(domain.registerPropagationCompletion({
        run_id: runId, status: "done",
        affected: plan.result.affected, frozen: plan.result.frozen,
        isolated: plan.result.isolated, noticed: plan.result.noticed,
        qr_reissue: plan.result.qr_reissue, cert_reissue: plan.result.cert_reissue,
        checksum: plan.checksum, finished_at: this.#clock(),
      }));
    }
    return { run_id: runId, plan, ...plan.result, checksum: plan.checksum };
  }

  #applyDecision(decision, runId, now) {
    if (decision.decision === "isolate" || decision.decision === "freeze") {
      const orderId = `q:${runId}:${decision.node_id}`;
      if (!this.#repo.get("quarantine_order", orderId)) {
        this.#repo.add(domain.registerQuarantine({
          order_id: orderId, run_id: runId, node_id: decision.node_id,
          level: decision.decision === "isolate" ? "isolated" : "frozen",
          reason_code: decision.reason_code, issued_at: now,
        }));
      }
    } else if (decision.decision === "notify") {
      const noticeId = `n:${runId}:${decision.node_id}`;
      if (!this.#repo.get("risk_notice", noticeId)) {
        this.#repo.add(domain.registerRiskNotice({
          notice_id: noticeId, run_id: runId,
          ref_kind: decision.node_kind === "can" ? "can_code" : "lot", ref_id: decision.node_id,
          message: `节点已不在控制范围（${decision.reason_code}），上游质量结论变更，发出风险通知，原记录依法保留。`,
          issued_by: "quality-office", issued_at: now,
        }));
      }
    }
  }

  #reissueQr(canCode, runId, now, plan) {
    const reissueId = `qrre:${runId}:${canCode}`;
    if (this.#repo.get("qr_reissue", reissueId)) return;
    const snaps = this.#repo.find("qr_snapshot", (q) => q.can_code === canCode)
      .sort((a, b) => a.version - b.version);
    const latest = snaps.at(-1);
    const version = latest.version + 1;
    const content = `${latest.content}\n【质量更新 ${now}】上游检测结论变更，本罐所在批次处置见追溯页；本页为第 ${version} 版，历史版本保留。`;
    const snapshotId = `${canCode}:v${version}`;
    this.#repo.add(domain.registerQrSnapshot({
      snapshot_id: snapshotId, can_code: canCode, version, content, captured_at: now,
    }));
    this.#repo.add(domain.registerQrReissue({
      reissue_id: reissueId, can_code: canCode,
      old_snapshot_id: latest.snapshot_id, new_snapshot_id: snapshotId, run_id: runId, at: now,
    }));
  }

  /**
   * 服务恢复：继续所有未完成的传播。计划以运行开始时冻结的版本为准，
   * 因此恢复结果与崩溃前逐节点一致（可重复）；账本新事件属于下一次传播。
   */
  resumePropagations() {
    const finished = new Set(this.#repo.list("propagation_completion").map((c) => c.run_id));
    return this.#repo.list("propagation_run").filter((r) => !finished.has(r.run_id)).map((run) => {
      const result = this.#executePlan(run.run_id, run.frozen_plan);
      return { run_id: run.run_id, resumed: true, result };
    });
  }

  listRuns() {
    return this.#repo.list("propagation_run").map((run) => ({
      run_id: run.run_id, source_node: run.source_node,
      trigger_kind: run.trigger_kind, plan_checksum: run.plan_checksum,
      completed: this.#repo.list("propagation_completion").some((c) => c.run_id === run.run_id),
    }));
  }

  getRun(runId) {
    const run = this.#repo.get("propagation_run", runId);
    if (!run) return null;
    const steps = this.#repo.find("propagation_step", (s) => s.run_id === runId);
    const completion = this.#repo.list("propagation_completion").find((c) => c.run_id === runId) ?? null;
    return { run, steps, completion };
  }

  /* --------------------------- 罐码反查（追溯接口） ------------------------- */

  trace(canCode) {
    const graph = buildGraph(this.#repo);
    if (!graph.nodes.has(canCode)) throw new Error(`罐码不存在：${canCode}`);
    const origins = upstreamOrigins(graph, canCode);
    const nodeIds = new Set([canCode]);
    for (const o of origins) o.path.forEach((edge) => nodeIds.add(edge.from).add(edge.to));

    const nodes = [...nodeIds].sort().map((id) => this.#describeNode(id, graph));
    const standards = new Map();
    for (const record of this.#repo.list("test")) {
      if (nodeIds.has(record.lot_id)) standards.set(`${record.standard_id}@${record.standard_version}`, {
        standard_id: record.standard_id, version: record.standard_version,
      });
    }
    for (const snap of this.#repo.list("standard_version")) standards.set(`${snap.standard_id}@${snap.version}`, {
      standard_id: snap.standard_id, version: snap.version, title: snap.title, effective_from: snap.effective_from,
    });

    // 最近一次波及本罐的传播运行，用来解释相邻批次为何未受影响。
    const runs = this.#repo.list("propagation_completion")
      .filter((c) => c.affected.includes(canCode))
      .sort((a, b) => b.finished_at.localeCompare(a.finished_at));
    const latestRun = runs[0]?.run_id ?? null;
    const neighborsExcluded = latestRun
      ? this.#repo.get("propagation_run", latestRun).frozen_plan.result.neighbors_excluded
      : [];

    return {
      can_code: canCode,
      lineage: origins.map((o) => ({
        source: o.source, contribution_ratio: o.ratio_path,
        path: o.path.map((edge) => ({
          from: edge.from, to: edge.to, event_id: edge.event_id, event_kind: edge.event_kind,
          ratio: edge.ratio,
          conclusion_snapshot: edge.conclusion_snapshot
            ? { lot_id: edge.conclusion_snapshot.lot_id, conclusions: edge.conclusion_snapshot.conclusions }
            : null,
        })),
      })),
      nodes,
      standards_used: [...standards.values()].sort((a, b) =>
        a.standard_id.localeCompare(b.standard_id) || String(a.version).localeCompare(String(b.version))),
      responsible_parties: this.#responsibleParties(nodeIds),
      latest_run_id: latestRun,
      neighbors_excluded: neighborsExcluded,
    };
  }

  #describeNode(id, graph) {
    const kind = graph.nodes.get(id)?.kind ?? "lot";
    const records = {
      raw_milk: this.#repo.get("raw_milk_lot", id),
      tests: this.#repo.find("test", (t) => t.lot_id === id),
      releases: this.#repo.find("regulator_release", (r) => r.lot_id === id),
      dispositions: this.#repo.find("disposition", (d) => d.ref_kind === "lot" && d.ref_id === id),
      quarantines: this.#repo.find("quarantine_order", (q) => q.node_id === id),
      notices: this.#repo.find("risk_notice", (n) => n.ref_kind === "lot" && n.ref_id === id),
      export_certs: this.#repo.find("export_cert", (c) => c.ref_id === id),
    };
    if (kind === "can") {
      records.dispositions = this.#repo.find("disposition", (d) => d.ref_kind === "can_code" && d.ref_id === id);
      records.qr_snapshots = this.#repo.find("qr_snapshot", (q) => q.can_code === id);
      records.export_certs = this.#repo.find("export_cert", (c) => c.ref_kind === "can_code" && c.ref_id === id);
      records.notices = this.#repo.find("risk_notice", (n) => n.ref_kind === "can_code" && n.ref_id === id);
    }
    const liftedOrders = new Set(this.#repo.list("quarantine_lift").map((lift) => lift.order_id));
    const activeQuarantine = records.quarantines.filter((q) => !liftedOrders.has(q.order_id))
      .sort((a, b) => b.issued_at.localeCompare(a.issued_at))[0] ?? null;
    const disposition = records.dispositions.sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
    return {
      node_id: id, kind,
      owner_party_id: graph.nodes.get(id)?.owner_party_id ?? null,
      current_handling: activeQuarantine ? activeQuarantine.level
        : disposition ? disposition.stage
        : records.releases.length ? "released" : "in_control",
      current_handling_reason: activeQuarantine ? activeQuarantine.reason_code
        : disposition ? `ALREADY_${disposition.stage.toUpperCase()}`
        : records.releases.length ? "LAWFULLY_RELEASED" : "IN_CONTROL",
      records,
    };
  }

  #responsibleParties(nodeIds) {
    const parties = new Map();
    const add = (partyId, role, evidence) => {
      if (!partyId) return;
      const entry = parties.get(partyId) ?? { party_id: partyId, roles: [] };
      if (!entry.roles.some((r) => r.role === role && r.evidence === evidence)) {
        entry.roles.push({ role, evidence });
      }
      parties.set(partyId, entry);
    };
    for (const raw of this.#repo.list("raw_milk_lot")) {
      if (!nodeIds.has(raw.raw_id)) continue;
      add(raw.ranch_id, "牧场", raw.raw_id);
      if (raw.coop_id) add(raw.coop_id, "奶农合作社", raw.raw_id);
      const memberships = this.#repo.find("coop_membership", (m) => m.ranch_id === raw.ranch_id
        && m.joined_at <= raw.produced_at
        && (!m.left_at || m.left_at > raw.produced_at));
      for (const m of memberships) add(m.farmer_id, "合作社成员（奶农）", m.id);
    }
    for (const t of this.#repo.list("transport_seal")) if (nodeIds.has(t.raw_id)) add(t.carrier_id, "承运方", t.seal_id);
    for (const evt of this.#repo.list("process").concat(this.#repo.list("merge")).concat(this.#repo.list("split"))) {
      if (nodeIds.has(evt.output_lot_id ?? evt.input_lot_id)) add(evt.plant_id, "加工厂", evt.event_id ?? evt.split_id);
    }
    for (const pack of this.#repo.list("packing")) if (nodeIds.has(pack.can_lot_id)) add(pack.plant_id, "加工厂（装罐）", pack.can_lot_id);
    for (const test of this.#repo.list("test")) if (nodeIds.has(test.lot_id)) add(test.submitted_by, `检测提交（${test.source}）`, test.test_id);
    for (const release of this.#repo.list("regulator_release")) if (nodeIds.has(release.lot_id)) add(release.regulator_id, "监管放行", release.release_id);
    return [...parties.values()].sort((a, b) => a.party_id.localeCompare(b.party_id));
  }

  /* -------------------------------- 内部工具 ------------------------------ */

  #nodeExists(id) {
    const graph = buildGraph(this.#repo);
    return graph.nodes.has(id);
  }

  #referenceExists(ref) {
    const graph = buildGraph(this.#repo);
    if (ref.ref_kind === "can_code") return graph.nodes.has(ref.ref_id);
    return graph.nodes.has(ref.ref_id) || this.#repo.get("packing", ref.ref_id);
  }

  #effectiveQualification(ranchId, at) {
    return this.#repo.find("ranch_qualification", (q) => q.ranch_id === ranchId && q.valid_from <= at
      && (!q.valid_to || q.valid_to > at))
      .sort((a, b) => b.version - a.version)[0] ?? null;
  }

  /** 某检测是否已有绑定的、已批准且未被驳回的例外。 */
  #approvedExceptionFor(testId) {
    return this.#repo.find("exception_request", (req) => req.test_id === testId).some((req) =>
      this.#repo.find("exception_approval", (a) => a.exception_id === req.exception_id)
        .some((a) => a.decision === "approved"));
  }

  /**
   * 某批次在指定时点“当时有效”的检测结论：
   * 取 tested_at <= at 的检测，排除已被更正的旧结论与冲突上报，按指标取最新一条。
   */
  #effectiveConclusions(lotId, at) {
    const tests = this.#repo.find("test", (t) => t.lot_id === lotId && t.tested_at <= at && !t.conflict);
    const corrected = new Set(tests.filter((t) => t.correction_of).map((t) => t.correction_of));
    const latestByMetric = new Map();
    for (const test of tests) {
      if (corrected.has(test.test_id)) continue;
      const current = latestByMetric.get(test.metric);
      if (!current || test.tested_at > current.tested_at) latestByMetric.set(test.metric, test);
    }
    return [...latestByMetric.values()]
      .sort((a, b) => a.metric.localeCompare(b.metric))
      .map((test) => ({
        test_id: test.test_id, metric: test.metric, value: test.value, unit: test.unit,
        result: test.result, standard_id: test.standard_id, standard_version: test.standard_version,
        tested_at: test.tested_at,
      }));
  }
}
