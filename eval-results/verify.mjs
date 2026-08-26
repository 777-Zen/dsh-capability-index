/**
 * dsh-capability-index —— 纯逻辑回归（verify）。
 *
 * 零依赖（node:assert），直接 import lib/core.js / lib/dsh-adapter.js
 * （不经过 dsh 运行时）。断言组：
 *   A. 样本回归（samples.json S1–S12：判定 / 落点 / 反例）
 *   B. normalizeSchemas（run_code 过滤 / code 模式探测 / 非法输入）
 *   C. parseDeclarations（v1 契约 / v0 数字版本 / 无 version / 裸数组 / 非法条目）
 *   D. renderOverview（mode 感知文案）
 *   E. rankTop（planOnly 只读过滤 / hintedFactor 防反复推）
 *   F. buildHint 集成（T2 推送与声明渲染 / plan 只推只读 / T1·none 总览 / code 口径）
 *   G. 三级合议矩阵（fuseLayers 五态 / buildHintSemantic 全路径，mock 向量）
 *   H. 语义引擎纯函数（embed.js / semantic.js，mock encode 不加载模型）
 *   I. 排序索引等价（rankTopIndexed ≡ rankTop；缓存复用稳定性）
 *   J. 软层总览分组（阈值内平铺字节一致 / 超阈值分类聚合 + 其他尾部）
 *   K. adapter 冒烟（fake ctx：视图缓存命中 / tools/change 失效 /
 *      声明载荷更换失效 / agent/disposed 清理 / 异常降级）
 *
 * 历史：本文件在 2026-08-25 规模优化轮因编码事故整体重建过一次
 * （pwsh 管道按 GBK 误读 UTF-8 导致原文件损坏，教训记录见 handoff-notes）。
 * 重建以当时 core.js 的函数契约为准，覆盖与原版等价（A–H）并新增 I–K。
 *
 * 用法：npm run verify   或   node eval-results/verify.mjs
 * 退出码：0 = 全绿；非零 = 有失败（发布前必须跑）。
 */

import { readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
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
const core = await imp(join(LIB_DIR, 'core.js'))
const {
  evaluate, normalizeSchemas, parseDeclarations,
  rankTop, rankTopIndexed, buildIndex, renderOverview, buildHint,
  fuseLayers, semanticVerdict, renderAdvisory, buildHintSemantic,
  RUN_CODE_TRANSPORT,
} = core
const { createAdapter } = await imp(join(LIB_DIR, 'dsh-adapter.js'))
const { TRIGGER_TABLE } = await imp(join(LIB_DIR, 'trigger-table.js'))
const { semanticTopK, embedToolVectors } = await imp(join(LIB_DIR, 'embed.js'))
const { defaultCacheDir } = await imp(join(LIB_DIR, 'semantic.js'))
const { createDecisionLogger, DECISIONS_FILENAME } = await imp(join(LIB_DIR, 'decision-log.js'))
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
const READONLY = TRIGGER_TABLE.plan.readonlyTools

const results = []
let passed = 0
let failed = 0
let knownFailed = 0

/**
 * 断言执行器。opts.knownFail=true 的断言失败时计入 knownFailed 而非 failed
 * （M3 校准项：样本按"正确判定"入库，现行为尚未达标——回归门保持常绿，
 * 校准后自动转绿并提示移除标记）。诚实口径：known-fail 始终显式报告。
 */
function test(name, fn, opts = {}) {
  try {
    fn()
    passed += 1
    results.push(opts.knownFail === true ? `  ✓ ${name}（known-fail 已转绿——考虑移除标记）` : `  ✓ ${name}`)
  } catch (e) {
    const msg = String(e.message ?? e).split('\n').join('\n      ')
    if (opts.knownFail === true) {
      knownFailed += 1
      results.push(`  ~ ${name}\n      [known-fail] ${msg}\n      （M3 校准项：阈值/词表校准后应转绿）`)
    } else {
      failed += 1
      results.push(`  ✗ ${name}\n      ${msg}`)
    }
  }
}

const S6_TEXT = "把 'abc' 和 'def' 拼接一下"

// ---------- A. 样本回归（判定 / 落点 / 反例） ----------
results.push('A. 样本回归（samples.json）')
// 守门口径（与 simulate.mjs 对齐，2026-08-26 生产验证后同步）：neverPush 命中
// 但带 gateWarn 软警示 = 合规（plan §4.5 验收"消失或带警示行"）；A 组直测
// rankTop 不过闸门会导致 S9 摘标后误红——A 组在排序后补一道关键词口径闸门。
const gateFnA = core.applyNotForGate
for (const s of json.samples) {
  test(`${s.id} 判定=${s.expected}`, () => {
    const dec = evaluate(s.text)
    const expectedOk = s.expected === 'none-or-light'
      ? (dec.kind === 'none' || dec.kind === 'T3')
      : dec.kind === s.expected
    assert.ok(expectedOk, `${s.id}: 判定 ${dec.kind} ≠ 预期 ${s.expected}`)
    if (dec.kind !== 'T2') return
    const top = rankTop(DEMO_SCHEMAS, s.text, dec, { lastTop: [] }, enrich)
    const gated = gateFnA({ candidates: top, text: s.text, enrich })
    for (const t of s.groundTruth.shouldUse) {
      assert.ok(gated.candidates.some(e => e.name === t), `${s.id}: 落点缺 ${t}（Top: ${gated.candidates.map(e => e.name).join('/') || '空'}）`)
    }
    for (const n of s.groundTruth.neverPush) {
      assert.ok(!gated.candidates.some(e => e.name === n && e.gateWarn !== true),
        `${s.id}: 反例错推 ${n}（Top: ${gated.candidates.map(e => e.name).join('/') || '空'}）`)
    }
  }, { knownFail: s.knownFail === true })
}

// ---------- B. normalizeSchemas ----------
results.push('B. normalizeSchemas（PTC 传输工具过滤 / mode 探测 / 非法输入）')
test('native 模式：无 run_code 时不误报', () => {
  const out = normalizeSchemas(DEMO_SCHEMAS)
  assert.equal(out.mode, 'native')
  assert.equal(out.filtered, 0)
  assert.equal(out.schemas.length, DEMO_SCHEMAS.length)
})
test(`code 模式：${RUN_CODE_TRANSPORT} 被过滤且探测为 code`, () => {
  const raw = [{ name: 'read', description: 'r' }, { name: RUN_CODE_TRANSPORT, description: 'transport' }]
  const out = normalizeSchemas(raw)
  assert.equal(out.mode, 'code')
  assert.equal(out.filtered, 1)
  assert.ok(!out.schemas.some(s => s.name === RUN_CODE_TRANSPORT))
})
test('非法输入安全：非数组 / 空 name / 非对象条目跳过', () => {
  for (const bad of [null, undefined, 42, 'x']) {
    const out = normalizeSchemas(bad)
    assert.deepEqual(out.schemas, [])
    assert.equal(out.mode, 'native')
  }
  const out = normalizeSchemas([null, {}, { name: '', description: 'x' }, { name: 'ok' }])
  assert.deepEqual(out.schemas.map(s => s.name), ['ok'])
})

// ---------- C. parseDeclarations ----------
results.push('C. parseDeclarations（契约兼容）')
const DECL_FIXTURE = [{ tool: 'echo', keywords: ['回显'], use_when: '原样返回' }]
test('v1 形状 {version:"1.0", declarations}', () => {
  const m = parseDeclarations({ version: '1.0', declarations: DECL_FIXTURE })
  assert.equal(m.get('echo').keywords[0], '回显')
})
test('v0 数字版本 {version:2, declarations} 兼容', () => {
  const m = parseDeclarations({ version: 2, declarations: DECL_FIXTURE })
  assert.equal(m.size, 1)
})
test('无 version 的 {declarations} 兼容', () => {
  const m = parseDeclarations({ declarations: DECL_FIXTURE })
  assert.equal(m.size, 1)
})
test('裸数组兼容', () => {
  const m = parseDeclarations(DECL_FIXTURE)
  assert.equal(m.get('echo').use_when, '原样返回')
})
test('非法条目跳过（null / 非对象 / tool 非字符串）；空输入返回空 Map', () => {
  const m = parseDeclarations([null, 3, { tool: 7 }, { nope: 1 }, ...DECL_FIXTURE])
  assert.equal(m.size, 1)
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.equal(parseDeclarations(bad).size, 0)
  }
})

// ---------- D. renderOverview（mode 感知文案） ----------
results.push('D. renderOverview（mode 文案）')
test('native 模式无 SDK 标注', () => {
  const text = renderOverview(DEMO_SCHEMAS, '非任务', 'native')
  assert.ok(text.includes('[dsh-capability-index] 插件库总览（非任务，软层兜底）'))
  assert.ok(!text.includes('SDK'))
})
test('code 模式标注 run_code 口径', () => {
  const text = renderOverview(DEMO_SCHEMAS, '非任务', 'code')
  assert.ok(text.includes('code 呈现模式'))
  assert.ok(text.includes(`经 ${RUN_CODE_TRANSPORT} 调用`))
  assert.ok(text.includes(`SDK 内可调 ${DEMO_SCHEMAS.length} 个`))
})

// ---------- E. rankTop（planOnly / hintedFactor） ----------
results.push('E. rankTop（planOnly 只读过滤 / hintedFactor）')
test('planOnly 只保留只读名单内工具', () => {
  const dec = evaluate('帮我读一下 README.md 然后整理')
  const top = rankTop(DEMO_SCHEMAS, '帮我读一下 README.md 然后整理', dec, { lastTop: [] }, enrich, { planOnly: true })
  assert.ok(top.length > 0)
  for (const e of top) {
    assert.ok(READONLY.includes(e.name), `planOnly 推了非只读工具 ${e.name}`)
  }
})
test('hintedFactor：已提示条目降权后排位下沉且分数减半', () => {
  const schemas = [
    { name: 'alpha_tool', description: 'alpha helper' },
    { name: 'beta_tool', description: 'beta helper' },
  ]
  const text = 'alpha beta' // 两工具各命中一个 token → 并列
  const dec = evaluate(text)
  const fresh = rankTop(schemas, text, dec, { lastTop: [] }, new Map())
  assert.deepEqual(fresh.map(e => e.name), ['alpha_tool', 'beta_tool'], '并列时按注册序')
  const hinted = rankTop(schemas, text, dec, { lastTop: ['alpha_tool'] }, new Map())
  assert.deepEqual(hinted.map(e => e.name), ['beta_tool', 'alpha_tool'], '已提示的 alpha 应下沉')
  assert.equal(hinted[1].score, fresh[0].score / 2, '已提示条目分数应 ×0.5')
})
test('min_complexity 高于当前量级的声明条目被跳过', () => {
  const schemas = [{ name: 'heavy_tool', description: 'heavy' }]
  const decls = new Map([['heavy_tool', { min_complexity: 'high' }]])
  const dec = evaluate("把 'abc' 拼接一下") // 短消息 → low
  const top = rankTop(schemas, "把 'abc' 拼接一下", dec, { lastTop: [] }, decls)
  assert.equal(top.length, 0, 'low 量级不应推荐 high 复杂度工具')
})

// ---------- F. buildHint 集成 ----------
results.push('F. buildHint（判定 → 排序 → 渲染）')
test('T2：Top-K 含 concat_text 且渲染能力声明', () => {
  const out = buildHint({ text: S6_TEXT, hasImage: false, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] } })
  assert.equal(out.kind, 'T2')
  assert.ok(out.pendingTop.includes('concat_text'))
  assert.ok(out.text.includes('[dsh-capability-index] 任务型请求（T2）'))
  assert.ok(out.text.includes('concat_text'))
  assert.ok(out.text.includes('未提供能力声明') || out.text.includes('适用'), '声明渲染或降级标注缺失')
})
test('plan 场景（planOnly）：pendingTop 全部在只读名单内', () => {
  const out = buildHint({
    text: '帮我读一下 README.md 然后整理', hasImage: false, schemas: DEMO_SCHEMAS,
    enrich, state: { lastTop: [] }, planOnly: true,
  })
  assert.equal(out.kind, 'T2')
  for (const n of out.pendingTop) assert.ok(READONLY.includes(n))
})
test('闲聊：软层总览兜底（kind=none）', () => {
  const out = buildHint({ text: '今天天气不错', hasImage: false, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] } })
  assert.equal(out.kind, 'none')
  assert.ok(out.text.includes('插件库总览'))
  assert.deepEqual(out.pendingTop, [])
})
test('T1 显式查插件：总览口径', () => {
  const out = buildHint({ text: '看看我有哪些插件能用', hasImage: false, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] } })
  assert.equal(out.kind, 'T1')
  assert.ok(out.text.includes('T1 显式查插件'))
})
test('T2 无命中：回退总览', () => {
  // S6 文本判 T2（B=拼接 + F=引号），但工具视图为空 → 无命中 → 总览
  const out = buildHint({ text: S6_TEXT, hasImage: false, schemas: [], enrich, state: { lastTop: [] } })
  assert.equal(out.kind, 'T2')
  assert.ok(out.text.includes('T2 无命中'))
})
test('code 呈现模式：总览带 SDK 口径', () => {
  const out = buildHint({ text: '今天天气不错', hasImage: false, schemas: DEMO_SCHEMAS, enrich, state: {}, mode: 'code' })
  assert.ok(out.text.includes('SDK 内可调'))
})

// ---------- G. 三级合议矩阵（mock 向量） ----------
results.push('G. 三级合议（fuseLayers / buildHintSemantic）')
const RULE_TOP = [{ name: 'read', desc: 'r', score: 5, decl: undefined }]
const SEM_TOP_HIT = [
  { name: 'web_search', score: 0.52 },
  { name: 'grep', score: 0.40 },
]
test('fuseLayers both：有交集 → 硬推并集（规则优先序）', () => {
  const out = fuseLayers({ ruleTop: RULE_TOP, semTop: [{ name: 'read', score: 0.5 }] })
  assert.equal(out.decision, 'both')
  assert.equal(out.candidates[0].name, 'read')
})
test('fuseLayers conflict：都命中但无交集 → 带内第三层', () => {
  const out = fuseLayers({ ruleTop: RULE_TOP, semTop: SEM_TOP_HIT })
  assert.equal(out.decision, 'conflict')
  assert.equal(out.candidates.length, 3, '并集截断 k')
  assert.equal(out.candidates[0].name, 'read')
})
test('fuseLayers 单侧命中：semantic-only / rule-only', () => {
  assert.equal(fuseLayers({ ruleTop: [], semTop: SEM_TOP_HIT }).decision, 'semantic-only')
  assert.equal(fuseLayers({ ruleTop: RULE_TOP, semTop: [] }).decision, 'rule-only')
  assert.equal(fuseLayers({ ruleTop: [], semTop: [] }).decision, 'none')
})
test('buildHintSemantic：无向量数据 → null（向后兼容 v0.1 纯规则路径）', () => {
  assert.equal(buildHintSemantic({ text: S6_TEXT, schemas: DEMO_SCHEMAS, enrich }), null)
})
test('buildHintSemantic：英文任务（规则层 none）向量命中 → semantic-only 语义提示', () => {
  const vecs = new Map([['format_text', vecOf(0.9)], ['read', vecOf(0.3)]])
  const out = buildHintSemantic({
    text: 'uppercase this string please',
    schemas: DEMO_SCHEMAS, enrich, state: {},
    taskVec: vecOf(1), toolVectors: vecs, semThreshold: 0.35,
  })
  assert.equal(out.decision, 'semantic-only')
  assert.ok(out.text.includes('语义匹配'))
  assert.ok(out.pendingTop.includes('format_text'))
})
test('buildHintSemantic：英文任务向量未命中 → 软层总览（不渲染语义提示）', () => {
  const vecs = new Map([['format_text', vecOf(0.05)]])
  const out = buildHintSemantic({
    text: 'uppercase this string please',
    schemas: DEMO_SCHEMAS, enrich, state: {},
    taskVec: vecOf(1), toolVectors: vecs, semThreshold: 0.35,
  })
  assert.equal(out.decision, 'none')
  assert.ok(out.text.includes('插件库总览'))
})
test('语义未命中路径的理由文案与纯规则路径字节一致（闲聊 / T3）', () => {
  for (const text of ['今天天气不错', '我想做个大项目']) {
    const input = { text, schemas: DEMO_SCHEMAS, enrich, state: {} }
    const out = buildHintSemantic({ ...input, taskVec: vecOf(1), toolVectors: new Map([['read', vecOf(0.1)]]), semThreshold: 0.35 })
    const pure = buildHint(input)
    assert.equal(out.decision, 'none')
    assert.equal(out.text, pure.text, `「${text}」软层理由文案与纯规则路径不一致`)
  }
})
test('buildHintSemantic：规则命中但向量不过阈值 → rule-only（输出同纯规则路径）', () => {
  const vecs = new Map([['concat_text', vecOf(0.1)]])
  const input = { text: S6_TEXT, schemas: DEMO_SCHEMAS, enrich, state: {} }
  const out = buildHintSemantic({ ...input, taskVec: vecOf(1), toolVectors: vecs, semThreshold: 0.35 })
  const pure = buildHint(input)
  assert.equal(out.decision, 'rule-only')
  assert.equal(out.text, pure.text, 'rule-only 渲染必须与 v0.1 路径字节一致')
})
test('buildHintSemantic conflict：注入"供你终判"带内第三层', () => {
  const vecs = new Map([['web_search', vecOf(0.9)]])
  const out = buildHintSemantic({
    text: S6_TEXT, schemas: DEMO_SCHEMAS, enrich, state: {},
    taskVec: vecOf(1), toolVectors: vecs, semThreshold: 0.35,
  })
  assert.equal(out.decision, 'conflict')
  assert.ok(out.text.includes('供你终判'))
  assert.ok(out.text.includes('规则层认为'))
  assert.ok(out.text.includes('语义层认为'))
})
test('renderAdvisory：候选为空返回空串（调用方回落硬层渲染）', () => {
  assert.equal(renderAdvisory({ decision: 'conflict', candidates: [] }), '')
})

// 向量构造辅助：全 1 归一化方向（点积即另一向量的首分量权重）
function vecOf(w) {
  return Float32Array.from([w, Math.sqrt(Math.max(0, 1 - w * w))])
}
// 注意：vecOf(1) 与 vecOf(0.9) 点积 = 0.9 ≥ 0.35；vecOf(1)×vecOf(0.05)=0.05 < 0.35

// ---------- H. 语义引擎纯函数（mock encode，不加载模型） ----------
results.push('H. 语义引擎（embed.js / semantic.js 纯函数）')
test('semanticTopK：降序 + k 截断', () => {
  const out = semanticTopK([1, 0, 0], new Map([
    ['a', [0.9, 0, 0]],
    ['b', [0.2, 0, 0]],
    ['c', [0.7, 0, 0]],
  ]), 2)
  assert.deepEqual(out.map(e => e.name), ['a', 'c'])
  assert.equal(out.length, 2)
})
test('embedToolVectors：mock encode 逐条产出，失败条目跳过', async () => {
  const encode = async text => Float32Array.from([text.length])
  const vecs = await embedToolVectors(encode, [
    { name: 'a', description: 'x' },
    { name: 'b', description: 'y' },
  ])
  assert.equal(vecs.size, 2)
  assert.ok(vecs.get('a') instanceof Float32Array)
})
test('embedToolVectors：声明 keywords 并入描述（多源文本）', async () => {
  const seen = []
  const encode = async text => { seen.push(text); return Float32Array.from([1]) }
  await embedToolVectors(encode, [{ name: 'echo', description: 'desc' }], new Map([['echo', { keywords: ['回显', 'echo'] }]]))
  const joined = seen[0]
  assert.ok(joined.includes('desc') && joined.includes('回显'))
})
test('defaultCacheDir：DSH_HOME 优先且为 .cache/dsh-capability-index 形态', () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'D:\\dsh-home-test'
    const dir = defaultCacheDir()
    assert.ok(dir.startsWith('D:\\dsh-home-test'))
    assert.ok(dir.includes('.cache'))
    assert.ok(dir.includes('dsh-capability-index'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

// ---------- I. 排序索引等价（rankTopIndexed ≡ rankTop） ----------
results.push('I. 排序索引（buildIndex / rankTopIndexed 等价与复用）')
test('索引路径与便捷入口输出逐项一致（全部 T2 样本 × planOnly/hinted 变体）', () => {
  const idx = buildIndex(DEMO_SCHEMAS, enrich)
  const t2s = json.samples.filter(s => s.expected === 'T2')
  assert.ok(t2s.length >= 3, 'T2 样本数不足')
  for (const s of t2s) {
    const dec = evaluate(s.text)
    for (const opts of [{}, { planOnly: true }]) {
      for (const state of [{ lastTop: [] }, { lastTop: ['concat_text'] }]) {
        const a = rankTop(DEMO_SCHEMAS, s.text, dec, state, enrich, opts)
        const b = rankTopIndexed(idx, s.text, dec, state, opts)
        assert.deepEqual(b, a, `${s.id} 在 ${JSON.stringify(opts)} × lastTop=${state.lastTop.join('|')} 下不一致`)
      }
    }
  }
})
test('同一索引多次打分结果稳定（缓存复用语义）', () => {
  const idx = buildIndex(DEMO_SCHEMAS, enrich)
  const dec = evaluate(S6_TEXT)
  const first = rankTopIndexed(idx, S6_TEXT, dec, { lastTop: [] })
  const second = rankTopIndexed(idx, S6_TEXT, dec, { lastTop: [] })
  assert.deepEqual(first, second)
  assert.ok(first.length > 0 && first[0].name === 'concat_text', `落点漂移：${first.map(e => e.name).join('/')}`)
})
test('buildIndex：非法输入安全（非数组 / 空 name 跳过）', () => {
  assert.deepEqual(buildIndex(null, enrich).items, [])
  const idx = buildIndex([{ name: '', description: 'x' }, { name: 'ok_tool', description: 'y' }], enrich)
  assert.equal(idx.items.length, 1)
  assert.equal(idx.items[0].name, 'ok_tool')
})
test('buildHint 接受缓存 index（与临时构建结果一致）', () => {
  const idx = buildIndex(DEMO_SCHEMAS, enrich)
  const a = buildHint({ text: S6_TEXT, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] } })
  const b = buildHint({ text: S6_TEXT, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] }, index: idx })
  assert.deepEqual(b, a)
})

// ---------- J. 软层总览分组 ----------
results.push('J. renderOverview 分组摘要（阈值内平铺 / 超阈值聚合）')
const THRESHOLD = TRIGGER_TABLE.overview.groupedThreshold
test(`≤阈值（${DEMO_SCHEMAS.length} 工具）保持旧平铺格式`, () => {
  const text = renderOverview(DEMO_SCHEMAS, '非任务', 'native')
  assert.ok(text.includes(`当前可用工具 ${DEMO_SCHEMAS.length} 个——echo、concat_text`), text)
  assert.ok(!text.includes('其他：'))
  assert.ok(text.endsWith('（有明确任务时会给出针对性提示）'))
})
test('超阈值走分类聚合：组标签 + 其他尾部 + 预算内不截断', () => {
  const big = [
    'read', 'echo', 'todo_write', 'subagent', 'skill', 'get_goal', 'pwsh',
    ...Array.from({ length: THRESHOLD - 6 }, (_, i) => `u${String(i + 1).padStart(2, '0')}`),
  ]
  assert.equal(big.length, THRESHOLD + 1, 'fixture 尺寸错误')
  const text = renderOverview(big.map(n => ({ name: n, description: '' })), '非任务', 'native')
  assert.ok(text.includes(`当前可用工具 ${THRESHOLD + 1} 个`), text)
  assert.ok(text.includes('文件(1)：read'), text)
  assert.ok(text.includes('任务协调(2)：todo_write/subagent'), text)
  assert.ok(text.includes('插件管理(1)：skill'), text)
  assert.ok(text.includes('目标与确认(1)：get_goal'), text)
  assert.ok(text.includes('系统(1)：pwsh'), text)
  assert.ok(text.includes('其他：u01/'), text)
  assert.ok(text.includes('u18'), '未分组尾部被提前截断')
  assert.ok(text.endsWith('（有明确任务时会给出针对性提示）'))
})
test('code 呈现模式的分组总览保留 SDK 口径标注', () => {
  const big = Array.from({ length: THRESHOLD + 5 }, (_, i) => ({ name: `tool_${i}`, description: '' }))
  const text = renderOverview(big, 'T3 模糊宏大', 'code')
  assert.ok(text.includes(`SDK 内可调 ${THRESHOLD + 5} 个`), text)
  assert.ok(text.includes('其他：tool_0/'), text)
})
test('阈值边界：恰好等于阈值仍平铺', () => {
  const exactly = Array.from({ length: THRESHOLD }, (_, i) => ({ name: `t${i}`, description: '' }))
  const text = renderOverview(exactly, '非任务', 'native')
  assert.ok(!text.includes('其他：'))
  assert.ok(text.includes('——t0、t1'))
})
test('分组配置缺省/畸形时回退平铺（数据文件容错）', () => {
  const saved = TRIGGER_TABLE.overview
  try {
    TRIGGER_TABLE.overview = undefined
    const text = renderOverview(Array.from({ length: 40 }, (_, i) => ({ name: `z${i}`, description: '' })), '非任务', 'native')
    assert.ok(!text.includes('其他：'))
  } finally {
    TRIGGER_TABLE.overview = saved
  }
})

// ---------- K. adapter 冒烟（fake ctx，不加载 dsh 运行时） ----------
results.push('K. adapter 冒烟（fake ctx：视图缓存 / 失效 / 清理）')

/** 最小 fake ctx：只覆盖 createAdapter 用到的触点，全部传纯数据。 */
function makeFakeCtx(rawSchemas) {
  const listeners = new Map()
  let contextText = null
  let schemasCalls = 0
  const state = { declarations: undefined }
  const ctx = {
    on(event, handler) {
      let arr = listeners.get(event)
      if (arr === undefined) listeners.set(event, arr = [])
      arr.push(handler)
      return () => {}
    },
    systemPrompt: { context(reg) { contextText = reg.text } },
    tools: {
      schemas(agent) {
        schemasCalls += 1
        return typeof rawSchemas === 'function' ? rawSchemas() : rawSchemas
      },
    },
    get(name) {
      if (name === 'capabilityIndex.declarations') return state.declarations
      return undefined
    },
    __emit(event, payload) {
      for (const h of listeners.get(event) ?? []) h(payload)
    },
    __setDeclarations(d) { state.declarations = d },
    __context: () => contextText,
    __schemasCalls: () => schemasCalls,
  }
  return ctx
}

const FAKE_MSG = {
  source: { kind: 'user' },
  content: [{ type: 'text', text: S6_TEXT }],
}

test('claimed → 渲染 T2 提示；两次组装只克隆一次 schema（缓存命中）', () => {
  const ctx = makeFakeCtx(DEMO_SCHEMAS)
  ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS })
  const ret = createAdapter(ctx, core, { current: null })
  assert.equal(ret.mode, 'adapter-ready')
  ctx.__emit('agent/inbox/claimed', { agent: { id: 'a1' }, message: FAKE_MSG, turn: 1 })
  const out1 = ctx.__context()({ agent: { id: 'a1' } })
  assert.ok(out1.includes('[dsh-capability-index]'), out1)
  assert.ok(out1.includes('concat_text'), `落点缺失：${out1}`)
  const out2 = ctx.__context()({ agent: { id: 'a1' } })
  assert.equal(out2, out1, '同消息重复组装渲染漂移')
  assert.equal(ctx.__schemasCalls(), 1, `稳态应只克隆一次，实际 ${ctx.__schemasCalls()}`)
})
test('tools/change 后视图失效：下一次组装重建（再克隆一次）', () => {
  const ctx = makeFakeCtx(DEMO_SCHEMAS)
  ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS })
  createAdapter(ctx, core, { current: null })
  ctx.__emit('agent/inbox/claimed', { agent: { id: 'a2' }, message: FAKE_MSG, turn: 1 })
  ctx.__context()({ agent: { id: 'a2' } })
  assert.equal(ctx.__schemasCalls(), 1)
  ctx.__emit('tools/change')
  ctx.__context()({ agent: { id: 'a2' } })
  assert.equal(ctx.__schemasCalls(), 2, 'tools/change 未触发视图重建')
})
test('声明载荷更换（新对象身份）触发视图重建', () => {
  const ctx = makeFakeCtx(DEMO_SCHEMAS)
  ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS })
  createAdapter(ctx, core, { current: null })
  ctx.__emit('agent/inbox/claimed', { agent: { id: 'a3' }, message: FAKE_MSG, turn: 1 })
  ctx.__context()({ agent: { id: 'a3' } })
  assert.equal(ctx.__schemasCalls(), 1)
  ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS }) // 新对象身份
  ctx.__context()({ agent: { id: 'a3' } })
  assert.equal(ctx.__schemasCalls(), 2, '声明更换未触发视图重建')
})
test('agent/disposed 清理状态：销毁后组装返回空串且不再读 schema', () => {
  const ctx = makeFakeCtx(DEMO_SCHEMAS)
  ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS })
  createAdapter(ctx, core, { current: null })
  const agent = { id: 'a4' }
  ctx.__emit('agent/inbox/claimed', { agent, message: FAKE_MSG, turn: 1 })
  assert.ok(ctx.__context()({ agent }).length > 0)
  const callsBefore = ctx.__schemasCalls()
  ctx.__emit('agent/disposed', { agent })
  assert.equal(ctx.__context()({ agent }), '', '销毁后仍渲染提示块')
  assert.equal(ctx.__schemasCalls(), callsBefore, '销毁后仍读取工具视图')
})
test('无消息的 agent 组装早退（零 schema 克隆）', () => {
  const ctx = makeFakeCtx(DEMO_SCHEMAS)
  createAdapter(ctx, core, { current: null })
  assert.equal(ctx.__context()({ agent: { id: 'nobody' } }), '')
  assert.equal(ctx.__schemasCalls(), 0)
})
test('tools.schemas 抛错时不炸注入（降级后仍产出合法字符串）', () => {
  const ctx = makeFakeCtx(() => { throw new Error('boom') })
  ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS })
  createAdapter(ctx, core, { current: null })
  ctx.__emit('agent/inbox/claimed', { agent: { id: 'a5' }, message: FAKE_MSG, turn: 1 })
  const out = ctx.__context()({ agent: { id: 'a5' } })
  assert.equal(typeof out, 'string')
  assert.ok(out.length > 0)
})
test('非 user 来源消息不进入状态（tool 结果不触发预检）', () => {
  const ctx = makeFakeCtx(DEMO_SCHEMAS)
  createAdapter(ctx, core, { current: null })
  ctx.__emit('agent/inbox/claimed', { agent: { id: 'a6' }, message: { source: { kind: 'tool' }, content: [{ type: 'text', text: S6_TEXT }] }, turn: 1 })
  assert.equal(ctx.__context()({ agent: { id: 'a6' } }), '')
})

// ---------- L. 决策日志（M3 数据基建：JSONL 落盘 / 停用 / 失败静默 / adapter 接线） ----------
results.push('L. decision-log（M3 数据基建）')
const DL_TMP = new URL('./.tmp-decision-log/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
test('无 dir → 返回 null（停用；离线回归默认零副作用）', () => {
  assert.equal(createDecisionLogger({}), null)
  assert.equal(createDecisionLogger({ dir: '' }), null)
})
test('正常落盘：字段齐全、msgHead 截断 120、semTop 分数四位收敛、多余字段丢弃', () => {
  rmSync(DL_TMP, { recursive: true, force: true })
  try {
    const log = createDecisionLogger({ dir: DL_TMP })
    log({
      msgHead: 'x'.repeat(300), kind: 'T2', decision: 'rule-only', hit: false,
      pushed: ['concat_text', 42, null, 'format_text'],
      semTop: [{ name: 'read', score: 0.123456 }, { name: '', score: 0.5 }, null, { name: 'glob' }],
      mode: 'code', planOnly: false, junk: { nested: true },
    })
    const lines = readFileSync(`${DL_TMP}${DECISIONS_FILENAME}`, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const rec = JSON.parse(lines[0])
    assert.equal(typeof rec.ts, 'string')
    assert.equal(rec.msgHead.length, 120, 'msgHead 必须截到 ≤120 字')
    assert.deepEqual(rec.pushed, ['concat_text', 'format_text'], '非字符串条目必须过滤')
    assert.deepEqual(rec.semTop, [{ name: 'read', score: 0.1235 }, { name: 'glob', score: null }],
      '无 score 的合法条目保留为 null，畸形条目过滤，分数四位收敛')
    assert.equal(rec.mode, 'code')
    assert.equal(rec.hit, false, 'hit=false 是合法布尔，应如实落盘')
    assert.equal(rec.planOnly, undefined, 'planOnly=false 不落盘（只有 true 才记）')
    assert.equal(rec.junk, undefined, '规格外字段必须丢弃')
  } finally {
    rmSync(DL_TMP, { recursive: true, force: true })
  }
})
test('broken 门闩：目录不可写时首次静默失败，之后不再尝试且不抛错', () => {
  rmSync(DL_TMP, { recursive: true, force: true })
  try {
    writeFileSync(DL_TMP.replace(/[\\/]+$/, ''), 'not a dir', 'utf8') // 占位同名文件（父目录已存在）
    const log = createDecisionLogger({ dir: DL_TMP })
    log({ msgHead: 'a', kind: 'T2' }) // mkdir 撞上同名文件 → 失败 → broken
    log({ msgHead: 'b', kind: 'T2' }) // broken 后静默返回
    assert.ok(true, '两次调用都未抛错即通过')
  } finally {
    rmSync(DL_TMP, { recursive: true, force: true })
  }
})
test('adapter 接线：注入一次记一行；不传 decisionLog 零写入', () => {
  rmSync(DL_TMP, { recursive: true, force: true })
  try {
    const ctx = makeFakeCtx(DEMO_SCHEMAS)
    ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS })
    createAdapter(ctx, core, { current: null }, { decisionLog: createDecisionLogger({ dir: DL_TMP }) })
    ctx.__emit('agent/inbox/claimed', { agent: { id: 'a7' }, message: FAKE_MSG, turn: 1 })
    ctx.__context()({ agent: { id: 'a7' } })
    let lines = readFileSync(`${DL_TMP}${DECISIONS_FILENAME}`, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, `一次注入应记一行，实际 ${lines.length}`)
    const rec = JSON.parse(lines[0])
    assert.equal(rec.kind, 'T2')
    assert.ok(Array.isArray(rec.pushed) && rec.pushed.includes('concat_text'), `pushed 应含 concat_text：${JSON.stringify(rec.pushed)}`)
    // 同内容重复组装（每个 model step 都会重组注入块）→ 按渲染内容去重
    ctx.__context()({ agent: { id: 'a7' } })
    ctx.__context()({ agent: { id: 'a7' } })
    lines = readFileSync(`${DL_TMP}${DECISIONS_FILENAME}`, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, `同内容重复组装不得重复记，实际 ${lines.length}`)
    // 不传 decisionLog 的默认路径：零副作用
    const ctx2 = makeFakeCtx(DEMO_SCHEMAS)
    createAdapter(ctx2, core, { current: null })
    ctx2.__emit('agent/inbox/claimed', { agent: { id: 'a8' }, message: FAKE_MSG, turn: 1 })
    ctx2.__context()({ agent: { id: 'a8' } })
    lines = readFileSync(`${DL_TMP}${DECISIONS_FILENAME}`, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, '默认路径不应产生任何日志行')
  } finally {
    rmSync(DL_TMP, { recursive: true, force: true })
  }
})

// ---------- M. not_for 守门闸（M3 立项：plan-notfor-gate，verify-first 先红后绿） ----------
results.push('M. not_for 守门闸（双信号两档；plan-notfor-gate）')

const S9_TEXT = '把这三个文件批量重命名'
// 动态取用（verify-first）：实现落地前 core.applyNotForGate 为 undefined，
// 断言以"能力缺失"形式干净地红，不炸模块加载。
const gateFn = core.applyNotForGate

test('M1 闸门导出与配置块存在（core.applyNotForGate / trigger-table.notForGate）', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const cfg = TRIGGER_TABLE.notForGate
  assert.ok(cfg !== null && typeof cfg === 'object', 'trigger-table.notForGate 配置块缺失')
  assert.equal(cfg.enabled, true, '默认应启用')
  assert.ok(typeof cfg.hardSim === 'number' && cfg.hardSim > 0 && cfg.hardSim < 1, 'hardSim 应为 (0,1) 数值')
  assert.ok(typeof cfg.softSim === 'number' && cfg.softSim > 0 && cfg.softSim < cfg.hardSim, 'softSim 应为数值且 < hardSim')
  assert.ok(typeof cfg.demoteFactor === 'number' && cfg.demoteFactor > 0 && cfg.demoteFactor <= 1, 'demoteFactor 应为 (0,1] 数值')
})

test('M2 硬拦：S9 型双信号命中（关键词 ∧ 嵌入≥hardSim）→ 候选移除、gateBlocked 落名', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  // 生产同款路径：buildHintSemantic（both：规则层批量 keyword 命中 + 向量层命中）
  const out = buildHintSemantic({
    text: S9_TEXT, hasImage: false, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] },
    taskVec: vecOf(1),
    toolVectors: new Map([['batch_transform', vecOf(0.9)], ['read', vecOf(0.3)]]),
    notForVectors: new Map([['batch_transform', vecOf(0.75)]]), // ≥ hardSim(0.62)
    semThreshold: 0.58,
  })
  assert.equal(out.decision, 'both', '前置：合议应为 both')
  assert.ok(!out.pendingTop.includes('batch_transform'), `硬拦失效，仍推送：${out.pendingTop.join('/')}`)
  assert.ok(!out.text.includes('batch_transform'), '渲染文本不得再出现被拦工具')
  assert.deepEqual(out.gateBlocked, ['batch_transform'], 'gateBlocked 未如实落名')
  assert.deepEqual(out.gateWarned, [])
})

test('M3 软处理：仅关键词命中（无向量数据）→ 保尾降位 + 警示行 + gateWarned 落名', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  // 预热期/语义未就绪的纯规则路径：关键词单信号只允许软处理，不允许硬拦
  const out = buildHint({ text: S9_TEXT, hasImage: false, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] } })
  assert.equal(out.kind, 'T2')
  assert.ok(out.pendingTop.includes('batch_transform'), '仅关键词命中不得硬拦（诚实边界）')
  const idxBt = out.pendingTop.indexOf('batch_transform')
  const others = out.pendingTop.filter(n => n !== 'batch_transform')
  assert.ok(out.gateWarned.includes('batch_transform'), 'gateWarned 未落名')
  assert.deepEqual(out.gateBlocked, [], '仅关键词命中不得进 gateBlocked')
  for (const n of others) {
    assert.ok(idxBt > out.pendingTop.indexOf(n), `降位失效：batch_transform(${idxBt}) 应排在 ${n} 之后`)
  }
  assert.ok(out.text.includes('⚠️ 声明提示'), '卡片缺 not_for 警示行')
})

test('M4 软处理：嵌入落入 [softSim, hardSim) 区间（关键词未中）→ 降位 + 警示', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const decls = new Map([['calc_tool', { tool: 'calc_tool', not_for: '数值计算、科学仿真' }]])
  const candidates = [{ name: 'calc_tool', desc: 'd', score: 5 }]
  const res = gateFn({
    candidates,
    text: '帮我把这段文字拼接一下', // 与 not_for 无词面交集
    enrich: decls,
    taskVec: vecOf(1),
    notForVectors: new Map([['calc_tool', vecOf(0.52)]]), // ∈ [softSim(0.50), hardSim(0.62))
  })
  assert.deepEqual(res.blocked, [], '软区间的候选不得硬拦')
  assert.deepEqual(res.warned, ['calc_tool'], '软区间应警示')
  assert.equal(res.candidates.length, 1, '软处理不移除候选')
})

test('M5 双信号皆未中：候选原样通过（顺序与成员零改动）', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const candidates = [
    { name: 'alpha', desc: 'a', score: 3 },
    { name: 'beta', desc: 'b', score: 2 },
  ]
  const decls = new Map([['alpha', { tool: 'alpha', not_for: '文件重命名等真实文件系统操作' }]])
  const res = gateFn({
    candidates,
    text: '今天天气不错',
    enrich: decls,
    taskVec: vecOf(1),
    notForVectors: new Map([['alpha', vecOf(0.05)]]),
  })
  assert.deepEqual(res.candidates.map(e => e.name), ['alpha', 'beta'])
  assert.deepEqual(res.blocked, [])
  assert.deepEqual(res.warned, [])
})

test('M6 enabled=false 整体旁路（配置开关语义）', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const candidates = [{ name: 'batch_transform', desc: 'd', score: 9 }]
  const decls = new Map([['batch_transform', { tool: 'batch_transform', not_for: '文件重命名' }]])
  const res = gateFn({
    candidates, text: S9_TEXT, enrich: decls,
    taskVec: vecOf(1), notForVectors: new Map([['batch_transform', vecOf(0.9)]]),
    config: { enabled: false },
  })
  assert.deepEqual(res.candidates.map(e => e.name), ['batch_transform'], '关闭后必须原样通过')
  assert.deepEqual(res.blocked, [])
  assert.deepEqual(res.warned, [])
})

test('M7 显式补词通道：decl.not_for_keywords 命中（向后兼容字段）', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const decls = new Map([['mover', { tool: 'mover', not_for: '纯文本加工', not_for_keywords: ['重命名'] }]])
  const res = gateFn({
    candidates: [{ name: 'mover', desc: 'd', score: 4 }],
    text: S9_TEXT, // 消息含"重命名"，自动分词亦应命中——此处验证显式补词同样生效
    enrich: decls, // 无向量 → 仅关键词信号 → 软处理
  })
  assert.deepEqual(res.blocked, [])
  assert.deepEqual(res.warned, ['mover'], 'not_for_keywords 显式补词未生效')
})

test('M8 合议 both 路径集成：硬拦后剩余候选保持原相对顺序、decision 不变', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const out = buildHintSemantic({
    text: S9_TEXT, hasImage: false, schemas: DEMO_SCHEMAS, enrich, state: { lastTop: [] },
    taskVec: vecOf(1),
    toolVectors: new Map([['batch_transform', vecOf(0.9)], ['concat_text', vecOf(0.62)]]),
    notForVectors: new Map([['batch_transform', vecOf(0.75)]]),
    semThreshold: 0.58,
  })
  assert.equal(out.decision, 'both')
  // 预截断池语义（plan §3.3）：闸门先于 Top-K 截断执行，被拦条目不占席位——
  // 池序 [batch_transform, read, glob, concat_text] 拦截后剩余按原相对序补位
  assert.deepEqual(out.pendingTop, ['read', 'glob', 'concat_text'], `拦截后顺序错乱：${out.pendingTop.join('/')}`)
})

test('M9 硬拦清空候选 → 回退软层总览（不渲染空提示块）', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const onlyBt = [DEMO_SCHEMAS.find(s => s.name === 'batch_transform')]
  const declsBt = new Map([[ 'batch_transform', DECLARATIONS.find(d => d.tool === 'batch_transform') ]])
  const out = buildHintSemantic({
    text: S9_TEXT, hasImage: false, schemas: onlyBt, enrich: declsBt, state: { lastTop: [] },
    taskVec: vecOf(1),
    toolVectors: new Map([['batch_transform', vecOf(0.9)]]),
    notForVectors: new Map([['batch_transform', vecOf(0.75)]]),
    semThreshold: 0.58,
  })
  assert.ok(out.text.includes('插件库总览'), `清空后应回退总览，实际：${out.text.slice(0, 80)}`)
  assert.deepEqual(out.pendingTop, [])
  assert.deepEqual(out.gateBlocked, ['batch_transform'])
})

test('M10 无声明工具不受闸门影响（诚实边界：无从核对）', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const candidates = [{ name: 'plain_tool', desc: 'd', score: 7 }]
  const res = gateFn({
    candidates, text: S9_TEXT, enrich: new Map(),
    taskVec: vecOf(1), notForVectors: new Map([['plain_tool', vecOf(0.99)]]),
  })
  assert.deepEqual(res.candidates.map(e => e.name), ['plain_tool'])
  assert.deepEqual(res.blocked, [])
  assert.deepEqual(res.warned, [])
})

test('M11 conflict advisory 渲染：被警示候选附 ⚠️ 声明提示行', () => {
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  // 小工具集 fixture：规则层仅 batch_transform 得分，软降位后仍留在窗口内
  const smallSchemas = [
    DEMO_SCHEMAS.find(s => s.name === 'batch_transform'),
    { name: 'web_search', description: 'Search the web for current information.' },
  ]
  const out = buildHintSemantic({
    text: S9_TEXT, hasImage: false, schemas: smallSchemas, enrich, state: { lastTop: [] },
    taskVec: vecOf(1),
    toolVectors: new Map([['web_search', vecOf(0.9)]]),
    notForVectors: new Map(), // 嵌入信号缺席 → 关键词单信号只软处理
    semThreshold: 0.58,
  })
  assert.equal(out.decision, 'conflict')
  assert.ok(out.text.includes('供你终判'))
  assert.ok(out.text.includes('⚠️ 声明提示'), 'advisory 缺警示行')
  assert.ok(out.gateWarned.includes('batch_transform'))
})

test('M12 decision-log 白名单放行 gateBlocked/gateWarned（加法式，向后兼容）', () => {
  rmSync(DL_TMP, { recursive: true, force: true })
  try {
    const ctx = makeFakeCtx(DEMO_SCHEMAS)
    ctx.__setDeclarations({ version: '1.0', declarations: DECLARATIONS })
    createAdapter(ctx, core, { current: null }, { decisionLog: createDecisionLogger({ dir: DL_TMP }) })
    ctx.__emit('agent/inbox/claimed', { agent: { id: 'm12' }, message: { source: { kind: 'user' }, content: [{ type: 'text', text: S9_TEXT }] }, turn: 1 })
    ctx.__context()({ agent: { id: 'm12' } })
    const lines = readFileSync(`${DL_TMP}${DECISIONS_FILENAME}`, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const rec = JSON.parse(lines[0])
    assert.deepEqual(rec.gateWarned, ['batch_transform'], `决策日志缺 gateWarned：${JSON.stringify(rec)}`)
    assert.equal(rec.gateBlocked, undefined, '软处理场景不应有 gateBlocked')
  } finally {
    rmSync(DL_TMP, { recursive: true, force: true })
  }
})

test('M13 两段式语义：池级只硬拦不清退软命中，软处理仅在窗口内降位（首轮校准修正）', () => {
  // 首轮网格扫描证伪池级沉底：软命中的高分条目会被大量低分噪音反超而丢席位
  //（召回 0.714→0.286）。修正契约：软命中必须保留成员资格（窗口内降位+警示）。
  assert.equal(typeof gateFn, 'function', 'core.applyNotForGate 未实现')
  const poolSchemas = [
    DEMO_SCHEMAS.find(s => s.name === 'batch_transform'),
    { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.' },
    { name: 'glob', description: 'Find files whose paths match a glob pattern.' },
    { name: 'write', description: 'Write a file.' },
    { name: 'edit', description: 'Edit a file.' },
    { name: 'pwsh', description: 'Run PowerShell.' },
  ]
  const out = buildHint({
    text: S9_TEXT, hasImage: false, schemas: poolSchemas, enrich, state: { lastTop: [] },
  })
  assert.equal(out.kind, 'T2')
  // 关键断言：软命中的 batch_transform 不得因沉底跌出窗口（成员资格保留）
  assert.ok(
    out.pendingTop.includes('batch_transform'),
    `软命中被清退出窗口（池级沉底残留）：${out.pendingTop.join('/')}`,
  )
  // 且在窗口内降位到尾（其余干净候选在前）
  const idxBt = out.pendingTop.indexOf('batch_transform')
  assert.equal(idxBt, out.pendingTop.length - 1, `未降位到窗口尾：${out.pendingTop.join('/')}`)
  assert.ok(out.gateWarned.includes('batch_transform'))
  assert.deepEqual(out.gateBlocked, [])
})

// ---------- 汇总 ----------
console.log('dsh-capability-index verify（core.js 纯逻辑回归）\n')
console.log(results.join('\n'))
const knownNote = knownFailed > 0 ? `, ${knownFailed} known-fail（M3 校准项，显式报告不判败）` : ''
console.log(`\n${passed} passed, ${failed} failed${knownNote}`)
process.exit(failed === 0 ? 0 : 1)
