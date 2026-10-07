# 奶粉批次全链责任账（formula-chain-ledger）

进口奶粉在牧场、原奶运输、加工、检验与入境流通之间经历多次拆批与合批。本服务把
全链过程沉淀为一本**只追加事实账本**，并在其上提供批次谱系、可恢复可重复的影响传播
演算和任意罐码反查，回答质量团队最关心的问题：

- 每一罐经过了哪些节点、责任主体是谁、当时采用哪个检验标准版本；
- 上游检测被更正后，哪些成品罐、出口证明、公开追溯页必须跟着变化；
- 关键节点被隔离时，哪些后续批次仍能冻结，哪些已放行/已消费只能补风险通知；
- 召回演算如何复算、崩溃后如何续算，以及相邻批次为何没有被波及。

项目只使用 Node.js 内置模块，无需外部数据库或服务。

## 设计总览

```
src/domain.js       全链事实类型与校验；有效检验结论、投入比例、读数指纹等纯函数
src/ledger.js       只追加事实账本：seq + SHA-256 哈希链，内存或 JSONL 持久化
src/genealogy.js    批次谱系图：投料边（含比例）、正向可达、反向祖先、分流解释
src/propagation.js  影响传播规划器：纯函数、确定性顺序、每步可解释
src/service.js      应用服务：登记校验、合批快照、去重、职责分离、传播/恢复/反查
src/repository.js   v0.1 进程内基础记录仓库（保留兼容）
src/cli.js          命令行入口
```

事实只增不删，每条事实分配顺序 `seq` 并与前一条做 SHA-256 串联；任何历史条目被
修改或缺失，重放与 `verify()` 都会发现。已依法放行或已消费的批次不能被冻结或抹除，
只能追加 `risk_notification`（风险通知/消费者警示）补充处置。

## 全链事实

| 类型 | 含义 |
| --- | --- |
| `coop_membership` | 奶农合作社成员 |
| `farm_qualification` / `qualification_update` | 牧场资格授予 / 暂停·恢复·撤销 |
| `raw_milk_batch` | 原奶批次（须牧场资格有效） |
| `shipment` | 原奶运输与封签（绑定原奶批次，封签号不可复用） |
| `test_report` | 检验报告：检验方法+版本、参数、结论；`supersedes` 更正、`withdrawn` 撤回 |
| `exception_request` / `exception_decision` | 例外申请与批准/驳回 |
| `transform` | 加工投料 / 合批 / 拆批，保存投入比例与当时有效检测结论快照 |
| `can_pack` | 成品罐包装（罐码 → 成品批次） |
| `regulatory_release` | 监管放行 / 出口证明 |
| `consumer_purchase` | 已进入消费（脱离控制范围） |
| `qrcode_snapshot` | 二维码公开追溯页版本快照（版本必须连续） |
| `device_reading` | 设备上报，按设备号+业务键去重 |
| `risk_notification` | 冻结标记或风险通知，只增不删 |

## 关键规则

- **合批快照**：`transform` 落账时把每个投入的数量占比（`ratio`）与沿投入上游归集到
  的**当时有效检验结论**（报告号、方法版本、结论、签发时间）一并写入 `input_snapshot`，
  事后检测更正不会改写历史快照。
- **检测更正**：新报告用 `supersedes` 指向旧报告；`effectiveTest()` 只看未撤回、
  未被更正的最新报告，方法版本随之更新。
- **设备去重与冲突**：同一 `device_id + business_key` 的重复上报幂等丢弃；若测值不同，
  保存冲突读数并**隔离归属节点的整条依赖链**。
- **职责分离**：检测提交人（`test_report.tested_by`）不得批准与本人检测相关的例外。
- **隔离传播**：`isolate(rootId)` 沿投料图正向演算——仍在控制范围的节点 `quarantine`
  （冻结，禁止再投料/放行）；已有监管放行或消费记录的节点 `notify`（风险通知），
  记录全部保留。
- **可重复、可解释、可恢复**：
  - `replayPropagation(rootId)` 只读复算，结果由账本事实+触发点唯一决定；
  - 每步处置附带证据路径与原因（见 `explainStep`）；
  - 每处理一个节点写一个检查点，进程重启后 `resumeRun(runId)` 续算，动作幂等。
- **罐码反查**：`trace(canCode, {neighbors})` 返回经过节点、责任主体、标准版本、
  当前处置，并对相邻批次给出未波及原因（`no_shared_origin` /
  `contamination_after_split` / `split_before_contamination` / `downstream_after_merge`）。

## 使用

```bash
npm test                 # 运行全部测试
npm run build            # 语法检查所有模块
npm run check:sample     # 将 data/sample.json 全链场景载入账本并校验哈希链
npm run demo             # 同上，但账本保留在 ./ledger.demo.jsonl 便于后续命令
```

命令行（账本文件可选，省略则仅用内存账本）：

```bash
node src/cli.js load   <ledger.jsonl> <scenario.json>   # 顺序载入场景事件
node src/cli.js isolate <ledger.jsonl> <rootId> [reason]
node src/cli.js resume  <ledger.jsonl> <runId>           # 服务恢复后续传
node src/cli.js replay  <ledger.jsonl> <rootId>          # 只读复算
node src/cli.js trace   <ledger.jsonl> <canCode> [邻居罐码,…]
node src/cli.js verify  <ledger.jsonl>                   # 哈希链完整性
node src/cli.js validate <record.json>                   # v0.1 基础记录校验
```

代码中：

```js
import { Service } from "./src/service.js";
const service = new Service({ path: "ledger.jsonl" }); // 省略 path 为纯内存
service.record("transform", { run_id: "mix", output_id: "lot-1", /* … */ });
const run = service.isolate("RAW-F01-0901", { reason: "蛋白质复检不合格" });
const trace = service.trace("CAN-890-B-0001", { neighbors: ["CAN-890-A-0001"] });
```

## 演示场景

`data/sample.json` 是一条完整叙事链：两个牧场原奶（其一初检临界超标、经独立第三方
复检并由非检测人批准例外后更正为合格）→ 封签运输 → 按 2:1 合批为基粉 → 拆为两条
成品线并各有独立支线 → 其中一条取得出口证明且一罐已被购买、公开页生成 v1 快照 →
上游另一原奶蛋白质按新版方法复检不合格 → 隔离并传播 → 暂停牧场资格、公开页发布 v2。
传播结果：在控成品冻结；已放行批次与已消费罐仅补发监管/消费者风险通知；纯另一牧场
支线被解释为“分流后污染”而不波及。

## 目录

- `contracts/record.json`：v0.1 基础记录契约（仍由 `register/find` 支持）。
- `contracts/ledger-scenario.json`：全链事实与场景事件契约、关键规则清单。
- `data/sample.json`：全链演示场景；`data/legacy-record.json`：v0.1 记录样例。
- `tests/`：领域、账本、服务（含崩溃恢复、可重复性、相邻批次解释）共 34 项测试。
