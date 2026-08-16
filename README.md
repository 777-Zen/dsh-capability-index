# dsh-capability-index

让 agent 对插件库从"机会主义的直觉判断"变成"规律性的预先审视"——
**插件库利用率可预期**：有合适插件时就用上，规律、稳定，不靠运气。

任务量上来时，本插件在动手前给 agent 做一次"起飞前检查单"式的插件库预检，
把可能适用的插件提示出来；最终调不调，决策权仍在模型。

## 状态（Status）

**雏形 / early version**。dsh 目前处于 developer preview，正式发布时本插件
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

- 安装一次进插件库，**无需每次重新下载/安装**。
- 关闭/开启：在 profile 补丁层把行置 `disabled: true`（见 `cordis.patch.yml`
  注释）后重启；会话粒度开关走 dsh 的 preset 机制（本插件挂在哪个组合，
  就对哪个组合的会话生效）。
- 未启用时不加载任何代码（行被禁用 → 不进树 → 不 provide 任何服务）。

## 能力声明约定（capabilities）

插件作者随插件发布能力声明，本插件在命中时把它们**集中渲染进自己的提示块**
（不改写任何其他插件的工具定义）。声明通道：`ctx.provide('capabilityIndex.declarations', …)`
——**v0 单聚合器约定：每个组合只应有一个插件提供该服务**；多来源聚合属后续演进。

```js
// 示例（见样例插件 dsh-tool-demo-cap）
ctx.provide('capabilityIndex.declarations', {
  version: 1,
  declarations: [
    {
      tool: 'echo',
      keywords: ['回显', '原样返回', 'echo'],   // 消息命中 → 排序加分
      use_when: '用户要求文本原样返回',          // 集中渲染进提示块
      not_for: '任何加工、转换、格式化',
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

- `package.json` — 包清单 + `dsh.bundle.patch` 声明
- `cordis.patch.yml` — patch 层：insert `capability-index` 行（含关闭示例）
- `lib/index.js` — 插件本体：触发表判定 + 索引排序 + 提示渲染
- `lib/trigger-table.js` — 触发表 v0.1 词表数据（lang 标记，实测校准只改这里）

## 发布

公开 GitHub 仓库 + **`dsh-plugin` topic** 即可被官方生态发现
（官方立场：社区插件与官方包地位平等，无 marketplace/审批制）；
GitHub Discussions / Discord 社区用于反馈与曝光。

## 实验归因备忘（不属于 v0 构建）

三组消融：A 无工具列表 / B 有列表无提示 / C 有列表+提示；真值信 `tool/call`
日志不信总结；场景级人工标注（每场景标一次"该用哪些、绝不推哪些"）。
