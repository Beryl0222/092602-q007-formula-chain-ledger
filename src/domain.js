/**
 * 奶粉批次全链责任账——领域事实模型。
 *
 * 账本里只保存“已经发生的事实”（不可变、只追加）。每条事实按 FACT_TYPES
 * 声明的必填字段做形状校验；跨事实的引用完整性、合批快照、职责分离等
 * 规则在 service 层裁决。
 */

/** 全链事实类型。key 为事实类型，value 为该类型的必填字段。 */
export const FACT_TYPES = {
  // —— 责任主体与资格 ——
  coop_membership: ["coop_id", "member_id"], // 奶农合作社成员
  farm_qualification: ["farm_id", "qualification_no", "valid_from", "status"], // 牧场资格授予
  qualification_update: ["farm_id", "status", "changed_at"], // 牧场资格状态变更（暂停/恢复/撤销）
  // —— 牧场与原奶 ——
  raw_milk_batch: ["batch_id", "farm_id", "collected_at", "volume"], // 原奶批次
  shipment: ["shipment_id", "seal_no", "batch_ids", "sealed_at"], // 原奶运输（含封签）
  // —— 检验与例外 ——
  test_report: ["report_id", "target_id", "test_method", "method_version", "parameter", "result", "tested_by", "issued_at"], // 检验报告（含方法版本/更正）
  exception_request: ["request_id", "target_id", "requested_by", "reason"], // 例外申请
  exception_decision: ["request_id", "decision", "decided_by", "decided_at"], // 例外批准/驳回
  // —— 加工与成品 ——
  transform: ["run_id", "output_id", "inputs", "produced_at"], // 加工投料/合批/拆批（含投入比例）
  can_pack: ["can_code", "lot_id", "packed_at"], // 成品罐包装
  // —— 监管放行、消费与公开页 ——
  regulatory_release: ["release_id", "target_id", "authority", "certificate_no", "released_at"], // 监管放行/出口证明
  consumer_purchase: ["can_code", "purchased_at"], // 已进入消费
  qrcode_snapshot: ["can_code", "version", "generated_at"], // 二维码公开追溯页快照
  // —— 设备与风险沟通 ——
  device_reading: ["device_id", "business_key", "metric", "value", "target_id", "measured_at"], // 设备上报（业务键去重，须归属节点）
  risk_notification: ["notification_id", "target_id", "reason", "issued_by", "action"], // 风险通知/冻结（issued_at 缺省取登记时刻，只增不删）
};

/** 检验结论取值。withdrawn 表示该报告被撤回（不参与有效结论）。 */
export const TEST_RESULTS = ["pass", "fail", "withdrawn"];
export const EXCEPTION_DECISIONS = ["approved", "rejected"];
export const QUALIFICATION_STATUSES = ["active", "suspended", "revoked"];

const str = (v) => String(v ?? "").trim();

/** 通用事实构造：校验类型与必填字段，返回冻结对象（seq 由账本分配）。 */
export function createFact(type, payload = {}, context = {}) {
  if (!FACT_TYPES[type]) throw new Error(`未知事实类型：${type}`);
  const data = { ...payload };
  const missing = FACT_TYPES[type]
    .filter((name) => {
      const v = data[name];
      return v === undefined || v === null || (typeof v === "string" && !v.trim());
    })
    .filter((name) => name !== "batch_ids" && name !== "inputs"); // 数组单独校验
  if (missing.length) throw new Error(`${type} 缺少必要字段：${missing.join("、")}`);

  const fact = { fact_id: str(data.fact_id) || null, type, ...data };

  switch (type) {
    case "coop_membership":
      fact.coop_id = str(fact.coop_id);
      fact.member_id = str(fact.member_id);
      break;
    case "farm_qualification":
      fact.farm_id = str(fact.farm_id);
      fact.qualification_no = str(fact.qualification_no);
      fact.coop_id = str(fact.coop_id) || null;
      fact.member_id = str(fact.member_id) || null;
      if (!QUALIFICATION_STATUSES.includes(str(fact.status))) {
        throw new Error(`牧场资格状态非法：${fact.status}`);
      }
      break;
    case "qualification_update":
      fact.farm_id = str(fact.farm_id);
      if (!QUALIFICATION_STATUSES.includes(str(fact.status))) {
        throw new Error(`牧场资格状态非法：${fact.status}`);
      }
      fact.reason = str(fact.reason) || null;
      break;
    case "raw_milk_batch":
      fact.batch_id = str(fact.batch_id);
      fact.farm_id = str(fact.farm_id);
      fact.volume = Number(fact.volume);
      if (!(fact.volume > 0)) throw new Error("原奶批次 volume 必须为正数");
      break;
    case "shipment":
      fact.shipment_id = str(fact.shipment_id);
      fact.seal_no = str(fact.seal_no);
      if (!Array.isArray(fact.batch_ids) || fact.batch_ids.length === 0) {
        throw new Error("运输封签必须绑定至少一个原奶批次 batch_ids");
      }
      fact.batch_ids = [...new Set(fact.batch_ids.map(str))];
      fact.vehicle_id = str(fact.vehicle_id);
      fact.driver_id = str(fact.driver_id);
      fact.arrived_at = str(fact.arrived_at) || null;
      break;
    case "test_report":
      fact.report_id = str(fact.report_id);
      fact.target_id = str(fact.target_id);
      fact.test_method = str(fact.test_method);
      fact.method_version = str(fact.method_version);
      fact.parameter = str(fact.parameter);
      fact.result = str(fact.result);
      if (!TEST_RESULTS.includes(fact.result)) throw new Error(`检验结论非法：${fact.result}`);
      fact.tested_by = str(fact.tested_by);
      fact.value = fact.value === undefined || fact.value === null ? null : Number(fact.value);
      fact.unit = str(fact.unit) || null;
      fact.limit = fact.limit === undefined || fact.limit === null ? null : Number(fact.limit);
      fact.supersedes = str(fact.supersedes) || null; // 本报告更正的旧报告
      break;
    case "exception_request":
      fact.request_id = str(fact.request_id);
      fact.target_id = str(fact.target_id);
      fact.report_id = str(fact.report_id) || fact.target_id;
      fact.requested_by = str(fact.requested_by);
      fact.reason = str(fact.reason);
      break;
    case "exception_decision":
      fact.request_id = str(fact.request_id);
      fact.decision = str(fact.decision);
      if (!EXCEPTION_DECISIONS.includes(fact.decision)) throw new Error(`例外决定非法：${fact.decision}`);
      fact.decided_by = str(fact.decided_by);
      fact.basis = str(fact.basis) || null;
      break;
    case "transform": {
      fact.run_id = str(fact.run_id);
      fact.output_id = str(fact.output_id);
      fact.output_kind = str(fact.output_kind) || "product_lot";
      if (!Array.isArray(fact.inputs) || fact.inputs.length === 0) {
        throw new Error("加工/合批必须声明投入 inputs");
      }
      fact.inputs = fact.inputs.map((input) => {
        const id = str(input.id ?? input.batch_id ?? input.lot_id);
        const qty = Number(input.qty ?? input.quantity ?? 0);
        if (!id) throw new Error("投入项缺少 id");
        if (!(qty > 0)) throw new Error(`投入 ${id} 的 qty 必须为正数`);
        return { id, qty, unit: str(input.unit) || null };
      });
      fact.plant_id = str(fact.plant_id);
      fact.processed_by = str(fact.processed_by);
      // conclusion 快照由 service 在登记时按当时有效检测结论注入；若调用方自带则保留。
      fact.input_conclusions = data.input_conclusions ?? null;
      fact.input_snapshot = data.input_snapshot ?? null; // [{id,qty,unit,ratio,conclusion}]
      fact.conflict = data.conflict === true; // 设备读数冲突补发的事实
      break;
    }
    case "can_pack":
      fact.can_code = str(fact.can_code);
      fact.lot_id = str(fact.lot_id);
      break;
    case "regulatory_release":
      fact.release_id = str(fact.release_id);
      fact.target_id = str(fact.target_id);
      fact.authority = str(fact.authority);
      fact.certificate_no = str(fact.certificate_no);
      fact.released_by = str(fact.released_by) || null;
      break;
    case "consumer_purchase":
      fact.can_code = str(fact.can_code);
      fact.channel = str(fact.channel) || null;
      break;
    case "qrcode_snapshot":
      fact.can_code = str(fact.can_code);
      fact.version = Number(fact.version);
      if (!Number.isInteger(fact.version) || fact.version < 1) throw new Error("二维码版本必须为正整数");
      fact.content = data.content ?? null;
      fact.content_hash = str(fact.content_hash) || null;
      break;
    case "device_reading":
      fact.device_id = str(fact.device_id);
      fact.business_key = str(fact.business_key);
      fact.metric = str(fact.metric);
      fact.value = Number(fact.value);
      if (Number.isNaN(fact.value)) throw new Error("设备测值必须是数值");
      fact.unit = str(fact.unit) || null;
      fact.target_id = str(fact.target_id) || null; // 读数归属的业务节点
      fact.reading_id = str(fact.reading_id) || `${fact.device_id}:${fact.business_key}`;
      break;
    case "risk_notification":
      fact.notification_id = str(fact.notification_id);
      fact.target_id = str(fact.target_id);
      fact.reason = str(fact.reason);
      fact.issued_by = str(fact.issued_by);
      fact.action = str(fact.action) || "notify";
      if (!["quarantine", "notify"].includes(fact.action)) throw new Error(`风险通知动作非法：${fact.action}`);
      fact.issued_at = str(fact.issued_at) || fact.at;
      fact.channel = str(fact.channel) || null;
      fact.run_id = str(fact.run_id) || null;
      break;
  }

  if (context.actor) fact.actor = str(context.actor);
  fact.at = str(data.at) || context.at || new Date().toISOString();
  // 返回可变草稿：service 在追加前可能补充合批快照等派生字段；
  // 入帐后由账本哈希链保证不可篡改（见 ledger.appendFact）。
  return fact;
}

/** 业务键：每种节点事实对外稳定的编号。 */
export function businessKeyOf(fact) {
  switch (fact.type) {
    case "coop_membership": return `member:${fact.coop_id}/${fact.member_id}`;
    case "farm_qualification": return `farm-qual:${fact.farm_id}/${fact.qualification_no}`;
    case "qualification_update": return `farm-qual-update:${fact.farm_id}@${fact.changed_at}`;
    case "raw_milk_batch": return `raw:${fact.batch_id}`;
    case "shipment": return `shipment:${fact.shipment_id}`;
    case "test_report": return `report:${fact.report_id}`;
    case "exception_request": return `exception:${fact.request_id}`;
    case "exception_decision": return `exception-decision:${fact.request_id}`;
    case "transform": return `transform:${fact.run_id}`;
    case "can_pack": return `can:${fact.can_code}`;
    case "regulatory_release": return `release:${fact.release_id}`;
    case "consumer_purchase": return `purchase:${fact.can_code}`;
    case "qrcode_snapshot": return `qrcode:${fact.can_code}@v${fact.version}`;
    case "device_reading": return fact.conflict ? `device-conflict:${fact.reading_id}` : `device:${fact.device_id}/${fact.business_key}`;
    case "risk_notification": return `notice:${fact.notification_id}`;
    default: return fact.fact_id;
  }
}

/** 事实产出/绑定的批次节点 id（用于构建谱系图）。 */
export function nodeIdOf(fact) {
  switch (fact.type) {
    case "raw_milk_batch": return fact.batch_id;
    case "shipment": return fact.shipment_id;
    case "transform": return fact.output_id;
    case "can_pack": return fact.can_code;
    default: return null;
  }
}

/**
 * 从一组检验报告中解析当前有效结论。
 * 规则：result=withdrawn 不参与；被任一更晚报告以 supersedes 指向的报告失效；
 * 其余按 (issued_at, seq) 取最新。
 */
export function effectiveReport(reports) {
  const active = reports.filter((r) => r.result !== "withdrawn");
  const superseded = new Set(active.map((r) => r.supersedes).filter(Boolean));
  const live = active.filter((r) => !superseded.has(r.report_id));
  if (!live.length) return null;
  return [...live].sort((a, b) => {
    const t = String(b.issued_at).localeCompare(String(a.issued_at));
    return t !== 0 ? t : (b.seq ?? 0) - (a.seq ?? 0);
  })[0];
}

/** 设备读数指纹：业务键相同但指纹不同即冲突。 */
export function readingFingerprint(reading) {
  return JSON.stringify([reading.metric, reading.value, reading.unit ?? null]);
}

/** 投入比例：每个投入量占总投入的份额（0~1，保留 6 位）。 */
export function inputRatios(inputs) {
  const total = inputs.reduce((sum, i) => sum + i.qty, 0);
  return inputs.map((i) => ({ ...i, ratio: Number((i.qty / total).toFixed(6)) }));
}

/** —— 以下保留 v0.1 基础记录能力，供基线契约与测试继续使用。 —— */
export function createRecord(payload) {
  const required = ["record_id", "owner_id", "state"];
  const missing = required.filter((name) => !String(payload[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
  const revision = Number(payload.revision ?? 1);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是正整数");
  return Object.freeze({
    record_id: String(payload.record_id), owner_id: String(payload.owner_id),
    state: String(payload.state), revision,
    created_at: payload.created_at || new Date().toISOString(),
  });
}
