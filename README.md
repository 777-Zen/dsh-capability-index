# dsh-capability-index

dsh-capability-index 是 DeepSeek Harness (dsh) 的元插件：让 agent 对自身插件库的处理，
从"机会主义的直觉判断"变成"规律性的预先审视"。任务量上来时，它在动手前给 agent
做一次插件库预检——任务型请求命中触发规则后，自动注入"可能适用的 Top-K 插件"
提示块，并带上插件作者声明的 `use_when` / `not_for` 能力说明；模型最终调不调，
决策权仍在模型。插件只读、只提示：不改写任何其他插件的工具定义，不强制调用，
不替代工具对比类插件。

**三行要点**：

- 三级合议：语义向量召回（主信号）→ 规则词表守门过滤 → 灰色地带注入冲突提示，模型终判
- 零侵入：通过 dsh 原生 runtime-context 通道注入，提示只在内容变化时替换、不逐轮堆积
- 状态：v0.2——语义召回 + not_for 守门闸 + 决策日志落地；中文词表起步、持续校准；兼容 dsh developer preview 版本

## 设计初衷（作者原话）

> 以下话语出自本插件作者的原始设计想法，尽量保留原样：
>
> - "让 agent 对自身插件库的处理，从'机会主义的直觉判断'变成'规律性的预先审视'：
>   任务量上来时，动手前先系统性过一遍已知插件库，而不是做到哪算哪、凭感觉决定要不要用工具。"
> - "现象：agent 明明有可用的插件/工具，却常常闭门造车（自己手搓），或机会主义地漏用，
>   直到任务中/任务后才发现'其实有个插件能用'。"
> - "类比：给 agent 加一道'起飞前检查单'——先看清自己带了什么装备，再起飞。"
> - "真正的价值：插件库利用率可预期——有合适插件时就用上，规律、稳定，不靠运气。"
> - "规则宁缺毋滥，避免正常交流也被跑一遍（倒反天罡）。"
> - "用户希望拿来就能用：插件一开，自己扫完插件库，对话过程中就自己识别、按触发规则来走。"
> - "只扫已启用的插件库；没被启用的就不管，那是用户的隐私。"

## 状态（Status）

**v0.2 / early version**。相对 v0.1 新增：进程内语义召回（bge-small-zh-v1.5，
~24MB 本地权重）、三级合议决策、not_for 守门闸（声明契约 v1.1）、决策日志与规模优化。
隐私口径：索引只覆盖当前会话模型可见工具；决策日志（`decisions.jsonl`）与向量权重
缓存均存本地（`DSH_HOME/.cache/dsh-capability-index/`），无任何数据上传（权重仅首次
经 hf-mirror 下载一次）。dsh 目前处于 developer preview，正式发布时本插件
的注入通道（`systemPrompt.context` 快照）、声明约定（`capabilityIndex.declarations`）
与触发表词表都可能有兼容性变化；升级 dsh 后如提示块消失或异常，先检查
README 与本仓库的发布说明。实验证据与方法见 `eval-results/`（活样本库 +
评分脚本 + 离线模拟器）。

## 实验证据（2026-08-16，B/C 对照）

同 profile、同会话入口、同消息原文，仅切换本插件开关（部署级 `disabled: true`
补丁，热更新免重启）对比真实行为；真值信 `tool/call` 日志与 runtime-context
快照，不信模型总结。样本库 10 条（S1–S10，见 `eval-results/samples.json`），
评分脚本 `eval-results/eval-metrics.mjs`。

| 指标 | B 组（无提示，14 条） | C 组（有提示，7 条） |
|---|---|---|
| 工具调用率（正例） | **50%** | **100%** |
| 误触发（漏推/错推） | 0 / 0 | 0 / 0 |
| 上下文增量 | 0 字符/条 | 约 180–200 字符/条（预算 ≤260） |

**执行主体（如实说明）**：以上实验的执行、记录与统计由**模型在会话中自主完成**
（探针、模拟器与评分脚本均由模型编写运行），**无人为干预、无筛选**；真值由场景级
人工标注一次确定。样本规模小（B 14 条 / C 7 条，每场景 2~3 次），结论是方向性的，
不构成统计显著性验证。

**结论**：对显而易见的内置工具（read/echo 等），有无提示行为一致；对
**不显而易见的插件工具（concat_text/format_text 等），提示块把调用率从
0% 提升到 100%**（无提示时模型全程心算、完全没发现这些工具），且零误触发
（提示不会造成强制误用——样本 S9 中模型正确拒绝了不适用工具）。

**v0 边界（实测）**：提示面向**主会话**注入；子代理会话不接收提示块
（依赖 `agent/inbox/claimed` 消息路径，子会话不触发）。

## 工作方式（三层机制）

| 层 | 触发 | 行为 |
|---|---|---|
| 硬层 | 触发表 v0.1 命中（任务型请求） | 注入 Top-K（默认 3）提示块：可能适用的工具 + 能力声明（use_when/not_for） |
| 软层 | 未命中 / 模糊宏大 / 闲聊 | 注入轻量"插件库总览"兜底（当前可用工具清单） |

- 触发表 v0.1（词表见 `lib/trigger-table.js`，**中文起步**，词条带 `lang` 标记）：
  - A 显式要求（"看看我有哪些插件"）→ T1
  - B 任务型动词 且（C 具体载体｜D 多子要求｜F 具体对象）→ T2
  - B 但无 C/D/F（"我想做个大项目"）→ T3，软层兜底
  - 无 B（闲聊/澄清）→ 不触发，软层兜底
- 注入通道：`systemPrompt.context()` 函数式提供者 → 提示落进 **runtime-context 快照**，
  **只在内容变化时替换、不逐轮堆积**（快照 commit-on-change 语义）。
- **not_for 守门闸**（声明契约 v1.1）：声明的 `not_for` 不只是提示文案——推荐落定前
  对携带声明的候选做双信号核对（关键词词集求交 + 嵌入相似度），确定性冲突硬拦移除，
  模糊地带窗口内降位 + "⚠️ 可能不适用"警示行；模型终判权不变，无声明工具不受影响。
- 索引口径：`tools.schemas(agent)` —— 当前会话模型可见工具集的精确口径，
  隐私边界自动成立（不可见工具不进索引）。

## v0 边界（明确不做什么）

- **只读 + 建议性质**：不改写任何其他插件注册的工具定义/description、不碰注册表。
- **不强制调用**：只提示/引导，最终决策权在模型。
- 不自动下载/安装缺失插件；不替代 dsh-tool-search（本插件管"有什么、用不用"，
  它管"哪个好"的二次比较）。

## 安装与开关

```powershell
# 安装一次（在 DSH checkout 根目录跑；<path> 换成本目录绝对路径）
pnpm dsh plugin --profile <name> add <path>\dsh-capability-index

# 确认进了插件树
pnpm dsh --profile <name> --dump-config | Select-String capability-index

# 重启 web 应用后生效；设置 → Plugins 页可见本插件条目
```

- 安装一次进插件库，**无需每次重新下载/安装**；用户想在哪个会话里开，自己去启用就是，
  不用一个会话一个会话来。
- 关闭/开启：在 profile 补丁层把行置 `disabled: true`（见 `cordis.patch.yml`
  注释）后重启；会话粒度开关走 dsh 的 preset 机制（本插件挂在哪个组合，
  就对哪个组合的会话生效）。
- 未启用时不加载任何代码（行被禁用 → 不进树 → 不 provide 任何服务）。

## 架构（v0.2 M1+M2：抗冲击地基 + 语义召回层）

**适配层 + 纯逻辑层拆分**（M1，2026-08-25 落地）：

- `lib/core.js` —— 纯逻辑层：判定 / 排序 / 渲染 / 声明解析 / 工具视图投影 /
  **三级合议**（fuseLayers / semanticVerdict / renderAdvisory / buildHintSemantic），
  **零 dsh 导入**（唯一依赖是同目录数据文件 trigger-table.js），可在纯 Node 单测。
- `lib/dsh-adapter.js` —— **唯一 dsh 触点**：事件监听、注入通道、工具口径、
  声明服务、会话投影与每 agent 状态容器；对 core 只传纯数据。
- `lib/embed.js` / `lib/semantic.js` —— 向量层（M2）：embedding 运行时封装
  （动态 import，缺失自动降级）+ 语义引擎（工具描述向量缓存、默认 D 盘缓存目录）。
- `lib/index.js` —— 薄壳：`apply(ctx) → createAdapter(ctx, core, semanticRef)`。

目标：dsh 正式版 API 变化时**只改 dsh-adapter.js + 跑回归**。

**三级合议（M2，差异化核心）**：

| 层 | 职责 | 判定 |
|---|---|---|
| 向量层（新） | 进程内 embedding（bge-small-zh-v1.5 q8，~24MB），任务文本 vs 工具描述语义相似度 | 主召回信号，过阈值（默认 0.58）即"像有工具" |
| 规则层（守门） | 触发表 v0.1 + use_when/not_for/min_complexity 过滤 | 保留为守门，词表继续补 |
| 带内第三层（新） | 灰色地带（两层候选冲突）注入丰富提示，模型终判；兼作元认知刺激 | 零额外延迟/token |

合议结果：both（硬推并集）/ semantic-only（偏硬推+置信度标注）/ rule-only（v0.1 行为）/
conflict（带内第三层）/ none（软层总览，闲聊安全）。向量层**异步预取**：
`agent/inbox/claimed` 捕获消息后立即 embed，就绪前自动降级纯规则（不卡注入、不堆积）。

**回归 harness**（`npm run verify`，即 `node ../eval-results/verify.mjs`）：

- 断言：样本判定/落点/反例（S1–S16）+ 契约解析兼容 + PTC 过滤 + plan 只读 +
  三级合议决策矩阵 + 语义引擎纯函数（mock 向量，不加载模型）+
  **排序索引等价 + 总览分组 + adapter 冒烟**（fake ctx 驱动视图缓存/失效/清理）+
  **not_for 守门闸 M 组**（双信号两档 / 两段式语义 / decision-log gate 字段）。
- 零依赖（node:assert），退出码非零 = 失败，发布前必须跑。
  当前 **80 过 / 0 挂 / 2 known-fail**（S14+S16，元交流误触族，M3 校准点 #2 挂账，
  显式报告不判败；S9 已随 not_for 守门闸生产验证通过而摘标转正）。
  仓库克隆内直接 `npm run verify` / `npm run simulate`（eval-results 随仓库分发；
  工作区开发环境用绝对路径跑）。

**契约版本化**：能力声明对象建议携带 `version: '1.0'`；解析器兼容
v0 的 `{ version: 2, declarations }`、无 version 的 `{ declarations }` 与裸数组。
解析器来源无关——静态声明槽（package.json 扩展字段）将来接入不碰 core。

## M2 配置（cordis.patch.yml 的 config.embed，全部可选）

```yaml
config:
  embed:
    enabled: true                  # false = 纯规则（v0.1 行为）
    model: 'Xenova/bge-small-zh-v1.5'
    dtype: 'q8'                    # 权重约 24MB
    cacheDir: 'D:\\...'            # 权重缓存（默认 DSH_HOME/.cache/dsh-capability-index，不写 C 盘）
    endpoint: 'https://hf-mirror.com'  # 权重下载端点（HF 直连超时环境用镜像）
    threshold: 0.58                # 向量命中阈值（2026-08-25 用户拍板定案）
  notForGate:                      # not_for 守门闸（声明契约 v1.1；默认即开）
    enabled: true                  # false = 整体旁路（not_for 退回纯展示文案）
    hardSim: 0.62                  # 硬拦：关键词命中 ∧ 嵌入≥此值 → 候选移除
    softSim: 0.50                  # 软警示下限：恰一信号命中或嵌入落 [soft,hard) → 降位+警示行
    demoteFactor: 0.5              # 软处理分数折减（窗口内降位，不动成员资格）
  decisionLog:                     # 决策日志（默认开；纯本地 JSONL）
    enabled: true                  # false = 完全关闭落盘
```

- 语义引擎异步初始化（模型加载约 5s，权重缺失时经镜像下载一次）；
  就绪前/失败/未启用 → 自动纯规则，不阻塞插件加载、不影响注入。
- 依赖 `@huggingface/transformers` 由部署环境提供（profile 依赖树或插件携带）；
  缺失时 `createEmbedder` 返回降级标记，主链路不炸。

## 能力声明约定（capabilities）

插件作者随插件发布能力声明，本插件在命中时把它们**集中渲染进自己的提示块**
（不改写任何其他插件的工具定义）。声明通道：`ctx.provide('capabilityIndex.declarations', …)`
——**v0 单聚合器约定：每个组合只应有一个插件提供该服务**；多来源聚合属后续演进。

```js
// 示例（见样例插件 dsh-tool-demo-cap）
ctx.provide('capabilityIndex.declarations', {
  version: '1.0',           // 契约版本（解析器兼容 v0 数字版本/无 version）
  declarations: [
    {
      tool: 'echo',
      keywords: ['回显', '原样返回', 'echo'],   // 消息命中 → 排序加分
      use_when: '用户要求文本原样返回',          // 集中渲染进提示块
      not_for: '任何加工、转换、格式化',          // v1.1 起参与守门闸执行核对
      not_for_keywords: ['转换'],                // 可选显式补词（缺省自动分词）
      min_complexity: 'low',                    // 低于该任务量级不推
      lang: 'zh',
    },
  ],
})
```

- 无能力声明的存量插件照常进索引：工具 description 全文作为**低置信条目**
  参与关键词匹配（权重低于有声明条目），提示块中标注"未提供能力声明"。
- 静态声明槽（package.json 扩展字段 / cordis_define 载荷扩展）属演进项，
  需要改 harness 源码，v0 不做。

## 文件

- `package.json` — 包清单 + `dsh.bundle.patch` 声明 + `scripts.verify` / `scripts.simulate`
- `cordis.patch.yml` — patch 层：insert `capability-index` 行（含关闭/embed 配置示例）
- `lib/index.js` — 薄壳：组装 adapter + 语义引擎（异步初始化，失败降级）
- `lib/dsh-adapter.js` — 唯一 dsh 触点（事件 / context / schemas / 声明 / 会话投影 / 状态 /
  向量预取 / **工具视图与声明缓存**，`tools/change`·`agent/disposed` 生命周期失效）
- `lib/core.js` — 纯逻辑层：判定 + 排序（含索引预构建）+ 渲染 + 契约解析 + 工具视图投影 + 三级合议（零 dsh 导入）
- `lib/embed.js` — embedding 运行时封装（动态 import，缺失降级；工具向量缓存与语义 Top-K）
- `lib/semantic.js` — 语义引擎（模型生命周期 + 工具向量缓存 + 默认 D 盘缓存目录）
- `lib/trigger-table.js` — 触发表 v0.1 词表 + plan 只读名单 + embed 阈值 +
  总览分组配置 + **notForGate 守门闸阈值**（实测校准只改这里）
- `lib/decision-log.js` — 决策日志：每次注入异步追加一行 JSONL 到
  `<DSH_HOME>/.cache/dsh-capability-index/decisions.jsonl`（纯本地，可关），
  记录判定 / 合议结果 / 推送名单 / 守门警示——校准数据的主要来源
- `docs/capability-contract.md` — 能力声明契约 v1.1（not_for 执行语义 + not_for_keywords）

## 发布

公开 GitHub 仓库 + **`dsh-plugin` topic** 即可被官方生态发现
（官方立场：社区插件与官方包地位平等，无 marketplace/审批制）；
GitHub Discussions / Discord 社区用于反馈与曝光。

## 实验归因备忘（不属于 v0 构建）

三组消融：A 无工具列表 / B 有列表无提示 / C 有列表+提示；真值信 `tool/call`
日志不信总结；场景级人工标注（每场景标一次"该用哪些、绝不推哪些"）。

## 已知问题与潜在限制

**PTC / Code Mode 呈现适配（M1 已实现，待真实 PTC 会话实测）**：

- PTC 模式（内置 code 预设）下模型只直接调用 `run_code`，其余工具经生成的
  TypeScript SDK 间接调用；M1 在 core 层落地：
  1. `run_code` 传输工具从索引与推荐中过滤（`core.normalizeSchemas`，
     常量 `RUN_CODE_TRANSPORT`，对应 `tools/src/code-mode.ts:20` 的 `RUN_CODE_NAME`）；
  2. "当前可用工具 N 个"按模式区分文案：code 会话标注"SDK 内可调 N 个"
     （`core.renderOverview` 的 mode 参数）；
  3. 模式探测：`tools.schemas(agent)` 中出现 `run_code` 即 code 模式
     （adapter 探测后传入 core）；
  4. plan 阶段只推只读工具（只读名单在 `trigger-table.js` 的 `plan.readonlyTools`，
     信号来自 plan-mode 注册的 `plan` session projection，adapter 尽力而为探测，
     拿不到信号则不限制）。
  - 以上逻辑均有离线单测覆盖（verify B/D/E/F 组），并已通过真实 PTC 会话烟测
    （闲聊 `mode:"code"`、pushed 零 `run_code`、plan 模式只读推送，三项全绿，2026-08-25）。

**插件规模（第一批已落地，2026-08-25 规模优化轮）**：

- ✅ **工具视图缓存**：`ctx.tools.schemas(agent)` 每次深克隆全部参数 schema
  （`tools/src/index.ts:1234-1236`）——adapter 按 agent 缓存 normalize 视图与排序索引，
  `tools/change`（emit、无载荷）或声明载荷身份变化时失效；稳态热路径零克隆。
- ✅ **排序索引预构建**：`core.buildIndex` + `rankTopIndexed` 单一打分实现，
  字符串拼接/小写化/声明查找一次性完成；`rankTop` 同实现体，行为逐字节一致（verify I 组）。
- ✅ **软层总览分组摘要**：工具数超过 `overview.groupedThreshold`（默认 24）时
  从全量平铺改为分类聚合（`overview.groups` 纯数据，未列出工具进"其他"），
  260 字符预算的截断先打在尾部而不是任意腰斩清单。schema 不暴露工具→插件归属，
  分类聚合是无 harness 改动前提下的最优近似。
- ✅ **agent/disposed 清理**：per-agent 状态与视图缓存随 agent 销毁释放，
  防会话树增长下的 Map 泄漏；视图缓存另有 64 条防御性上限。
- ⏳ 倒排候选过滤（token 子串噪声随工具数放大）：当前子串语义下倒排要么有损
  要么内存重，36 工具量级收益不抵复杂度；留到工具数 >500 再评估。
- ⏳ 子代理注入成本：实测子代理会话不接收提示块（claimed 不触发 → 早退零开销），
  当前无成本问题；跨会话提示属设计决策不在本轮范围。

**其它**：多声明来源聚合（v0 单聚合器约定）；Q2 多轮遗忘后的重扫策略
（快照替换已防堆积，重扫阈值待实测）。

## 维护与迭代

- **词表与模糊边界是启发式，需要持续维护**：T1/T2/T3 边界定义、关键词词表、排序权重
  随使用持续校准；样本库（含误判/漏判样本）是校准的主要数据源，欢迎持续扩充；
- **语言**：中文起步，词条带 `lang` 标记；英文覆盖后补为纯数据追加，不改判定代码；
- **数值**：Top-K、描述截断、总览预算、min_complexity 全部集中在 `lib/trigger-table.js`，
  实测校准只改数据文件；
- **贡献**：欢迎提交能力声明、词表扩充、样本与反馈；dsh 尚处 developer preview，
  正式版可能有兼容变化。

欢迎大家在 GitHub Discussions 里面交流和反馈以及互动。
