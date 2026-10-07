import test from "node:test";
import assert from "node:assert/strict";
import {
  createFact, businessKeyOf, effectiveReport, inputRatios, readingFingerprint, FACT_TYPES,
} from "../src/domain.js";

test("每种事实类型都校验必填字段", () => {
  assert.throws(() => createFact("raw_milk_batch", { batch_id: "x" }), /缺少必要字段/);
  assert.throws(() => createFact("unknown_type", {}), /未知事实类型/);
});

test("原奶体积与二维码版本必须合法", () => {
  assert.throws(() => createFact("raw_milk_batch", { batch_id: "r", farm_id: "f", collected_at: "t", volume: 0 }), /正数/);
  assert.throws(() => createFact("qrcode_snapshot", { can_code: "c", version: 0, generated_at: "t" }), /正整数/);
});

test("检验结论与例外决定只接受受控取值", () => {
  assert.throws(() => createFact("test_report", {
    report_id: "p", target_id: "t", test_method: "m", method_version: "v1", parameter: "x", result: "maybe", tested_by: "a", issued_at: "t",
  }), /检验结论非法/);
  assert.throws(() => createFact("exception_decision", { request_id: "e", decision: "wait", decided_by: "a", decided_at: "t" }), /例外决定非法/);
});

test("合批投入必须带正数量并可换算比例", () => {
  const fact = createFact("transform", {
    run_id: "run-1", output_id: "lot-1", produced_at: "t",
    inputs: [{ id: "a", qty: 30 }, { id: "b", qty: 90 }],
  });
  const ratios = inputRatios(fact.inputs).map((i) => i.ratio);
  assert.deepEqual(ratios, [0.25, 0.75]);
  assert.throws(() => createFact("transform", {
    run_id: "run-2", output_id: "lot-2", produced_at: "t", inputs: [{ id: "a", qty: 0 }],
  }), /qty 必须为正数/);
});

test("effectiveReport：撤回与更正使旧报告失效，取最新有效结论", () => {
  const reports = [
    { seq: 1, report_id: "p1", target_id: "t", result: "pass", issued_at: "2026-09-01T09:00Z" },
    { seq: 2, report_id: "p2", target_id: "t", result: "fail", issued_at: "2026-09-02T09:00Z", supersedes: "p1" },
    { seq: 3, report_id: "p3", target_id: "t", result: "withdrawn", issued_at: "2026-09-03T09:00Z" },
  ];
  const effective = effectiveReport(reports);
  assert.equal(effective.report_id, "p2");
  assert.equal(effective.result, "fail");
});

test("设备读数指纹：同键同值相同、不同值冲突", () => {
  const a = { metric: "temp", value: 4, unit: "C" };
  const b = { metric: "temp", value: 4, unit: "C" };
  const c = { metric: "temp", value: 8, unit: "C" };
  assert.equal(readingFingerprint(a) === readingFingerprint(b), true);
  assert.equal(readingFingerprint(a) === readingFingerprint(c), false);
});

test("业务键稳定且冲突读数使用独立键", () => {
  const normal = createFact("device_reading", {
    device_id: "d", business_key: "bk", metric: "m", value: 1, target_id: "t", measured_at: "t",
  });
  const conflict = createFact("device_reading", {
    ...normal, reading_id: "d:bk#conflict@t", conflict: true,
  });
  assert.equal(businessKeyOf(normal), "device:d/bk");
  assert.match(businessKeyOf(conflict), /^device-conflict:/);
});

test("事实类型清单覆盖全链责任所需节点", () => {
  for (const type of [
    "coop_membership", "farm_qualification", "raw_milk_batch", "shipment", "test_report",
    "exception_request", "exception_decision", "transform", "can_pack", "regulatory_release",
    "consumer_purchase", "qrcode_snapshot", "device_reading", "risk_notification",
  ]) {
    assert.ok(FACT_TYPES[type], `缺少事实类型 ${type}`);
  }
});
