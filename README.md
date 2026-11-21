# pi-johari-flow

把「乔哈里窗」变成一条可执行的交付流水线：**先确认理解，再研究事实，再给方案，再交叉评审，批准后监督执行，最后出报告**。
每一步都有硬门禁和 HTML 展示页，不靠 agent 自觉。

## 为什么需要它

普通 agent 的失败模式不是「不会写代码」，而是：

- 理解偏了却直接开写（**盲目区**）
- 知道有风险却不说（**隐藏区**）
- 可以查的东西靠猜（**未知区**）

这个包把三个泄漏口都堵上：意图必须用页面确认、方案必须交叉评审、每条结论必须带证据，
并且每一轮用户可见的回复末尾都要由模型自己写「乔哈里自检」八项 —— 扩展负责**校验**（缺项/只有标签/整段过短都会被点名，并按阶段限流提醒），不替你写。

## 安装

本地包（推荐先这样试）：

```bash
pi install C:/Users/19629/.pi/agent/packages/pi-johari-flow
```

或临时加载，不动 settings：

```bash
pi -e C:/Users/19629/.pi/agent/packages/pi-johari-flow/extensions/johari-flow/index.ts
```

装好后 `pi list` 应能看到 `pi-johari-flow`，并自动获得 `johari-flow` skill。

## 用法

```
/flow start 把 export 改成流式写入，内存峰值要降到 200M 以内
```

之后 agent 会：

1. 出 **意图确认页**（`.pi/flow/<session>/01-intent.html`），在浏览器打开，等你确认
2. 并行派只读 sub agent 调研，把未知压成事实
3. 出 **决策简报页**（`02-decision.html`），列出 ≥2 个方案及代价，你点选
4. 派 ≥2 个 reviewer 交叉评审
5. 批准后监督执行，遇到边界变更/不可逆操作就 `flow_ask` 回来问你
6. 出 **完成报告页**（`03-report.html`），含证据、偏差、遗留风险

随时 `/flow` 看当前阶段，`/flow abort` 终止。

## 组成

| 文件 | 作用 |
|---|---|
| `extensions/johari-flow/types.ts` | 阶段图、`EDGES`、`FlowState`、`isPreApproval` |
| `extensions/johari-flow/protocol.ts` | 注入 system prompt 的编排者协议 + 四象限纪律 |
| `extensions/johari-flow/johari.ts` | 「乔哈里自检」八维校验器（证据/用词/框架/假设/未知/隐藏/一致性/下一步） |
| `extensions/johari-flow/html.ts` | 三页共用的 HTML shell（自包含、离线、可点击回执） |
| `extensions/johari-flow/index.ts` | 工具 `flow_plan` / `flow_page` / `flow_ask`、命令 `/flow`、门禁与后处理 |
| `skills/johari-flow/SKILL.md` | 各阶段 playbook（怎么做才对） |

## 工具与命令

| 调用 | 作用 |
|---|---|
| `flow_plan {action:"start", goal:"<用户原话>"}` | 开启流程，进入意图澄清 |
| `flow_plan {action:"setGoal", goal:"<修正后的原话>"}` | 用户修正意图：改 goal 并退回 intent 重新确认 |
| `flow_plan {action:"confirm", reason:"<用户原话>"}` | 记录「用户确认了意图理解」 |
| `flow_plan {action:"approve", reason:"<用户原话或选项>"}` | 记录「用户批准了方案」（仅 ④ 交叉评审 阶段） |
| `flow_plan {action:"advance", to:"<阶段>"}` | 推进到下一阶段（非法跳转会被拒） |
| `flow_plan {action:"status"}` | 看当前阶段、产出物、已定决策 |
| `flow_page {kind, title, sections, options, questions, css, johari}` | 渲染并在浏览器打开 HTML 页（单决策用 `options`，多决策点用 `questions`，13 种载体块见下） |
| `flow_ask {question, context, options}` | 阻塞式向用户提问（终端选择 + 可附 HTML 简报） |
| `/flow [status]` | 终端查看当前阶段 |
| `/flow start <目标>` | 从终端开启流程 |
| `/flow approve <备注>` | 从终端批准方案（仅 review） |
| `/flow report` | 出报告入口（仅 approved/execute/report） |
| `/flow abort` | 终止流程 |

## 页面载体块（写给不看代码的人）

`flow_page` 的 `sections[]` 每节结构固定：`heading` → `lead`（一句大白话结论）→ `blocks`（1～2 块）→ `body`/`items`（仅在没有载体时用）。

| `blocks[].kind` | 长什么样 | 用在哪 |
|---|---|---|
| `flow` | 横向步骤链，可标 `done`/`now`/`next` | 流程、阶段、操作先后 |
| `timeline` | 竖向时间线 | 过程、一轮轮迭代 |
| `stats` | 3～4 张大数字卡 | 关键指标 |
| `bars` | 条形占比（可上四象限配色） | 比例、得分 |
| `compare` | 左右两栏 | 旧 vs 新、方案 A vs B |
| `callout` | 左竖线重点框（`info`/`ok`/`warn`） | 一节只有一个结论 |
| `loop` | 步骤药丸 + 回环 | 会反复发生的循环 |
| `facts` | 键值小卡网格 | 清单类信息 |
| `tree` | 可折叠层级树 | 层级/包含：项目结构、模块地图 |
| `branch` | 缩进分支树（岔路口带条件胶囊） | 如果…就…的岔路、失败回退 |
| `sequence` | 泳道时序图（虚线=回复） | 多方按顺序来往 |
| `graph` | 圆形关系网 + 带标签连线 | 谁依赖谁、影响面 |
| `state` | 状态 + 箭头 + 上弧回跳 | 状态机与跳转条件 |

结构图统一用扁平列表 + `parent`/`from`/`to` 指向（不做递归 schema）：`tree`/`branch` → `items[]`；`sequence` → `actors[]` + `messages[]`；`graph` → `nodes[]` + `edges[]`；`state` → `states[]` + `transitions[]`。页面仅出场动画（无步进播放）；`css` 参数可整页覆盖样式，只在默认版式放不下时用。

硬规矩（写进了 `promptGuidelines` 与系统提示的乔哈里纪律第 5 条）：页面**不出现代码、文件名、英文标识符与术语**；术语必须当场用一句话解释；每节先给 `lead`；每页 5～7 节。

## 门禁（不是建议，是 block）

- `intent` 阶段：`write` / `edit` / 写文件的 shell（`>`、tee、Set-Content、cp/mv/sed -i…）、派 sub agent，全部被拒。
- 方案未批准（`intent`/`research`/`design`/`review`）：破坏性命令被拒
  （`rm -rf`、`find -delete`、`git push -f`、`git reset --hard`、`git clean -f`、`dd`、`drop table`、`Remove-Item -Recurse` 等）；只读命令（`rg`/`grep`/`cat`/`git log`…）即使用参数里带着这些字串也放行。
- 非法阶段跳转被拒；`advance to="research"` 需先 `confirm`，`to="execute"` 需先 `approve`（approve 本身只允许在 review 阶段），`to="done"` 需报告页已存在。

## 状态

流程状态存在 session 的自定义条目里（`customType: "johari-flow"`），**不进模型上下文**，
重启/回滚分支后从 branch 重建。页面文件在项目内 `.pi/flow/` 下，可随时删。

## 设计取舍

- **不自己实现 sub agent 派发**：直接用内置 `Agent` 工具，扩展只做规则与门禁 —— 比 spawn `pi` 子进程稳。
- **协议走 `systemPromptOptions.sections`** 而不是整体替换 system prompt —— 保持 prompt cache 命中。
- **自检区块由模型写、扩展只校验**：不改写已定格的 assistant 消息，只记 `johari-selfcheck` 条目 + 提醒（每阶段最多 2 次），避免把模型没说过的话塞进 transcript。
