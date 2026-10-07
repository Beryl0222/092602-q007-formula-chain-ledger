import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../src/service.js";
import { buildChain } from "./fixtures.js";

test("健康检查返回服务状态", () => {
  assert.equal(new Service().health().status, "ok");
});

test("v0.1 基础记录：登记、查询、重复编号拒绝", () => {
  const service = new Service();
  const saved = service.register({ record_id: "can-lot-001", owner_id: "quality-office", state: "in-process", revision: 1 });
  assert.equal(saved.revision, 1);
  assert.equal(service.find("can-lot-001").owner_id, "quality-office");
  assert.throws(() => service.register({ record_id: "can-lot-001", owner_id: "x", state: "s" }), /已存在/);
});

test("牧场资格：无资格/被暂停不能产出原奶，恢复后可以", () => {
  const service = new Service();
  const rec = (t, p) => service.record(t, p, { actor: "a" });
  rec("farm_qualification", { farm_id: "f1", qualification_no: "Q1", valid_from: "t", status: "active" });
  assert.ok(rec("raw_milk_batch", { batch_id: "r1", farm_id: "f1", collected_at: "t", volume: 10 }));
  assert.throws(() => rec("raw_milk_batch", { batch_id: "rX", farm_id: "f2", collected_at: "t", volume: 10 }), /无有效资格/);
  rec("qualification_update", { farm_id: "f1", status: "suspended", changed_at: "t2" });
  assert.throws(() => rec("raw_milk_batch", { batch_id: "r2", farm_id: "f1", collected_at: "t3", volume: 10 }), /无有效资格/);
  rec("qualification_update", { farm_id: "f1", status: "active", changed_at: "t4" });
  assert.ok(rec("raw_milk_batch", { batch_id: "r3", farm_id: "f1", collected_at: "t5", volume: 10 }));
});

test("运输封签：引用必须存在、封签号不可复用", () => {
  const service = new Service();
  buildChain(service);
  assert.throws(() => service.record("shipment", { shipment_id: "s-x", seal_no: "S-X", batch_ids: ["ghost"], sealed_at: "t" }), /不存在的原奶批次/);
  assert.throws(() => service.record("shipment", { shipment_id: "s-y", seal_no: "SEAL-A", batch_ids: ["raw-a"], sealed_at: "t" }), /封签号/);
});

test("合批保存投入比例与当时有效检测结论（含上游封签内原奶报告）", () => {
  const service = new Service();
  buildChain(service);
  const mix = service.ledger.facts().find((f) => f.type === "transform" && f.output_id === "lot-mix");
  assert.deepEqual(mix.input_snapshot.map((i) => i.ratio), [0.666667, 0.333333]);
  const shipA = mix.input_snapshot.find((i) => i.id === "ship-a");
  assert.equal(shipA.conclusions[0].source_id, "raw-a");
  assert.equal(shipA.conclusions[0].result, "pass");
  assert.equal(shipA.conclusions[0].method_version, "v2023");
});

test("检验更正：新报告以 supersedes 声明后，有效结论切换且方法版本更新", () => {
  const service = new Service();
  buildChain(service);
  service.record("test_report", {
    report_id: "rep-raw-a-r2", target_id: "raw-a", test_method: "GB-X", method_version: "v2024",
    parameter: "p", result: "fail", value: 2.1, tested_by: "lab-zhang", issued_at: "2026-09-06T08:00Z", supersedes: "rep-raw-a",
  }, { actor: "lab-zhang" });
  const effective = service.effectiveTest("raw-a");
  assert.equal(effective.result, "fail");
  assert.equal(effective.method_version, "v2024");
  assert.throws(() => service.record("test_report", {
    report_id: "rep-bad", target_id: "raw-a", test_method: "m", method_version: "v", parameter: "p", result: "fail", tested_by: "x", issued_at: "t", supersedes: "nope",
  }), /被更正的报告不存在/);
});

test("职责分离：提交检测的人不得批准自己相关例外", () => {
  const service = new Service();
  buildChain(service);
  service.record("exception_request", { request_id: "exc-1", target_id: "raw-a", report_id: "rep-raw-a", requested_by: "plant", reason: "r" }, { actor: "plant" });
  assert.throws(() => service.record("exception_decision", { request_id: "exc-1", decision: "approved", decided_by: "lab-zhang", decided_at: "t", basis: "b" }), /职责分离/);
  assert.doesNotThrow(() => service.record("exception_decision", { request_id: "exc-1", decision: "approved", decided_by: "qa-boss", decided_at: "t", basis: "独立复核" }));
  assert.throws(() => service.record("exception_decision", { request_id: "exc-1", decision: "rejected", decided_by: "qa-boss2", decided_at: "t2" }), /已有决定/);
});

test("设备上报：业务键去重；同键不同测值隔离整条依赖链", () => {
  const service = new Service();
  buildChain(service);
  const reading = { device_id: "dev-1", business_key: "BK/1", metric: "temp", value: 4, unit: "C", target_id: "raw-a", measured_at: "t" };
  const first = service.record("device_reading", reading, { actor: "device" });
  assert.equal(first.metric, "temp");
  assert.equal(service.ledger.hasKey("device:dev-1/BK/1"), true);
  const again = service.record("device_reading", reading, { actor: "device" });
  assert.equal(again.deduplicated, true);

  const conflict = service.record("device_reading", { ...reading, value: 12, measured_at: "t" }, { actor: "device" });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.propagation.root_id, "raw-a");
  // 下游成品罐被冻结
  assert.equal(service.trace("CAN-A-1").disposition, "quarantined");
});

test("隔离传播：在控节点冻结；已放行/已消费只发风险通知且记录不删除", () => {
  const service = new Service();
  buildChain(service, { releaseX: true, consumeX1: true });
  const run = service.isolate("raw-a", { reason: "污染", actor: "qa" });
  const byNode = Object.fromEntries(run.plan.map((p) => [p.node_id, p.action]));
  assert.equal(byNode["raw-a"], "quarantine");
  assert.equal(byNode["lot-y"], "quarantine");
  assert.equal(byNode["CAN-Y-1"], "quarantine");
  assert.equal(byNode["lot-x"], "notify");       // 已监管放行
  assert.equal(byNode["CAN-X-1"], "notify");    // 已消费
  // 记录仍可反查（未删除）
  assert.ok(service.trace("CAN-X-1"));
  const notices = service.ledger.facts().filter((f) => f.type === "risk_notification");
  assert.ok(notices.some((n) => n.target_id === "CAN-X-1" && n.action === "notify"));
});

test("冻结后不能继续投料、不能监管放行", () => {
  const service = new Service();
  buildChain(service);
  service.isolate("raw-b", { reason: "污染" });
  assert.throws(() => service.record("transform", {
    run_id: "new-run", output_id: "lot-new", produced_at: "t", inputs: [{ id: "ship-b", qty: 1 }], plant_id: "p", processed_by: "o",
  }), /已被冻结/);
  assert.throws(() => service.record("regulatory_release", { release_id: "rel-bad", target_id: "raw-b", authority: "海关", certificate_no: "C", released_at: "t" }), /已被冻结/);
});

test("演算可重复：replay 与实际运行计划逐节点一致，且不产生写入", () => {
  const service = new Service();
  buildChain(service, { releaseX: true, consumeX1: true });
  const run = service.isolate("raw-a", { reason: "污染" });
  const sizeAfterRun = service.ledger.size;
  const replay = service.replayPropagation("raw-a");
  assert.equal(service.ledger.size, sizeAfterRun); // 只读
  assert.deepEqual(
    replay.plan.map((p) => [p.node_id, p.action]),
    run.plan.map((p) => [p.node_id, p.action]),
  );
  assert.equal(replay.summary.total, run.summary.total);
});

test("崩溃恢复：中断的传播从检查点继续，补做剩余动作且幂等", () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-"));
  const path = join(dir, "ledger.jsonl");
  try {
    const first = new Service({ path });
    buildChain(first, { releaseX: true, consumeX1: true });
    const crashed = first.isolate("raw-a", { reason: "污染", run_id: "run-fixed", crashAfter: 3 });
    assert.equal(crashed.interrupted, true);
    assert.equal(crashed.actions.length, 3);

    // 服务重启：新实例从同一账本恢复
    const restarted = new Service({ path });
    const resumed = restarted.resumeRun("run-fixed");
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.resumed_actions.length, crashed.plan.length - 3);
    // 再次恢复不重复落账
    const again = restarted.resumeRun("run-fixed");
    assert.equal(again.resumed, false);
    assert.equal(restarted.verify().ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("罐码反查：节点链、责任主体、标准版本、当前处置齐全", () => {
  const service = new Service();
  buildChain(service);
  const trace = service.trace("CAN-Y-1");
  const ids = trace.path.map((h) => h.node_id);
  assert.ok(ids.includes("raw-a"));
  assert.ok(ids.includes("raw-b"));
  assert.ok(ids.includes("lot-mix"));
  const rawHop = trace.path.find((h) => h.node_id === "raw-a");
  assert.equal(rawHop.owner.farm_id, "farm-a");
  assert.equal(rawHop.standard.method_version, "v2023");
  // 原料占比归因：raw-a 0.666667 经 mix（全量投入 split）保持
  const mixHop = trace.path.find((h) => h.node_id === "lot-mix");
  assert.ok(mixHop.input_snapshot.length === 2);
});

test("为何未波及相邻批次：合批下游受波及，独立产线给出分流解释", () => {
  const service = new Service();
  buildChain(service);
  service.isolate("raw-b", { reason: "污染" });
  const trace = service.trace("CAN-Y-1", { neighbors: ["CAN-A-1"] });
  const neighbor = trace.neighbors[0];
  assert.equal(neighbor.affected, false);
  assert.equal(neighbor.explanation.reason, "contamination_after_split");
  assert.ok(neighbor.explanation.detail.includes("分流"));

  // 合批同源的另一罐必然受波及
  service.isolate("raw-a", { reason: "污染2" });
  const trace2 = service.trace("CAN-Y-1", { neighbors: ["CAN-X-1"] });
  assert.equal(trace2.neighbors[0].affected, true);
  assert.equal(trace2.neighbors[0].explanation.reason, "downstream_after_merge");
});

test("合批同源：纯 a 产线隔离 raw-a 时，含 a 的合批下游同样受波及", () => {
  const service = new Service();
  buildChain(service);
  service.isolate("raw-a", { reason: "污染" });
  const trace = service.trace("CAN-A-1", { neighbors: ["CAN-Y-1"] });
  // CAN-A-1 纯 a、CAN-Y-1 含 a+b：Y 受 a 影响
  assert.equal(trace.neighbors[0].affected, true);
});

test("完全无共同来源：两条独立牧场产线互不为邻", () => {
  const service = new Service();
  buildChain(service);
  // 新增与既有链条完全无关的牧场/原奶/产线
  service.record("farm_qualification", { farm_id: "farm-z", qualification_no: "Q-Z", valid_from: "t", status: "active" }, { actor: "a" });
  service.record("raw_milk_batch", { batch_id: "raw-z", farm_id: "farm-z", collected_at: "t", volume: 10 }, { actor: "a" });
  service.record("test_report", { report_id: "rep-raw-z", target_id: "raw-z", test_method: "m", method_version: "v1", parameter: "p", result: "pass", tested_by: "lab-z", issued_at: "t" }, { actor: "a" });
  service.record("transform", { run_id: "line-z", output_id: "lot-z", produced_at: "t", inputs: [{ id: "raw-z", qty: 10 }], plant_id: "p", processed_by: "o" }, { actor: "a" });
  service.record("can_pack", { can_code: "CAN-Z-1", lot_id: "lot-z", packed_at: "t" }, { actor: "a" });
  service.isolate("raw-a", { reason: "污染" });
  const trace = service.trace("CAN-A-1", { neighbors: ["CAN-Z-1"] });
  assert.equal(trace.neighbors[0].affected, false);
  assert.equal(trace.neighbors[0].explanation.reason, "no_shared_origin");
});

test("二维码快照：版本必须连续，内容为全链快照；处置更新后新版本反映", () => {
  const service = new Service();
  buildChain(service);
  const v1 = service.record("qrcode_snapshot", { can_code: "CAN-Y-1", version: 1, generated_at: "t1" }, { actor: "page" });
  assert.equal(v1.content_hash.length, 64);
  assert.equal(v1.content.disposition, "in_control");
  assert.throws(() => service.record("qrcode_snapshot", { can_code: "CAN-Y-1", version: 3, generated_at: "t2" }), /版本必须连续/);
  service.isolate("raw-a", { reason: "污染" });
  const v2 = service.record("qrcode_snapshot", { can_code: "CAN-Y-1", version: 2, generated_at: "t3" }, { actor: "page" });
  assert.equal(v2.content.disposition, "quarantined");
  // v1 原样保留（静态历史快照不被改写）
  const old = service.ledger.facts().find((f) => f.type === "qrcode_snapshot" && f.can_code === "CAN-Y-1" && f.version === 1);
  assert.equal(old.content.disposition, "in_control");
});

test("风险通知不能删除任何历史；账本哈希链始终完整", () => {
  const service = new Service();
  buildChain(service, { releaseX: true, consumeX1: true });
  const before = service.ledger.facts().length;
  service.isolate("raw-a", { reason: "污染" });
  const afterFacts = service.ledger.facts();
  assert.ok(afterFacts.length > before);
  // 所有历史事实仍在
  assert.ok(afterFacts.some((f) => f.type === "consumer_purchase"));
  assert.ok(afterFacts.some((f) => f.type === "regulatory_release"));
  assert.equal(service.verify().ok, true);
});
