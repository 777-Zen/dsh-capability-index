/**
 * dsh-capability-index —— 离线模拟器（阶段二）。
 *
 * 不依赖运行实例：直接调用 evaluate + rankTop，用 demo-cap 的声明与工具
 * schema 模拟"命中 → Top-K 推送"，用于扩库后第一时间核对样本预期判定。
 *
 * 用法：node eval-results/simulate.mjs
 */

import { readFileSync } from 'node:fs'
import { evaluate, rankTop } from '../lib/index.js'
import { DECLARATIONS } from '../examples/dsh-tool-demo-cap/lib/index.js'

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

console.log('样本 → 判定 → Top-K 推送（离线模拟，demo-cap + S2 内置工具）\n')
let mismatch = 0
for (const s of json.samples) {
  const dec = evaluate(s.text)
  const top = rankTop(DEMO_SCHEMAS, s.text, dec, { lastTop: [] }, enrich)
  const showPushed = dec.kind === 'T2' ? top.map(e => e.name).join(', ') || '—' : '—（非 T2，无 Top-K）'
  // 预期判定：'none-or-light' 接受 none/T3；其余精确匹配
  const expectedOk = s.expected === 'none-or-light'
    ? (dec.kind === 'none' || dec.kind === 'T3')
    : dec.kind === s.expected
  // 落点检查：仅 T2 会渲染 Top-K；T1/T3/none 只查"绝不推"（无 Top-K 即无错推）
  const okPush = dec.kind !== 'T2' || s.groundTruth.shouldUse.every(t => top.some(e => e.name === t))
  const badPush = top.some(e => s.groundTruth.neverPush.includes(e.name))
  if (!expectedOk || !okPush || badPush) mismatch += 1
  console.log(
    `${s.id} ${dec.kind}${expectedOk ? '' : `(预期 ${s.expected})`}${okPush ? '' : ' ✗缺落点'}${badPush ? ' ✗错推' : ''}`,
    `| 推: ${showPushed} | 真值: [${s.groundTruth.shouldUse.join('/') || '—'}] 绝不: [${s.groundTruth.neverPush.join('/') || '—'}]`,
  )
}
console.log(`\n${mismatch === 0 ? '全部样本与预期一致' : mismatch + ' 条样本与预期不符'}`)
process.exit(mismatch === 0 ? 0 : 1)
