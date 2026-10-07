/** 测试夹具：构造两条牧场来源、合批/拆批、放行/消费的全链。 */
export function buildChain(service, opts = {}) {
  const rec = (type, payload, actor = "tester") => service.record(type, payload, { actor });

  rec("coop_membership", { coop_id: "coop-1", member_id: "farmer-a" });
  rec("coop_membership", { coop_id: "coop-1", member_id: "farmer-b" });
  rec("farm_qualification", { farm_id: "farm-a", qualification_no: "Q-A", valid_from: "2026-01-01", status: "active", coop_id: "coop-1", member_id: "farmer-a" });
  rec("farm_qualification", { farm_id: "farm-b", qualification_no: "Q-B", valid_from: "2026-01-01", status: "active", coop_id: "coop-1", member_id: "farmer-b" });

  rec("raw_milk_batch", { batch_id: "raw-a", farm_id: "farm-a", collected_at: "2026-09-01T06:00Z", volume: 1000 });
  rec("raw_milk_batch", { batch_id: "raw-b", farm_id: "farm-b", collected_at: "2026-09-01T06:00Z", volume: 1000 });

  const pass = (target, by = "lab-zhang", id) => rec("test_report", {
    report_id: id ?? `rep-${target}`, target_id: target, test_method: "GB-X", method_version: "v2023",
    parameter: "p", result: "pass", value: 3.0, tested_by: by, issued_at: "2026-09-01T09:00Z",
  });
  pass("raw-a");
  pass("raw-b", "lab-li");

  rec("shipment", { shipment_id: "ship-a", seal_no: "SEAL-A", batch_ids: ["raw-a"], sealed_at: "2026-09-01T11:00Z", vehicle_id: "truck-1" });
  rec("shipment", { shipment_id: "ship-b", seal_no: "SEAL-B", batch_ids: ["raw-b"], sealed_at: "2026-09-01T11:00Z", vehicle_id: "truck-2" });

  // 合批：a:b = 600:300 = 2:1
  rec("transform", {
    run_id: "mix", output_id: "lot-mix", produced_at: "2026-09-02T08:00Z",
    inputs: [{ id: "ship-a", qty: 600 }, { id: "ship-b", qty: 300 }], plant_id: "plant-1", processed_by: "op-1",
  });
  // 纯 a 的独立产线
  rec("transform", {
    run_id: "line-a", output_id: "lot-a-only", produced_at: "2026-09-02T08:00Z",
    inputs: [{ id: "ship-a", qty: 100 }], plant_id: "plant-1", processed_by: "op-1",
  });

  rec("transform", { run_id: "split-x", output_id: "lot-x", produced_at: "t", inputs: [{ id: "lot-mix", qty: 400 }], plant_id: "plant-1", processed_by: "op-1" });
  rec("transform", { run_id: "split-y", output_id: "lot-y", produced_at: "t", inputs: [{ id: "lot-mix", qty: 400 }], plant_id: "plant-1", processed_by: "op-1" });

  rec("can_pack", { can_code: "CAN-X-1", lot_id: "lot-x", packed_at: "t" });
  rec("can_pack", { can_code: "CAN-Y-1", lot_id: "lot-y", packed_at: "t" });
  rec("can_pack", { can_code: "CAN-A-1", lot_id: "lot-a-only", packed_at: "t" });

  if (opts.releaseX) {
    rec("regulatory_release", { release_id: "rel-x", target_id: "lot-x", authority: "海关", certificate_no: "CERT-X", released_at: "2026-09-03T08:00Z" });
  }
  if (opts.consumeX1) {
    rec("consumer_purchase", { can_code: "CAN-X-1", purchased_at: "2026-09-04T08:00Z", channel: "shop" });
  }
  return { rec };
}
