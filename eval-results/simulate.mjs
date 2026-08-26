/**
 * dsh-capability-index —— 离线模拟器（阶段二；M1 起 import 纯逻辑层 core.js）。
 *
 * 不依赖运行实例：直接调用 evaluate + rankTop，用 demo-cap 的声明与工具
 * schema 模拟"命中 → Top-K 推送"，用于扩库后第一时间核对样本预期判定。
 * 回归断言见 verify.mjs（npm run verify）。
 *
 * 用法：node eval-results/simulate.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// 双布局兼容：仓库克隆（eval-results 与 lib/examples 同级）或工作区开发树（包目录平级）
const HERE = dirname(fileURLToPath(import.meta.url))
const firstExisting = (...candidates) => {
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(`layout resolution failed; tried:\n  ${candidates.join('\n  ')}`)
}
const imp = (p) => import(pathToFileURL(p).href)
const CORE = firstExisting(
  join(HERE, '..', 'lib', 'core.js'),
  join(HERE, '..', 'dsh-capability-index', 'lib', 'core.js'),
)
const DEMO_INDEX = firstExisting(
  join(HERE, '..', 'examples', 'dsh-tool-demo-cap', 'lib', 'index.js'),
  join(HERE, '..', 'dsh-tool-demo-cap', 'lib', 'index.js'),
)
const { evaluate, rankTop, applyNotForGate } = await imp(CORE)
const { DECLARATIONS } = await imp(DEMO_INDEX)

// demo-cap 工具 schema + S2 落点所需的内置工具（read/glob 描述与真实工具一致）
const DEMO_SCHEMAS = [
  { name: 'echo', description: 'Echo back the given text. A smoke-test tool proving this plugin row reached the composed tree and registered into the tools registry.' },
  { name: 'concat_text', description: 'Concatenate multiple text pieces into one string, optionally inserting a separator between them.' },
  { name: 'format_text', description: 'Format a text string: change case (upper/lower/title), trim surrounding whitespace, or collapse repeated whitespace.' },
  { name: 'batch_transform', description: 'Apply one transformation to every item of a list: case change, trim, or prefix/suffix injection — for batch operations on many items.' },
  { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.' },
  { name: 'glob', description: 'Find files whose paths match a glob pattern.' },
]

const enrich = new Map(DECLARATIONS.map(d => [d.tool, d]))
const json = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url), 'utf8'))

console.log('样本 → 判定 → Top-K 推送（离线模拟，demo-cap + S2 内置工具；含 not_for 守门闸，离线为关键词单信号口径）\n')
let mismatch = 0
let knownFail = 0
let kfGreen = 0
for (const s of json.samples) {
  const dec = evaluate(s.text)
  const top = rankTop(DEMO_SCHEMAS, s.text, dec, { lastTop: [] }, enrich)
  // 守门闸（plan-notfor-gate）：离线无向量 → 关键词单信号只软处理（降位+警示）
  const gated = applyNotForGate({ candidates: top, text: s.text, enrich })
  const pushedNames = gated.candidates.map(e => e.name)
  const showPushed = dec.kind === 'T2' ? pushedNames.join(', ') || '—' : '—（非 T2，无 Top-K）'
  const gateInfo = `拦: ${gated.blocked.join('/') || '—'} 警: ${gated.warned.join('/') || '—'}`
  // 预期判定：'none-or-light' 接受 none/T3；其余精确匹配
  const expectedOk = s.expected === 'none-or-light'
    ? (dec.kind === 'none' || dec.kind === 'T3')
    : dec.kind === s.expected
  // 落点检查：仅 T2 会渲染 Top-K；T1/T3/none 只查"绝不推"（无 Top-K 即无错推）。
  // 守门口径（plan §4.5 验收铁证）：neverPush 命中但带 gateWarn 软警示 = 合规
  //（生产验收标准"消失或带警示行"）；硬拦条目已从 candidates 移除，天然合规。
  const okPush = dec.kind !== 'T2' || s.groundTruth.shouldUse.every(t => pushedNames.includes(t))
  const badPush = gated.candidates.some(
    e => s.groundTruth.neverPush.includes(e.name) && e.gateWarn !== true,
  )
  const bad = !expectedOk || !okPush || badPush
  if (!bad && s.knownFail === true) {
    // known-fail 样本离线转绿：如实报告，标记移除待生产确认（plan §4.5）
    kfGreen += 1
    console.log(
      `${s.id} ${dec.kind} ✓ [known-fail 已离线转绿——生产确认后移除标记]`,
      `| 推: ${showPushed} | ${gateInfo} | 真值: [${s.groundTruth.shouldUse.join('/') || '—'}] 绝不: [${s.groundTruth.neverPush.join('/') || '—'}]`,
    )
    continue
  }
  if (bad && s.knownFail === true) {
    // M3 校准项（如 S14）：预期为正确判定而非现行为——显式标注，不计失败
    knownFail += 1
    console.log(
      `${s.id} ${dec.kind}(预期 ${s.expected}) ~ [known-fail，M3 校准项]`,
      `| 推: ${showPushed} | ${gateInfo} | 真值: [${s.groundTruth.shouldUse.join('/') || '—'}] 绝不: [${s.groundTruth.neverPush.join('/') || '—'}]`,
    )
    continue
  }
  if (bad) mismatch += 1
  console.log(
    `${s.id} ${dec.kind}${expectedOk ? '' : `(预期 ${s.expected})`}${okPush ? '' : ' ✗缺落点'}${badPush ? ' ✗错推' : ''}`,
    `| 推: ${showPushed} | ${gateInfo} | 真值: [${s.groundTruth.shouldUse.join('/') || '—'}] 绝不: [${s.groundTruth.neverPush.join('/') || '—'}]`,
  )
}
const kfNote = knownFail > 0 ? `；另 ${knownFail} 条 known-fail（M3 校准项，未计入）` : ''
const kfGreenNote = kfGreen > 0 ? `；${kfGreen} 条 known-fail 已离线转绿（待生产确认摘标）` : ''
console.log(`\n${mismatch === 0 ? '全部样本与预期一致' : mismatch + ' 条样本与预期不符'}${kfNote}${kfGreenNote}`)
process.exit(mismatch === 0 ? 0 : 1)
