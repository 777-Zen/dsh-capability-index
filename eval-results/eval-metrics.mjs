/**
 * dsh-capability-index —— 实验评分脚本（阶段二，零依赖纯 ESM）。
 *
 * 用法：node eval-metrics.mjs [--json]
 *
 * 输入：eval-results/samples.json（活样本库；runs 逐条追加，真值信 tool/call 日志与快照）
 * 输出：三指标（按 B/C 组对比）
 *   指标 1 调用率：正例样本中 groundTruth.shouldUse 与 used 的交集命中率
 *   指标 2 误触发率：两向都记——正例"该推没推" + 反例"不该推却推"
 *   指标 3 上下文增量：每条消息提示块渲染长度（hintChars，缺省按提示块条目估算）
 *
 * 约定：不写文件，只读样本库并打印结果（写回记录由会话手工完成）。
 */

import { readFileSync } from 'node:fs'

const PATH = new URL('./samples.json', import.meta.url)
const json = JSON.parse(readFileSync(PATH, 'utf8'))
const samples = json.samples

// ---- 指标 1：调用率（正例 shouldUse 命中）----
function callRate(runs) {
  if (runs.length === 0) return null
  let hits = 0
  const details = []
  for (const r of runs) {
    const should = r._shouldUse ?? []
    const used = r.used ?? []
    const hit = should.length === 0 ? null : should.some(t => used.includes(t))
    if (hit === true) hits += 1
    if (hit !== null) details.push(`${r._id}:${hit ? '✓' : '✗'}`)
  }
  return { rate: hits / details.length, details }
}

// ---- 指标 2：误触发（两向）----
// 漏推只对 T2 硬层样本计数（T3/none 走软层总览，无 Top-K 是设计行为——
// 模型从总览找到工具属于调用率口径，不算漏推），且只对 C 组有效
// （B 组无注入机制，pushed 恒为空，"漏推"不适用）。
function falseTrigger(runs) {
  let missPush = 0 // 该推没推：C 组 T2 样本的 shouldUse 工具一个都没进 pushed
  let badPush = 0 // 不该推却推：neverPush 工具进了 pushed
  const missDetails = []
  const badDetails = []
  for (const r of runs) {
    const should = r._shouldUse ?? []
    const never = r._neverPush ?? []
    const pushed = r.pushed ?? []
    if (r.group === 'C' && r._expected === 'T2' && should.length > 0 && !should.some(t => pushed.includes(t))) {
      missPush += 1
      missDetails.push(`${r._id}:该推没推(${should.join('/')})→推了[${pushed.join(',') || '无'}]`)
    }
    for (const t of never) {
      if (pushed.includes(t)) {
        badPush += 1
        badDetails.push(`${r._id}:不该推却推(${t})`)
      }
    }
  }
  return { missPush, badPush, missDetails, badDetails }
}

// ---- 指标 3：上下文增量（hintChars 实测优先，缺省估算）----
function estimateHintChars(run) {
  if (run.group === 'B') return 0 // B 组无注入，增量恒为 0
  if (typeof run.hintChars === 'number' && run.hintChars > 0) return run.hintChars
  const j = run.judgment
  if (j === 'T2') {
    const names = (run.pushed ?? []).map(n => n.length)
    const desc = (run.pushed ?? []).length * 50 // 描述截断预算
    return 60 + names.reduce((a, b) => a + b, 0) + desc + (run.pushed.length > 0 ? 20 : 0)
  }
  return 40 // T1/总览兜底：轻量行
}

function hintStats(runs) {
  if (runs.length === 0) return null
  const chars = runs.map(estimateHintChars)
  const sum = chars.reduce((a, b) => a + b, 0)
  return { mean: Math.round(sum / chars.length), perRun: chars }
}

// ---- 汇总（按组 + 整体）----
// 真值优先取 run.truth（每轮可覆盖样本级真值，如扩库前 S6 无对应工具）。
function groupRuns(group) {
  const runs = []
  for (const s of samples) {
    for (const r of s.runs) {
      if (r.group !== group) continue
      runs.push({
        ...r,
        _id: s.id,
        _expected: s.expected,
        _shouldUse: r.truth ? r.truth.shouldUse : s.groundTruth.shouldUse,
        _neverPush: r.truth ? r.truth.neverPush : s.groundTruth.neverPush,
      })
    }
  }
  return runs
}

const groups = ['B', 'C']
const table = []
for (const g of groups) {
  const runs = groupRuns(g)
  if (runs.length === 0) {
    table.push({ group: g, n: 0, callRate: null, missPush: 0, badPush: 0, hintChars: null })
    continue
  }
  const cr = callRate(runs)
  const ft = falseTrigger(runs)
  const hs = hintStats(runs)
  table.push({
    group: g, n: runs.length,
    callRate: cr, missPush: ft.missPush, badPush: ft.badPush,
    missDetails: ft.missDetails, badDetails: ft.badDetails,
    hintChars: hs,
  })
}

const flag = process.argv.includes('--json')
if (flag) {
  console.log(JSON.stringify(table, null, 2))
} else {
  console.log(`样本库：${samples.length} 条（${samples.filter(s => s.runs.length > 0).length} 条已有实测）`)
  for (const t of table) {
    console.log(`\n[组 ${t.group}] 实测 ${t.n} 条`)
    if (t.n === 0) { console.log('  无数据'); continue }
    const cr = t.callRate
    console.log(`  指标1 调用率：${cr.rate === null ? '无正例样本' : (cr.rate * 100).toFixed(0) + '%'}  ${cr.details.join(' ')}`)
    console.log(`  指标2 误触发：该推没推 ${t.missPush} 次 / 不该推却推 ${t.badPush} 次`)
    for (const d of t.missDetails) console.log(`    漏推 ${d}`)
    for (const d of t.badDetails) console.log(`    错推 ${d}`)
    console.log(`  指标3 上下文增量：平均 ${t.hintChars.mean} 字符/条（预算：T2 Top-3 约 50×3+40 ≈ 190；总览 ≤260）`)
  }
}
