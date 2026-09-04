# dsh-capability-index

  > **⚠️ Archived / 已归档** — 本项目不再维护。最后版本：v0.2.0（2026-08-27）。
![Archived](https://img.shields.io/badge/status-archived-lightgrey)
  ---

  ## 这是什么

  dsh-capability-index 是一个为 DeepSeek Harness (DSH) 开发的**元插件（meta-plugin）**，目标是提高 AI agent 对已有插件库
  的利用率。

  核心思路：在 agent 处理任务前，自动扫描已启用的插件库，将"可能适用的插件"以提示块的形式注入上下文，让 agent 从"凭直觉
  选工具"变成"系统性地预审插件库"。

  ### 核心设计

  - **三层触发判定**：规则词表（硬层）→ 语义向量召回（语义层）→ `not_for` 守门闸（负向过滤）
  - **零侵入**：通过 DSH 原生 runtime-context 通道注入，不改写其他插件的工具定义
  - **模型自主决策**：只提示、不强制调用，最终决策权仍在模型

  ## 为什么停止维护

  1. DSH 正式版持续延期，生态用户基数过小，无法获得真实使用反馈
  2. 16 条样本的评估不足以证明核心价值，缺乏用户数据就无法验证效果
  3. 官方大概率会自行实现同类功能，第三方插件的护城河接近于零

  继续投入的 ROI 不合理，遂于 v0.2.0 及时止损归档。

  ## 项目结构（v0.2.0）

  ```
  lib/                 # 核心代码（~1100 行 JS）
    core.js            三层判定主逻辑
    embed.js           进程内语义召回（bge-small-zh-v1.5）
    semantic.js        语义合议决策
    adapter.js         DSH 运行时适配
    trigger-table.js   规则词表与配置
    declarations.js    能力声明解析

  eval-results/        # 评估框架
    samples.json       16 条评估样本
    verify.mjs         回归验证脚本
    simulate.mjs       判定模拟器
    calibrate.mjs      阈值校准工具

  docs/                # 设计文档
    capability-contract.md  能力声明契约 v1.1
  ```

  ## 许可证

  MIT

  ---

  *如有兴趣了解技术细节或设计思路，可查看仓库内的文档与代码注释。*

  ———

 
