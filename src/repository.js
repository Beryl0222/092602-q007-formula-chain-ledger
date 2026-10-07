/**
 * 仅追加账本：记录一旦写入不可修改、不可删除。
 *
 * - 主键为 `${type}:${id}`，同键重复写入被拒绝（设备幂等去重在服务层判定）。
 * - 每条记录分配单调递增 seq，传播演算按确定性规则排序而不依赖插入偶然顺序。
 * - 可选 JSONL 审计日志：每行一条记录，服务重开后重放即可恢复全部状态。
 */
import { existsSync, appendFileSync, readFileSync } from "node:fs";

export class Repository {
  #records = new Map();
  #seq = 0;
  #logFile;

  constructor({ logFile = null } = {}) {
    this.#logFile = logFile;
  }

  static fromLog(logFile) {
    const repo = new Repository({ logFile });
    if (logFile && existsSync(logFile)) {
      const text = readFileSync(logFile, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = JSON.parse(trimmed);
        repo.#ingest(entry.record, { persist: false, seq: entry.seq });
      }
    }
    return repo;
  }

  add(record) {
    if (!record || !record.type || !record.id) throw new Error("记录缺少 type 或 id");
    const key = `${record.type}:${record.id}`;
    if (this.#records.has(key)) {
      const err = new Error("记录编号已存在");
      err.code = "DUPLICATE_RECORD";
      err.existing = this.#records.get(key);
      throw err;
    }
    return this.#ingest(record, { persist: true });
  }

  #ingest(record, { persist, seq = null }) {
    if (seq !== null) {
      if (seq <= this.#seq) throw new Error(`审计日志 seq 非单调：${seq}`);
      this.#seq = seq;
    } else {
      this.#seq += 1;
    }
    const entry = { seq: this.#seq, record };
    this.#records.set(`${record.type}:${record.id}`, entry);
    if (persist && this.#logFile) {
      appendFileSync(this.#logFile, `${JSON.stringify(entry)}\n`);
    }
    return record;
  }

  get(type, id) {
    return this.#records.get(`${type}:${id}`)?.record ?? null;
  }

  list(type) {
    const rows = [...this.#records.values()]
      .filter((entry) => !type || entry.record.type === type)
      .sort((a, b) => (a.seq - b.seq) || a.record.id.localeCompare(b.record.id));
    return rows.map((entry) => entry.record);
  }

  find(type, predicate) {
    return this.list(type).filter(predicate);
  }

  get seq() { return this.#seq; }
}
