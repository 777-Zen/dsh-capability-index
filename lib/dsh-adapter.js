/**
 * dsh-capability-index —— dsh-adapter（唯一 dsh 触点）。
 *
 * 本文件是插件与 dsh 运行时之间的唯一接口层：事件监听（agent/inbox/claimed、
 * tools/change、agent/disposed）、注入通道（systemPrompt.context）、工具口径
 * （tools.schemas）、能力声明服务（capabilityIndex.declarations）、会话投影
 * （sessionProjections，可选）与每 agent 状态容器。除 `core.js` 外不 import
 * 任何领域逻辑；对外（core）只传纯数据对象，内部不掺渲染/判定逻辑。
 *
 * 适配层目标：dsh 正式版 API 变化时只改本文件 + 跑回归。
 *
 * M2（向量层）：接受可选 `semantic` 引擎（lib/semantic.js 实例）。
 * 时序：systemPrompt.context 的 text 回调是**同步**的，向量是异步产物 →
 * 预取策略——agent/inbox/claimed 捕获消息后立即异步 embed 任务文本与工具
 * 描述（~150ms），写入每 agent 状态；context 回调读到就用三级合议，
 * 读不到（预取未完成/失败/未启用）走纯规则路径，下轮内容变化时再补
 * （commit-on-change 语义下不堆积、不卡注入）。
 *
 * 规模优化（2026-08-25，README 已知问题"插件规模"落地）：
 *  - 工具视图缓存：`ctx.tools.schemas(agent)` 每次**深克隆全部参数 schema**
 *    （tools/src/index.ts:1234-1236），随插件数线性变贵 → 按 agent 缓存
 *    normalize 后的视图与排序索引，`tools/change`（emit、无载荷、"possibly
 *    for one scope only"→ 只能保守清空）与声明载荷身份变化时失效。
 *    稳态热路径零 schema 克隆、零 normalize、零 parseDeclarations。
 *  - 声明解析缓存：WeakMap 按载荷对象身份缓存 parseDeclarations 结果，
 *    provide 更换（新对象）自动失效。
 *  - agent/disposed 清理 per-agent 状态与视图缓存，防会话树增长下的 Map 泄漏。
 */

/**
 * 从 dsh 消息对象提取纯文本与图片标记（不携带任何 dsh 类型）。
 */
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

/** 视图缓存条目的声明载荷哨兵（无声明 / 原始值时用稳定键）。 */
function declRefOf(payload) {
  return payload !== null && typeof payload === 'object' ? payload : undefined
}

/**
 * 探测当前会话的 plan 阶段（可选服务，尽力而为）：
 * plan-mode 注册了 `plan` session projection（值 { active: boolean }）。
 * sessionProjections 服务或 session 拿不到时返回 undefined（不做 plan 限制）。
 */
function planProbe(ctx, agent) {
  try {
    const sp = ctx.get('sessionProjections')
    if (sp === null || sp === undefined) return undefined
    const session = agent?.session
    if (session === null || session === undefined) return undefined
    const values = sp.snapshot(session)?.values
    if (values === null || values === undefined) return undefined
    return values.plan?.active === true
  } catch {
    return undefined
  }
}

/**
 * 创建插件运行体：注册事件与注入通道，返回一个只读描述对象。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx dsh 组合上下文
 * @param {object} core 纯逻辑层（lib/core.js 的导出集合）
 * @param {object} semanticRef 语义引擎可变引用容器 { current: engine|null }
 *   （lib/semantic.js 实例；current 为 null/未就绪 → 纯规则路径）
 * @param {object} [opts] 可选配置
 *   - decisionLog: (entry: object) => void  决策日志记录器
 *     （lib/decision-log.js 实例；缺省/null = 不记录，离线回归零副作用）。
 *     每次实际注入（含软层总览）记一行，供 M3 离线校准与 PTC 审计。
 */
export function createAdapter(ctx, core, semanticRef = { current: null }, opts = {}) {
  const semantic = () => (semanticRef !== null && semanticRef !== undefined ? semanticRef.current : null)
  const logDecision = opts !== null && typeof opts === 'object' && typeof opts.decisionLog === 'function'
    ? opts.decisionLog
    : null
  // 每 agent 状态：消息文本 + 已提示清单 + 预取向量（M2）
  const perAgent = new Map()
  const stateFor = id => {
    let st = perAgent.get(id)
    if (st === undefined) {
      st = {
        text: '', hasImage: false, turn: -1, lastTop: [], pendingTop: [],
        taskVec: null, toolVecs: null, toolVecKey: '',
        notForVecs: null,
        lastLogged: '',
      }
      perAgent.set(id, st)
    }
    return st
  }

  // ---- 声明解析缓存（WeakMap 按载荷身份；provide 更换即新对象 → 自动失效）----
  const declCache = new WeakMap()
  const declMapOf = payload => {
    if (payload !== null && typeof payload === 'object') {
      let map = declCache.get(payload)
      if (map === undefined) {
        map = core.parseDeclarations(payload)
        declCache.set(payload, map)
      }
      return map
    }
    return core.parseDeclarations(payload)
  }
  const safeGetDeclarations = ctxInner => {
    try {
      return ctxInner.get('capabilityIndex.declarations')
    } catch {
      return undefined
    }
  }
  const declsFor = () => declMapOf(safeGetDeclarations(ctx))

  // ---- 工具视图缓存（每 agent 一份；tools/change 或声明更换时失效）----
  // 条目：{ schemas, mode, index, declRef }。schemas 是 normalizeSchemas 的纯
  // 数据投影（{name, description} 列表），index 是 buildIndex 的排序索引——
  // 二者与 declRef 指向的声明同源构建，失效时整条重建，永不混用旧声明。
  const viewCache = new Map()
  const VIEW_CACHE_LIMIT = 64
  const viewFor = agent => {
    const id = agent === null || agent === undefined ? '(global)' : String(agent.id)
    const payload = safeGetDeclarations(ctx)
    const ref = declRefOf(payload)
    let v = viewCache.get(id)
    if (v === undefined || v.declRef !== ref) {
      try {
        const rawSchemas = ctx.tools.schemas(agent)
        const norm = core.normalizeSchemas(rawSchemas)
        v = {
          schemas: norm.schemas,
          mode: norm.mode,
          index: core.buildIndex(norm.schemas, declMapOf(payload)),
          declRef: ref,
        }
      } catch {
        v = { schemas: [], mode: 'native', index: { items: [] }, declRef: ref }
      }
      viewCache.set(id, v)
      if (viewCache.size > VIEW_CACHE_LIMIT) {
        // 防御性上限：异常多 agent 场景下整体清空（下次组装重建，正确性不受影响）
        viewCache.clear()
        viewCache.set(id, v)
      }
    }
    return v
  }

  /** 预取向量（尽力而为）：失败/未启用置 null，不打断事件分发。 */
  const prefetchVectors = (st, agent, view) => {
    const engine = semantic()
    if (engine === null || engine === undefined || engine.ok !== true) return
    const textAtStart = st.text
    const keyAtStart = view.schemas.map(s => (typeof s?.name === 'string' ? s.name : '')).join(',')
    // 任务文本向量
    engine.encodeTask(textAtStart)
      .then(vec => {
        if (st.text === textAtStart) st.taskVec = vec
      })
      .catch(() => { if (st.text === textAtStart) st.taskVec = null })
    // 工具描述向量（引擎内部按 key 缓存）
    engine.toolVectors(view.schemas, declsFor())
      .then(vecs => {
        if (st.text === textAtStart) {
          st.toolVecs = vecs
          st.toolVecKey = keyAtStart
        }
      })
      .catch(() => { if (st.text === textAtStart) st.toolVecs = null })
    // not_for 向量（守门闸嵌入信号；引擎内部按声明文本指纹缓存）
    engine.notForVectors(declsFor())
      .then(vecs => {
        if (st.text === textAtStart) st.notForVecs = vecs
      })
      .catch(() => { if (st.text === textAtStart) st.notForVecs = null })
  }

  // 工具集变更：清空全部视图缓存（事件无载荷且可能只涉单 scope，保守失效）
  ctx.on('tools/change', () => {
    try {
      viewCache.clear()
    } catch {
      // 永不打断事件分发
    }
  })

  // agent 销毁：清理其消息状态与工具视图缓存（防会话树增长下的 Map 泄漏）
  ctx.on('agent/disposed', payload => {
    try {
      const agent = payload?.agent
      if (agent === null || agent === undefined) return
      const id = String(agent.id)
      perAgent.delete(id)
      viewCache.delete(id)
    } catch {
      // 永不打断事件分发
    }
  })

  // 消息捕获：agent/inbox/claimed 先于 prompt 组装触发（时序见 handoff-notes）
  ctx.on('agent/inbox/claimed', payload => {
    try {
      const message = payload?.message
      if (message === null || message === undefined
        || message.source === undefined || message.source.kind !== 'user') return
      const { text, hasImage } = messageText(message)
      if (text === '') return
      const agent = payload?.agent ?? null
      const id = agent === null ? 'agent' : String(agent.id)
      const st = stateFor(id)
      if (st.text !== '' && st.text !== text) {
        // 消息切换：上一消息的渲染结果封存为"已提示清单"，旧向量作废
        st.lastTop = st.pendingTop
        st.pendingTop = []
        st.taskVec = null
        st.toolVecs = null
        st.notForVecs = null
        st.lastLogged = ''
      }
      st.text = text
      st.hasImage = hasImage
      if (typeof payload?.turn === 'number') st.turn = payload.turn
      // 预取向量（M2）：视图走缓存（首次才触发 schemas 克隆）；失败自动降级
      try {
        prefetchVectors(st, agent, viewFor(agent))
      } catch {
        // 预取失败不影响注入
      }
    } catch {
      // 永不打断事件分发
    }
  })

  ctx.systemPrompt.context({
    name: core.CONTEXT_NAME,
    order: core.CONTEXT_ORDER,
    text: assembly => {
      try {
        const agent = assembly?.agent
        if (agent === null || agent === undefined) return ''
        const st = stateFor(String(agent.id))
        if (st.text === '') return ''
        const view = viewFor(agent)
        const enrich = declsFor()
        const planOnly = planProbe(ctx, agent)

        // 决策日志（M3 数据基建）：每次实际注入记一行（含软层总览——误触发
        // 审计既需要"推了什么"，也需要"没推时的判定种类"）。注入块每个 model
        // step 都会重组，commit-on-change 只防快照堆积——这里按渲染内容去重，
        // 同一 agent 同一内容的重复组装不重复记（生产实测：一条多步消息曾记
        // 17 行）。日志失败不影响注入。
        const emit = out => {
          if (logDecision !== null && out !== null && typeof out.text === 'string' && out.text !== ''
            && out.text !== st.lastLogged) {
            try {
              logDecision({
                msgHead: st.text,
                kind: out.kind,
                decision: out.decision,
                hit: out.hit,
                pushed: out.pendingTop,
                semTop: out.semTop,
                gateBlocked: out.gateBlocked,
                gateWarned: out.gateWarned,
                mode: view.mode,
                planOnly: planOnly === true,
              })
              st.lastLogged = out.text
            } catch {
              // 永不打断注入
            }
          }
          return out.text
        }

        // M2：预取向量齐备且工具集未变 → 三级合议；否则纯规则（v0.1 行为）
        if (st.taskVec !== null && st.toolVecs !== null && st.toolVecs.size > 0
          && st.toolVecKey === view.schemas.map(s => s.name).join(',')) {
          const engine = semantic()
          const out = core.buildHintSemantic({
            text: st.text,
            hasImage: st.hasImage,
            schemas: view.schemas,
            enrich,
            state: st,
            mode: view.mode,
            planOnly,
            taskVec: st.taskVec,
            toolVectors: st.toolVecs,
            semThreshold: engine !== null && engine !== undefined ? engine.threshold : undefined,
            notForVectors: st.notForVecs,
            index: view.index,
          })
          if (out !== null) {
            if (out.pendingTop.length > 0) st.pendingTop = out.pendingTop
            return emit(out)
          }
        }

        const out = core.buildHint({
          text: st.text,
          hasImage: st.hasImage,
          schemas: view.schemas,
          enrich,
          state: st,
          mode: view.mode,
          planOnly,
          index: view.index,
        })
        if (out.pendingTop.length > 0) st.pendingTop = out.pendingTop
        return emit(out)
      } catch {
        return ''
      }
    },
  })

  const engine = semantic()
  return { mode: 'adapter-ready', semanticEnabled: engine !== null && engine !== undefined && engine.ok === true }
}
