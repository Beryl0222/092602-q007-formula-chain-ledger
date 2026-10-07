import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.js";
import { createFact } from "../src/domain.js";

function rawBatch(id = "raw-1") {
  return createFact("raw_milk_batch", {
    batch_id: id, farm_id: "farm-1", collected_at: "2026-09-01T06:00Z", volume: 1000,
  });
}

test("事实顺序编号且哈希链可校验", () => {
  const ledger = new Ledger();
  ledger.appendFact(rawBatch("raw-1"));
  ledger.appendFact(rawBatch("raw-2"));
  const result = ledger.verify();
  assert.equal(result.ok, true);
  assert.equal(result.entries, 2);
});

test("业务键重复可在索引中检出", () => {
  const ledger = new Ledger();
  ledger.appendFact(rawBatch("raw-1"));
  assert.equal(ledger.hasKey("raw:raw-1"), true);
  assert.equal(ledger.seqByKey("raw:raw-1"), 1);
  assert.equal(ledger.hasKey("raw:missing"), false);
});

test("JSONL 持久化：重开服务重放重建且哈希链一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "a.jsonl");
  try {
    const first = new Ledger(path);
    first.appendFact(rawBatch("raw-1"));
    first.appendRunEvent({ kind_run: "started", run_id: "run-1", root_id: "raw-1", plan: [] });

    const reopened = new Ledger(path);
    assert.equal(reopened.size, 2);
    assert.equal(reopened.verify().ok, true);
    assert.equal(reopened.runState("run-1").root_id, "raw-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("历史条目被篡改时重放/校验失败（不可悄悄改写）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "tamper.jsonl");
  try {
    const ledger = new Ledger(path);
    ledger.appendFact(rawBatch("raw-1"));
    ledger.appendFact(rawBatch("raw-2"));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.fact.volume = 9999; // 改写历史
    lines[0] = JSON.stringify(tampered);
    writeFileSync(path, lines.join("\n") + "\n");

    assert.throws(() => new Ledger(path), /哈希|篡改|不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺失条目导致序列断裂被拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "gap.jsonl");
  try {
    const ledger = new Ledger(path);
    ledger.appendFact(rawBatch("raw-1"));
    ledger.appendFact(rawBatch("raw-2"));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, lines[1] + "\n"); // 只保留 seq=2
    assert.throws(() => new Ledger(path), /序列断裂|哈希/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
