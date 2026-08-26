/**
 * dsh-capability-index —— core（纯逻辑层，零 dsh 导入）。
 *
 * 本文件不 import 任何 dsh / cordis 包，只依赖同目录数据文件
 * `trigger-table.js`。所有 dsh 触点（事件 / context / schemas / 声明服务 /
 * 状态容器）都在 `dsh-adapter.js`；本文件的输入输出全部是普通数据对象，
 * 因此可以在纯 Node 里单测与回归（`npm run verify`）。
 *
 * 对外函数（adapter 与测试共用）：
 *   evaluate(text, hasImage)                     → 触发表判定
 *   normalizeSchemas(rawSchemas)                 → 工具视图投影（过滤 PTC 传输工具）
 *   parseDeclarations(payload)                   → 能力声明 → Map（v0/v1 兼容）
 *   buildIndex(schemas, enrich)                  → 排序索引预构建（adapter 缓存用）
 *   rankTop(schemas, …) / rankTopIndexed(index,…)-> Top-K 排序（同一实现体）
 *   renderTop(top, dec)                          → 硬层提示块
 *   renderOverview(schemas, reason, mode)        → 软层总览（PTC 模式感知；超阈值分组摘要）
 *   buildHint(input)                             → 顶层编排（判定→排序→渲染）
 */

import { TRIGGER_TABLE } from './trigger-table.js'

export const RUN_CODE_TRANSPORT = 'run_code'

export const CONTEXT_NAME = 'dsh-capability-index.hint'
export const CONTEXT_ORDER = 50

/**
 * 守门闸预截断池上限（plan-notfor-gate §3.3）：排序/合议先出大池 → not_for 闸
 * → 再截 Top-K，被拦/降位条目不占推送席位。64 远低于"倒排候选过滤"暂缓项的
 * 规模红线（工具 >500），当前部署（36 工具）行为与全池等价。
 */
const GATE_POOL_LIMIT = 64

const T = TRIGGER_TABLE

// ---- 词表数据 → 运行时对象（数据文件只存字符串）----
const A_WORDS = T.signals.A.words
const B_WORDS = T.signals.B.words
const B_CHARS = T.signals.B.chars
const B_PLEASE = T.signals.B.please
const C_ATTACH = T.signals.C.attachWords
const C_FILE_RE = new RegExp(T.signals.C.patterns.file)
const C_READ_RE = new RegExp(T.signals.C.patterns.read)
const C_AT_RE = new RegExp(T.signals.C.patterns.at)
const D_SPLIT_RE = new RegExp(T.signals.D.separators)
const F_QUOTE_RE = new RegExp(T.signals.F.patterns.quote)
const F_SPECIFIC_RE = new RegExp(T.signals.F.patterns.specific)
const CODE_FENCE = T.signals.F.codeFence
const LEVELS = T.complexity.levels

// ---- token 化（阶段二调优第一批：minLen≥3 + 停用词过滤；nameMention 精确匹配）----
const TOKEN_RE = new RegExp(`[\\w@./\\\\-]{${T.tokens.minLen},}`, 'g')
const STOPWORDS = new Set(T.tokens.stopwords)

// ---- 触发表 v0.1 判定 ----
function pleaseHit(text) {
  return text.startsWith(B_PLEASE.startsWith) || new RegExp(B_PLEASE.pattern).test(text)
}

function hasB(text) {
  return B_WORDS.some(w => text.includes(w))
    || B_CHARS.some(c => text.includes(c))
    || pleaseHit(text)
}

/** 任务动词（不含 please 礼貌语）：用于分句统计，避免"请把这文字再改改"误判为多任务。 */
function hasTaskVerb(text) {
  return B_WORDS.some(w => text.includes(w))
    || B_CHARS.some(c => text.includes(c))
}

function countClauses(text) {
  const parts = text.split(D_SPLIT_RE)
    .map(s => s.trim())
    .filter(s => s.length >= T.signals.D.minClauseChars)
  let count = 0
  for (const part of parts) {
    if (hasTaskVerb(part)) count += 1
  }
  return count
}

/**
 * 对当前用户消息求值触发表 v0.1，返回判定结果。
 * T1 = A；T2 = B 且（C|D|F）；T3 = B 但无 C/D/F；none = 无 B（闲聊/澄清）。
 * level 由 E（长度）+ D（子要求数）估计任务量级，用于 min_complexity 过滤。
 */
export function evaluate(text, hasImage) {
  const a = A_WORDS.some(w => text.includes(w))
  const b = hasB(text)
  const c = C_FILE_RE.test(text) || C_READ_RE.test(text) || C_AT_RE.test(text)
    || hasImage === true || C_ATTACH.some(w => text.includes(w))
  const d = countClauses(text) >= T.signals.D.minClauses
  const f = F_QUOTE_RE.test(text) || F_SPECIFIC_RE.test(text) || text.includes(CODE_FENCE)
  const len = text.length
  const kind = a ? 'T1' : b && (c || d || f) ? 'T2' : b ? 'T3' : 'none'
  const level = len >= T.complexity.longLimit && d ? 'high'
    : len >= T.complexity.longLimit || d ? 'mid' : 'low'
  return { kind, a, b, c, d, f, len, level }
}

/**
 * 工具视图投影：把 dsh 工具 schema 列表规范化为纯数据视图
 * （{ name, description }），并过滤 PTC 传输工具 `run_code`。
 *
 * mode 探测：列表中出现 `run_code` → code 呈现模式（模型直接可调只有
 * run_code，其余工具经生成的 SDK 间接调用）；否则 native。
 *
 * @param {Array} rawSchemas dsh tools.schemas(agent) 的原始返回
 * @returns {{ schemas: Array<{name:string,description:string}>, mode: 'code'|'native', filtered: number }}
 */
export function normalizeSchemas(rawSchemas) {
  const schemas = []
  let mode = 'native'
  let filtered = 0
  if (Array.isArray(rawSchemas)) {
    for (const s of rawSchemas) {
      if (s === null || s === undefined || typeof s !== 'object') continue
      const name = typeof s.name === 'string' ? s.name : ''
      if (name === '') continue
      if (name === RUN_CODE_TRANSPORT) {
        mode = 'code'
        filtered += 1
        continue
      }
      schemas.push({
        name,
        description: typeof s.description === 'string' ? s.description : '',
      })
    }
  }
  return { schemas, mode, filtered }
}

/**
 * 能力声明解析（来源无关）：接受
 *   - v1 形状：{ version: '1.0', declarations: [...] }
 *   - v0 形状：{ version: 2, declarations: [...] }（demo-cap 现状，数字版本）
 *   - v0 退化形状：无 version 字段的 { declarations: [...] } 或裸数组
 * 返回 tool → 声明 的 Map（tool 非字符串的条目跳过）。
 *
 * @param {unknown} payload ctx.get('capabilityIndex.declarations') 的返回
 * @returns {Map<string, object>}
 */
export function parseDeclarations(payload) {
  const map = new Map()
  if (payload === null || payload === undefined) return map
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.declarations)
      ? payload.declarations
      : null
  if (list === null) return map
  for (const decl of list) {
    if (decl !== null && typeof decl === 'object' && typeof decl.tool === 'string') {
      map.set(decl.tool, decl)
    }
  }
  return map
}

// ---- 索引与排序 ----
/**
 * 索引构建（规模优化 a/b 前置，2026-08-25）：把每步重复的字符串拼接、小写化、
 * 声明查找一次性做完。adapter 按"工具集版本 + 声明载荷身份"缓存索引
 * （tools/change 事件或声明对象更换时失效），排序热路径只做纯打分。
 * 注意：index 内嵌 decl 快照，必须与传入的 enrich 同源构建。
 *
 * @param {Array<{name:string, description:string}>} schemas 已 normalize 的工具视图
 * @param {Map<string, object>} enrich 能力声明（parseDeclarations 结果）
 * @returns {{ items: Array<{name, desc, hay, lower, decl}> }}
 */
export function buildIndex(schemas, enrich) {
  const map = enrich instanceof Map ? enrich : new Map()
  const items = []
  if (Array.isArray(schemas)) {
    for (const schema of schemas) {
      const toolName = typeof schema?.name === 'string' ? schema.name : ''
      if (toolName === '') continue
      const desc = typeof schema?.description === 'string' ? schema.description : ''
      items.push({
        name: toolName,
        desc,
        hay: `${toolName} ${desc}`.toLowerCase(),
        lower: toolName.toLowerCase(),
        decl: map.get(toolName),
      })
    }
  }
  return { items }
}

/**
 * 命中分数排序（索引版；rankTop 的唯一实现体，保证行为一致）：
 *  - 词面命中（消息 token 出现在 name/description）：+token
 *  - 工具名被直接点名：+nameMention
 *  - 能力声明 keywords 命中：+declaredKeyword（有声明条目权重高于降级条目）
 *  - 降级条目靠脚手架词表兜底（A 步实测的 BOOST_* 表，集中渲染前的起步方案）
 *  - 上一轮已提示的条目 ×0.5（已提示清单；防反复推）
 *  - min_complexity 高于当前量级的声明条目跳过
 *  - planOnly 时只保留只读工具（避免与 plan-mode 规则相抵）
 */
export function rankTopIndexed(index, text, dec, state, opts = {}) {
  // limit：守门闸预截断池（plan-notfor-gate §3.3：闸门须在 Top-K 截断前执行，
  // 被拦/降位条目不得占用推送席位）；缺省仍为 topK（旧调用方行为不变）
  const { planOnly = false } = opts
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : T.topK
  const tokens = (text.match(TOKEN_RE) ?? [])
    .map(t => t.toLowerCase())
    .filter(t => !STOPWORDS.has(t))
  const lastTop = Array.isArray(state?.lastTop) ? state.lastTop : []
  const entries = []
  const items = Array.isArray(index?.items) ? index.items : []
  for (const item of items) {
    const toolName = item.name
    if (planOnly && !T.plan.readonlyTools.includes(toolName)) continue
    let score = 0
    for (const token of tokens) {
      if (item.hay.includes(token)) score += T.rank.token
    }
    // 精确词匹配（实测修正：子串包含会把 "README" 误判为点名 "read" 工具）
    if (tokens.some(token => token === item.lower)) {
      score += T.rank.nameMention
    }

    const decl = item.decl
    if (decl !== undefined) {
      for (const keyword of decl.keywords ?? []) {
        if (typeof keyword === 'string' && keyword !== '' && text.includes(keyword)) {
          score += T.rank.declaredKeyword
        }
      }
      if (typeof decl.min_complexity === 'string'
        && LEVELS[decl.min_complexity] !== undefined
        && LEVELS[decl.min_complexity] > LEVELS[dec.level]) {
        continue
      }
    }

    if (dec.a) score += 1
    if (dec.c) {
      const boostFile = T.rank.boostFile[toolName]
      if (boostFile !== undefined) score += boostFile
      if (C_READ_RE.test(text)) {
        const boostRead = T.rank.boostRead[toolName]
        if (boostRead !== undefined) score += boostRead
      }
    }
    if (dec.d && T.rank.boostOrg[toolName] !== undefined) score += T.rank.boostOrg[toolName]
    if (/写|改|建|生成|拆分|合并|格式化/.test(text) && T.rank.boostWrite[toolName] !== undefined) {
      score += T.rank.boostWrite[toolName]
    }
    if (/整理|分析|统计|汇总|翻译|转换/.test(text) && T.rank.boostOrg[toolName] !== undefined) {
      score += T.rank.boostOrg[toolName]
    }
    if (/查|找|搜|了解/.test(text) && T.rank.boostLookup[toolName] !== undefined) {
      score += T.rank.boostLookup[toolName]
    }
    if (lastTop.includes(toolName)) score *= T.rank.hintedFactor

    if (score > 0) entries.push({ name: toolName, desc: item.desc, score, decl })
  }
  entries.sort((x, y) => y.score - x.score)
  return entries.slice(0, limit)
}

/**
 * 命中分数排序（便捷入口：内部建临时索引后走 rankTopIndexed）。
 * 生产热路径请用 buildIndex + rankTopIndexed（配合 adapter 缓存）；
 * 本入口保持旧签名，供测试与一次性调用使用。
 */
export function rankTop(schemas, text, dec, state, enrich, opts = {}) {
  return rankTopIndexed(buildIndex(schemas, enrich), text, dec, state, opts)
}

// ---- 渲染 ----
function cleanDesc(desc) {
  const one = String(desc).replace(/\s+/g, ' ').trim()
  return one.length > T.descLimit ? one.slice(0, T.descLimit) + '…' : one
}

/** 硬层 Top-K 提示块（集中渲染：use_when/not_for 渲染进本插件自己的块）。 */
export function renderTop(top, dec) {
  const lines = top.map(entry => {
    const base = `- ${entry.name}：${cleanDesc(entry.desc)}`
    const notes = []
    if (entry.gateWarn === true) {
      // 守门闸软处理标记（applyNotForGate）：声明 not_for 与当前场景疑似冲突
      notes.push('⚠️ 声明提示：此场景可能不适用（not_for）')
    }
    if (entry.decl !== undefined) {
      if (typeof entry.decl.use_when === 'string' && entry.decl.use_when !== '') {
        notes.push(`适用：${entry.decl.use_when}`)
      }
      if (typeof entry.decl.not_for === 'string' && entry.decl.not_for !== '') {
        notes.push(`不适用：${entry.decl.not_for}`)
      }
    }
    if (notes.length === 0) return base
    return `${base}（${notes.join('；')}）`
  })
  const undeclared = top.filter(entry => entry.decl === undefined).length
  const footer = undeclared === 0
    ? '以上条目均提供能力声明。'
    : `其中 ${undeclared} 条未提供能力声明（description 降级索引，置信度低）。`
  return [
    `[dsh-capability-index] 任务型请求（${dec.kind}），插件库预检提示——仅提示，是否调用由你决定：`,
    ...lines,
    `${footer}调用前先确认工具参数。`,
  ].join('\n')
}

/**
 * 软层总览兜底（T3/闲聊/无命中）。mode 感知文案：
 * code 呈现模式下模型直接可调只有 run_code（已从 schemas 过滤），
 * 其余工具经 SDK 间接调用——"当前可用工具 N 个"按 SDK 内可调口径标注。
 *
 * 规模优化 c（2026-08-25）：工具数超过 trigger-table 的 overview.groupedThreshold
 * 时改用"分类聚合摘要"（overview.groups 纯数据），未列出的工具进"其他"；
 * 260 字符预算的截断先打在尾部而不是任意腰斩清单。阈值内保持旧平铺格式
 * （字节一致，回归断言依赖）。
 */
export function renderOverview(schemas, reason, mode = 'native') {
  const names = schemas
    .map(s => (typeof s?.name === 'string' ? s.name : ''))
    .filter(n => n !== '')
  const modeNote = mode === 'code'
    ? `（code 呈现模式：模型经 run_code 调用，SDK 内可调 ${names.length} 个）`
    : ''
  const cfg = T.overview
  const useGroups = cfg !== null && typeof cfg === 'object'
    && Number.isInteger(cfg.groupedThreshold) && cfg.groupedThreshold > 0
    && names.length > cfg.groupedThreshold
    && Array.isArray(cfg.groups) && cfg.groups.length > 0
  let body
  if (!useGroups) {
    const list = names.join('、')
    body = list.length > T.overviewLimit ? list.slice(0, T.overviewLimit) + '…' : list
  } else {
    const nameSet = new Set(names)
    const parts = []
    const used = new Set()
    for (const g of cfg.groups) {
      if (g === null || typeof g !== 'object' || typeof g.label !== 'string' || !Array.isArray(g.names)) continue
      const inGroup = []
      for (const n of g.names) {
        if (typeof n === 'string' && n !== '' && nameSet.has(n) && !used.has(n)) {
          inGroup.push(n)
          used.add(n)
        }
      }
      if (inGroup.length > 0) parts.push(`${g.label}(${inGroup.length})：${inGroup.join('/')}`)
    }
    const rest = names.filter(n => !used.has(n))
    if (rest.length > 0) parts.push(`其他：${rest.join('/')}`)
    body = parts.join('；')
    if (body.length > T.overviewLimit) body = body.slice(0, T.overviewLimit) + '…'
  }
  return `[dsh-capability-index] 插件库总览（${reason}，软层兜底）：当前可用工具 ${names.length} 个${modeNote}——${body}（有明确任务时会给出针对性提示）`
}

/**
 * 顶层编排：判定 → 排序 → 渲染，一步出提示块。
 *
 * @param {object} input 纯数据输入（无任何 dsh 类型）：
 *   - text: string            当前用户消息文本（已 trim）
 *   - hasImage: boolean       是否含图片附件
 *   - schemas: Array          已 normalizeSchemas 投影的工具视图
 *   - enrich: Map             能力声明（parseDeclarations 的结果）
 *   - state: object           每 agent 状态（{ lastTop: string[] }）
 *   - mode: 'code'|'native'   呈现模式（normalizeSchemas 已探测）
 *   - planOnly: boolean|undefined  plan 阶段（只推只读）
 *   - index: object|undefined 可选，buildIndex 的缓存索引（须与 enrich 同源；
 *                             缺省时内部临时构建——测试与一次性调用用）
 * @returns {{ kind: string, text: string, pendingTop: string[] }}
 *   kind: 'T1'|'T2'|'T3'|'none'；pendingTop 仅 T2 有内容。
 */
export function buildHint(input) {
  const { text, hasImage = false, schemas = [], enrich, state = {}, mode = 'native', planOnly, index } = input
  const dec = evaluate(text, hasImage)
  if (dec.kind === 'T1') {
    return { kind: dec.kind, text: renderOverview(schemas, 'T1 显式查插件', mode), pendingTop: [], gateBlocked: [], gateWarned: [] }
  }
  if (dec.kind === 'T2') {
    const map = enrich instanceof Map ? enrich : new Map()
    const top = index !== null && index !== undefined
      ? rankTopIndexed(index, text, dec, state, { planOnly, limit: GATE_POOL_LIMIT })
      : rankTop(schemas, text, dec, state, map, { planOnly, limit: GATE_POOL_LIMIT })
    // not_for 守门闸（预热期/纯规则路径）：两段式——池级只硬拦（成员级），
    // 截 Top-K 后窗口段再做软处理（降位+警示，不动成员资格）；无向量数据时
    // 嵌入信号缺席，关键词单信号只允许软处理（绝不硬拦——诚实口径）
    const poolGated = applyNotForGate({ candidates: top, text, enrich: map, scope: 'pool' })
    const gated = applyNotForGate({
      candidates: poolGated.candidates.slice(0, T.topK), text, enrich: map,
    })
    const finalCandidates = gated.candidates
    if (finalCandidates.length === 0) {
      return {
        kind: dec.kind, text: renderOverview(schemas, 'T2 无命中', mode), pendingTop: [],
        gateBlocked: [...poolGated.blocked, ...gated.blocked], gateWarned: gated.warned,
      }
    }
    const pendingTop = finalCandidates.map(entry => entry.name)
    return {
      kind: dec.kind, text: renderTop(finalCandidates, dec), pendingTop,
      gateBlocked: [...poolGated.blocked, ...gated.blocked], gateWarned: gated.warned,
    }
  }
  return {
    kind: dec.kind,
    text: renderOverview(schemas, dec.kind === 'T3' ? 'T3 模糊宏大' : '非任务', mode),
    pendingTop: [], gateBlocked: [], gateWarned: [],
  }
}

// ================= 三级合议（v0.2 M2）=================

/**
 * 规则层 × 向量层合议（纯函数，向量为普通数组可 mock）。
 *
 * @param {object} input
 *   - ruleTop: Array  规则层 Top-K（rankTop 结果，含 decl）
 *   - semTop: Array   向量层 Top-K（[{ name, score }]）
 *   - k: number       输出候选上限（默认 trigger-table 的 topK）
 * @returns {{ decision: 'both'|'semantic-only'|'rule-only'|'conflict'|'none',
 *             candidates: Array<{name, score?, decl?, source?}> }}
 *   both         两层都命中且有交集 → 硬推并集（规则优先序）
 *   semantic-only 仅向量命中（规则守门未过）→ 偏硬推，标注来源
 *   rule-only    仅规则命中（向量未过阈值/未启用）→ v0.1 行为
 *   conflict     两层都命中但候选无交集 → 带内第三层，模型终判
 *   none         两层都无 → 软层总览（闲聊安全）
 */
export function fuseLayers(input) {
  const ruleTop = Array.isArray(input.ruleTop) ? input.ruleTop : []
  const semTop = Array.isArray(input.semTop) ? input.semTop : []
  const k = Number.isInteger(input.k) && input.k > 0 ? input.k : T.topK

  if (ruleTop.length > 0 && semTop.length > 0) {
    const ruleNames = new Set(ruleTop.map(e => e.name))
    const overlap = semTop.some(e => ruleNames.has(e.name))
    const merged = [...ruleTop]
    for (const e of semTop) {
      if (!ruleNames.has(e.name)) merged.push({ ...e, source: 'semantic' })
    }
    return { decision: overlap ? 'both' : 'conflict', candidates: merged.slice(0, k) }
  }
  if (ruleTop.length > 0) return { decision: 'rule-only', candidates: ruleTop.slice(0, k) }
  if (semTop.length > 0) return { decision: 'semantic-only', candidates: semTop.slice(0, k) }
  return { decision: 'none', candidates: [] }
}

/**
 * 向量层判定：任务向量 vs 工具向量缓存，最高相似度过阈值即"像有工具"。
 * 纯函数（向量为普通数组）；semanticTopK 在 embed.js（真实实现）。
 *
 * @param {Float32Array|number[]} taskVec
 * @param {Map<string, Float32Array|number[]>} toolVectors
 * @param {object} opts { threshold?, k? } 默认取 trigger-table 的 embed 配置
 * @returns {{ hit: boolean, top: Array<{name:string, score:number}> }}
 */
export function semanticVerdict(taskVec, toolVectors, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : T.embed.threshold
  const k = Number.isInteger(opts.k) && opts.k > 0 ? opts.k : T.embed.topK
  const entries = []
  if (taskVec !== null && taskVec !== undefined && toolVectors instanceof Map) {
    for (const [name, vec] of toolVectors) {
      if (vec === null || vec === undefined) continue
      let s = 0
      const n = Math.min(taskVec.length, vec.length)
      for (let i = 0; i < n; i++) s += taskVec[i] * vec[i]
      entries.push({ name, score: s })
    }
  }
  entries.sort((x, y) => y.score - x.score)
  const top = entries.slice(0, k)
  const hit = top.length > 0 && top[0].score >= threshold
  return { hit, top }
}

/**
 * 带内第三层渲染（灰色地带：不额外调模型接口，注入更丰富提示让模型终判）。
 * decision = 'conflict'（两层候选无交集）或 'semantic-only'（规则存疑）。
 *
 * @param {object} input
 *   - decision: string
 *   - candidates: Array   合议候选
 *   - ruleTop: Array      规则层 Top-K（渲染理由用）
 *   - semTop: Array       向量层 Top-K（渲染理由用）
 *   - mode: string        呈现模式（code/native）
 * @returns {string} 提示块文本
 */
export function renderAdvisory(input) {
  const { decision, candidates = [], ruleTop = [], semTop = [], mode = 'native' } = input
  const names = candidates.map(e => e.name).filter(n => n !== '')
  if (names.length === 0) return ''
  // 守门闸软处理候选（gateWarn 标记）：advisory 无逐条卡片，警示合并为一行
  const warnedNames = candidates
    .filter(e => e !== null && typeof e === 'object' && e.gateWarn === true && typeof e.name === 'string')
    .map(e => e.name)
  const gateNote = warnedNames.length > 0
    ? `⚠️ 声明提示：${warnedNames.join('、')} 的声明 not_for 与当前场景疑似冲突，是否采纳由你定。`
    : ''
  const declNote = candidates.filter(e => e.decl !== undefined).length === 0
    ? ''
    : '（其中部分条目提供能力声明，调用前先核对 use_when / not_for）'
  if (decision === 'conflict') {
    const ruleNames = ruleTop.map(e => e.name).join('、') || '—'
    const semNames = semTop.map(e => e.name).join('、') || '—'
    const codeNote = mode === 'code' ? '（code 呈现模式：经 run_code 调用）' : ''
    return [
      `[dsh-capability-index] 插件库预检（规则命中 × 语义命中，候选不一致，供你终判${codeNote}）：`,
      `候选工具：${names.join('、')}`,
      `规则层认为：${ruleNames}；语义层认为：${semNames}。`,
      '两边理由不同，是否调用由你决定；拿不准时建议先查对应工具参数。',
      declNote,
      gateNote,
    ].filter(x => x !== '').join('\n')
  }
  if (decision === 'semantic-only') {
    const codeNote = mode === 'code' ? '（code 呈现模式：经 run_code 调用）' : ''
    return [
      `[dsh-capability-index] 插件库预检（语义匹配${codeNote}）：${names.join('、')}`,
      '规则词表未命中这些工具，仅凭语义相似度推荐——置信度中等，调用前先确认工具参数。',
      gateNote,
    ].filter(x => x !== '').join('\n')
  }
  return ''
}

/**
 * buildHint 的向量层扩展入口：规则判定后，若有向量数据则合议，否则纯规则。
 * 返回 null 表示无向量数据（调用方维持原 buildHint 行为）。
 *
 * @param {object} input buildHint 的 input + 额外字段：
 *   - taskVec: Float32Array|number[]   任务文本向量（可选）
 *   - toolVectors: Map<string, Float32Array|number[]> 工具描述向量缓存（可选）
 *   - semThreshold: number             向量阈值覆盖（可选，M3 校准用）
 * @returns {{ kind: string, text: string, pendingTop: string[], decision?: string,
 *   hit?: boolean, semTop?: Array<{name:string,score:number}> } | null}
 */
export function buildHintSemantic(input) {
  const { text, hasImage = false, schemas = [], enrich, state = {}, mode = 'native', planOnly,
    taskVec, toolVectors, semThreshold, index, notForVectors } = input
  if (taskVec === null || taskVec === undefined || !(toolVectors instanceof Map)) return null
  const dec = evaluate(text, hasImage)
  if (dec.kind === 'T1') return null
  const map = enrich instanceof Map ? enrich : new Map()
  // 规则层只在任务型（T2）时参与；非 T2（英文/模糊）由向量层独立判断——
  // 规则词表不覆盖英文，向量层是英文任务的唯一召回信号（D7：模棱两可偏硬推）
  const ruleTop = dec.kind === 'T2'
    ? (index !== null && index !== undefined
        ? rankTopIndexed(index, text, dec, state, { planOnly, limit: GATE_POOL_LIMIT })
        : rankTop(schemas, text, dec, state, map, { planOnly, limit: GATE_POOL_LIMIT }))
    : []
  // 预截断池：语义侧同样取大池，闸门后再截 Top-K（plan §3.3 截断前核对）
  const verdict = semanticVerdict(taskVec, toolVectors, { threshold: semThreshold, k: GATE_POOL_LIMIT })
  // hit=false（低于阈值，如闲聊）→ 向量层视同无命中，避免"语义匹配"误渲染
  const fused = fuseLayers({ ruleTop, semTop: verdict.hit ? verdict.top : [], k: GATE_POOL_LIMIT })
  // not_for 守门闸：两段式（首轮校准修正）——池级只硬拦（被拦条目不占席位，
  // 双信号精确触发），截 Top-K 后窗口段做软处理（降位+警示，不动成员资格）。
  const poolGated = applyNotForGate({
    candidates: fused.candidates, text, enrich: map, taskVec, notForVectors, scope: 'pool',
  })
  const windowGated = applyNotForGate({
    candidates: poolGated.candidates.slice(0, T.topK), text, enrich: map, taskVec, notForVectors,
  })
  fused.candidates = windowGated.candidates
  const gateBlocked = [...poolGated.blocked, ...windowGated.blocked]
  const gateWarned = windowGated.warned

  // 硬拦清空候选 → 回退软层总览（不渲染空提示块；decision/semTop 照实保留供审计）
  if (fused.decision !== 'none' && fused.candidates.length === 0) {
    const reason = dec.kind === 'T3' ? 'T3 模糊宏大'
      : dec.kind === 'T2' ? 'T2 无命中'
        : '非任务'
    return {
      kind: dec.kind, text: renderOverview(schemas, reason, mode), pendingTop: [],
      decision: fused.decision, hit: verdict.hit, semTop: verdict.top,
      gateBlocked, gateWarned,
    }
  }
  const pendingTop = fused.candidates.map(e => e.name)

  if (fused.decision === 'none') {
    // 两层都无 → 软层总览（闲聊安全）；理由文案与纯规则路径按判定种类对齐，
    // 避免闲聊/T3 消息在语义路径下被误标为"T2 无命中"
    const reason = dec.kind === 'T3' ? 'T3 模糊宏大'
      : dec.kind === 'T2' ? 'T2 无命中'
        : '非任务'
    return {
      kind: dec.kind, text: renderOverview(schemas, reason, mode), pendingTop: [],
      decision: fused.decision, hit: verdict.hit, semTop: verdict.top,
      gateBlocked, gateWarned,
    }
  }
  if (fused.decision === 'rule-only') {
    // 仅规则命中（向量未过阈值/未启用）→ v0.1 行为
    return {
      kind: dec.kind, text: renderTop(fused.candidates, dec), pendingTop,
      decision: fused.decision, hit: verdict.hit, semTop: verdict.top,
      gateBlocked, gateWarned,
    }
  }
  if (fused.decision === 'both') {
    return {
      kind: dec.kind, text: renderTop(fused.candidates, dec), pendingTop,
      decision: fused.decision, hit: verdict.hit, semTop: verdict.top,
      gateBlocked, gateWarned,
    }
  }
  // conflict / semantic-only → 带内第三层（灰色地带）
  const advisory = renderAdvisory({
    decision: fused.decision,
    candidates: fused.candidates,
    ruleTop,
    semTop: verdict.top,
    mode,
  })
  if (advisory === '') {
    return {
      kind: dec.kind, text: renderTop(fused.candidates, dec), pendingTop,
      decision: fused.decision, hit: verdict.hit, semTop: verdict.top,
      gateBlocked, gateWarned,
    }
  }
  return {
    kind: dec.kind, text: advisory, pendingTop,
    decision: fused.decision, hit: verdict.hit, semTop: verdict.top,
    gateBlocked, gateWarned,
  }
}

// ================= not_for 守门闸（v0.2 M3，plan-notfor-gate）=================

/** 中文连续段（≥2 字）：闸门 CJK 二元组分词用。TOKEN_RE 是 ASCII 口径
 * （\w 不含 CJK），S9 类纯中文消息没有任何 ASCII token——守门关键词信号
 * 必须自带中文口径，否则结构性失灵。 */
const GATE_CJK_RUN_RE = /[\u4e00-\u9fa5]{2,}/g

/** 文本 → 闸门词集 { ascii, cjk }：ASCII token 复用排序口径（TOKEN_RE +
 * STOPWORDS），中文取相邻字二元组（确定性零依赖的轻量切分）。 */
function gateTokenSets(text) {
  const s = String(text)
  const ascii = new Set((s.match(TOKEN_RE) ?? [])
    .map(t => t.toLowerCase())
    .filter(t => !STOPWORDS.has(t)))
  const cjk = new Set()
  for (const run of s.match(GATE_CJK_RUN_RE) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) cjk.add(run.slice(i, i + 2))
  }
  return { ascii, cjk }
}

/**
 * 关键词信号：声明 not_for 词集与消息词集求交，非空即命中；
 * 显式补词 decl.not_for_keywords（可选数组）按消息子串匹配。
 * 整句包含必失灵（S9 教训："文件重命名" vs "文件批量重命名"），故走词集交。
 */
function notForKeywordHit(msgSets, msgText, nfSets, explicitWords) {
  for (const t of nfSets.ascii) if (msgSets.ascii.has(t)) return true
  for (const t of nfSets.cjk) if (msgSets.cjk.has(t)) return true
  if (Array.isArray(explicitWords)) {
    for (const w of explicitWords) {
      if (typeof w === 'string' && w !== '' && msgText.includes(w)) return true
    }
  }
  return false
}

/**
 * not_for 守门闸（纯函数）：让声明的负面清单从展示文案变成有牙齿的规则。
 *
 * 双信号（plan-notfor-gate §3.1）：
 *  - 关键词：not_for 分词（ASCII token ∪ CJK 二元组 ∪ 显式补词）与消息求交；
 *  - 嵌入：cosine(任务向量, vec(not_for))；taskVec / notForVectors 任一缺席则
 *    该信号跳过（预热期、语义引擎未就绪、离线纯规则场景）。
 *
 * 两档动作（§3.2）：
 *  - 硬拦：关键词 ∧ 嵌入 ≥ hardSim → 候选从输出移除（确定性冲突，不解释）；
 *  - 软处理：恰一信号命中，或嵌入 ∈ [softSim, hardSim) → 移至尾部（保相对序）
 *    + score × demoteFactor + gateWarn 标记（渲染层附 ⚠️ 行）；模型终判权不变。
 *
 * 边界：
 *  - 无声明工具直接通过（无从核对——诚实边界，当前受保护对象 = 携带声明者）；
 *  - 仅关键词命中（嵌入缺席）只软处理，绝不硬拦；
 *  - scope 两段式（首轮校准修正，2026-08-26）：'pool' 段只执行硬拦（成员级、
 *    罕见且精确——软命中若在池级沉底，会被大量低分噪音反超挤出 Top-K，
 *    实测召回 0.714→0.286，已证伪）；'window' 段（默认）在 Top-K 窗口内
 *    执行完整两档——软命中保留成员资格，仅窗口内降位 + score×demoteFactor；
 *  - enabled=false 整体旁路。
 *
 * @param {object} input
 *   - candidates: Array   合议输出候选（{name, score?, decl?, ...}）
 *   - text: string        当前用户消息
 *   - enrich: Map         能力声明（entry.decl 缺席时按名补查）
 *   - taskVec?: Float32Array|null     任务向量（可缺省）
 *   - notForVectors?: Map<string,Float32Array>|null  工具 → vec(not_for)
 *   - config?: object     覆盖 trigger-table.notForGate（测试/校准扫描用）
 *   - scope?: 'pool'|'window'  两段式作用域（默认 'window'）
 * @returns {{ candidates: Array, blocked: string[], warned: string[] }}
 */
export function applyNotForGate(input) {
  const cfg = (input.config !== null && input.config !== undefined)
    ? input.config
    : (T.notForGate ?? {})
  const source = Array.isArray(input.candidates) ? input.candidates : []
  const blocked = []
  const warned = []
  if (cfg.enabled === false || source.length === 0) {
    return { candidates: source, blocked, warned }
  }
  const poolStage = input.scope === 'pool'
  const enrich = input.enrich instanceof Map ? input.enrich : new Map()
  const msgText = String(input.text ?? '')
  const msgSets = gateTokenSets(msgText)
  const taskVec = input.taskVec ?? null
  const notForVectors = input.notForVectors instanceof Map ? input.notForVectors : null
  const kept = []
  const demoted = []
  for (const entry of source) {
    const name = entry !== null && typeof entry === 'object' && typeof entry.name === 'string'
      ? entry.name
      : ''
    const decl = entry && entry.decl !== undefined ? entry.decl : enrich.get(name)
    const hasProse = typeof decl?.not_for === 'string' && decl.not_for !== ''
    const hasExplicit = Array.isArray(decl?.not_for_keywords)
      && decl.not_for_keywords.some(k => typeof k === 'string' && k !== '')
    // 无声明 / 声明无任何 not_for 材料 → 直接通过（无从核对）
    if (name === '' || decl === undefined || (!hasProse && !hasExplicit)) {
      kept.push(entry)
      continue
    }

    const kwHit = notForKeywordHit(
      msgSets, msgText,
      hasProse ? gateTokenSets(decl.not_for) : { ascii: new Set(), cjk: new Set() },
      decl.not_for_keywords,
    )

    let embSim = null
    if (taskVec !== null && notForVectors !== null) {
      const vec = notForVectors.get(name)
      if (vec !== null && vec !== undefined) {
        let s = 0
        const n = Math.min(taskVec.length, vec.length)
        for (let i = 0; i < n; i++) s += taskVec[i] * vec[i]
        if (Number.isFinite(s)) embSim = s
      }
    }
    const embHard = embSim !== null && embSim >= cfg.hardSim

    if (kwHit && embHard) {
      blocked.push(name)
      continue
    }
    // 池级段：只硬拦，不做软处理（软命中保留席位，窗口段再降位）
    if (poolStage) {
      kept.push(entry)
      continue
    }
    const softZone = embSim !== null && !embHard && embSim >= cfg.softSim
    if ((kwHit && !embHard) || softZone) {
      warned.push(name)
      demoted.push({
        ...entry,
        score: typeof entry.score === 'number' ? entry.score * cfg.demoteFactor : entry.score,
        gateWarn: true,
      })
      continue
    }
    kept.push(entry)
  }
  return { candidates: [...kept, ...demoted], blocked, warned }
}
