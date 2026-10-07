/**
 * 只追加事实账本。
 *
 * - 所有写入顺序编号、哈希串联，任何历史条目被篡改都会在校验时暴露；
 * - 条目一经追加不可修改、不可删除（已放行/已消费记录只能以风险通知补充）；
 * - 可选 JSONL 文件持久化：打开时重放重建，服务恢复后继续未完成的影响传播；
 * - 传播运行（propagation run）作为同类条目保存检查点，崩溃后从最后检查点继续。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { businessKeyOf } from "./domain.js";

const GENESIS = "0".repeat(64);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function digest(prevHash, body) {
  // 先做 JSON 规范化：剔除 undefined、NaN→null，使内存摘要与 JSONL 落盘/重放语义一致。
  const stable = JSON.parse(JSON.stringify(body));
  return createHash("sha256").update(prevHash).update("\0").update(canonical(stable)).digest("hex");
}

export class Ledger {
  #entries = [];
  #keyIndex = new Map(); // 业务键 -> seq
  #path = null;

  constructor(path = null) {
    this.#path = path;
    if (path && existsSync(path)) this.#replay(readFileSync(path, "utf8"));
  }

  #replay(text) {
    text.split("\n").forEach((line) => {
      if (!line.trim()) return;
      const entry = JSON.parse(line);
      this.#ingest(entry, { verify: true });
    });
  }

  #ingest(entry, { verify }) {
    if (entry.seq !== this.#entries.length + 1) {
      throw new Error(`账本序列断裂：期望 ${this.#entries.length + 1}，实际 ${entry.seq}`);
    }
    const prevHash = this.#entries.length ? this.#entries[this.#entries.length - 1].hash : GENESIS;
    if (verify && entry.prev_hash !== prevHash) throw new Error(`条目 ${entry.seq} 哈希链断裂（历史被修改）`);
    if (verify) {
      const { hash, prev_hash, ...body } = entry;
      if (digest(prevHash, body) !== hash) throw new Error(`条目 ${entry.seq} 内容哈希不一致`);
    }
    this.#entries.push(entry);
    if (entry.kind === "fact" && entry.fact) {
      const key = businessKeyOf(entry.fact);
      if (key) this.#keyIndex.set(key, entry.seq);
    }
  }

  /**
   * 追加一条事实。返回完整条目。
   * @param {object} fact 经 domain.createFact 构造的冻结事实
   * @param {{actor?:string, at?:string}} meta
   */
  appendFact(fact, meta = {}) {
    const seq = this.#entries.length + 1;
    const prevHash = this.#entries.length ? this.#entries[this.#entries.length - 1].hash : GENESIS;
    const body = { seq, kind: "fact", at: meta.at || new Date().toISOString(), actor: meta.actor || null, fact };
    const entry = { ...body, prev_hash: prevHash, hash: digest(prevHash, body) };
    this.#persist(entry);
    this.#ingest(entry, { verify: false });
    const stored = { ...fact, seq: entry.seq };
    return { entry, fact: stored };
  }

  /** 追加一条传播运行条目（started / checkpoint / finished）。 */
  appendRunEvent(payload) {
    const seq = this.#entries.length + 1;
    const prevHash = this.#entries.length ? this.#entries[this.#entries.length - 1].hash : GENESIS;
    const body = { seq, kind: "propagation", at: new Date().toISOString(), ...payload };
    const entry = { ...body, prev_hash: prevHash, hash: digest(prevHash, body) };
    this.#persist(entry);
    this.#ingest(entry, { verify: false });
    return entry;
  }

  #persist(entry) {
    if (!this.#path) return;
    appendFileSync(this.#path, JSON.stringify(entry) + "\n");
  }

  /** 全量校验哈希链（用于可重复演算前的完整性确认）。 */
  verify() {
    let prev = GENESIS;
    for (const entry of this.#entries) {
      if (entry.prev_hash !== prev) return { ok: false, seq: entry.seq, reason: "哈希链断裂" };
      const { hash, prev_hash, ...body } = entry;
      if (digest(prev, body) !== hash) return { ok: false, seq: entry.seq, reason: "内容哈希不一致" };
      prev = hash;
    }
    return { ok: true, entries: this.#entries.length };
  }

  facts({ asOf = Infinity } = {}) {
    return this.#entries.filter((e) => e.kind === "fact" && e.seq <= asOf).map((e) => ({ ...e.fact, seq: e.seq, at: e.fact.at || e.at }));
  }

  entries() { return [...this.#entries]; }
  get size() { return this.#entries.length; }
  get path() { return this.#path; }

  seqByKey(key) { return this.#keyIndex.get(key) ?? null; }
  hasKey(key) { return this.#keyIndex.has(key); }
  factByKey(key) {
    const seq = this.#keyIndex.get(key);
    return seq ? { ...this.#entries[seq - 1].fact, seq } : null;
  }

  /** 某传播运行的最新持久状态（用于崩溃恢复）。 */
  runState(runId) {
    let state = null;
    for (const entry of this.#entries) {
      if (entry.kind === "propagation" && entry.run_id === runId) state = entry;
    }
    return state;
  }

  /** 某运行自最后检查点之后的事实条目（恢复时不重放这些副作用）。 */
  factsAfter(seq) {
    return this.#entries.filter((e) => e.kind === "fact" && e.seq > seq).length;
  }
}
