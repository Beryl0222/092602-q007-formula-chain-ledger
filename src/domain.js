/**
 * 奶粉批次全链责任账领域记录。
 *
 * 所有工厂返回冻结记录；账本只追加，状态只能由“追加新记录”改变
 * （新版资格、更正检测、风险通知、新版二维码快照），从不覆盖旧记录。
 */

const RATIO_TOLERANCE = 1e-9;

export function nonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`缺少必要字段：${label}`);
  return text;
}

export function positiveNumber(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) throw new Error(`${label} 必须是正数`);
  return num;
}

export function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error("测值必须是数值");
  return num;
}

export function isoTime(value, label, fallback = new Date().toISOString()) {
  const text = String(value ?? fallback);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${label} 必须是可解析的时间`);
  return text;
}

/** 校验投入/产出份额：数量为正且比例之和为 1。 */
export function normalizeShares(parts, label) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error(`${label}至少包含一项`);
  const normalized = parts.map((part) => ({
    lot_id: nonEmpty(part.lot_id, `${label}批次编号`),
    qty: positiveNumber(part.qty, `${label}数量`),
    unit: nonEmpty(part.unit ?? "kg", `${label}单位`),
  }));
  const units = new Set(normalized.map((part) => part.unit));
  if (units.size > 1) throw new Error(`${label}必须使用同一计量单位`);
  const total = normalized.reduce((sum, part) => sum + part.qty, 0);
  let assigned = 0;
  normalized.forEach((part, index) => {
    part.ratio = index === normalized.length - 1
      ? roundRatio(1 - assigned)
      : roundRatio(part.qty / total);
    assigned += part.ratio;
  });
  const sum = normalized.reduce((s, part) => s + part.ratio, 0);
  if (Math.abs(sum - 1) > RATIO_TOLERANCE) throw new Error(`${label}比例之和必须为 1`);
  return normalized;
}

function roundRatio(value) {
  return Math.round(value * 1e9) / 1e9;
}

function freeze(type, id, payload) {
  return Object.freeze({ type, id, ...payload });
}

/* ---------------------------------- 基线 ---------------------------------- */

/** 基线通用记录，保持已有登记契约不变。 */
export function createRecord(payload) {
  const required = ["record_id", "owner_id", "state"];
  const missing = required.filter((name) => !String(payload[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
  const revision = Number(payload.revision ?? 1);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是正整数");
  return Object.freeze({
    type: "generic_record",
    id: String(payload.record_id),
    record_id: String(payload.record_id), owner_id: String(payload.owner_id),
    state: String(payload.state), revision,
    created_at: isoTime(payload.created_at, "created_at"),
  });
}

/* -------------------------------- 责任主体 -------------------------------- */

export function registerParty(payload) {
  const id = nonEmpty(payload.party_id, "party_id");
  const kinds = ["cooperative", "farmer", "ranch", "carrier", "plant", "lab", "regulator", "distributor", "brand"];
  if (!kinds.includes(payload.kind)) throw new Error(`主体类型无效：${payload.kind}`);
  return freeze("party", id, {
    party_id: id,
    kind: payload.kind,
    name: nonEmpty(payload.name, "name"),
    registered_at: isoTime(payload.registered_at, "registered_at"),
  });
}

/** 奶农合作社成员关系：成员退社也只能追加终止记录，不删除。 */
export function registerCoopMembership(payload) {
  const coop_id = nonEmpty(payload.coop_id, "coop_id");
  const farmer_id = nonEmpty(payload.farmer_id, "farmer_id");
  return freeze("coop_membership", `${coop_id}:${farmer_id}`, {
    coop_id, farmer_id, ranch_id: nonEmpty(payload.ranch_id, "ranch_id"),
    joined_at: isoTime(payload.joined_at, "joined_at"),
    left_at: payload.left_at ? isoTime(payload.left_at, "left_at") : null,
  });
}

/** 牧场资格按版本追加，suspended/revoked 是新版本，旧版本保留可审计。 */
export function registerRanchQualification(payload) {
  const ranch_id = nonEmpty(payload.ranch_id, "ranch_id");
  const version = positiveNumber(payload.version ?? 1, "version");
  const statuses = ["qualified", "suspended", "revoked"];
  if (!statuses.includes(payload.status)) throw new Error(`牧场资格状态无效：${payload.status}`);
  return freeze("ranch_qualification", `${ranch_id}:v${version}`, {
    qual_id: nonEmpty(payload.qual_id ?? `${ranch_id}:v${version}`, "qual_id"),
    ranch_id, version: Math.trunc(version),
    status: payload.status,
    cert_no: nonEmpty(payload.cert_no, "cert_no"),
    valid_from: isoTime(payload.valid_from, "valid_from"),
    valid_to: payload.valid_to ? isoTime(payload.valid_to, "valid_to") : null,
  });
}

/** 检验方法/标准版本：检测结论永远锁定当时有效的版本号。 */
export function registerStandardVersion(payload) {
  const standard_id = nonEmpty(payload.standard_id, "standard_id");
  const version = nonEmpty(payload.version, "version");
  return freeze("standard_version", `${standard_id}:${version}`, {
    standard_id, version,
    title: nonEmpty(payload.title, "title"),
    effective_from: isoTime(payload.effective_from, "effective_from"),
  });
}

/* ------------------------------ 牧场到加工边 ------------------------------ */

export function registerRawMilkLot(payload) {
  return freeze("raw_milk_lot", nonEmpty(payload.raw_id, "raw_id"), {
    raw_id: nonEmpty(payload.raw_id, "raw_id"),
    ranch_id: nonEmpty(payload.ranch_id, "ranch_id"),
    coop_id: payload.coop_id ? nonEmpty(payload.coop_id, "coop_id") : null,
    qty: positiveNumber(payload.qty, "qty"),
    unit: nonEmpty(payload.unit ?? "kg", "unit"),
    produced_at: isoTime(payload.produced_at, "produced_at"),
  });
}

/** 原奶运输封签：到货封签破损的原奶不能投料。 */
export function registerTransport(payload) {
  const seal_id = nonEmpty(payload.seal_id, "seal_id");
  return freeze("transport_seal", seal_id, {
    seal_id,
    raw_id: nonEmpty(payload.raw_id, "raw_id"),
    carrier_id: nonEmpty(payload.carrier_id, "carrier_id"),
    vehicle_no: nonEmpty(payload.vehicle_no, "vehicle_no"),
    seal_no: nonEmpty(payload.seal_no, "seal_no"),
    sealed_at: isoTime(payload.sealed_at, "sealed_at"),
    arrived_at: isoTime(payload.arrived_at, "arrived_at"),
    arrival_seal_intact: payload.arrival_seal_intact !== false,
  });
}

/**
 * 投料事件同时覆盖“加工”与“合批”：一个产出批次对应若干投入批次。
 * 投入比例与各投入批次当时有效的检测结论在事件发生时快照冻结。
 */
export function registerFeeding(payload) {
  const kind = payload.kind === "merge" ? "merge" : "process";
  const event_id = nonEmpty(payload.event_id, "event_id");
  const output_lot_id = nonEmpty(payload.output_lot_id, "output_lot_id");
  const inputs = normalizeShares(payload.inputs, "投入");
  return freeze(kind === "merge" ? "merge" : "process", event_id, {
    event_id, kind,
    plant_id: nonEmpty(payload.plant_id, "plant_id"),
    run_id: nonEmpty(payload.run_id, "run_id"),
    inputs,
    output_lot_id,
    output_qty: positiveNumber(payload.output_qty, "output_qty"),
    output_unit: nonEmpty(payload.output_unit ?? inputs[0].unit, "output_unit"),
    at: isoTime(payload.at, "at"),
    // 由服务层在登记时填充：每个投入当时有效的检测结论快照。
    conclusion_snapshot: Object.freeze(Array.isArray(payload.conclusion_snapshot)
      ? payload.conclusion_snapshot.map(Object.freeze) : []),
  });
}

/** 拆批：一个投入批次拆成多个产出批次，比例同样冻结。 */
export function registerSplit(payload) {
  const split_id = nonEmpty(payload.split_id, "split_id");
  const input_lot_id = nonEmpty(payload.input_lot_id, "input_lot_id");
  const outputs = normalizeShares(payload.outputs, "拆批产出");
  return freeze("split", split_id, {
    split_id,
    plant_id: nonEmpty(payload.plant_id, "plant_id"),
    input_lot_id,
    outputs,
    at: isoTime(payload.at, "at"),
  });
}

/** 装罐：粉批次对应成品罐批，比例 1:1。 */
export function registerPacking(payload) {
  const can_lot_id = nonEmpty(payload.can_lot_id, "can_lot_id");
  return freeze("packing", can_lot_id, {
    can_lot_id,
    source_lot_id: nonEmpty(payload.source_lot_id, "source_lot_id"),
    plant_id: nonEmpty(payload.plant_id, "plant_id"),
    qty: positiveNumber(payload.qty, "qty"),
    unit: nonEmpty(payload.unit ?? "can", "unit"),
    packed_at: isoTime(payload.packed_at, "packed_at"),
  });
}

/** 罐码登记：罐码属于罐批，是公开追溯的最小单位。 */
export function registerCan(payload) {
  const can_code = nonEmpty(payload.can_code, "can_code");
  return freeze("can", can_code, {
    can_code,
    can_lot_id: nonEmpty(payload.can_lot_id, "can_lot_id"),
  });
}

/* -------------------------------- 检测领域 -------------------------------- */

/**
 * 检测上报。business_key 是设备/实验室侧业务键（设备编号+检测流水）。
 * 同业务键同测值 = 重复上报去重；同业务键不同测值 = 冲突，由服务层隔离依赖链。
 */
export function registerTest(payload) {
  const test_id = nonEmpty(payload.test_id, "test_id");
  const result = String(payload.result ?? "").trim();
  if (!["pass", "fail", "invalid"].includes(result)) throw new Error(`检测结论无效：${result}`);
  const isCorrection = Boolean(payload.correction_of);
  return freeze("test", test_id, {
    test_id,
    business_key: nonEmpty(payload.business_key, "business_key"),
    source: payload.source === "lab" ? "lab" : "device",
    device_id: payload.device_id ? nonEmpty(payload.device_id, "device_id") : null,
    lot_id: nonEmpty(payload.lot_id, "lot_id"),
    standard_id: nonEmpty(payload.standard_id, "standard_id"),
    standard_version: nonEmpty(payload.standard_version, "standard_version"),
    metric: nonEmpty(payload.metric, "metric"),
    value: optionalNumber(payload.value),
    unit: nonEmpty(payload.unit, "unit"),
    result,
    submitted_by: nonEmpty(payload.submitted_by, "submitted_by"),
    tested_at: isoTime(payload.tested_at, "tested_at"),
    correction_of: isCorrection ? nonEmpty(payload.correction_of, "correction_of") : null,
    conflict: Boolean(payload.conflict),
  });
}

/** 例外申请。 */
export function registerExceptionRequest(payload) {
  const exception_id = nonEmpty(payload.exception_id, "exception_id");
  return freeze("exception_request", exception_id, {
    exception_id,
    lot_id: nonEmpty(payload.lot_id, "lot_id"),
    test_id: nonEmpty(payload.test_id, "test_id"),
    requested_by: nonEmpty(payload.requested_by, "requested_by"),
    reason: nonEmpty(payload.reason, "reason"),
    at: isoTime(payload.at, "at"),
  });
}

/** 例外批准：批准人必须与提交人不同，由服务层强制。 */
export function registerExceptionApproval(payload) {
  const exception_id = nonEmpty(payload.exception_id, "exception_id");
  const decision = ["approved", "rejected"].includes(payload.decision) ? payload.decision : null;
  if (!decision) throw new Error(`例外决定无效：${payload.decision}`);
  return freeze("exception_approval", `${exception_id}:${decision}`, {
    exception_id,
    decision,
    approved_by: nonEmpty(payload.approved_by, "approved_by"),
    comment: String(payload.comment ?? ""),
    at: isoTime(payload.at, "at"),
  });
}

/* ------------------------------ 监管与流通边 ------------------------------ */

export function registerRegulatorRelease(payload) {
  const release_id = nonEmpty(payload.release_id, "release_id");
  return freeze("regulator_release", release_id, {
    release_id,
    lot_id: nonEmpty(payload.lot_id, "lot_id"),
    regulator_id: nonEmpty(payload.regulator_id, "regulator_id"),
    doc_no: nonEmpty(payload.doc_no, "doc_no"),
    released_at: isoTime(payload.released_at, "released_at"),
  });
}

export function registerExportCert(payload) {
  const cert_id = nonEmpty(payload.cert_id, "cert_id");
  return freeze("export_cert", cert_id, {
    cert_id,
    ref_kind: payload.can_code ? "can_code" : "lot",
    ref_id: nonEmpty(payload.can_code ?? payload.lot_id, "lot_id/can_code"),
    cert_no: nonEmpty(payload.cert_no, "cert_no"),
    issued_by: nonEmpty(payload.issued_by, "issued_by"),
    issued_at: isoTime(payload.issued_at, "issued_at"),
    supersedes: payload.supersedes ? nonEmpty(payload.supersedes, "supersedes") : null,
  });
}

/** 出口证明换发：旧证明保留，换发事件说明去向。 */
export function registerCertReissue(payload) {
  const reissue_id = nonEmpty(payload.reissue_id, "reissue_id");
  return freeze("cert_reissue", reissue_id, {
    reissue_id,
    old_cert_id: nonEmpty(payload.old_cert_id, "old_cert_id"),
    new_cert_id: nonEmpty(payload.new_cert_id, "new_cert_id"),
    run_id: nonEmpty(payload.run_id, "run_id"),
    reason_code: nonEmpty(payload.reason_code, "reason_code"),
    at: isoTime(payload.at, "at"),
  });
}

/** 销售/消费处置：进入此状态的记录不受冻结，只接收风险通知。 */
export function registerDisposition(payload) {
  const stage = ["sold", "consumed"].includes(payload.stage) ? payload.stage : null;
  if (!stage) throw new Error(`流通处置无效：${payload.stage}`);
  const refKind = payload.can_code ? "can_code" : "lot";
  const ref = nonEmpty(payload.can_code ?? payload.lot_id, "lot_id/can_code");
  return freeze("disposition", `${refKind}:${ref}:${stage}`, {
    ref_kind: refKind,
    ref_id: ref,
    stage,
    at: isoTime(payload.at, "at"),
  });
}

/** 二维码公开追溯页快照：更正只能发布新版本，旧快照留痕。 */
export function registerQrSnapshot(payload) {
  const can_code = nonEmpty(payload.can_code, "can_code");
  const version = Math.trunc(positiveNumber(payload.version ?? 1, "version"));
  const content = nonEmpty(payload.content, "content");
  return freeze("qr_snapshot", `${can_code}:v${version}`, {
    snapshot_id: nonEmpty(payload.snapshot_id ?? `${can_code}:v${version}`, "snapshot_id"),
    can_code, version,
    content,
    content_hash: nonEmpty(payload.content_hash ?? hashText(content), "content_hash"),
    captured_at: isoTime(payload.captured_at, "captured_at"),
  });
}

/** 二维码快照换版：旧快照不删不改变，记录被哪个新版本替代。 */
export function registerQrReissue(payload) {
  const reissue_id = nonEmpty(payload.reissue_id, "reissue_id");
  return freeze("qr_reissue", reissue_id, {
    reissue_id,
    can_code: nonEmpty(payload.can_code, "can_code"),
    old_snapshot_id: nonEmpty(payload.old_snapshot_id, "old_snapshot_id"),
    new_snapshot_id: nonEmpty(payload.new_snapshot_id, "new_snapshot_id"),
    run_id: nonEmpty(payload.run_id, "run_id"),
    at: isoTime(payload.at, "at"),
  });
}

/** 风险通知：放行/消费后的补救只能追加通知，绝不删除原记录。 */
export function registerRiskNotice(payload) {
  const notice_id = nonEmpty(payload.notice_id, "notice_id");
  return freeze("risk_notice", notice_id, {
    notice_id,
    ref_kind: nonEmpty(payload.ref_kind, "ref_kind"),
    ref_id: nonEmpty(payload.ref_id, "ref_id"),
    run_id: payload.run_id ? nonEmpty(payload.run_id, "run_id") : null,
    message: nonEmpty(payload.message, "message"),
    issued_by: nonEmpty(payload.issued_by, "issued_by"),
    issued_at: isoTime(payload.issued_at, "issued_at"),
  });
}

/** 隔离/冻结指令：trigger 说明触发来源，scope 为 affected 节点。 */
export function registerQuarantine(payload) {
  const order_id = nonEmpty(payload.order_id, "order_id");
  return freeze("quarantine_order", order_id, {
    order_id,
    run_id: nonEmpty(payload.run_id, "run_id"),
    node_id: nonEmpty(payload.node_id, "node_id"),
    level: payload.level === "isolated" ? "isolated" : "frozen",
    reason_code: nonEmpty(payload.reason_code, "reason_code"),
    issued_at: isoTime(payload.issued_at, "issued_at"),
  });
}

/** 隔离解除：只能追加解除事件，绝不修改或删除原隔离指令。 */
export function registerQuarantineLift(payload) {
  const lift_id = nonEmpty(payload.lift_id, "lift_id");
  return freeze("quarantine_lift", lift_id, {
    lift_id,
    order_id: nonEmpty(payload.order_id, "order_id"),
    node_id: nonEmpty(payload.node_id, "node_id"),
    lifted_by: nonEmpty(payload.lifted_by, "lifted_by"),
    reason: nonEmpty(payload.reason, "reason"),
    at: isoTime(payload.at, "at"),
  });
}

/** 影响传播运行与分步检查点（断点续传依据）。frozen_plan 在创建时冻结整份演算计划。 */
export function registerPropagationRun(payload) {
  const frozenPlan = payload.frozen_plan;
  if (!frozenPlan || typeof frozenPlan !== "object") throw new Error("frozen_plan 缺失");
  return freeze("propagation_run", nonEmpty(payload.run_id, "run_id"), {
    run_id: nonEmpty(payload.run_id, "run_id"),
    trigger_event_id: nonEmpty(payload.trigger_event_id, "trigger_event_id"),
    trigger_kind: nonEmpty(payload.trigger_kind, "trigger_kind"),
    source_node: nonEmpty(payload.source_node, "source_node"),
    algorithm: "bfs-lineage-v1",
    log_seq: Number(payload.log_seq),
    plan_checksum: nonEmpty(payload.plan_checksum, "plan_checksum"),
    frozen_plan: deepFreeze(structuredClone(frozenPlan)),
    status: "running",
    created_at: isoTime(payload.created_at, "created_at"),
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function registerPropagationStep(payload) {
  return freeze("propagation_step", `${payload.run_id}:${payload.node_id}`, {
    run_id: nonEmpty(payload.run_id, "run_id"),
    node_id: nonEmpty(payload.node_id, "node_id"),
    depth: Number(payload.depth),
    parent: payload.parent ? Object.freeze({ node_id: String(payload.parent.node_id), ratio_path: Number(payload.parent.ratio_path) }) : null,
    decision: nonEmpty(payload.decision, "decision"),
    reason_code: nonEmpty(payload.reason_code, "reason_code"),
  });
}

export function registerPropagationCompletion(payload) {
  return freeze("propagation_completion", nonEmpty(payload.run_id, "run_id"), {
    run_id: nonEmpty(payload.run_id, "run_id"),
    status: payload.status === "crashed" ? "crashed" : "done",
    affected: Object.freeze([...payload.affected].map(String).sort()),
    frozen: Object.freeze([...(payload.frozen ?? [])].map(String).sort()),
    isolated: Object.freeze([...(payload.isolated ?? [])].map(String).sort()),
    noticed: Object.freeze([...(payload.noticed ?? [])].map(String).sort()),
    qr_reissue: Object.freeze([...(payload.qr_reissue ?? [])].map(String).sort()),
    cert_reissue: Object.freeze([...(payload.cert_reissue ?? [])].map(String).sort()),
    checksum: nonEmpty(payload.checksum, "checksum"),
    finished_at: isoTime(payload.finished_at, "finished_at"),
  });
}

/** 简易稳定哈希（Node 内置 crypto 在服务层注入也可），避免领域文件依赖运行时 API。 */
function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return `djb2-${(h >>> 0).toString(16).padStart(8, "0")}`;
}
