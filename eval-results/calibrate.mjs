/**
 * dsh-capability-index —— M3 主力离线校准脚本（handoff-opt §5.1 数据通道 1）。
 *
 * 职责（完全不依赖任何会话在场——样本在 samples.json 里，本脚本随时可跑可重跑）：
 *   1. 阈值扫描：对 embed.threshold 逐档取值，按生产同款三级合议
 *      （evaluate → rankTop → semanticVerdict(hit 门控) → fuseLayers）模拟推送，
 *      出三指标：正例召回 / 反例噪音 / 绝不推违规。
 *   2. 排序审计：在当前阈值下打印每样本的相似度全序前 5 与正确工具位次
 *      （EN 英文排序质量、todo_write 噪音等 M3 校准点的直接证据）。
 *   3. 报告落盘：eval-results/calibrate-report.json（数据说话，不自动改配置）。
 *
 * 口径：
 *  - 工具语料 = tool-corpus.json（≈生产 36 工具的子集近似；真值引用全覆盖，
 *    缺口会显式警告）；声明 keywords 并入工具文本（与生产 embedToolVectors 一致）。
 *  - known-fail 样本（如 S14）参与统计并单独标注——它们正是阈值的反面证据。
 *  - 模型/缓存/镜像与生产一致：bge-small-zh-v1.5 q8、hf-mirror、D 盘 .hf-cache。
 *
 * 用法：node eval-results/calibrate.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pipeline, env } from '@huggingface/transformers'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// 双布局兼容：仓库克隆（eval-results 与 lib/examples 同级）或工作区开发树（包目录平级）
const HERE = dirname(fileURLToPath(import.meta.url))
const firstExisting = (...candidates) => {
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(`layout resolution failed; tried:\n  ${candidates.join('\n  ')}`)
}
const imp = (p) => import(pathToFileURL(p).href)
const LIB_DIR = dirname(firstExisting(
  join(HERE, '..', 'lib', 'core.js'),
  join(HERE, '..', 'dsh-capability-index', 'lib', 'core.js'),
))
const DEMO_INDEX = firstExisting(
  join(HERE, '..', 'examples', 'dsh-tool-demo-cap', 'lib', 'index.js'),
  join(HERE, '..', 'dsh-tool-demo-cap', 'lib', 'index.js'),
)
const { evaluate, rankTop, semanticVerdict, fuseLayers, applyNotForGate } = await imp(join(LIB_DIR, 'core.js'))
const { TRIGGER_TABLE } = await imp(join(LIB_DIR, 'trigger-table.js'))
const { DECLARATIONS } = await imp(DEMO_INDEX)

env.remoteHost = 'https://hf-mirror.com'
// 权重缓存：优先工作区规范路径，克隆环境退回仓库旁 .hf-cache
const HF_CACHE_WS = 'D:\\dsh-lab\\.hf-cache'
env.cacheDir = existsSync(HF_CACHE_WS) ? HF_CACHE_WS : join(HERE, '..', '.hf-cache')

const K = TRIGGER_TABLE.topK
const BASE_THRESHOLD = TRIGGER_TABLE.embed.threshold
const GATE_CFG = TRIGGER_TABLE.notForGate ?? null
const POOL = 64 // 守门闸预截断池（与 core.js GATE_POOL_LIMIT 同口径）

const corpus = JSON.parse(readFileSync(new URL('./tool-corpus.json', import.meta.url), 'utf8'))
const SCHEMAS = corpus.tools.map(t => ({ name: t.name, description: t.description }))
const enrich = new Map(DECLARATIONS.map(d => [d.tool, d]))
const { samples: SAMPLES } = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url), 'utf8'))

// 语料覆盖检查：真值引用了语料外工具 → 显式警告（口径缺口不静默）
const known = new Set(SCHEMAS.map(s => s.name))
for (const s of SAMPLES) {
  for (const t of [...(s.groundTruth?.shouldUse ?? []), ...(s.groundTruth?.neverPush ?? [])]) {
    if (!known.has(t)) console.log(`⚠ 语料缺口：${s.id} 真值引用 "${t}" 不在 tool-corpus.json`)
  }
}

console.log(`dsh-capability-index 校准（模型 bge-small-zh-v1.5 q8 / 语料 ${SCHEMAS.length} 工具 / 样本 ${SAMPLES.length} 条）\n`)

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', {
  dtype: 'q8', cache_dir: 'D:\\dsh-lab\\.hf-cache',
})
const encode = async text => {
  const out = await extractor(text, { pooling: 'mean', normalize: true })
  return Float32Array.from(out.data)
}
const dot = (a, b) => { let r = 0; for (let i = 0; i < a.length; i++) r += a[i] * b[i]; return r }

// 工具向量（name + description + 声明 keywords，多源文本与生产一致）
const toolVecs = new Map()
for (const s of SCHEMAS) {
  const kw = Array.isArray(enrich.get(s.name)?.keywords) ? enrich.get(s.name).keywords : []
  toolVecs.set(s.name, await encode([s.name, s.description, ...kw].filter(Boolean).join(' ')))
}

// not_for 向量（守门闸嵌入信号；仅携带 not_for 的声明参与）
const notForVecs = new Map()
for (const [tool, decl] of enrich) {
  if (typeof decl?.not_for === 'string' && decl.not_for !== '') {
    notForVecs.set(tool, await encode(decl.not_for))
  }
}

// 每样本预计算：任务向量 / 规则层（预截断池）/ 相似度全序（排序审计用）
const prepared = []
for (const s of SAMPLES) {
  const taskVec = await encode(s.text)
  const dec = evaluate(s.text)
  const ruleTop = dec.kind === 'T2'
    ? rankTop(SCHEMAS, s.text, dec, { lastTop: [] }, enrich, { limit: POOL }).map(e => ({ name: e.name }))
    : []
  const simAll = [...toolVecs.entries()]
    .map(([name, v]) => ({ name, score: dot(taskVec, v) }))
    .sort((a, b) => b.score - a.score)
  prepared.push({ ...s, taskVec, dec, ruleTop, simAll })
}

/**
 * 给定阈值与闸门配置，按生产三级合议 + 守门闸模拟全部样本的推送结果。
 * gateCfg = null → 无闸门（v0.2 M2 基线口径，供对比）；给定 → 带闸门。
 */
function fusionAt(threshold, gateCfg = null) {
  return prepared.map(p => {
    const verdict = semanticVerdict(p.taskVec, toolVecs, { threshold, k: POOL })
    const fused = fuseLayers({ ruleTop: p.ruleTop, semTop: verdict.hit ? verdict.top : [], k: POOL })
    let candidates = fused.candidates
    let blocked = []
    let warned = []
    if (gateCfg !== null) {
      // 两段式（与生产一致）：池级只硬拦 → 截 K → 窗口段软处理
      const poolGated = applyNotForGate({
        candidates,
        text: p.text,
        enrich,
        taskVec: p.taskVec,
        notForVectors: notForVecs,
        config: gateCfg,
        scope: 'pool',
      })
      const windowGated = applyNotForGate({
        candidates: poolGated.candidates.slice(0, K),
        text: p.text,
        enrich,
        taskVec: p.taskVec,
        notForVectors: notForVecs,
        config: gateCfg,
      })
      candidates = windowGated.candidates
      blocked = [...poolGated.blocked, ...windowGated.blocked]
      warned = windowGated.warned
    } else {
      // 无闸门基线同样截 K（2026-08-26 修复：此前漏截导致基线召回虚高，
      // 出现过"基线 0.857 vs 闸门 0.714"的假回归——probe/notfor-diag 定案：
      // 两配置逐样本成员一致，真实净效果 = 违规清零 + S9 转合规，召回零损失）
      candidates = candidates.slice(0, K)
    }
    const pushed = candidates.map(e => e.name)
    return { p, decision: fused.decision, pushed, hit: verdict.hit, blocked, warned }
  })
}

/** 三指标 + 合议路径分布。known-fail 样本的违规单列（其问题在词表/声明，
 * 与向量阈值正交；阈值推荐只看非 kf 违规，但数据全部如实呈现）。
 * 守门口径（plan §4.5）：neverPush 命中但带 gateWarn 软警示不计违规，
 * 单列 warnedHits；硬拦条目已不在 pushed 中（单列 blockedTotal 供观察）。 */
function score(rows) {
  let posN = 0, posRecallSum = 0, negN = 0, negNoise = 0, violations = 0, kfViolations = 0, advisoryN = 0
  let warnedHits = 0, blockedTotal = 0, warnedTotal = 0
  for (const { p, pushed, decision, blocked = [], warned = [] } of rows) {
    const gt = p.groundTruth ?? {}
    if ((gt.shouldUse ?? []).length > 0) {
      posN += 1
      posRecallSum += gt.shouldUse.filter(t => pushed.includes(t)).length / gt.shouldUse.length
    } else {
      negN += 1
      if (pushed.length > 0) negNoise += 1
    }
    const never = gt.neverPush ?? []
    if (never.some(n => pushed.includes(n) && !warned.includes(n))) {
      if (p.knownFail === true) kfViolations += 1
      else violations += 1
    }
    if (never.some(n => warned.includes(n))) warnedHits += 1
    blockedTotal += blocked.length
    warnedTotal += warned.length
    if (decision === 'conflict' || decision === 'semantic-only') advisoryN += 1
  }
  return {
    posRecall: posN > 0 ? Math.round((posRecallSum / posN) * 1000) / 1000 : null,
    posN,
    negNoise,
    negN,
    violations,
    kfViolations,
    advisory: advisoryN,
    warnedHits,
    blockedTotal,
    warnedTotal,
  }
}

// ---- 1. 阈值扫描（主口径：带当前生产闸门配置，与生产路径一致） ----
const gateLabel = GATE_CFG !== null ? `闸门开（hard=${GATE_CFG.hardSim}/soft=${GATE_CFG.softSim}）` : '闸门关'
console.log(`── 阈值扫描（${gateLabel}；正例召回↑ / 反例噪音↓ / 违规必须为 0；warnedHits=软警示合规数）──`)
console.log('thr    正例召回  (n)   反例噪音 (n)  违规(kf外+kf内)  warnedHits  拦/警总数  带内advisory')
const sweep = []
for (let t = 0.20; t <= 0.6001; t = Math.round((t + 0.01) * 1000) / 1000) {
  const rows = fusionAt(t, GATE_CFG)
  const m = score(rows)
  sweep.push({ threshold: t, ...m })
  console.log(
    `${t.toFixed(2)}   ${m.posRecall === null ? '  —' : m.posRecall.toFixed(3)}   (${m.posN})   `
    + `${m.negNoise}/${m.negN}          ${m.violations}+${m.kfViolations}            ${m.warnedHits}        `
    + `${m.blockedTotal}/${m.warnedTotal}        ${m.advisory}`,
  )
}
// 无闸门基线（M2 口径）：分离"阈值效果"与"闸门效果"
const baseNoGate = score(fusionAt(BASE_THRESHOLD, null))
const baseRow = sweep.find(r => r.threshold === BASE_THRESHOLD)
console.log(`\n当前生产阈值 ${BASE_THRESHOLD}：正例召回 ${baseRow?.posRecall}，反例噪音 ${baseRow?.negNoise}/${baseRow?.negN}，违规 ${baseRow?.violations}(+kf ${baseRow?.kfViolations})，warnedHits ${baseRow?.warnedHits}`)
console.log(`同阈值无闸门基线：正例召回 ${baseNoGate.posRecall}，反例噪音 ${baseNoGate.negNoise}/${baseNoGate.negN}，违规 ${baseNoGate.violations}(+kf ${baseNoGate.kfViolations})——差值即闸门净效果`)

// ---- 1b. 守门闸网格扫描（plan §4.4：hardSim/softSim 初值以扫描数据为准） ----
console.log('\n── 闸门网格 @embed阈值' + BASE_THRESHOLD + '（v=违规 kf外+kf内 / r=召回 / n=噪音 / b=拦截数 / w=警示数 / S9=挂账样本状态）──')
console.log('hard\\soft     0.35        0.40        0.45        0.50        0.55')
const HARD_SIMS = [0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
const SOFT_SIMS = [0.35, 0.40, 0.45, 0.50, 0.55]
const gateSweep = []
for (const hard of HARD_SIMS) {
  const cells = []
  for (const soft of SOFT_SIMS) {
    if (soft >= hard) { cells.push('    —    '); continue }
    const cfg = { ...(GATE_CFG ?? {}), enabled: true, hardSim: hard, softSim: soft }
    const rows = fusionAt(BASE_THRESHOLD, cfg)
    const m = score(rows)
    const s9 = rows.find(r => r.p.id === 'S9')
    const s9Ok = s9 !== undefined && (!s9.pushed.includes('batch_transform') || s9.warned.includes('batch_transform'))
    cells.push(`${m.violations}+${m.kfViolations} r${m.posRecall?.toFixed(2)} b${m.blockedTotal} w${m.warnedTotal}${s9Ok ? '✓' : '✗'}`)
    gateSweep.push({ hardSim: hard, softSim: soft, ...m, s9Compliant: s9Ok })
  }
  console.log(`${hard.toFixed(2)}   ${cells.join('  ')}`)
}

// ---- 2. 当前阈值下的逐样本审计（带生产闸门口径） ----
const baseRows = fusionAt(BASE_THRESHOLD, GATE_CFG)
console.log(`\n── 排序审计 @${BASE_THRESHOLD}（相似度前 5；★=真值该用，▲=绝不推；含合议推送）──`)
const audit = []
for (let i = 0; i < prepared.length; i++) {
  const p = prepared[i]
  const gt = { shouldUse: p.groundTruth?.shouldUse ?? [], neverPush: p.groundTruth?.neverPush ?? [] }
  const tag = e => (gt.shouldUse.includes(e.name) ? '★' : gt.neverPush.includes(e.name) ? '▲' : '')
  const top5 = p.simAll.slice(0, 5).map(e => `${e.name}${tag(e)}(${e.score.toFixed(3)})`).join(' ')
  const correctRanks = gt.shouldUse.map(t => `${t}#${p.simAll.findIndex(e => e.name === t) + 1}`).join('/') || '—'
  const row = baseRows[i]
  audit.push({
    id: p.id, kind: p.dec.kind, expected: p.expected, knownFail: p.knownFail === true,
    simTop5: p.simAll.slice(0, 5).map(e => ({ name: e.name, score: Math.round(e.score * 10000) / 10000 })),
    correctRank: Object.fromEntries(gt.shouldUse.map(t => [t, p.simAll.findIndex(e => e.name === t) + 1])),
    hitAtBase: row.hit,
    decisionAtBase: row.decision,
    pushedAtBase: row.pushed,
    textHead: p.text.slice(0, 40),
  })
  console.log(
    `${p.id}${p.knownFail ? '(kf)' : ''} [${p.dec.kind}] 相似度: ${top5}\n`
    + `        正确位次: ${correctRanks} | 规则层: ${p.ruleTop.map(e => e.name).join('/') || '—'}`
    + ` | hit=${row.hit} ${row.decision} → 推[${row.pushed.join('/') || '—'}]`,
  )
}

// ---- 3. 报告落盘（只出数据与建议，不改配置） ----
const candidates = sweep.filter(r => r.violations === 0 && r.posRecall !== null)
  .sort((a, b) => b.posRecall - a.posRecall || a.negNoise - b.negNoise)
const suggestion = candidates[0]
  ? `候选最优 ${candidates[0].threshold}（召回 ${candidates[0].posRecall}/噪音 ${candidates[0].negNoise}/${candidates[0].negN}）；是否调整由人工拍板后改 trigger-table.js`
  : '无零违规档位——先补 not_for/词表再谈阈值'

const report = {
  generatedAt: new Date().toISOString(),
  model: 'Xenova/bge-small-zh-v1.5 q8',
  corpusSize: SCHEMAS.length,
  sampleCount: SAMPLES.length,
  baseThreshold: BASE_THRESHOLD,
  gateConfig: GATE_CFG,
  baseMetrics: baseRow ?? null,
  noGateBaseline: baseNoGate,
  gateSweep,
  sweep,
  audit,
  suggestion,
}
writeFileSync(new URL('./calibrate-report.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8')
console.log(`\n${suggestion}`)
console.log('报告已写入 eval-results/calibrate-report.json')
