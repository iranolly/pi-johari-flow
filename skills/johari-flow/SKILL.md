---
name: johari-flow
description: Use when the user wants a task handled under the Johari-window delivery workflow — confirm intent via an HTML page, research with read-only sub agents, design options, cross-review, then orchestrate execution with a decision-page loop and a final HTML report. Triggers on "用乔哈里窗/工作流做", "/flow", "先确认意图", "出个确认页", "调研+评审+执行", or whenever a non-trivial coding task should be driven by flow_plan / flow_page / flow_ask instead of ad-hoc edits.
---

# Johari Flow · 编排者手册

这个 skill 是**怎么做**；`pi-johari-flow` 扩展是**什么时候不许做**。
扩展持有状态机（`flow_plan`）、页面渲染（`flow_page`）、阻塞提问（`flow_ask`）和硬门禁；
你负责在每一阶段做正确的事。两者合起来才是完整工作流。

**当前阶段永远以 `flow_plan {action:"status"}` 的输出为准**，不要凭记忆猜。

---

## 0. 铁律（违反任何一条，流程就是假的）

1. **意图未确认前，一行代码都不写。** `intent` 阶段写文件会被扩展直接 block。
2. **没有 HTML 页面，就没有确认。** 口头说「我理解你的需求了」不算，必须 `flow_page kind="intent"`。
3. **每个用户可见的最终回复都落在开放区。** 结论 + 依据 + 未验证/风险 + 需要用户决定的事，四段齐全即可；不要附「乔哈里自检」清单。
4. **决策属于用户，不属于你。** 范围变更、不可逆操作、方案前提崩塌、同一处连续两次修不好 —— 一律 `flow_ask`。
5. **批准前一律只读。** ② 调研 / ③ 设计 / ④ 评审 三个阶段里，`write`/`edit` 改项目文件、`sed -i`、`git apply`、`npm install`、`git commit` 都会被 `tool_call` hook 拦掉；唯一例外是 `<cwd>/.pi/` 下的页面与草稿（含 shell 重定向进去）。要动手就是 `execute` 阶段了。
6. **没有派活工具就降级。** 若本环境不提供 `Agent`/`subagent`/`task` 之类工具，不要假装派了活：自己分饰多个视角逐项查证，并在页面与回复里写明「降级自查」。
7. **收尾必须有报告页。** 没有 `flow_page kind="report"`，`advance to="done"` 会被拒；报告页只能在 `execute` / `report` 阶段出。

---

## 1. 阶段图与推进条件

```
idle → intent → research → design → review → approved → execute → report → done
         ↑          ↑         ↑                     ↑         │
         └──────────┴─────────┴─────────────────────┴─────────┘  (允许回退)
```

| 阶段 | 阶段目标 | 允许推进到 | 硬性条件 |
|---|---|---|---|
| `intent` | 让用户确认「你真的理解对了」 | research | `flow_page intent` 已出 + 用户明确确认 + `flow_plan {action:"confirm"}` |
| `research` | 把未知变成事实 | design | 每个待答问题都有证据或标为未知 |
| `design` | 给出 ≥2 个可选方案 | review | 每方案含影响面/成本/可回滚性 |
| `review` | 交叉评审打掉自欺 | approved | ≥2 个不同视角的 reviewer 结论 + 「必须改」已落地 + `flow_plan {action:"approve", reason:"<用户原话>"}` |
| `approved` | 已拍板，准备动手 | execute | `advance to="execute"`（主路径；发现新事实可退回 review/design） |
| `execute` | 监督执行 + 决策大循环 | report | 每步有验证证据 |
| `report` | 说清做了什么、没做什么 | done | 报告页已生成 |
| `done` | 结束 | idle | `advance to="idle"` 才能开新流程；也可直接 `flow_plan {action:"start"}` |

回退都不丢历史：`setGoal` 会回到 `intent` 并作废旧的意图确认；已批准后 `setGoal` 会被拒，须先 `advance to="design"`。

回退是正常的：发现新事实就 `advance` 回 `research` 或 `design`，别硬着头皮往前推。

---

## 2. 各阶段怎么做

### ① intent — 意图澄清

先 `flow_plan {action:"start", goal:"<用户原话逐字>"}`，然后**只做一件事**：出确认页。

`flow_page {kind:"intent"}` 的 sections 固定五块：

1. **我听到的**：用你自己的话复述，一段，不夹带方案。
2. **我假设的**：所有隐含前提（技术栈、环境、范围边界、验收标准）。这是盲目区，必须显式。
3. **我理解不在范围内的**：明确排除项，避免后面扯皮。
4. **风险与代价**：这事大概要动哪些地方、可能坏什么。
5. **待你确认**：3～5 条具体的是/否问题。

`johari` 面板四栏都要填。确认页只有**一个**决策（这理解对不对），所以用 `options` 给「确认无误 / 需要修正 / 我补充一下」，并包含一个「先别动」项。

页面生成后：把工具返回的 `[打开完整说明](路径)` **原样写进你这条回复**，一句话请用户点选，然后**立刻调用 `flow_wait`**。带 `options` / `questions` 的页面自带一条只活这道题的本机通道，用户点完答案直接回到对话，不用复制回执。
用户修正 → `flow_plan {action:"setGoal", goal:"<修正后的原话>"}`（回 intent 且需重新确认）重出页面，不要自己替用户拍板。
用户确认 → `flow_plan {action:"confirm", reason:"<用户原话>"}`，再 `advance to="research"`。

### ② research — 项目调研

并行派**只读** sub agent，一次派 2～4 个不同角度：

- `scout` / `explore`：这个功能在代码里长什么样？谁在调用？现有约定是什么？
- `net-research`：外部依赖/API/最佳实践是什么？（能查就别猜，这是缩小未知区）
- 需要跑命令验证的：明确要求它给出命令 + 输出摘录。

任务描述模板（照抄）：

```
只读调研，不要修改任何文件。
问题：<要回答的具体问题>
产出：结论 + 证据（file:line / URL / 命令输出）
边界：不要给方案，只给事实；查不到就写「未找到，因为…」
```

收回来后压成两栏：**事实（带证据）** / **未知（需要什么才能确定）**。
未知项要么补一轮调研，要么升级成 `design` 阶段的决策点。

### ③ design — 方案设计

至少 2 个方案，其中一个是「最小改动」、一个是「什么都不做（含代价）」。
每个方案必须写：影响面（文件清单）、成本（人时/复杂度）、可回滚性、失败的早期信号。

派 `plan` / `impl` sub agent 并行出草案，你负责**收敛与取舍**，不要直接采纳第一份。
成型后 `flow_page {kind:"decision"}`：选项 = 方案，`cost` 写代价行，`recommended` 标推荐项；随后把相对链接写进回复并 `flow_wait`。

### ④ review — 交叉评审

派 **≥2 个不同视角** 的 `reviewer`：正确性 / 安全与权限 / 可维护性 / 与现有约定冲突。
每个 reviewer 给出「必须改 / 建议改 / 已知取舍」三分类，禁止只写好评。
评审意见先自己消化一轮，把「必须改」合进方案，然后：

- 需要用户看懂取舍 → `flow_page {kind:"decision"}` 出评审结论页（多个独立决策点用 `questions`，每题一组候选）。
- 用户已拍板 / 无待决事项 → 直接 `flow_plan {action:"approve", reason:"<用户原话或选项 id>"}`。

`approve` **只在 ④ 交叉评审 阶段有效**，在 ③ 直接批准会被拒（这是故意的：没评审的批准等于没批准）。

### ⑤ approved → ⑥ execute — 监督执行

批准后 `advance to="execute"`，进入**抽象大循环**：

```
派活（impl sub agent，任务边界写死）
  → 验收（看 diff / 跑测试 / 读日志，不信任口头汇报）
  → 判断（需要问用户吗？）
      ├─ 需要 → flow_ask（附决策背景 + 选项代价）→ 按答案调整 → 回到派活
      └─ 不需要 → 下一步
  → 全部完成 → advance to="report"
```

**必须 `flow_ask` 的四种情况**（扩展会在 pre-approval 阶段 block 不可逆 bash，但批准后靠你自觉）：

1. 要突破已批准方案的边界（加依赖、改公共接口、动别人的模块）。
2. 发现原方案的前提不成立。
3. 出现不可逆操作（删数据、`git push --force`、改生产配置）。
4. 同一处连续两次修复失败 —— 说明理解错了，回去 `intent`/`research`。

`flow_ask` 与带选项的 `flow_page` 都是**两步**：

1. 工具写页面、开一条只活这道题的本机通道，立刻返回；选项里必须写代价（`cost`）。
2. 把它返回的 `[打开完整说明](路径)` 原样写进你这条回复，**然后立刻调用 `flow_wait`** 等用户点选。链接必须在你自己的回复里：放在回复里，pi-web 会在自己的面板（侧边）打开；放在工具结果里只会开一个新标签页。

用户点了（还可以在页面上顺手补一句理由），`flow_wait` 就带着答案返回，工具记下决定；没点（默认等十分钟）就把题原样还给用户，不要替他选。本机通道只活这一道题，页面过期后再点会提示「回对话里说」。`questions` 多题页面要点「提交答案」一起交，不能只选一题就交。

`flow_ask` 写法：`question` 是能回答的选择题；`context` 讲清「为什么现在必须决定 + 已经验证了什么」；
`options` ≥2 且每条带 `detail` 与 `cost`。它立刻返回，不阻塞；答案靠 `flow_wait` 收。

### ⑦ report — 完成报告

`flow_page {kind:"report"}` sections 固定六块（每块先写 `lead`，再上载体块，禁止代码与术语）：

1. **目标 vs 实际**：逐条对上原始意图 → `compare` 或 `facts`。
2. **改了什么**：用功能描述讲清动了哪几处 → `flow` 或 `facts`（不写文件名/函数名）。
3. **验证证据**：关键数字进 `stats`，验证方式用 `timeline` 讲「怎么试的、结果如何」。
4. **偏差**：和批准方案的差异，以及为什么 → `compare`。
5. **遗留风险与未做的事**：诚实清单 → `callout tone="warn"` + `items`。
6. **下一步建议**：一句话结论进 `lead`。

然后 `advance to="done"`。

---

## 3. 乔哈里窗的四象限怎么落到动作上

| 象限 | 含义 | 在工作流里的动作 |
|---|---|---|
| 开放区 | 双方都知道且都知道对方知道 | 结论 + 证据 + 影响面，一屏可读；每轮回复四段式 |
| 盲目区 | 你知道但没说 | **禁止**。任何隐含前提写成「我假设：…」；intent 页第 2 块 + review 的「必须改」 |
| 隐藏区 | 你知道但不想说 | **禁止**。未验证就写「未验证」；report 页第 5 块强制列遗留风险 |
| 未知区 | 双方都不知道 | `research` 阶段用联网/读码/跑命令主动缩小；缩不小就标「未知 + 需要什么才能确定」 |

**不需要写自检清单。** 早先版本要求每条回复末尾附「乔哈里自检」八项，现在已取消：扩展不再校验，也不再提醒。开放区的落地方式就是把结论、证据、未验证项和待你决定的事写清楚。

---

## 4. 页面怎么写（`flow_page` 参数要点）

### 4.1 先定纪律：写给「不看代码的人」

用户不看代码、没有代码基础。页面里**出现下列东西就是写坏了**：

| 禁止 | 换成 |
|---|---|
| 代码块、函数名、变量名、文件名含后缀、命令行 | 「一个负责判断下一步该派谁的环节」这类**功能描述** |
| `JSON`/`schema`/`hook`/`typebox`/`regression` 等英文术语 | 中文大白话；术语必须在同一句里用 6 个字解释 |
| 一段超过 3 行的纯文字 | 换载体（见 4.2），文字退成 `lead` 或块内 `note` |
| 形容词堆砌（「大幅提升」「显著改善」） | 具体数字进 `stats` / `bars` |

判断标准：**用户只看每节第一句 `lead`，能不能说出这节在讲什么。** 不能就是没写清。

### 4.2 载体块 `blocks`（能用图画就别写段落）

| `kind` | 长什么样 | 什么时候用 |
|---|---|---|
| `flow` | 横向步骤链，可标 `done`/`now`/`next` | 流程、阶段、操作先后（「现在走到哪一步」） |
| `timeline` | 竖向时间线，带圆点 | 事情按时间发生、修复过程、一轮轮迭代 |
| `stats` | 3～4 个大数字卡 | 关键指标（拦截次数、覆盖数、耗时） |
| `bars` | 条形占比，可上四象限配色 | 比例、得分、前后对比的量 |
| `compare` | 左右两栏 | 「以前怎样 / 现在怎样」「方案 A / 方案 B」 |
| `callout` | 带左竖线的重点框（`info`/`ok`/`warn`） | 这节只有一个结论，必须记住 |
| `loop` | 步骤药丸 + 回环箭头 | 会反复发生的循环（监督执行的抽象大循环） |
| `facts` | 键值小卡网格 | 清单类信息（在哪、什么时候、用了什么） |
| `tree` | 可折叠层级树（点▾收展） | **层级/包含**关系：项目结构、模块地图、目录、组织 | 
| `branch` | 缩进分支树，岔路口带条件胶囊 | **如果…就…的岔路**：业务流程判断、失败回退、条件分支 |
| `sequence` | 泳道时序图（参与者竖线 + 来往箭头，虚线=回复） | **多方按顺序来往**：谁先跟谁说、派活与回报 |
| `graph` | 圆形布局关系网（节点 + 带标签的连线） | **相互依赖/关联**：谁依赖谁、影响面、耦合 |
| `state` | 单行状态 + 箭头 + 上弧回跳 | **状态与跳转**：一台机器的几种状态、跳转条件 |
| `image` | 真图网格（多张自动排两列，点击放大） | **必须亲眼看的东西**：截图、前后对比、报错画面 |

> 证据只有两种：**截图**和**看得懂的数字**。`json` / `log` / `csv` 这类记录文件不要写成链接或路径 —— 页面会自动把它们降成普通文字，但更好的做法是根本不写。

写法要点：

- 每节顺序固定：`heading` → `lead`（一句大白话结论）→ `blocks`（1～2 块）→ `body`/`items`（只在没有载体时用）。
- **一页一结论**：每节的 `lead` 就是这节唯一的结论句；图自己会说的事不要再用文字说一遍 —— 块里的 `note`、`caption` **默认不写**，除非数字/图确实无法表达。写的字越少，读的人越快。
- 每页 5～7 节；超过 7 节就说明该拆页。
- `title` 写**具体判断**，不写「关于 X 的说明」。例：`把导出改成边读边写，内存峰值从 1.2G 降到 180M`。
- `summary` 一段话讲清「这页要你确认什么」。页面顶部自动生成目录（按节跳转）。
- `tone` 选 `facts` / `assumptions` / `unknowns` / `risks` / `deliverables` 会给标题竖条换色，别全用 `plain`。
- 五种结构图（`tree`/`branch`/`sequence`/`graph`/`state`）都用**扁平列表 + `parent` 指向**，不要写嵌套结构：`tree`/`branch` 用 `items[{id,parent?,label,note?,cond?}]`；`sequence` 用 `actors[]` + `messages[{from,to,text?,style?}]`（`style:"dashed"` 表示回复/异步，`from===to` 画自调用）；`graph` 用 `nodes[{id,label,kind?}]` + `edges[{from,to,label?}]`；`state` 用 `states[{id,label,kind?:"start"|"plain"|"end"}]` + `transitions[{from,to,label?}]`（相邻向右画直线，其他画上弧）。
- 正文、`items`、`lead` 里的本地路径（`comet-audit/timeline.html`、`notes/a.png`）会自动变成可点链接 —— 文件真的存在才变，不存在就保持等宽文字；`https://…` 网址也会自动可点。不用手写链接语法。
- 页面只有出场动画（淡入/条形生长/回环旋转），**没有步进播放**，所以别规划「点一下看下一步」的叙事；一屏内要能读完。
- 默认版式**确实放不下**时才传 `css`（整页自定义样式，追加在默认样式之后并可覆盖）；能用现有 14 种块解决就别写样式。
- 要放图就用 `image` 块：`images[{src,caption?,alt?}]`，`src` 写**本地文件路径**（相对项目根目录或绝对路径），页面会把图直接嵌进 HTML，所以页面离线也能看。远程 `http(s)` 图会被拒绝（会泄露「这页被人看过」）；先下载到本地再引用。单张 ≤6MB、整页 ≤24MB，超了会在图上位置显示一行黄色提示，不会静默变空白。一行纯文本 `![说明](路径)` 放在 `body` 里也会变成同样的图。

### 4.3 决策与选项

- `options[].id` 用短 id（`A`/`B`/`confirm`/`revise`）。选项行点击即复制回执，用户粘回 Pi 你就收到决策了。
- **只有一个决策时才用 `options`**；有 N 个互不绑定的决策点，就用 `questions`：每题 `{id, prompt, hint?, choices[]}`，页面渲染成 N 组独立单选 + 页尾回执（`Q1=A（…）；Q2=B（…）`）。把多个决策打包成一个选项列表是错的 —— 用户只能整包接受。
- 每个 choice 的 `detail` 写「选它具体意味着什么」；推荐项加 `recommended: true`。`cost` 只存在于 `options[]`（单决策用），`questions[].choices[]` 只有 `id`/`label`/`detail`/`recommended`，写 `cost` 会被忽略。

### 4.4 产物位置

页面落在 `<cwd>/.pi/flow/<session8>/NN-<kind>.html`（`NN` 取目录内最大序号 +1，不覆盖旧页），纯静态、无网络依赖、可直接打印。

每次生成页面都会在同目录写一份同名 `.json` 配置记录（`NN-<kind>.json`）：完整参数、阶段、工作目录、版本、生成时间、是否自动打开。要复盘或重生成就查它，不要从 HTML 反推。默认**不**打开浏览器，把地址贴给用户即可。

## 5. 常用命令

```
/flow                 查看当前阶段
/flow start <目标>    开始流程（等价 flow_plan action=start）
/flow approve         在 ④ 交叉评审 阶段手动批准
/flow report          出报告入口（只在 approved/execute/report 阶段有效）
/flow abort           终止流程
```
