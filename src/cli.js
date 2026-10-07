/**
 * 本地命令入口（只读/演示用）。
 *
 *   node src/cli.js health
 *   node src/cli.js validate <record.json>        基线通用记录登记
 *   node src/cli.js load <events.jsonl> [--db a.jsonl] [--resume]
 *       逐行加载 {"op": "...", "payload": {...}} 事件，事件自动触发的传播
 *       若中断可用 --resume 继续
 *   node src/cli.js trace <can_code> [--db a.jsonl]
 *       从罐码反查血缘、责任主体、标准版本、当前处置与相邻未波及原因
 *   node src/cli.js recall <node_id> [--db a.jsonl]
 *       预览召回影响传播计划（不落任何记录）
 */
import { readFile } from "node:fs/promises";
import { Service } from "./service.js";
import { Repository } from "./repository.js";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
const logFile = dbFlag >= 0 ? args[dbFlag + 1] : null;

function openService() {
  return new Service(logFile ? Repository.fromLog(logFile) : new Repository());
}

async function loadEvents(service, file) {
  const text = await readFile(file, "utf8");
  const summary = { loaded: 0, triggered_runs: [], errors: [] };
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const envelope = JSON.parse(trimmed);
    const handler = service[envelope.op];
    if (typeof handler !== "function") throw new Error(`第 ${index + 1} 行：未知操作 ${envelope.op}`);
    const result = handler.call(service, envelope.payload ?? {});
    summary.loaded += 1;
    if (typeof result?.run_id === "string" && result.run_id.startsWith("run:")) {
      summary.triggered_runs.push(result.run_id);
    }
  }
  return summary;
}

if (args[0] === "validate" && args[1]) {
  const payload = JSON.parse(await readFile(args[1], "utf8"));
  console.log(JSON.stringify(new Service().register(payload), null, 2));
} else if (args[0] === "load" && args[1]) {
  const service = openService();
  const summary = await loadEvents(service, args[1]);
  if (args.includes("--resume")) summary.resumed = service.resumePropagations().map((r) => r.run_id);
  console.log(JSON.stringify(summary, null, 2));
} else if (args[0] === "trace" && args[1]) {
  console.log(JSON.stringify(openService().trace(args[1]), null, 2));
} else if (args[0] === "recall" && args[1]) {
  console.log(JSON.stringify(openService().previewRecall({ source: args[1] }), null, 2));
} else if (args[0] === "resume") {
  console.log(JSON.stringify(openService().resumePropagations().map((r) => r.run_id), null, 2));
} else {
  console.log(JSON.stringify(openService().health(), null, 2));
}
