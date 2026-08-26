/**
 * dsh-capability-index —— 决策日志（M3 数据基建，2026-08-25 用户拍板建设）。
 *
 * 目的：把"观察"从会话内的 agent 搬进插件本体——每次注入提示块时追加一行
 * JSONL 到 `<cacheDir>/decisions.jsonl`，生产持续产生校准数据；未来任意会话
 * （或 eval-results/calibrate.mjs）可直接离线挖矿，不依赖某个"我"在场。
 *
 * 行格式（handoff-opt §5.1 规格为准，附加 decision/mode/planOnly 供 PTC 与
 * 合议路径审计）：{ ts, msgHead≤120字, kind, decision?, hit?, pushed[],
 * semTop[{name,score}]≤5, mode?, planOnly? }
 *
 * 约束：
 *  - 纯本地无网络；默认目录 DSH_HOME/.cache/dsh-capability-index（D 盘纪律）；
 *  - config 可关（index.js: config.decisionLog.enabled === false → 不创建）；
 *  - 任何写入失败 → 静默永久停用（broken 门闩），绝不影响注入主链路；
 *  - 只落纯数据叶子字段（sanitize 防御性收敛形状），不携带任何运行时引用。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const DECISIONS_FILENAME = 'decisions.jsonl'

/**
 * 创建决策日志记录器。
 * @param {object} options
 *   - dir: 日志目录（必填字符串才启用；空/缺失返回 null = 停用）
 * @returns {((entry: object) => void) | null}
 */
export function createDecisionLogger({ dir } = {}) {
  if (typeof dir !== 'string' || dir === '') return null
  const file = join(dir.replace(/[\\/]+$/, ''), DECISIONS_FILENAME)
  let broken = false
  return function logDecision(entry) {
    if (broken) return
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...sanitize(entry) })}\n`, 'utf8')
    } catch {
      broken = true
    }
  }
}

/** 防御性收敛：只保留规格内叶子字段，畸形输入不炸、不多记。 */
function sanitize(entry) {
  const out = {}
  if (entry === null || typeof entry !== 'object') return out
  if (typeof entry.msgHead === 'string' && entry.msgHead !== '') out.msgHead = entry.msgHead.slice(0, 120)
  if (typeof entry.kind === 'string' && entry.kind !== '') out.kind = entry.kind
  if (typeof entry.decision === 'string' && entry.decision !== '') out.decision = entry.decision
  if (typeof entry.hit === 'boolean') out.hit = entry.hit
  if (Array.isArray(entry.pushed)) {
    const names = entry.pushed.filter(n => typeof n === 'string' && n !== '')
    if (names.length > 0) out.pushed = names.slice(0, 8)
  }
  if (Array.isArray(entry.semTop)) {
    const tops = entry.semTop
      .filter(e => e !== null && typeof e === 'object' && typeof e.name === 'string' && e.name !== '')
      .slice(0, 5)
      .map(e => ({ name: e.name, score: typeof e.score === 'number' && Number.isFinite(e.score)
        ? Math.round(e.score * 10000) / 10000 : null }))
    if (tops.length > 0) out.semTop = tops
  }
  // 守门闸字段（M3 plan-notfor-gate，加法式向后兼容）：空数组不落盘
  for (const field of ['gateBlocked', 'gateWarned']) {
    if (Array.isArray(entry[field])) {
      const names = entry[field].filter(n => typeof n === 'string' && n !== '')
      if (names.length > 0) out[field] = names.slice(0, 8)
    }
  }
  if (entry.mode === 'native' || entry.mode === 'code') out.mode = entry.mode
  if (entry.planOnly === true) out.planOnly = true
  return out
}
