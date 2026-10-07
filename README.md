# 奶粉批次全链责任账

面向进口奶粉的批次全链责任系统：记录奶农合作社成员、牧场资格、原奶批次、运输封签、加工投料、检验方法版本、成品拆并批、监管放行、出口证明与二维码快照；在设备冲突或检测更正时，自动演算并执行**可重复、可解释、可断点续传**的召回影响传播。

项目只依赖 Node.js 内置模块，无需外部服务。

## 领域规则（全部由服务层强制）

- **仅追加账本**：任何更正、换版、隔离解除都是新记录，已写入记录永不修改或删除。
- **合批冻结时点事实**：每次加工/合批都保存投入比例，以及各投入批次在当时有效的检测结论（含标准版本）；后续检测更正不改变历史快照。
- **设备上报按业务键去重**：`business_key` 相同且测值相同 → 幂等忽略；编号相同但测值不同 → 记为冲突上报并**自动隔离整条下游依赖链**。
- **检测更正**：`correction_of` 指向旧检测，旧结论保留，以旧结论所在批次为源触发传播。
- **职责分离**：提交检测的人、例外申请人都不得批准该例外；一个例外只能决定一次。
- **受控处置边界**：隔离源节点、冻结仍在控制范围的下游；已依法放行、已售、已消费的记录不冻结、不删除，只追加**风险通知**。
- **投料前置拦截**：牧场资格失效的原奶不入账；缺封签或到货封签破损不得投料；在冻批次不得再投料/放行/销售；当时结论不合格且无已批准例外不得投料。
- **公开页与证明留痕**：二维码快照只发新版本（`qr_reissue` 链），出口证明只做换发（`cert_reissue` 链）。

## 召回演算（`bfs-lineage-v1`）

1. 确定性广度优先遍历下游（邻接按节点编号排序，遍历顺序恒定）。
2. 拓扑序动态规划计算源批次对每个节点的**投入贡献比例**（菱形合流时多路径累加）。
3. 源节点 `isolated`；在控下游 `frozen`；失控节点 `noticed`；并点名需换发的二维码与出口证明。
4. **相邻未波及解释**：同一合批事件中不含触发源血缘的并列投入批次，列为 `neighbors_excluded` 并给出原因。
5. 计划经规范化 JSON 取 SHA-256 校验和；同账本状态、同源永远得到同一结果。
6. 运行创建时整份计划冻结进账本；每个节点处置后落检查点。服务崩溃后 `resumePropagations()` 跳过已完成节点继续，结果与冻结计划严格一致，不产生重复指令。

## 目录

- `src/domain.js` — 记录类型工厂与输入校验（记录全部冻结）。
- `src/repository.js` — 仅追加账本、业务键基础索引、JSONL 审计日志与重放恢复。
- `src/graph.js` — 血缘图构建（比例边、合批快照）与上游溯源。
- `src/recall.js` — 确定性召回演算、受控判定、校验和。
- `src/service.js` — 应用服务：登记规则、去重/冲突、职责分离、传播执行与续跑、罐码反查。
- `src/cli.js` — 本地命令入口。
- `contracts/record.json` — 记录类型与算法契约说明。
- `data/events.sample.jsonl` — 覆盖合批、拆批、放行、消费、设备冲突传播的完整事件样例。
- `tests/` — 基线测试 + 14 个全链规则场景（含崩溃恢复）。

## 运行

```bash
npm test          # 全部测试（17 个）
npm run build     # 所有源码语法检查
npm run check:sample   # 加载样例事件并完成一次反查与召回预览
```

### CLI

```bash
# 加载事件日志（每行 {"op":..., "payload":...}），落盘到可重放账本
node src/cli.js load data/events.sample.jsonl --db ledger.jsonl

# 从任意罐码反查：血缘路径与累乘比例、责任主体、标准版本、当前处置、邻居未波及原因
node src/cli.js trace CAN-0001 --db ledger.jsonl

# 预览某节点的召回传播计划（纯读，不落记录）
node src/cli.js recall raw-r1a --db ledger.jsonl

# 服务恢复：继续所有未完成传播
node src/cli.js resume --db ledger.jsonl

# 基线通用记录
node src/cli.js validate data/sample.json
node src/cli.js health
```

### 服务接口要点

```js
new Service(repository, { clock, onStep });   // onStep 可在每节点处置后注入中断（演练/故障注入）
service.reportTest(payload)                   // 去重 / 冲突隔离 / 更正传播
service.registerFeeding(payload)              // process | merge，自动冻结比例与当时结论
service.previewRecall({ source })             // 可复核的召回计划（含 checksum）
service.quarantineNode({ node_id, reason_code })
service.liftQuarantine({ order_id, ... })     // 追加解除，不删原指令
service.reissueExportCert({ old_cert_id, cert_id, run_id })
service.resumePropagations()                  // 断点续传
service.trace(canCode)                        // 一罐一账的公开/内审反查
service.getRun(runId)                         // 检查点、冻结计划与完成记录
```

### 场景结果（样例）

一号牧场原奶 `raw-r1a` 与二号牧场 `raw-r2a` 分别加工为基粉，按 60%/40% 合批后对半拆批装罐。设备随后以**相同业务键、不同测值**重报 `raw-r1a`：

- `raw-r1a` 隔离；`pow-base1 → pow-mix → lot-fin1/fin2 → canlot-fin2 → CAN-0002` 中仍在控的节点冻结；
- 已放行罐批 `canlot-fin1` 与已消费罐码 `CAN-0001` 只收风险通知，原记录保留，二维码发 v2、出口证明待换发；
- 二号牧场的 `raw-r2a`、独立罐 `CAN-0003` 不在链上；合批并列投入 `pow-base2` 被显式解释为未波及邻居；
- `CAN-0001` 对 `raw-r1a` 的累乘贡献比例为 1.0 × 0.6 × 0.5 = **0.3**。
