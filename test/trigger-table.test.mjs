/**
 * 触发表 v0.1 测试（零依赖，直接运行：`node test/trigger-table.test.mjs`）。
 * 不用 node:test 的 runner：它在沙箱里 spawn 子进程会撞 EPERM（命名管道限制）。
 * 覆盖：T1/T2/T3/none 判定、信号 A–F、量级映射、词表缺口回归（拼接/更新）、
 * 排序 token 噪声回归（minLen≥3 + 停用词 + nameMention 精确匹配）。
 */
import assert from 'node:assert/strict'
import { evaluate, rankTop } from '../lib/index.js'

let passed = 0
let failed = 0

function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    passed += 1
    console.log(`ok   - ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${label}: ${error.message}`)
  }
}

// ---- T1 显式要求（A） ----
check('T1 看看我有哪些插件能用', evaluate('看看我有哪些插件能用').kind, 'T1')
check('T1 动手前先走一遍插件库', evaluate('动手前先走一遍插件库').kind, 'T1')

// ---- T2 任务型命中（B 且 C/D/F） ----
{
  const dec = evaluate('帮我读一下 README.md 然后整理')
  check('T2 帮我读文件+整理 → kind', dec.kind, 'T2')
  check('T2 帮我读文件+整理 → C', dec.c, true)
  check('T2 帮我读文件+整理 → D', dec.d, true)
  check('T2 帮我读文件+整理 → level(mid)', dec.level, 'mid')
}
check('T2 请把文档翻译成英文', evaluate('请把文档翻译成英文').kind, 'T2')
{
  const dec = evaluate('把 "abc" 和 "def" 拼接')
  check('T2 拼接中间地带 → kind', dec.kind, 'T2')
  check('T2 拼接中间地带 → F', dec.f, true)
  check('T2 拼接中间地带 → level(low)', dec.level, 'low')
}
check('T2 图片附件', evaluate('帮我看看这张图片', true).kind, 'T2')
{
  const dec = evaluate('先整理，再翻译，最后输出表格')
  check('T2 三分句 → kind', dec.kind, 'T2')
  check('T2 三分句 → D', dec.d, true)
}
check('T2 @引用', evaluate('帮我改一下 @capix-1 的代码').kind, 'T2')

// ---- 阶段二词表补充回归（2026-08-15 已观测漏触发样本） ----
check('T3 更新（B 命中、无载体 → 不判闲聊）', evaluate('那你也更新一下，明天那边会话就按照顺序来走').kind, 'T3')
check('T2 更新+文件载体', evaluate('帮我更新一下 README.md').kind, 'T2')

// ---- T3 模糊宏大（B 但无 C/D/F） ----
{
  const dec = evaluate('我想做个大项目')
  check('T3 我想做个大项目 → kind', dec.kind, 'T3')
  check('T3 我想做个大项目 → level(low)', dec.level, 'low')
}
check('T3 请把这段文字再改改', evaluate('请把这段文字再改改').kind, 'T3')

// ---- none 不触发（无 B） ----
check('none 今天天气不错', evaluate('今天天气不错').kind, 'none')
check('none 好的', evaluate('好的').kind, 'none')
check('none 谢谢，明白了', evaluate('谢谢，明白了').kind, 'none')

// ---- 量级映射（E+D → low/mid/high） ----
{
  const long = '帮我先读一下 README.md 的完整内容，然后逐节整理出重点要点，再把这些要点逐条翻译成英文表述，最后汇总成一张中英对照表输出到文档里，请确保对照表包含原文、译文和页码三列。'
  const dec = evaluate(long)
  check('level 长消息且多分句 → high', dec.level, 'high')
  check('长消息 → T2', dec.kind, 'T2')
  assert.ok(dec.len >= 80, '长消息长度应 ≥ 80')
  passed += 1
  console.log('ok   - 长消息 len ≥ 80')
}

// ---- 澄清追问不按任务触发（至多 T3，绝不 T2） ----
{
  const dec = evaluate('请问现在几点')
  try {
    assert.notEqual(dec.kind, 'T2')
    passed += 1
    console.log(`ok   - 请问现在几点 → ${dec.kind}（≠ T2）`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - 请问现在几点 ≠ T2: ${error.message}`)
  }
}

// ---- 排序 token 噪声回归（阶段二调优第一批；rankTop 直接测试） ----
// rankTop(schemas, text, dec, st, enrich)；dec 只用到 a/c/d/level 字段
const STUB_DEC = { a: false, c: false, d: false, level: 'low' }
const EMPTY_ENRICH = new Map()
{
  // 2 字符 token "ok" 不再泛命中（旧行为：子串命中 Token/look/took…）
  const top = rankTop(
    [{ name: 'fake_tool', description: 'Token lookup helper' }],
    'ok', STUB_DEC, { lastTop: [] }, EMPTY_ENRICH,
  )
  check('token 噪声：2 字符 token 不命中', top.length, 0)
}
{
  // 停用词过滤后无有效 token → 不命中
  const top = rankTop(
    [{ name: 'fake_tool', description: 'handles your files' }],
    'the and please', STUB_DEC, { lastTop: [] }, EMPTY_ENRICH,
  )
  check('token 噪声：纯停用词不命中', top.length, 0)
}
{
  // nameMention 精确匹配：点名 read 才 +3
  const schemas = [
    { name: 'read', description: 'Read files' },
    { name: 'readme_helper', description: 'helps with readmes' },
  ]
  const top = rankTop(schemas, '帮我用 read 读文件', STUB_DEC, { lastTop: [] }, EMPTY_ENRICH)
  check('nameMention 精确匹配：read 点名命中', top[0]?.name, 'read')
}
{
  // 子串巧合回归："README" 不误判为点名 "read"
  const top = rankTop(
    [{ name: 'read', description: 'Read files' }],
    'README 帮我读一下', STUB_DEC, { lastTop: [] }, EMPTY_ENRICH,
  )
  check('nameMention 精确匹配：README 不误点名 read', top.length, 0)
}
{
  // 3+ 字符 token 正常词面命中保留
  const top = rankTop(
    [{ name: 'read', description: 'Read files from disk' }],
    '帮我用 read 读一下文件', STUB_DEC, { lastTop: [] }, EMPTY_ENRICH,
  )
  check('词面命中保留：read 命中', top.length, 1)
}
{
  // 路径整体 token（README.md）不再子串命中 read（噪声收紧的预期行为）
  const top = rankTop(
    [{ name: 'read', description: 'Read files from disk' }],
    'README.md 帮我读一下', STUB_DEC, { lastTop: [] }, EMPTY_ENRICH,
  )
  check('路径 token 不子串命中 read', top.length, 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
