/**
 * dsh-capability-index —— embedding 层（v0.2 M2：语义召回主信号）。
 *
 * 设计约束：
 *  - **不静态 import** `@huggingface/transformers`：该依赖由部署环境提供
 *    （profile 依赖树 / 插件携带），运行时动态 import，缺失时降级为
 *    `{ ok: false, reason: 'transformers-not-installed' }`，插件主链路不炸。
 *  - core.js 不依赖本文件（向量层接口由 adapter 注入）；verify 用 mock 向量
 *    回归合议逻辑（见 verify.mjs G 组）。
 *  - 全部 I/O 纯数据：encode 返回 Float32Array（拷贝，不持库对象）。
 *
 * 选型（查证 A，2026-08-25）：Xenova/bge-small-zh-v1.5（q8，~24MB，512 维，
 * 中文语义梯度正确；≤30MB 预算）。依赖走 npmmirror、权重走 hf-mirror，
 * 缓存目录默认 D 盘（cacheDir 可配置，绝不写用户 C 盘临时区）。
 */

/**
 * 创建 embedder。选项：
 *   model: string           模型 id（默认 Xenova/bge-small-zh-v1.5）
 *   dtype: string           量化（默认 'q8'）
 *   cacheDir: string        权重缓存目录（默认 undefined → 库默认；生产环境由配置注入）
 *   endpoint: string        模型下载端点（如 'https://hf-mirror.com'）
 *   specifier: string       动态 import 的包名（默认 '@huggingface/transformers'）
 * 返回 { ok: true, encode, similarity, dims, model } 或 { ok: false, reason }
 */
export async function createEmbedder(options = {}) {
  const model = typeof options.model === 'string' && options.model !== ''
    ? options.model
    : 'Xenova/bge-small-zh-v1.5'
  const dtype = typeof options.dtype === 'string' && options.dtype !== ''
    ? options.dtype
    : 'q8'
  const specifier = typeof options.specifier === 'string' && options.specifier !== ''
    ? options.specifier
    : '@huggingface/transformers'
  const cacheDir = typeof options.cacheDir === 'string' ? options.cacheDir : undefined
  const endpoint = typeof options.endpoint === 'string' ? options.endpoint : undefined

  let tf
  try {
    tf = await import(specifier)
  } catch {
    return { ok: false, reason: 'transformers-not-installed' }
  }
  try {
    if (endpoint !== undefined && tf?.env !== undefined) tf.env.remoteHost = endpoint
    if (cacheDir !== undefined && tf?.env !== undefined) tf.env.cacheDir = cacheDir
    const extractor = await tf.pipeline('feature-extraction', model, {
      dtype,
      ...(cacheDir !== undefined ? { cache_dir: cacheDir } : {}),
    })

    /** 单条文本 → 归一化均值池化向量（Float32Array 拷贝）。 */
    const encode = async text => {
      const out = await extractor(text, { pooling: 'mean', normalize: true })
      const data = out?.data
      if (data === null || data === undefined) throw new Error('embed: empty output')
      return Float32Array.from(data)
    }

    /** 余弦相似度（输入须已归一化 → 点积）。 */
    const similarity = (a, b) => {
      const n = Math.min(a.length, b.length)
      let s = 0
      for (let i = 0; i < n; i++) s += a[i] * b[i]
      return s
    }

    // dims：从任意一次输出取（懒加载；错误时 undefined）
    let dims
    const probe = await encode('')
    dims = probe.length

    return { ok: true, encode, similarity, dims, model }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}

/**
 * 工具描述向量缓存：一次 embed，多次复用（工具集变化时重建）。
 * @param {Function} encode  embedder.encode
 * @param {Array<{name:string, description:string}>} schemas 规范化工具视图
 * @param {Map<string, object>} enrich 能力声明（keywords 并入描述）
 * @returns {Promise<Map<string, Float32Array>>} name → 向量
 */
export async function embedToolVectors(encode, schemas, enrich = new Map()) {
  const map = new Map()
  const jobs = []
  for (const s of schemas) {
    const decl = enrich.get(s.name)
    const keywords = Array.isArray(decl?.keywords) ? decl.keywords : []
    const text = [s.name, s.description, ...keywords].filter(x => typeof x === 'string' && x !== '').join(' ')
    jobs.push(encode(text).then(v => map.set(s.name, v)).catch(() => { /* 单条失败跳过 */ }))
  }
  await Promise.all(jobs)
  return map
}

/**
 * not_for 向量（守门闸嵌入信号用，plan-notfor-gate）：对每条携带 not_for
 * 的声明生成向量。与工具向量分开建——两者文本源不同、失效时机不同。
 * @param {Function} encode  embedder.encode
 * @param {Map<string, object>} enrich 能力声明
 * @returns {Promise<Map<string, Float32Array>>} tool → vec(not_for)
 */
export async function embedNotForVectors(encode, enrich = new Map()) {
  const map = new Map()
  const jobs = []
  for (const [tool, decl] of enrich) {
    const prose = typeof decl?.not_for === 'string' ? decl.not_for : ''
    if (prose === '') continue
    jobs.push(encode(prose).then(v => map.set(tool, v)).catch(() => { /* 单条失败跳过 */ }))
  }
  await Promise.all(jobs)
  return map
}

/**
 * 语义 Top-K：任务向量 vs 工具向量缓存，返回降序候选。
 * @param {Float32Array} taskVec
 * @param {Map<string, Float32Array>} toolVectors
 * @param {number} k
 * @returns {Array<{name:string, score:number}>}
 */
export function semanticTopK(taskVec, toolVectors, k) {
  const entries = []
  for (const [name, vec] of toolVectors) {
    let s = 0
    const n = Math.min(taskVec.length, vec.length)
    for (let i = 0; i < n; i++) s += taskVec[i] * vec[i]
    entries.push({ name, score: s })
  }
  entries.sort((x, y) => y.score - x.score)
  return entries.slice(0, k)
}
