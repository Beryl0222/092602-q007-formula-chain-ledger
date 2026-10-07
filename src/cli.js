/**
 * 命令行入口。
 *
 * 用法：
 *   node src/cli.js health
 *   node src/cli.js validate <record.json>            # v0.1 基础记录校验（兼容）
 *   node src/cli.js load <ledger.jsonl> <scenario.json>  # 顺序载入场景事件
 *   node src/cli.js isolate <ledger.jsonl> <rootId> [reason]
 *   node src/cli.js resume <ledger.jsonl> <runId>      # 服务恢复后继续未完成传播
 *   node src/cli.js replay <ledger.jsonl> <rootId>     # 只读复算，不写入
 *   node src/cli.js trace <ledger.jsonl> <canCode> [neighbor,neighbor]
 *   node src/cli.js verify <ledger.jsonl>              # 哈希链完整性
 */
import { readFile } from "node:fs/promises";
import { Service } from "./service.js";
import { createRecord } from "./domain.js";

const [command, arg1, arg2, arg3] = process.argv.slice(2);

function serviceFor(path) {
  return new Service({ path: path || null });
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function loadScenario(service, file) {
  const scenario = JSON.parse(await readFile(file, "utf8"));
  const events = Array.isArray(scenario) ? scenario : scenario.events;
  const output = [];
  for (const event of events) {
    if (event.op === "record" || !event.op) {
      try {
        const saved = service.record(event.type, event.payload, { actor: event.actor });
        output.push({ op: "record", type: event.type, seq: saved.seq, deduplicated: saved.deduplicated ?? false, business_key: event.payload?.report_id ?? event.payload?.batch_id ?? event.payload?.can_code ?? event.payload?.run_id ?? event.payload?.output_id ?? null });
      } catch (error) {
        if (event.expect_error) output.push({ op: "record", type: event.type, expected_error: error.message });
        else throw error;
      }
    } else if (event.op === "isolate") {
      output.push({ op: "isolate", ...service.isolate(event.root, { reason: event.reason, actor: event.actor, source: event.source }) });
    } else if (event.op === "resume") {
      output.push({ op: "resume", ...service.resumeRun(event.run_id) });
    } else if (event.op === "trace") {
      output.push({ op: "trace", ...service.trace(event.can_code, { neighbors: event.neighbors ?? [] }) });
    } else {
      throw new Error(`未知场景事件：${event.op}`);
    }
  }
  return output;
}

switch (command) {
  case "health":
    print(serviceFor(arg1).health());
    break;

  case "validate": {
    const payload = JSON.parse(await readFile(arg1, "utf8"));
    print(createRecord(payload));
    break;
  }

  case "load": {
    const service = serviceFor(arg1);
    print({ loaded: await loadScenario(service, arg2), verify: service.verify() });
    break;
  }

  case "isolate": {
    const service = serviceFor(arg1);
    print(service.isolate(arg2, { reason: arg3 || "关键节点隔离" }));
    break;
  }

  case "resume":
    print(serviceFor(arg1).resumeRun(arg2));
    break;

  case "replay":
    print(serviceFor(arg1).replayPropagation(arg2));
    break;

  case "trace":
    print(serviceFor(arg1).trace(arg2, { neighbors: arg3 ? arg3.split(",") : [] }));
    break;

  case "verify":
    print(serviceFor(arg1).verify());
    break;

  default:
    print(new Service().health());
}
