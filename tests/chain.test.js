import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Service } from "../src/service.js";
import { Repository } from "../src/repository.js";
import { buildChain, releaseAndConsume, triggerDeviceConflict, T } from "./scenario.js";

function newService(options = {}) {
  return new Service(new Repository(), options);
}

/* ------------------------------- 全链与传播 ------------------------------- */

test("设备冲突自动隔离整条依赖链，已放行/已消费只发风险通知", () => {
  const service = newService();
  buildChain(service);
  releaseAndConsume(service);
  const result = triggerDeviceConflict(service);

  assert.equal(result.conflict, true);
  assert.deepEqual(result.isolated, ["raw-r1a"]);
  // 仍在控制范围的下游全部冻结。
  assert.deepEqual(result.frozen, [
    "CAN-0002", "canlot-fin2", "lot-fin2", "lot-fin1", "pow-base1", "pow-mix",
  ].sort());
  // 已依法放行的罐批与已消费的罐码：不冻结、不删除，只收风险通知。
  assert.deepEqual(result.noticed, ["CAN-0001", "canlot-fin1"].sort());
  // 二号牧场原奶及其独立成品不在依赖链上。
  for (const untouched of ["raw-r2a", "pow-base2", "canlot-fin3", "CAN-0003"]) {
    assert.ok(!result.affected.includes(untouched), `${untouched} 不应受影响`);
  }

  const notice = service.repository.get("risk_notice", `n:${result.run_id}:CAN-0001`);
  assert.match(notice.message, /ALREADY_CONSUMED|风险通知/);
  assert.ok(service.repository.get("disposition", "can_code:CAN-0001:consumed"), "已消费记录必须保留");
});

test("合批冻结投入比例，源批次对成品罐的贡献比例可解释", () => {
  const service = newService();
  buildChain(service);
  const trace = service.trace("CAN-0001");
  const fromR1 = trace.lineage.find((l) => l.source === "raw-r1a");
  assert.ok(fromR1, "罐码必须能反查到一号牧场原奶来源");
  assert.equal(fromR1.contribution_ratio, 0.3, "1.0 × 540/900 × 450/900 = 0.3");
  const mergeEdge = fromR1.path.find((e) => e.event_kind === "merge");
  assert.equal(mergeEdge.ratio, 0.6);
  // 合批当时快照：base1 的水分不合格结论虽经例外放行，仍被如实冻结。
  const base1Snap = mergeEdge.conclusion_snapshot;
  assert.equal(base1Snap.lot_id, "pow-base1");
  const moisture = base1Snap.conclusions.find((c) => c.metric === "moisture");
  assert.equal(moisture.result, "fail");
  assert.equal(moisture.standard_version, "v1");
});

test("传播结果解释相邻批次为何未波及", () => {
  const service = newService();
  buildChain(service);
  triggerDeviceConflict(service);
  const trace = service.trace("CAN-0001");
  const sibling = trace.neighbors_excluded.find((n) => n.node_id === "pow-base2");
  assert.ok(sibling, "合批并列投入应列为排除邻居");
  assert.equal(sibling.reason_code, "SIBLING_INPUT_NO_LINEAGE");
  assert.ok(sibling.reason.length > 0);
});

/* -------------------------------- 设备去重 -------------------------------- */

test("设备上报按业务键去重，编号相同测值相同不重复入账", () => {
  const service = newService();
  buildChain(service);
  const before = service.repository.list("test").length;
  const dup = service.reportTest({
    test_id: "test-r1a-dup", business_key: "dev-d1#1001", source: "device", device_id: "dev-d1",
    lot_id: "raw-r1a", standard_id: "STD-MEL", standard_version: "v1",
    metric: "melamine", value: 0.2, unit: "mg/kg", result: "pass",
    submitted_by: "labtech-li", tested_at: T.tested,
  });
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.record.test_id, "test-r1a");
  assert.equal(service.repository.list("test").length, before);
});

test("编号相同但测值不同即冲突，不覆盖原记录并产生传播运行", () => {
  const service = newService();
  buildChain(service);
  const result = triggerDeviceConflict(service);
  assert.equal(result.conflict, true);
  assert.ok(result.run_id.startsWith("run:conflict:"));
  const original = service.repository.get("test", "test-r1a");
  assert.equal(original.value, 0.2, "首次上报必须原样保留");
});

/* -------------------------------- 职责分离 -------------------------------- */

test("提交检测的人不得批准自己的例外，申请人也不得自批", () => {
  const service = newService();
  buildChain(service);
  // buildChain 中 ex-1 已由他人批准；新增一个针对同检测的申请走拒绝路径。
  service.requestException({ exception_id: "ex-2", lot_id: "pow-base1", test_id: "test-base1-moist", requested_by: "foreman-zhao", reason: "再次申请", at: T.failTest });
  assert.throws(
    () => service.decideException({ exception_id: "ex-2", decision: "approved", approved_by: "labtech-li", at: T.failTest }),
    /职责分离/,
  );
  assert.throws(
    () => service.decideException({ exception_id: "ex-2", decision: "approved", approved_by: "foreman-zhao", at: T.failTest }),
    /职责分离/,
  );
  service.decideException({ exception_id: "ex-2", decision: "rejected", approved_by: "qa-head-chen", at: T.failTest });
  assert.throws(
    () => service.decideException({ exception_id: "ex-2", decision: "approved", approved_by: "qa-head-chen", at: T.failTest }),
    /已有处置决定/,
  );
});

/* ------------------------------- 冻结后拦截 ------------------------------- */

test("隔离后冻结批次不得再投料、不得放行或销售", () => {
  const service = newService();
  buildChain(service);
  triggerDeviceConflict(service);
  assert.throws(
    () => service.registerFeeding({ event_id: "proc-bad", kind: "process", plant_id: "plant-p1", run_id: "RUN-X", inputs: [{ lot_id: "pow-mix", qty: 10 }], output_lot_id: "pow-bad", output_qty: 9, at: T.fault }),
    /冻结/,
  );
  assert.throws(
    () => service.registerRelease({ release_id: "rel-bad", lot_id: "lot-fin2", regulator_id: "regulator-g1", doc_no: "D", released_at: T.fault }),
    /冻结/,
  );
});

test("封签破损或缺封签的原奶不得投料", () => {
  const service = newService();
  buildChain(service);
  service.registerRawMilk({ raw_id: "raw-r1b", ranch_id: "ranch-r1", qty: 100, produced_at: T.raw });
  assert.throws(
    () => service.registerFeeding({ event_id: "proc-noseal", kind: "process", plant_id: "plant-p1", run_id: "RNS", inputs: [{ lot_id: "raw-r1b", qty: 100 }], output_lot_id: "pow-noseal", output_qty: 90, at: T.proc1 }),
    /封签/,
  );
  service.registerTransport({ seal_id: "seal-broken", raw_id: "raw-r1b", carrier_id: "carrier-t1", vehicle_no: "V", seal_no: "S9", sealed_at: T.raw, arrived_at: T.proc1, arrival_seal_intact: false });
  assert.throws(
    () => service.registerFeeding({ event_id: "proc-broken", kind: "process", plant_id: "plant-p1", run_id: "RB", inputs: [{ lot_id: "raw-r1b", qty: 100 }], output_lot_id: "pow-broken", output_qty: 90, at: T.proc1 }),
    /封签破损/,
  );
});

/* ------------------------------ 二维码与出口证明 ----------------------------- */

test("公开追溯页只发新版不删旧版，出口证明换发留痕", () => {
  const service = newService();
  buildChain(service);
  releaseAndConsume(service);
  const result = triggerDeviceConflict(service);
  const v1 = service.repository.get("qr_snapshot", "CAN-0001:v1");
  const v2 = service.repository.get("qr_snapshot", "CAN-0001:v2");
  assert.ok(v1 && v2, "新旧两版快照都必须存在");
  assert.notEqual(v1.content_hash, v2.content_hash);
  const reissue = service.repository.get("qr_reissue", `qrre:${result.run_id}:CAN-0001`);
  assert.equal(reissue.old_snapshot_id, "CAN-0001:v1");
  // 未受影响罐码不换版。
  assert.equal(service.repository.get("qr_snapshot", "CAN-0003:v2"), null);
  // 计划点名必须换发的出口证明；执行换发后旧证明仍可查。
  assert.deepEqual(result.cert_reissue, ["CAN-0001"]);
  service.reissueExportCert({ old_cert_id: "cert-1", cert_id: "cert-2", cert_no: "CERT-2026-0002", issued_by: "regulator-g1", run_id: result.run_id, at: T.fault });
  assert.ok(service.repository.get("export_cert", "cert-1"), "旧证明保留");
  assert.equal(service.repository.get("export_cert", "cert-2").supersedes, "cert-1");
});

/* ------------------------------ 可重复与可恢复 ------------------------------ */

test("召回演算可重复：同状态重复预览校验和一致", () => {
  const service = newService();
  buildChain(service);
  const a = service.previewRecall({ source: "raw-r1a", trigger_event_id: "evt-x", now: T.fault });
  const b = service.previewRecall({ source: "raw-r1a", trigger_event_id: "evt-x", now: T.fault });
  assert.equal(a.checksum, b.checksum);
  assert.equal(a.algorithm, "bfs-lineage-v1");
});

test("传播可中断、服务恢复后继续未完成的影响传播且结果不重复", () => {
  const logFile = join(tmpdir(), `chain-${process.pid}-${Date.now()}.jsonl`);
  try {
    let steps = 0;
    const crashing = new Service(Repository.fromLog(logFile), {
      clock: () => T.fault,
      onStep: () => { if (++steps === 2) throw new Error("模拟服务崩溃"); },
    });
    buildChain(crashing);
    releaseAndConsume(crashing);
    assert.throws(() => triggerDeviceConflict(crashing), /模拟服务崩溃/);
    const partialRun = crashing.repository.list("propagation_run")[0];
    assert.ok(partialRun, "崩溃前运行记录与冻结计划必须已落盘");
    assert.ok(partialRun.frozen_plan);

    // 新进程：从审计日志重放全部状态后恢复传播。
    const recovered = new Service(Repository.fromLog(logFile), { clock: () => T.fault });
    const resumed = recovered.resumePropagations();
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].resumed, true);
    const completion = recovered.getRun(resumed[0].run_id).completion;
    assert.equal(completion.status, "done");
    assert.equal(completion.checksum, partialRun.plan_checksum, "恢复结果必须与冻结计划一致");
    // 再次恢复为空：不重复处置。
    assert.deepEqual(recovered.resumePropagations(), []);
    // 每个节点只有一条隔离/通知指令。
    for (const nodeId of completion.frozen.concat(completion.isolated)) {
      const orders = recovered.repository.find("quarantine_order", (q) => q.node_id === nodeId);
      assert.equal(orders.length, 1, `${nodeId} 不应有重复指令`);
    }
  } finally {
    rmSync(logFile, { force: true });
  }
});

/* -------------------------------- 罐码反查 -------------------------------- */

test("从任意罐码反查节点、责任主体、标准版本与当前处置", () => {
  const service = newService();
  buildChain(service);
  releaseAndConsume(service);
  triggerDeviceConflict(service);
  const trace = service.trace("CAN-0001");
  const canNode = trace.nodes.find((n) => n.node_id === "CAN-0001");
  assert.equal(canNode.current_handling, "consumed");
  assert.equal(canNode.current_handling_reason, "ALREADY_CONSUMED");
  const rawNode = trace.nodes.find((n) => n.node_id === "raw-r1a");
  assert.equal(rawNode.current_handling, "isolated");

  const partyIds = trace.responsible_parties.map((p) => p.party_id);
  for (const expected of ["coop-c1", "farmer-f1", "ranch-r1", "carrier-t1", "plant-p1", "labtech-li", "regulator-g1"]) {
    assert.ok(partyIds.includes(expected), `责任主体缺少 ${expected}`);
  }
  assert.deepEqual(trace.standards_used.map((s) => `${s.standard_id}@${s.version}`), ["STD-MEL@v1"]);
  // 责任角色可解释。
  const farmer = trace.responsible_parties.find((p) => p.party_id === "farmer-f1");
  assert.ok(farmer.roles.some((r) => r.role.includes("合作社成员")));
});

/* -------------------------------- 检测更正 -------------------------------- */

test("检测更正保留旧记录并触发传播，牧场资格暂停可隔离关键节点", () => {
  const service = newService();
  buildChain(service);
  const corrected = service.reportTest({
    test_id: "test-r2a-fix", business_key: "dev-d2#2001", source: "lab",
    lot_id: "raw-r2a", correction_of: "test-r2a",
    standard_id: "STD-MEL", standard_version: "v1", metric: "melamine",
    value: 2.1, unit: "mg/kg", result: "fail", submitted_by: "labtech-wang", tested_at: T.fault,
  });
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.conflict, undefined, "显式更正即使同业务键异值也不是设备冲突");
  assert.ok(service.repository.get("test", "test-r2a"), "旧检测保留");
  assert.ok(corrected.run_id.startsWith("run:test-r2a-fix"));
  assert.ok(service.previewRecall({ source: "raw-r2a" }).result.affected.includes("CAN-0003"));
});

test("牧场资格无有效版本时原奶不得入账", () => {
  const service = newService();
  service.registerParty({ party_id: "ranch-r9", kind: "ranch", name: "新牧场", registered_at: T.qual });
  assert.throws(
    () => service.registerRawMilk({ raw_id: "raw-r9", ranch_id: "ranch-r9", qty: 10, produced_at: T.raw }),
    /无有效合格资格/,
  );
});

test("人工隔离关键节点可解除且只能解除一次，原指令保留", () => {
  const service = newService();
  buildChain(service);
  const result = service.quarantineNode({ node_id: "pow-mix", reason_code: "MANUAL_HOLD", issued_at: T.fault });
  assert.deepEqual(result.isolated, ["pow-mix"]);
  const orderId = `q:${result.run_id}:pow-mix`;
  const lift = service.liftQuarantine({ order_id: orderId, lifted_by: "qa-head-chen", reason: "复核合格", at: T.fault });
  assert.equal(lift.order_id, orderId);
  assert.ok(service.repository.get("quarantine_order", orderId), "解除后原隔离指令必须保留");
  assert.throws(
    () => service.liftQuarantine({ order_id: orderId, lifted_by: "qa-head-chen", reason: "再次解除", at: T.fault }),
    /不可重复解除/,
  );
});
