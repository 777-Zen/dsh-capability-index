/**
 * dsh-capability-index —— 插件库"起飞前检查单"。
 *
 * 定位：让 agent 对插件库从"机会主义的直觉判断"变成"规律性的预先审视"——
 * 任务量上来时，动手前先系统性过一遍已知插件库。卖点只写"插件库利用率可预期"。
 *
 * 三层机制（设计大纲 §3，已定决策以大纲 §10 为准）：
 *   - 硬层：触发表 v0.1（词表见 lib/trigger-table.js，中文起步）每 model step
 *     对当前用户消息求值；T1/T2 命中注入 Top-K 提示块（use_when/not_for 集中渲染）。
 *   - 软层：未命中/模糊宏大（T3）/闲聊时注入轻量"插件库总览"兜底。
 *   - 注入通道：systemPrompt.context() 函数式提供者，输出落进 runtime-context
 *     快照（commit-on-change + "supersedes earlier snapshots" 语义 → 提示块只在
 *     内容变化时替换，不逐轮堆积）。
 *
 * 索引口径：tools.schemas(agent) = 当前会话模型可见工具集（隐私边界自动成立）。
 * 能力声明（可选富化层）：约定服务名 `capabilityIndex.declarations`，见 README
 * 「能力声明约定」。v0 单聚合器约定：每个组合只应有一个插件提供该服务。
 *
 * v0 硬边界：只读 + 建议性质；不改写任何其他插件的工具定义/description、
 * 不碰注册表、不强制调用（最终决策权在模型）、不自动安装缺失插件。
 *
 * 零依赖纯 ESM（理由同 dsh-tool-demo：pnpm 本地路径默认 symlink 安装，
 * Node 以 symlink 真实路径为锚点解析 import，依赖 @deepseek-ai/* 会找不到）。
 */

import { TRIGGER_TABLE } from './trigger-table.js'

export const name = 'capability-index'
export const inject = ['systemPrompt', 'tools']

const CONTEXT_NAME = 'dsh-capability-index.hint'
const CONTEXT_ORDER = 50
const T = TRIGGER_TABLE

// ---- 词表数据 → 运行期对象（index.js 负责编译，数据文件只存字符串）----
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

/** 任务动词（不含"请"礼貌语）：用于分句统计，避免"请把这段文字再改改"误判为多任务。 */
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
 * level 用 E（长度）+ D（子要求数）估计任务量级，用于 min_complexity 过滤。
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

// ---- 索引与排序 ----
/**
 * 命中分数排序：
 *  - 词面命中（消息 token 出现在 name/description）+2；
 *  - 工具名被直接点名 +3；
 *  - 能力声明 keywords 命中 +4（有声明条目权重高于降级条目）；
 *  - 降级条目靠脚手架词表兜底（A 步实测的 BOOST_* 表，集中渲染前的起步方案）；
 *  - 上一轮已提示的条目 ×0.5（"已提示清单"防反复推）；
 *  - min_complexity 高于当前量级的声明条目跳过。
 */
export function rankTop(schemas, text, dec, st, enrich) {
  const tokens = (text.match(TOKEN_RE) ?? [])
    .map(t => t.toLowerCase())
    .filter(t => !STOPWORDS.has(t))
  const lastTop = st.lastTop
  const entries = []
  for (const schema of schemas) {
    const toolName = typeof schema?.name === 'string' ? schema.name : ''
    const desc = typeof schema?.description === 'string' ? schema.description : ''
    if (toolName === '') continue
    const hay = `${toolName} ${desc}`.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (hay.includes(token)) score += T.rank.token
    }
    // 精确词匹配（实测修正：子串包含会把 "README" 误判为点名 "read" 工具）
    if (tokens.some(token => token === toolName.toLowerCase())) {
      score += T.rank.nameMention
    }

    const decl = enrich.get(toolName)
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
    if (Array.isArray(lastTop) && lastTop.includes(toolName)) score *= T.rank.hintedFactor

    if (score > 0) entries.push({ name: toolName, desc, score, decl })
  }
  entries.sort((x, y) => y.score - x.score)
  return entries.slice(0, T.topK)
}

// ---- 渲染 ----
function cleanDesc(desc) {
  const one = String(desc).replace(/\s+/g, ' ').trim()
  return one.length > T.descLimit ? one.slice(0, T.descLimit) + '…' : one
}

/** 硬层 Top-K 提示块（集中渲染：use_when/not_for 渲染进本插件自己的块）。 */
function renderTop(top, dec) {
  const lines = top.map(entry => {
    const base = `- ${entry.name}：${cleanDesc(entry.desc)}`
    if (entry.decl === undefined) return base
    const notes = []
    if (typeof entry.decl.use_when === 'string' && entry.decl.use_when !== '') {
      notes.push(`适用：${entry.decl.use_when}`)
    }
    if (typeof entry.decl.not_for === 'string' && entry.decl.not_for !== '') {
      notes.push(`不适用：${entry.decl.not_for}`)
    }
    return notes.length === 0 ? base : `${base}（${notes.join('；')}）`
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

/** 软层总览兜底（T3/闲聊/无命中）。 */
function renderOverview(schemas, reason) {
  const names = schemas
    .map(s => (typeof s?.name === 'string' ? s.name : ''))
    .filter(n => n !== '')
  const list = names.join('、')
  const shown = list.length > T.overviewLimit ? list.slice(0, T.overviewLimit) + '…' : list
  return `[dsh-capability-index] 插件库总览（${reason}，软层兜底）：当前可用工具 ${names.length} 个——${shown}（有明确任务时会给出针对性提示）`
}

// ---- 消息捕获：agent/inbox/claimed 先于 prompt 组装触发（时序见 handoff-notes）----
function messageText(message) {
  let text = ''
  let hasImage = false
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') text += block.text
      else if (block.type === 'image') hasImage = true
    }
  }
  return { text: text.trim(), hasImage }
}

export function apply(ctx) {
  // per-agent 状态：消息文本 + 上一消息已提示清单（跨消息 ×0.5，消息内不变化 → 文本稳定）
  const perAgent = new Map()
  const stateFor = id => {
    let st = perAgent.get(id)
    if (st === undefined) {
      st = { text: '', hasImage: false, turn: -1, lastTop: [], pendingTop: [] }
      perAgent.set(id, st)
    }
    return st
  }

  // 能力声明富化层（可选；v0 单聚合器约定，见 README）。
  // 每次求值时现取：声明服务可能在本插件之后加载，也随声明变化即时生效。
  const buildEnrich = declService => {
    const map = new Map()
    if (declService !== null && declService !== undefined && Array.isArray(declService.declarations)) {
      for (const decl of declService.declarations) {
        if (decl !== null && typeof decl === 'object' && typeof decl.tool === 'string') {
          map.set(decl.tool, decl)
        }
      }
    }
    return map
  }

  ctx.on('agent/inbox/claimed', payload => {
    try {
      const message = payload?.message
      if (message === null || message === undefined
        || message.source === undefined || message.source.kind !== 'user') return
      const { text, hasImage } = messageText(message)
      if (text === '') return
      const id = payload?.agent === null || payload?.agent === undefined ? 'agent' : String(payload.agent.id)
      const st = stateFor(id)
      if (st.text !== '' && st.text !== text) {
        // 消息切换：上一消息的渲染结果封存为"已提示清单"
        st.lastTop = st.pendingTop
        st.pendingTop = []
      }
      st.text = text
      st.hasImage = hasImage
      if (typeof payload?.turn === 'number') st.turn = payload.turn
    } catch {
      // 永不打断事件分发
    }
  })

  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: assembly => {
      try {
        const agent = assembly?.agent
        if (agent === null || agent === undefined) return ''
        const st = stateFor(String(agent.id))
        if (st.text === '') return ''
        const schemas = ctx.tools.schemas(agent)
        const dec = evaluate(st.text, st.hasImage)
        if (dec.kind === 'T1') return renderOverview(schemas, 'T1 显式查插件')
        if (dec.kind === 'T2') {
          const enrich = buildEnrich(ctx.get('capabilityIndex.declarations'))
          const top = rankTop(schemas, st.text, dec, st, enrich)
          if (top.length === 0) return renderOverview(schemas, 'T2 无命中')
          st.pendingTop = top.map(entry => entry.name)
          return renderTop(top, dec)
        }
        return renderOverview(schemas, dec.kind === 'T3' ? 'T3 模糊宏大' : '非任务')
      } catch {
        return ''
      }
    },
  })
}
