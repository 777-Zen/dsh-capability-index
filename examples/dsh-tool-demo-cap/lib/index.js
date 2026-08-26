/**
 * dsh-tool-demo-cap —— "带能力声明的样例插件"（dsh-tool-demo 的副本改造）。
 *
 * 样例库（阶段二第二轮实验扩容，2026-08-16）：
 *   - echo：冒烟回显（v0 即有）
 *   - concat_text：多段文本拼接（S6"把 'abc' 和 'def' 拼接一下"的落点）
 *   - format_text：文本格式化（大小写/trim/空白折叠）
 *   - batch_transform：对列表项批量应用同一变换
 * 全部工具调用写当前工作目录下的 echo-cap-calls.log（tool/call 实验证据；
 * 路径可用 config.logPath 覆盖，默认跨平台、开箱即用）。
 *
 * 能力声明：ctx.provide('capabilityIndex.declarations', …) 按
 * dsh-capability-index 的约定发布；消费者命中时集中渲染 use_when/not_for。
 * v0 单聚合器约定：每个组合只应有一个插件提供该服务。本样例即该形态的演示。
 */

import { appendFileSync } from 'node:fs'
import path from 'node:path'

export const name = 'tool-demo-cap'
export const inject = ['tools']

// 默认日志文件名；经 path.resolve 落到当前工作目录，可用 config.logPath 覆盖。
const DEFAULT_LOG_NAME = 'echo-cap-calls.log'

/** 记录一次调用；日志失败（无权限等）不影响工具本身返回。 */
function recordCall(logPath, tool, args, result) {
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${tool}(${JSON.stringify(args)}) -> ${JSON.stringify(result)}\n`, 'utf8')
  } catch {
    // 静默：日志是辅助验证，不是工具职责
  }
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback
}

function strArr(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
}

/** 能力声明（导出供离线模拟/测试复用；apply 内原样发布）。 */
export const DECLARATIONS = [
  {
    tool: 'echo',
    keywords: ['回显', '原样返回', 'echo', '重复输出'],
    use_when: '用户要求文本原样返回或冒烟测试工具链',
    not_for: '任何加工、转换、格式化',
    min_complexity: 'low',
    lang: 'zh',
  },
  {
    tool: 'concat_text',
    keywords: ['拼接', '合并', '连接', 'concat', 'join'],
    use_when: '用户要求把多段文本/字符串拼接到一起',
    not_for: '数值相加、列表批量变换（用 batch_transform）',
    min_complexity: 'low',
    lang: 'zh',
  },
  {
    tool: 'format_text',
    keywords: ['格式化', '大写', '小写', '首字母', '大小写', 'trim'],
    use_when: '用户要求对文本做大小写、去空白等格式化',
    not_for: '语义改写、翻译、拼接',
    min_complexity: 'low',
    lang: 'zh',
  },
  {
    tool: 'batch_transform',
    keywords: ['批量', '逐个', '列表', '每个', 'batch'],
    use_when: '用户要求对一组/列表项批量做同一变换（如统一加前缀、统一改大小写）',
    // M3 校准点（S9 灰色地带，2026-08-25）：补真实文件系统操作边界——
    // "把这三个文件批量重命名"语义像"批量"，但本工具只处理内存字符串
    not_for: '单条文本加工（用 format_text）、两段拼接（用 concat_text）、文件重命名/移动/删除等真实文件系统操作',
    min_complexity: 'low',
    lang: 'zh',
  },
]

export function apply(ctx, config = {}) {
  const suffix = typeof config === 'object' && config !== null && typeof config.suffix === 'string'
    ? config.suffix
    : ''
  const logPath = path.resolve(
    typeof config === 'object' && config !== null && typeof config.logPath === 'string' && config.logPath
      ? config.logPath
      : DEFAULT_LOG_NAME,
  )

  // ---- echo：冒烟回显 ----
  ctx.tools.register({
    name: 'echo',
    description: 'Echo back the given text. A smoke-test tool proving this plugin row reached the composed tree and registered into the tools registry.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to echo back.',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args) {
      const text = str(args?.text)
      const result = { text: `${text}${suffix}` }
      recordCall(logPath, 'echo', { text }, result)
      return result
    },
  })

  // ---- concat_text：多段文本拼接 ----
  ctx.tools.register({
    name: 'concat_text',
    description: 'Concatenate multiple text pieces into one string, optionally inserting a separator between them.',
    parameters: {
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Text pieces to concatenate, in order.',
        },
        separator: {
          type: 'string',
          description: 'Optional separator inserted between pieces (default empty).',
        },
      },
      required: ['parts'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args) {
      const parts = strArr(args?.parts)
      const separator = str(args?.separator)
      const result = { text: parts.join(separator) }
      recordCall(logPath, 'concat_text', { parts, separator }, result)
      return result
    },
  })

  // ---- format_text：文本格式化（大小写/trim/空白折叠） ----
  ctx.tools.register({
    name: 'format_text',
    description: 'Format a text string: change case (upper/lower/title), trim surrounding whitespace, or collapse repeated whitespace.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to format.',
        },
        mode: {
          type: 'string',
          enum: ['upper', 'lower', 'title', 'trim', 'collapse'],
          description: 'upper: all caps; lower: all lowercase; title: capitalize each word; trim: strip leading/trailing whitespace; collapse: reduce repeated whitespace to single spaces.',
        },
      },
      required: ['text', 'mode'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args) {
      const text = str(args?.text)
      const mode = str(args?.mode)
      let out = text
      if (mode === 'upper') out = text.toUpperCase()
      else if (mode === 'lower') out = text.toLowerCase()
      else if (mode === 'title') out = text.replace(/\b\w/g, c => c.toUpperCase())
      else if (mode === 'trim') out = text.trim()
      else if (mode === 'collapse') out = text.replace(/\s+/g, ' ').trim()
      const result = { text: out }
      recordCall(logPath, 'format_text', { text, mode }, result)
      return result
    },
  })

  // ---- batch_transform：列表批量变换 ----
  ctx.tools.register({
    name: 'batch_transform',
    description: 'Apply one transformation to every item of a list: case change, trim, or prefix/suffix injection — for batch operations on many items.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Items to transform, each one independently.',
        },
        op: {
          type: 'string',
          enum: ['upper', 'lower', 'trim', 'prefix', 'suffix'],
          description: 'upper/lower: case; trim: strip whitespace; prefix/suffix: prepend/append arg to each item.',
        },
        arg: {
          type: 'string',
          description: 'Argument used by prefix/suffix ops.',
        },
      },
      required: ['items', 'op'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', items: { type: 'string' } },
        },
        required: ['items'],
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value.items) }]
      },
    },
    async execute(args) {
      const items = strArr(args?.items)
      const op = str(args?.op)
      const arg = str(args?.arg)
      const out = items.map(item => {
        if (op === 'upper') return item.toUpperCase()
        if (op === 'lower') return item.toLowerCase()
        if (op === 'trim') return item.trim()
        if (op === 'prefix') return arg + item
        if (op === 'suffix') return item + arg
        return item
      })
      const result = { items: out }
      recordCall(logPath, 'batch_transform', { items, op, arg }, result)
      return result
    },
  })

  // 能力声明（dsh-capability-index 约定；disposer 由 cordis effect 持有，随行卸载）
  ctx.provide('capabilityIndex.declarations', {
    version: 2,
    declarations: DECLARATIONS,
  })
}
