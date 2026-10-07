/**
 * 奶粉批次全链责任账——应用服务。
 *
 * 对外能力：
 *  - record() 登记全链事实，含引用校验、合批比例与当时有效检测结论快照、
 *    设备业务键去重/冲突隔离、检测与例外批准职责分离；
 *  - release / purchase / publishQrcode：监管放行、消费、二维码快照；
 *  - isolate()：关键节点隔离 → 可重复的影响传播（冻结 / 风险通知），
 *    支持崩溃恢复 resumeRun 与脱离账本重放 replayPropagation；
 *  - trace(canCode)：任意罐码反查节点、责任主体、标准版本、当前处置、邻居未波及原因。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createFact, createRecord, businessKeyOf, nodeIdOf, effectiveReport,
  readingFingerprint, inputRatios, FACT_TYPES,
} from "./domain.js";
import { Ledger } from "./ledger.js";
import { Repository } from "./repository.js";
import { buildGraph } from "./genealogy.js";
import { planPropagation, summarize, explainStep } from "./propagation.js";

export class Service {
  constructor(options = {}) {
    this.ledger = options.ledger ?? new Ledger(options.path ?? null);
    this.repository = options.repository ?? new Repository(); // v0.1 兼容
  }

  health() { return { service: "formula_chain_ledger", status: "ok", entries: this.ledger.size }; }

  // —— v0.1 基础记录（保留兼容） ——
  register(payload) { return this.repository.add(createRecord(payload)); }
  find(recordId) { return this.repository.get(String(recordId)); }

  // —— 事实索引 ——
  #facts() { return this.ledger.facts(); }

  #factsByType(type) { return this.#facts().filter((f) => f.type === type); }

  #nodeExists(id) {
    if (!id) return false;
    return this.#facts().some((f) => nodeIdOf(f) === id);
  }

  #reportsFor(targetId) {
    return this.#factsByType("test_report").filter((r) => r.target_id === targetId);
  }

  /** 某节点当前有效检验结论（已被更正/撤回的报告不生效）。 */
  effectiveTest(targetId) {
    return effectiveReport(this.#reportsFor(targetId));
  }

  /**
   * 登记一条全链事实。
   * @param {string} type FACT_TYPES 中的类型
   * @param {object} payload
   * @param {{actor?:string}} ctx
   */
  record(type, payload, ctx = {}) {
    if (!FACT_TYPES[type]) throw new Error(`未知事实类型：${type}`);

    switch (type) {
      case "raw_milk_batch": {
        const fact = createFact(type, payload, ctx);
        if (this.#farmStatus(fact.farm_id) !== "active") {
          throw new Error(`牧场 ${fact.farm_id} 无有效资格（当前状态：${this.#farmStatus(fact.farm_id) || "未登记"}），不能产出原奶批次`);
        }
        return this.#append(fact, ctx);
      }

      case "shipment": {
        const fact = createFact(type, payload, ctx);
        for (const id of fact.batch_ids) {
          if (!this.#nodeExists(id)) throw new Error(`运输封签引用了不存在的原奶批次：${id}`);
        }
        const sameSeal = this.#factsByType("shipment").some((s) => s.seal_no === fact.seal_no);
        if (sameSeal) throw new Error(`封签号 ${fact.seal_no} 已被使用`);
        return this.#append(fact, ctx);
      }

      case "test_report": {
        const fact = createFact(type, payload, ctx);
        if (!this.#nodeExists(fact.target_id)) throw new Error(`检验对象不存在：${fact.target_id}`);
        if (fact.supersedes) {
          const old = this.#factsByType("test_report").find((r) => r.report_id === fact.supersedes);
          if (!old) throw new Error(`被更正的报告不存在：${fact.supersedes}`);
          if (old.target_id !== fact.target_id) throw new Error("更正报告必须针对同一检验对象");
        }
        return this.#append(fact, ctx);
      }

      case "exception_request": {
        const fact = createFact(type, payload, ctx);
        const report = this.#factsByType("test_report").find((r) => r.report_id === fact.report_id);
        if (!report) throw new Error(`例外申请必须基于检验报告：${fact.report_id}`);
        if (this.#factsByType("exception_request").some((x) => x.request_id === fact.request_id)) {
          throw new Error(`例外申请已存在：${fact.request_id}`);
        }
        return this.#append(fact, ctx);
      }

      case "exception_decision": {
        const fact = createFact(type, payload, ctx);
        const request = this.#factsByType("exception_request").find((x) => x.request_id === fact.request_id);
        if (!request) throw new Error(`例外申请不存在：${fact.request_id}`);
        if (this.#factsByType("exception_decision").some((d) => d.request_id === fact.request_id)) {
          throw new Error(`例外 ${fact.request_id} 已有决定，不可重复批准`);
        }
        // 职责分离：提交检测的人不得批准自己的例外。
        const report = this.#factsByType("test_report").find((r) => r.report_id === request.report_id);
        const tester = report?.tested_by;
        if (tester && fact.decided_by === tester) {
          throw new Error(`职责分离冲突：检测提交人 ${tester} 不得批准本人相关例外`);
        }
        // 批准针对“当前仍不合格”结论的例外，必须记录处置依据。
        if (fact.decision === "approved") {
          const effective = this.effectiveTest(request.target_id);
          if (effective?.result === "fail" && !fact.basis) {
            throw new Error("放行当前仍不合格结论的例外必须填写依据 basis");
          }
        }
        return this.#append(fact, ctx);
      }

      case "transform": {
        const fact = createFact(type, payload, ctx);
        if (this.#factsByType("transform").some((t) => t.run_id === fact.run_id)) {
          throw new Error(`加工批次号已存在：${fact.run_id}`);
        }
        if (this.#nodeExists(fact.output_id)) throw new Error(`产出节点编号已被占用：${fact.output_id}`);
        // 投入引用与状态校验 + 保存“当时有效检测结论”快照。
        const priorGraph = buildGraph(this.ledger.facts());
        const approvedExceptions = this.#approvedExceptionTargets();
        const snapshot = inputRatios(fact.inputs).map((input) => {
          if (!this.#nodeExists(input.id)) throw new Error(`加工投入引用了不存在的批次：${input.id}`);
          if (this.#dispositionOf(input.id) === "quarantined") throw new Error(`投入 ${input.id} 已被冻结，禁止投料`);
          // 结论既可能直接挂在投入节点，也可能挂在其上游（如运输封签内的原奶批次）。
          const sources = [input.id, ...priorGraph.ancestorsOf(input.id).keys()];
          const conclusions = [];
          for (const sourceId of sources) {
            const report = this.effectiveTest(sourceId);
            if (report) {
              if (report.result === "fail" && !approvedExceptions.has(sourceId) && !approvedExceptions.has(input.id)) {
                throw new Error(`投入 ${input.id} 上游 ${sourceId} 的有效结论为不合格且无已批准例外，禁止投料（报告 ${report.report_id}）`);
              }
              conclusions.push({
                source_id: sourceId,
                report_id: report.report_id, result: report.result,
                test_method: report.test_method, method_version: report.method_version,
                parameter: report.parameter, issued_at: report.issued_at,
                exception_approved: report.result === "fail" && (approvedExceptions.has(sourceId) || approvedExceptions.has(input.id)),
              });
            }
          }
          return { id: input.id, qty: input.qty, unit: input.unit, ratio: input.ratio, conclusions };
        });
        fact.input_snapshot = snapshot;
        fact.input_conclusions = snapshot.map((s) => ({ id: s.id, results: s.conclusions.map((c) => c.result) }));
        return this.#append(fact, ctx);
      }

      case "can_pack": {
        const fact = createFact(type, payload, ctx);
        if (!this.#nodeExists(fact.lot_id)) throw new Error(`包装引用了不存在的成品批次：${fact.lot_id}`);
        return this.#append(fact, ctx);
      }

      case "regulatory_release":
        return this.#release(createFact(type, payload, ctx), ctx);

      case "consumer_purchase": {
        const fact = createFact(type, payload, ctx);
        if (!this.#nodeExists(fact.can_code)) throw new Error(`消费记录引用了不存在的罐码：${fact.can_code}`);
        return this.#append(fact, ctx);
      }

      case "qrcode_snapshot":
        return this.#publishQrcode(createFact(type, payload, ctx), ctx);

      case "device_reading":
        return this.#recordReading(createFact(type, payload, ctx), ctx);

      case "risk_notification": {
        const fact = createFact(type, payload, ctx);
        if (!this.#nodeExists(fact.target_id)) throw new Error(`风险通知对象不存在：${fact.target_id}`);
        return this.#append(fact, ctx);
      }

      case "coop_membership":
        return this.#append(createFact(type, payload, ctx), ctx);

      case "farm_qualification":
        return this.#append(createFact(type, payload, ctx), ctx);

      case "qualification_update": {
        const fact = createFact(type, payload, ctx);
        const grant = this.#factsByType("farm_qualification").find((q) => q.farm_id === fact.farm_id);
        if (!grant) throw new Error(`牧场 ${fact.farm_id} 尚未取得资格，不能变更状态`);
        if (this.#farmStatus(fact.farm_id) === fact.status) {
          throw new Error(`牧场 ${fact.farm_id} 当前已是 ${fact.status}，变更无意义`);
        }
        return this.#append(fact, ctx);
      }

      default:
        throw new Error(`暂不支持直接登记类型：${type}`);
    }
  }

  /** 已被批准例外所覆盖的检验对象节点集合。 */
  #approvedExceptionTargets() {
    const approved = new Set();
    for (const decision of this.#factsByType("exception_decision").filter((d) => d.decision === "approved")) {
      const request = this.#factsByType("exception_request").find((x) => x.request_id === decision.request_id);
      if (request) approved.add(request.target_id);
    }
    return approved;
  }

  /** 牧场资格当前状态：授予事实叠加其后最后一条变更。 */
  #farmStatus(farmId) {
    const grant = this.#factsByType("farm_qualification").find((q) => q.farm_id === farmId);
    if (!grant) return null;
    const updates = this.#factsByType("qualification_update").filter((q) => q.farm_id === farmId);
    const latest = updates.sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)) || b.seq - a.seq)[0];
    return latest ? latest.status : grant.status;
  }

  #append(fact, ctx = {}) {
    const key = businessKeyOf(fact);
    if (key && this.ledger.hasKey(key)) throw new Error(`业务键重复：${key}`);
    return this.ledger.appendFact(fact, { actor: ctx.actor ?? fact.actor ?? null, at: fact.at }).fact;
  }

  #release(fact, ctx) {
    if (!this.#nodeExists(fact.target_id)) throw new Error(`放行对象不存在：${fact.target_id}`);
    if (this.#dispositionOf(fact.target_id) === "quarantined") {
      throw new Error(`节点 ${fact.target_id} 已被冻结，不能监管放行`);
    }
    const dup = this.#factsByType("regulatory_release").some((r) => r.release_id === fact.release_id);
    if (dup) throw new Error(`放行证明编号重复：${fact.release_id}`);
    return this.#append(fact, ctx);
  }

  /** 设备上报：业务键去重；同键不同测值 → 记录冲突事实并隔离整条依赖链。 */
  #recordReading(reading, ctx) {
    if (!this.#nodeExists(reading.target_id)) throw new Error(`设备读数归属节点不存在：${reading.target_id}`);
    const key = businessKeyOf(reading);
    const existing = this.ledger.factByKey(key);
    if (existing) {
      if (readingFingerprint(existing) === readingFingerprint(reading)) {
        return { deduplicated: true, business_key: key, seq: existing.seq }; // 幂等丢弃
      }
      // 冲突：保留新读数（独立业务键），并触发归属节点整条依赖链隔离。
      const conflictReading = createFact("device_reading", {
        ...reading, reading_id: `${reading.reading_id}#conflict@${reading.at}`, conflict: true,
      }, ctx);
      const saved = this.#append(conflictReading, ctx);
      const run = this.isolate(reading.target_id, { reason: `设备读数冲突：${key}`, actor: ctx.actor, source: "device_conflict" });
      return { conflict: true, business_key: key, reading: saved, propagation: run };
    }
    return this.#append(reading, ctx);
  }

  #publishQrcode(fact, ctx) {
    if (!this.#nodeExists(fact.can_code)) throw new Error(`二维码快照引用了不存在的罐码：${fact.can_code}`);
    const versions = this.#factsByType("qrcode_snapshot").filter((q) => q.can_code === fact.can_code);
    const expected = versions.length ? Math.max(...versions.map((q) => q.version)) + 1 : 1;
    if (fact.version !== expected) throw new Error(`二维码版本必须连续：期望 v${expected}，实际 v${fact.version}`);
    const content = fact.content ?? this.#renderQrcodeContent(fact.can_code);
    const stored = { ...fact, content, content_hash: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
    return this.#append(stored, ctx);
  }

  /** 公开追溯页内容：从罐码反查全链（消费者看到的是带版本的快照，而非静态介绍）。 */
  #renderQrcodeContent(canCode) {
    const trace = this.trace(canCode);
    return {
      can_code: canCode,
      generated_at: new Date().toISOString(),
      disposition: trace.disposition,
      chain: trace.path.map((hop) => ({ node: hop.node_id, kind: hop.kind, owner: hop.owner, standard: hop.standard })),
      latest_test: trace.latest_test,
      release: trace.release,
    };
  }

  // —— 处置状态 ——
  /** 计算节点当前处置：quarantined / released / consumed / released_consumed / in_control。 */
  #dispositionOf(nodeId, facts = this.#facts()) {
    const quarantined = facts.some((f) => f.type === "risk_notification" && f.target_id === nodeId && f.action === "quarantine");
    if (quarantined) return "quarantined";
    const released = facts.some((f) => f.type === "regulatory_release" && f.target_id === nodeId);
    // 罐的消费/放行也可能挂在其所属批次上
    const lot = facts.find((f) => f.type === "can_pack" && f.can_code === nodeId)?.lot_id;
    const consumed = facts.some((f) => f.type === "consumer_purchase" && f.can_code === nodeId);
    const releasedLot = lot && facts.some((f) => f.type === "regulatory_release" && f.target_id === lot);
    if (consumed && (released || releasedLot)) return "released_consumed";
    if (consumed) return "consumed";
    if (released || releasedLot) return "released";
    return "in_control";
  }

  #resolveNode = (nodeId) => {
    const facts = this.#facts();
    const releaseFacts = facts.filter((f) => f.type === "regulatory_release" && (f.target_id === nodeId || f.target_id === this.#lotOfCan(nodeId, facts)));
    const consumed = facts.some((f) => f.type === "consumer_purchase" && f.can_code === nodeId);
    const released = releaseFacts.length > 0;
    const action = consumed || released ? "notify" : "quarantine";
    return {
      action,
      statuses: {
        released, consumed,
        release_refs: releaseFacts.map((r) => r.certificate_no),
      },
    };
  };

  #lotOfCan(nodeId, facts) {
    return facts.find((f) => f.type === "can_pack" && f.can_code === nodeId)?.lot_id ?? null;
  }

  // —— 影响传播 ——
  /**
   * 隔离关键节点并沿谱系传播。
   * 返回 run（含确定性有序的处置计划与实际落账动作）。
   */
  isolate(rootId, options = {}) {
    if (!this.#nodeExists(rootId)) throw new Error(`隔离对象不存在：${rootId}`);
    const asOf = this.ledger.size;
    const runId = options.run_id || `run-${randomUUID()}`;
    const graph = buildGraph(this.ledger.facts());
    const plan = planPropagation(graph, this.#resolveNode, rootId);

    this.ledger.appendRunEvent({
      kind_run: "started", run_id: runId, root_id: rootId,
      reason: options.reason || "关键节点隔离", source: options.source || "manual",
      as_of_seq: asOf, plan, started_at: new Date().toISOString(),
    });

    const actions = [];
    for (const [index, step] of plan.entries()) {
      const action = this.#applyStep(runId, step, options.actor);
      actions.push(action);
      // 每处理一个节点写检查点：服务恢复后从最后检查点继续。
      this.ledger.appendRunEvent({
        kind_run: "checkpoint", run_id: runId, root_id: rootId,
        last_node: step.node_id, applied: actions.length, as_of_seq: asOf,
        at: new Date().toISOString(),
      });
      // 演练/故障注入：处理完第 N 个节点后模拟崩溃（不写 finished）。
      if (options.crashAfter && actions.length >= options.crashAfter) {
        return { run_id: runId, root_id: rootId, as_of_seq: asOf, plan, actions, interrupted: true };
      }
    }

    const summary = summarize(plan);
    this.ledger.appendRunEvent({
      kind_run: "finished", run_id: runId, root_id: rootId, as_of_seq: asOf,
      summary, actions, finished_at: new Date().toISOString(),
    });
    return { run_id: runId, root_id: rootId, as_of_seq: asOf, plan, actions, summary };
  }

  #applyStep(runId, step, actor) {
    if (step.action === "quarantine") {
      // 冻结记录以 risk_notification(action=quarantine) 落账，既标记冻结又满足“只增不删”。
      // 幂等：同一节点已被任意运行冻结则不再重复落账。
      const already = this.#factsByType("risk_notification").some(
        (n) => n.target_id === step.node_id && n.action === "quarantine"
      );
      if (already) return { node_id: step.node_id, action: "quarantine", skipped: "already_quarantined" };
      const note = createFact("risk_notification", {
        notification_id: `${runId}:freeze:${step.node_id}`,
        target_id: step.node_id, run_id: runId, action: "quarantine",
        reason: explainStep(step), issued_by: actor || "quality-system", channel: "internal_freeze",
      });
      const saved = this.#append(note, { actor });
      return { node_id: step.node_id, action: "quarantine", seq: saved.seq };
    }
    const already = this.#factsByType("risk_notification").some(
      (n) => n.target_id === step.node_id && n.run_id === runId && n.action === "notify"
    );
    if (already) return { node_id: step.node_id, action: "notify", skipped: "already_notified" };
    const note = createFact("risk_notification", {
      notification_id: `${runId}:notice:${step.node_id}`,
      target_id: step.node_id, run_id: runId, action: "notify",
      reason: explainStep(step), issued_by: actor || "quality-system",
      channel: step.statuses.consumed ? "consumer_advisory" : "regulatory_advisory",
    });
    const saved = this.#append(note, { actor });
    return { node_id: step.node_id, action: "notify", seq: saved.seq, statuses: step.statuses };
  }

  /** 崩溃恢复：若运行中断（无 finished 事件），从最后检查点继续落账未完成的动作。 */
  resumeRun(runId) {
    const state = this.ledger.runState(runId);
    if (!state) throw new Error(`传播运行不存在：${runId}`);
    if (state.kind_run === "finished") return { run_id: runId, resumed: false, result: "already_finished", actions: state.actions };

    const started = this.ledger.entries().find((e) => e.kind === "propagation" && e.run_id === runId && e.kind_run === "started");
    const plan = started.plan;
    const checkpoints = this.ledger.entries().filter((e) => e.kind === "propagation" && e.run_id === runId && e.kind_run === "checkpoint");
    const doneCount = checkpoints.length;

    const actions = [];
    for (const step of plan.slice(doneCount)) {
      actions.push(this.#applyStep(runId, step, "quality-system-resume"));
      this.ledger.appendRunEvent({
        kind_run: "checkpoint", run_id: runId, root_id: started.root_id,
        last_node: step.node_id, applied: doneCount + actions.length, as_of_seq: started.as_of_seq,
        at: new Date().toISOString(), resumed: true,
      });
    }
    const summary = summarize(plan);
    this.ledger.appendRunEvent({
      kind_run: "finished", run_id: runId, root_id: started.root_id, as_of_seq: started.as_of_seq,
      summary, resumed: true, finished_at: new Date().toISOString(),
    });
    return { run_id: runId, resumed: true, resumed_actions: actions, summary };
  }

  /**
   * 脱离写操作的可重复重放：给定账本文件（或当前账本）与触发点，
   * 返回与当初一致的处置计划，不产生任何新写入。用于审计复算。
   */
  replayPropagation(rootId, { asOf = Infinity } = {}) {
    const facts = this.ledger.facts({ asOf });
    const graph = buildGraph(facts);
    const resolve = (nodeId) => {
      const releaseFacts = facts.filter((f) => f.type === "regulatory_release" && f.target_id === nodeId);
      const consumed = facts.some((f) => f.type === "consumer_purchase" && f.can_code === nodeId);
      const action = consumed || releaseFacts.length ? "notify" : "quarantine";
      return { action, statuses: { released: releaseFacts.length > 0, consumed, release_refs: releaseFacts.map((r) => r.certificate_no) } };
    };
    const plan = planPropagation(graph, resolve, rootId);
    return { root_id: rootId, as_of_seq: asOf === Infinity ? this.ledger.size : asOf, plan, summary: summarize(plan) };
  }

  // —— 罐码反查 ——
  /**
   * 从任意罐码反查：经过的节点、责任主体、采用的标准版本、当前处置，
   * 以及为什么没有波及相邻批次。
   */
  trace(canCode, { neighbors = [] } = {}) {
    const facts = this.#facts();
    const graph = buildGraph(facts);
    if (!graph.nodes.has(canCode)) throw new Error(`罐码/节点不存在：${canCode}`);

    const ancestors = graph.ancestorsOf(canCode);
    const chainIds = [canCode, ...ancestors.keys()];

    const ownerOf = (nodeId) => {
      const raw = facts.find((f) => f.type === "raw_milk_batch" && f.batch_id === nodeId);
      if (raw) {
        const qual = facts.find((q) => q.type === "farm_qualification" && q.farm_id === raw.farm_id);
        return { type: "farm", farm_id: raw.farm_id, member_id: qual?.member_id ?? null, coop_id: qual?.coop_id ?? null };
      }
      const ship = facts.find((f) => f.type === "shipment" && f.shipment_id === nodeId);
      if (ship) return { type: "logistics", vehicle_id: ship.vehicle_id, driver_id: ship.driver_id };
      const transform = facts.find((f) => f.type === "transform" && f.output_id === nodeId);
      if (transform) return { type: "plant", plant_id: transform.plant_id, processed_by: transform.processed_by };
      const pack = facts.find((f) => f.type === "can_pack" && f.can_code === nodeId);
      if (pack) return { type: "plant", lot_id: pack.lot_id };
      return null;
    };

    const standardOf = (nodeId) => {
      const report = effectiveReport(facts.filter((f) => f.type === "test_report" && f.target_id === nodeId));
      return report ? { test_method: report.test_method, method_version: report.method_version, parameter: report.parameter, result: report.result, report_id: report.report_id, issued_at: report.issued_at } : null;
    };

    const path = chainIds.map((nodeId) => {
      const node = graph.nodes.get(nodeId);
      const ancestor = ancestors.get(nodeId);
      const transform = facts.find((f) => f.type === "transform" && f.output_id === nodeId);
      return {
        node_id: nodeId,
        kind: node?.kind ?? null,
        owner: ownerOf(nodeId),
        standard: standardOf(nodeId),
        input_share: ancestor ? ancestor.share : 1,
        ratio_from_parent: ancestor?.path[ancestor.path.length - 1]?.ratio ?? 1,
        input_snapshot: transform?.input_snapshot ?? null,
        disposition: this.#dispositionOf(nodeId, facts),
      };
    });

    const releaseFacts = facts.filter((f) => f.type === "regulatory_release" && (f.target_id === canCode || f.target_id === this.#lotOfCan(canCode, facts)));
    const qrVersions = facts.filter((f) => f.type === "qrcode_snapshot" && f.can_code === canCode).map((q) => q.version);

    // 邻居是否真的被波及：以账本中实际发生过的传播运行为准——
    // 与本罐同属某运行计划的邻居才受波及；否则仅按谱系解释为何分流。
    const runsCovering = this.ledger.entries()
      .filter((e) => e.kind === "propagation" && e.kind_run === "started")
      .filter((e) => e.plan.some((step) => step.node_id === canCode))
      .map((e) => ({ run_id: e.run_id, root_id: e.root_id, nodes: new Set(e.plan.map((s) => s.node_id)) }));

    const neighborReport = neighbors.map((neighborId) => {
      const sameRun = runsCovering.find((r) => r.nodes.has(neighborId));
      if (sameRun) {
        return {
          node_id: neighborId, affected: true,
          via_run: { run_id: sameRun.run_id, root_id: sameRun.root_id },
          explanation: graph.explainAgainstRoot(sameRun.root_id, canCode, neighborId),
        };
      }
      // 未被波及：以覆盖本罐的最近一次隔离根来解释分流位置。
      const rootRun = runsCovering[runsCovering.length - 1] ?? null;
      const explanation = rootRun
        ? graph.explainAgainstRoot(rootRun.root_id, canCode, neighborId)
        : graph.divergence(canCode, neighborId);
      return { node_id: neighborId, affected: false, via_run: null, explanation };
    });

    return {
      can_code: canCode,
      disposition: this.#dispositionOf(canCode, facts),
      path,
      latest_test: standardOf(canCode) ?? this.#nearestAncestorStandard(ancestors, standardOf),
      release: releaseFacts[0] ? { certificate_no: releaseFacts[0].certificate_no, authority: releaseFacts[0].authority, released_at: releaseFacts[0].released_at } : null,
      qrcode_versions: qrVersions,
      neighbors: neighborReport,
    };
  }

  #nearestAncestorStandard(ancestors, standardOf) {
    let best = null;
    for (const [id] of ancestors) {
      const std = standardOf(id);
      if (std) { best = std; break; }
    }
    return best;
  }

  /** 便捷：给定一批相邻罐码，返回为何未波及的解释（供 CLI why-not）。 */
  whyNot(canCode, neighborIds = []) {
    return this.trace(canCode, { neighbors: neighborIds }).neighbors;
  }

  /** 账本完整性校验。 */
  verify() { return this.ledger.verify(); }
}
