/**
 * dsh-capability-index —— 语义引擎（v0.2 M2：向量层）。
 *
 * 职责：embedder 生命周期 + 工具描述向量缓存，向 adapter 暴露纯数据接口：
 *   ready / dims / encodeTask(text) / toolVectors(schemas, enrich) / threshold
 *
 * 设计：
 *  - embedder 创建失败（transformers 未安装等）→ { ok:false, reason }，
 *    adapter 走纯规则路径，插件主链路不炸（降级不报错）。
 *  - 工具向量缓存按 schemas 名称序列做 key，命中即复用（首次 embed N 条描述）。
 *  - 缓存目录默认 DSH_HOME/.cache/dsh-capability-index（绝不写 C 盘临时区），
 *    可由配置覆盖。
 */
import { createEmbedder, embedToolVectors, embedNotForVectors } from './embed.js'

/**
 * 创建语义引擎（异步：内部加载模型，首次约 5–6s，之后常驻）。
 * @param {object} options
 *   - model / dtype / specifier / endpoint: 透传 createEmbedder
 *   - cacheDir: 权重缓存目录（默认 DSH_HOME/.cache/dsh-capability-index）
 *   - threshold: 向量命中阈值（默认 trigger-table 的 embed.threshold）
 * @returns {Promise<object>} { ok:true, dims, encodeTask, toolVectors, threshold }
 *                           或 { ok:false, reason }
 */
export async function createSemanticEngine(options = {}) {
  const cacheDir = typeof options.cacheDir === 'string' && options.cacheDir !== ''
    ? options.cacheDir
    : defaultCacheDir()
  const threshold = typeof options.threshold === 'number'
    ? options.threshold
    : undefined // undefined → core 用 trigger-table 默认

  const embedder = await createEmbedder({ ...options, cacheDir })
  if (embedder.ok !== true) return { ok: false, reason: embedder.reason }

  let toolCache = { key: '', vecs: new Map() }
  // not_for 向量缓存（守门闸嵌入信号）：key = 声明 not_for 文本指纹，
  // 声明更换（文本变化）自动重建
  let notForCache = { key: '', vecs: new Map() }

  return {
    ok: true,
    dims: embedder.dims,
    model: embedder.model,
    threshold,
    /** 任务文本 → 归一化向量（Float32Array）。 */
    async encodeTask(text) {
      return embedder.encode(text)
    },
    /**
     * 工具描述向量缓存（key = name 序列；变化才重建）。
     * @returns {Promise<Map<string, Float32Array>>}
     */
    async toolVectors(schemas, enrich = new Map()) {
      const key = Array.isArray(schemas)
        ? schemas.map(s => (typeof s?.name === 'string' ? s.name : '')).join(',')
        : ''
      if (toolCache.key === key && toolCache.vecs.size > 0) return toolCache.vecs
      const vecs = await embedToolVectors(embedder.encode, schemas, enrich)
      toolCache = { key, vecs }
      return vecs
    },
    /**
     * not_for 向量缓存（守门闸用；key = 工具名+not_for 文本序列）。
     * @returns {Promise<Map<string, Float32Array>>}
     */
    async notForVectors(enrich = new Map()) {
      const parts = []
      for (const [tool, decl] of enrich) {
        if (typeof decl?.not_for === 'string' && decl.not_for !== '') {
          parts.push(`${tool}:${decl.not_for}`)
        }
      }
      const key = parts.join('|')
      if (notForCache.key === key && notForCache.vecs.size > 0) return notForCache.vecs
      const vecs = await embedNotForVectors(embedder.encode, enrich)
      notForCache = { key, vecs }
      return vecs
    },
  }
}

/** 默认权重缓存目录：DSH_HOME/.cache/dsh-capability-index（D 盘优先，绝不 C 盘临时区）。 */
export function defaultCacheDir() {
  const home = typeof process !== 'undefined' ? process.env?.DSH_HOME : undefined
  const base = typeof home === 'string' && home !== '' ? home : typeof process !== 'undefined' ? process.cwd() : '.'
  return `${base.replace(/[\\/]+$/, '')}\\.cache\\dsh-capability-index`
}
