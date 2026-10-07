/** 测试/样例共用的全链场景构建器，时间线固定以便校验和可复算。 */

export const T = {
  qual: "2026-01-01T00:00:00.000Z",
  raw: "2026-02-01T08:00:00.000Z",
  tested: "2026-02-01T09:00:00.000Z",
  proc1: "2026-02-02T08:00:00.000Z",
  failTest: "2026-02-02T10:00:00.000Z",
  merge: "2026-02-03T08:00:00.000Z",
  split: "2026-02-03T12:00:00.000Z",
  pack: "2026-02-04T08:00:00.000Z",
  qr: "2026-02-04T10:00:00.000Z",
  cert: "2026-02-05T09:00:00.000Z",
  release: "2026-02-05T10:00:00.000Z",
  consumed: "2026-02-06T10:00:00.000Z",
  fault: "2026-02-10T09:00:00.000Z",
};

/** 建立主数据、原奶到成品罐的完整链路（不含放行/消费/故障传播）。 */
export function buildChain(service) {
  service.registerParty({ party_id: "coop-c1", kind: "cooperative", name: "绿野奶农合作社", registered_at: T.qual });
  service.registerParty({ party_id: "farmer-f1", kind: "farmer", name: "奶农赵一", registered_at: T.qual });
  service.registerParty({ party_id: "farmer-f2", kind: "farmer", name: "奶农钱二", registered_at: T.qual });
  service.registerParty({ party_id: "ranch-r1", kind: "ranch", name: "一号牧场", registered_at: T.qual });
  service.registerParty({ party_id: "ranch-r2", kind: "ranch", name: "二号牧场", registered_at: T.qual });
  service.registerParty({ party_id: "carrier-t1", kind: "carrier", name: "鲜奶运输公司", registered_at: T.qual });
  service.registerParty({ party_id: "plant-p1", kind: "plant", name: "乳品加工厂", registered_at: T.qual });
  service.registerParty({ party_id: "lab-l1", kind: "lab", name: "中心实验室", registered_at: T.qual });
  service.registerParty({ party_id: "regulator-g1", kind: "regulator", name: "海关与监管机构", registered_at: T.qual });
  service.registerParty({ party_id: "brand-b1", kind: "brand", name: "品牌方", registered_at: T.qual });

  service.registerMembership({ coop_id: "coop-c1", farmer_id: "farmer-f1", ranch_id: "ranch-r1", joined_at: T.qual });
  service.registerMembership({ coop_id: "coop-c1", farmer_id: "farmer-f2", ranch_id: "ranch-r2", joined_at: T.qual });

  service.registerQualification({ ranch_id: "ranch-r1", version: 1, cert_no: "Q-R1-2026", status: "qualified", valid_from: T.qual, valid_to: "2027-01-01T00:00:00.000Z" });
  service.registerQualification({ ranch_id: "ranch-r2", version: 1, cert_no: "Q-R2-2026", status: "qualified", valid_from: T.qual, valid_to: "2027-01-01T00:00:00.000Z" });

  service.registerStandard({ standard_id: "STD-MEL", version: "v1", title: "婴幼儿配方食品三聚氰胺限量检测方法 v1", effective_from: T.qual });

  service.registerRawMilk({ raw_id: "raw-r1a", ranch_id: "ranch-r1", coop_id: "coop-c1", qty: 1000, produced_at: T.raw });
  service.registerRawMilk({ raw_id: "raw-r2a", ranch_id: "ranch-r2", coop_id: "coop-c1", qty: 1000, produced_at: T.raw });

  service.registerTransport({ seal_id: "seal-s1", raw_id: "raw-r1a", carrier_id: "carrier-t1", vehicle_no: "冷链A-001", seal_no: "封0001", sealed_at: T.raw, arrived_at: T.proc1, arrival_seal_intact: true });
  service.registerTransport({ seal_id: "seal-s2", raw_id: "raw-r2a", carrier_id: "carrier-t1", vehicle_no: "冷链A-002", seal_no: "封0002", sealed_at: T.raw, arrived_at: T.proc1, arrival_seal_intact: true });

  service.reportTest({ test_id: "test-r1a", business_key: "dev-d1#1001", source: "device", device_id: "dev-d1", lot_id: "raw-r1a", standard_id: "STD-MEL", standard_version: "v1", metric: "melamine", value: 0.2, unit: "mg/kg", result: "pass", submitted_by: "labtech-li", tested_at: T.tested });
  service.reportTest({ test_id: "test-r2a", business_key: "dev-d2#2001", source: "device", device_id: "dev-d2", lot_id: "raw-r2a", standard_id: "STD-MEL", standard_version: "v1", metric: "melamine", value: 0.15, unit: "mg/kg", result: "pass", submitted_by: "labtech-wang", tested_at: T.tested });

  service.registerFeeding({ event_id: "proc-1", kind: "process", plant_id: "plant-p1", run_id: "RUN-1", inputs: [{ lot_id: "raw-r1a", qty: 1000 }], output_lot_id: "pow-base1", output_qty: 900, at: T.proc1 });
  service.registerFeeding({ event_id: "proc-2", kind: "process", plant_id: "plant-p1", run_id: "RUN-2", inputs: [{ lot_id: "raw-r2a", qty: 1000 }], output_lot_id: "pow-base2", output_qty: 900, at: T.proc1 });

  // base1 一次不合格检测，凭职责分离后批准的例外才允许进入合批。
  service.reportTest({ test_id: "test-base1-moist", business_key: "lab-l1#3001", source: "lab", lot_id: "pow-base1", standard_id: "STD-MEL", standard_version: "v1", metric: "moisture", value: 5.2, unit: "%", result: "fail", submitted_by: "labtech-li", tested_at: T.failTest });
  service.requestException({ exception_id: "ex-1", lot_id: "pow-base1", test_id: "test-base1-moist", requested_by: "foreman-zhao", reason: "复测在允许偏差内", at: T.failTest });
  service.decideException({ exception_id: "ex-1", decision: "approved", approved_by: "qa-head-chen", comment: "质量负责人批准", at: T.failTest });

  service.registerFeeding({ event_id: "merge-1", kind: "merge", plant_id: "plant-p1", run_id: "RUN-3", inputs: [{ lot_id: "pow-base1", qty: 540 }, { lot_id: "pow-base2", qty: 360 }], output_lot_id: "pow-mix", output_qty: 900, at: T.merge });

  service.registerSplit({ split_id: "split-1", plant_id: "plant-p1", input_lot_id: "pow-mix", outputs: [{ lot_id: "lot-fin1", qty: 450 }, { lot_id: "lot-fin2", qty: 450 }], at: T.split });

  service.registerPacking({ can_lot_id: "canlot-fin1", source_lot_id: "lot-fin1", plant_id: "plant-p1", qty: 10000, packed_at: T.pack });
  service.registerPacking({ can_lot_id: "canlot-fin2", source_lot_id: "lot-fin2", plant_id: "plant-p1", qty: 10000, packed_at: T.pack });
  // 相邻未波及产品：完全来自二号牧场基粉的独立罐批。
  service.registerPacking({ can_lot_id: "canlot-fin3", source_lot_id: "pow-base2", plant_id: "plant-p1", qty: 8000, packed_at: T.pack });

  service.registerCan({ can_code: "CAN-0001", can_lot_id: "canlot-fin1" });
  service.registerCan({ can_code: "CAN-0002", can_lot_id: "canlot-fin2" });
  service.registerCan({ can_code: "CAN-0003", can_lot_id: "canlot-fin3" });

  service.registerQrSnapshot({ can_code: "CAN-0001", version: 1, content: "进口配方奶粉 官方追溯页（静态介绍）", captured_at: T.qr });
  service.registerQrSnapshot({ can_code: "CAN-0002", version: 1, content: "进口配方奶粉 官方追溯页（静态介绍）", captured_at: T.qr });
  service.registerQrSnapshot({ can_code: "CAN-0003", version: 1, content: "进口配方奶粉 官方追溯页（静态介绍）", captured_at: T.qr });
}

/** 放行与消费：canlot-fin1 已依法放行，CAN-0001 已消费；fin2 仍在控。 */
export function releaseAndConsume(service) {
  service.registerExportCert({ cert_id: "cert-1", can_code: "CAN-0001", cert_no: "CERT-2026-0001", issued_by: "regulator-g1", issued_at: T.cert });
  service.registerRelease({ release_id: "rel-1", lot_id: "canlot-fin1", regulator_id: "regulator-g1", doc_no: "DOC-2026-001", released_at: T.release });
  service.registerDisposition({ can_code: "CAN-0001", stage: "consumed", at: T.consumed });
}

/** 设备冲突：同一业务键上报不同测值，返回自动传播结果。 */
export function triggerDeviceConflict(service) {
  return service.reportTest({ test_id: "test-r1a-redo", business_key: "dev-d1#1001", source: "device", device_id: "dev-d1", lot_id: "raw-r1a", standard_id: "STD-MEL", standard_version: "v1", metric: "melamine", value: 1.8, unit: "mg/kg", result: "fail", submitted_by: "labtech-li", tested_at: T.fault });
}