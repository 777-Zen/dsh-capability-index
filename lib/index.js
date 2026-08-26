/**
 * dsh-capability-index —— 插件薄壳（组装层）。
 *
 * 全部领域逻辑在 `lib/core.js`（零 dsh 导入），全部 dsh 触点在
 * `lib/dsh-adapter.js`；本文件只负责组合两者 + M2 语义引擎装配。
 *
 * 适配层目标：dsh 正式版 API 变化时只改 dsh-adapter.js + 跑回归。
 *
 * M2 配置（cordis.patch.yml 的 config 字段，全部可选）：
 *   embed:
 *     enabled: true            # false = 纯规则（v0.1 行为）
 *     model: 'Xenova/bge-small-zh-v1.5'
 *     dtype: 'q8'
 *     cacheDir: 'D:\\...'      # 默认 DSH_HOME/.cache/dsh-capability-index
 *     endpoint: 'https://hf-mirror.com'   # 模型权重下载端点
 *     threshold: 0.35          # 向量命中阈值（M3 校准）
 *   decisionLog:               # M3 数据基建：决策日志（每次注入记一行 JSONL）
 *     enabled: true            # false = 关闭
 *     dir: 'D:\\...'           # 默认 DSH_HOME/.cache/dsh-capability-index
 *                              # 文件 = <dir>/decisions.jsonl，纯本地无网络；
 *                              # 写入失败自动静默停用，绝不影响注入。
 * 语义引擎异步初始化（模型加载约 5s，权重缺失时经镜像下载一次）：
 * 就绪前与失败后自动降级纯规则，不阻塞插件加载、不影响注入。
 */

import { createAdapter } from './dsh-adapter.js'
import * as core from './core.js'
import { createSemanticEngine, defaultCacheDir } from './semantic.js'
import { createDecisionLogger } from './decision-log.js'

export const name = 'capability-index'
export const inject = ['systemPrompt', 'tools']

export function apply(ctx, config = {}) {
  // 可变引用容器：引擎异步就绪后写入，adapter 每次取值（null/失败 → 纯规则）
  const semanticRef = { current: null }
  const embedCfg = config?.embed
  if (embedCfg?.enabled !== false) {
    createSemanticEngine({
      model: embedCfg?.model,
      dtype: embedCfg?.dtype,
      specifier: embedCfg?.specifier,
      cacheDir: embedCfg?.cacheDir ?? defaultCacheDir(),
      // 默认镜像：HF 直连在多数网络超时（查证 A）；未显式配置时走 hf-mirror，
      // 首次启动下载 ~24MB 到缓存目录（一次性），之后离线可用
      endpoint: embedCfg?.endpoint ?? 'https://hf-mirror.com',
      threshold: embedCfg?.threshold,
    }).then(engine => {
      if (engine?.ok === true) semanticRef.current = engine
    }).catch(() => {
      // 初始化失败 → 保持纯规则
    })
  }
  // M3 数据基建：决策日志。默认开启（纯本地 JSONL，目录默认 DSH_HOME/.cache/
  // dsh-capability-index，D 盘纪律）；config.decisionLog.enabled === false 关闭。
  const dlCfg = config?.decisionLog ?? null
  const decisionLog = dlCfg !== null && dlCfg !== undefined && dlCfg.enabled === false
    ? null
    : createDecisionLogger({ dir: dlCfg?.dir ?? defaultCacheDir() })
  createAdapter(ctx, core, semanticRef, { decisionLog })
}
