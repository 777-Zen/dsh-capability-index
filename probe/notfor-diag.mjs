/**
 * 一次性诊断（not_for 守门闸阈值定参，2026-08-26）：
 * 回答"闸门净效果 -1 召回性单位来自谁"——列出每个样本在两段式闸门下的
 * blocked/warned 明细与关键嵌入相似度，区分"S9 收益"与"合法工具附带伤害"。
 * 用完可删；模型/缓存口径与 calibrate.mjs 一致。
 */
import { pipeline, env } from '@huggingface/transformers'
import { evaluate, rankTop, semanticVerdict, fuseLayers, applyNotForGate } from '../dsh-capability-index/lib/core.js'
import { TRIGGER_TABLE } from '../dsh-capability-index/lib/trigger-table.js'
import { DECLARATIONS } from '../dsh-tool-demo-cap/lib/index.js'
import { readFileSync } from 'node:fs'

env.remoteHost = 'https://hf-mirror.com'
env.cacheDir = 'D:\\dsh-lab\\.hf-cache'

const CFG = TRIGGER_TABLE.notForGate
const K = TRIGGER_TABLE.topK
const POOL = 64
const corpus = JSON.parse(readFileSync(new URL('../eval-results/tool-corpus.json', import.meta.url), 'utf8'))
const SCHEMAS = corpus.tools.map(t => ({ name: t.name, description: t.description }))
const enrich = new Map(DECLARATIONS.map(d => [d.tool, d]))
const { samples: SAMPLES } = JSON.parse(readFileSync(new URL('../eval-results/samples.json', import.meta.url), 'utf8'))

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8', cache_dir: 'D:\\dsh-lab\\.hf-cache' })
const encode = async t => Float32Array.from((await extractor(t, { pooling: 'mean', normalize: true })).data)
const dot = (a, b) => { let r = 0; for (let i = 0; i < a.length; i++) r += a[i] * b[i]; return r }

const toolVecs = new Map()
for (const s of SCHEMAS) {
  const kw = Array.isArray(enrich.get(s.name)?.keywords) ? enrich.get(s.name).keywords : []
  toolVecs.set(s.name, await encode([s.name, s.description, ...kw].filter(Boolean).join(' ')))
}
const nfVecs = new Map()
for (const [tool, decl] of enrich) {
  if (typeof decl?.not_for === 'string' && decl.not_for !== '') nfVecs.set(tool, await encode(decl.not_for))
}

console.log('── 关键嵌入相似度：消息 × vec(not_for) ──')
for (const s of SAMPLES) {
  if (!['S6', 'S8', 'S9', 'S10', 'S12'].includes(s.id)) continue
  const tv = await encode(s.text)
  const parts = []
  for (const [tool, nv] of nfVecs) {
    parts.push(`${tool}:${dot(tv, nv).toFixed(3)}`)
  }
  console.log(`${s.id}  ${parts.join('  ')}`)
}

console.log('\n── 两段式闸门明细 @当前配置 ──')
for (const s of SAMPLES) {
  const dec = evaluate(s.text)
  if (dec.kind !== 'T2') continue
  const taskVec = await encode(s.text)
  const ruleTop = rankTop(SCHEMAS, s.text, dec, { lastTop: [] }, enrich, { limit: POOL })
  const verdict = semanticVerdict(taskVec, toolVecs, { threshold: TRIGGER_TABLE.embed.threshold, k: POOL })
  const fused = fuseLayers({ ruleTop, semTop: verdict.hit ? verdict.top : [], k: POOL })
  const pg = applyNotForGate({ candidates: fused.candidates, text: s.text, enrich, taskVec, notForVectors: nfVecs, config: CFG, scope: 'pool' })
  const wg = applyNotForGate({ candidates: pg.candidates.slice(0, K), text: s.text, enrich, taskVec, notForVectors: nfVecs, config: CFG })
  const basePushed = fused.candidates.slice(0, K).map(e => e.name)
  const gatePushed = wg.candidates.map(e => e.name)
  const gt = s.groundTruth ?? {}
  const su = gt.shouldUse ?? []
  const frac = names => su.length === 0 ? null : Math.round(su.filter(t => names.includes(t)).length / su.length * 100) / 100
  console.log(
    `${s.id} 基线推[${basePushed.join('/')}] r=${frac(basePushed)}` 
    + ` || 闸门推[${gatePushed.join('/')}] r=${frac(gatePushed)}`
    + ` || 池拦[${pg.blocked.join('/') || '—'}] 警[${wg.warned.join('/') || '—'}]`,
  )
}

console.log('\n── 全样本两配置对比（含非 T2 语义路径）──')
let baseSum = 0, gateSum = 0, baseN = 0
for (const s of SAMPLES) {
  const dec = evaluate(s.text)
  const taskVec = await encode(s.text)
  const ruleTop = dec.kind === 'T2'
    ? rankTop(SCHEMAS, s.text, dec, { lastTop: [] }, enrich, { limit: POOL })
    : []
  const verdict = semanticVerdict(taskVec, toolVecs, { threshold: TRIGGER_TABLE.embed.threshold, k: POOL })
  const fused = fuseLayers({ ruleTop, semTop: verdict.hit ? verdict.top : [], k: POOL })
  const pg = applyNotForGate({ candidates: fused.candidates, text: s.text, enrich, taskVec, notForVectors: nfVecs, config: CFG, scope: 'pool' })
  const wg = applyNotForGate({ candidates: pg.candidates.slice(0, K), text: s.text, enrich, taskVec, notForVectors: nfVecs, config: CFG })
  const gt = s.groundTruth ?? {}
  const su = gt.shouldUse ?? []
  if (su.length === 0) continue
  baseN += 1
  const bp = fused.candidates.slice(0, K).map(e => e.name)
  const gp = wg.candidates.map(e => e.name)
  const bf = su.filter(t => bp.includes(t)).length / su.length
  const gf = su.filter(t => gp.includes(t)).length / su.length
  baseSum += bf
  gateSum += gf
  if (bf !== gf) {
    console.log(`${s.id} ★差异 基线[${bp.join('/')}]r=${bf} || 闸门[${gp.join('/')}]r=${gf} || 警[${wg.warned.join('/')}] 拦[${[...pg.blocked, ...wg.blocked].join('/')}]`)
  } else {
    console.log(`${s.id} 同 r=${bf}`)
  }
}
console.log(`基线 posRecall=${Math.round(baseSum / baseN * 1000) / 1000} 闸门 posRecall=${Math.round(gateSum / baseN * 1000) / 1000}`)
