/**
 * dsh-capability-index —— 触发表 v0.1 数据文件（中文起步）。
 *
 * 词条结构预留 `lang` 标记：v0 只求值 lang === 'zh' 的词条；
 * 英文覆盖后补为纯数据追加（同组信号多语言词条并集求值），不改判定代码。
 *
 * 约定：本文件只放"数据与正则模式"（字符串形式，由 index.js 编译为 RegExp），
 * 不放判定逻辑。数值默认值（Top-K、长度阈值、体积预算）也集中在此，
 * 实测校准只改这里。
 */
export const TRIGGER_TABLE = {
  version: '0.1',

  signals: {
    /** A 显式要求：用户明确点名要过插件库（人为提醒通道 → T1）。 */
    A: {
      lang: 'zh',
      words: [
        '查插件', '过一遍插件', '看看插件', '有哪些插件',
        '用什么插件', '检查插件库', '走一遍插件',
      ],
    },

    /** B 任务型动词：任务型请求的门槛信号。 */
    B: {
      lang: 'zh',
      words: [
        '帮我', '整理', '分析', '生成', '转换', '翻译', '汇总',
        '提取', '批量', '合并', '拆分', '格式化', '统计',
        // 实测补充（v0.1 起步词表缺口：大纲中间地带例子"把两个字符串拼接一下"不触发）：
        '拼接', '输出', '删除', '复制', '移动', '运行', '计算', '保存',
        '下载', '上传', '安装', '部署', '测试', '调试', '修复', '优化',
        '列出', '搜索', '创建', '导出', '导入',
        // 阶段二实测补充（2026-08-15 已观测漏触发样本："那你也更新一下…"被判非任务）：
        '更新',
      ],
      chars: ['做', '写', '改', '建', '查', '找'],
      // "请"单独处理：句首或后接动作词才算任务请求（"请问/申请"不算）。
      please: { startsWith: '请', pattern: '请(帮|把|将|你|您|按|用|先|再)' },
    },

    /** C 具体载体：文件/路径/@引用/图片附件。 */
    C: {
      lang: 'zh',
      // 实测补充：裸"文档/文件/目录/表格/数据"名词同样视为具体载体
      //（例："请把文档翻译成英文" → B+C → T2）。
      attachWords: ['图片', '截图', '照片', '附件', '图像', '文档', '文件', '目录', '表格', '数据'],
      patterns: {
        file: '[A-Za-z][\\w.-]*\\.\\w{1,5}',
        read: '(读|看|查看|阅读|打开).{0,10}?(文件|文档)',
        at: '@[A-Za-z_][\\w-]*|@[\\u4e00-\\u9fa5]{2,}',
      },
    },

    /** D 多子要求：≥2 个任务分句（分隔符 / 先…再…然后…）。 */
    D: {
      lang: 'zh',
      // 注意：整体必须非捕获（(?:…)，且内部不设捕获组）——JS 的 split 对
      // 未参与匹配的捕获组会插入 undefined 元素。分隔标记（先/再/然后…）本身
      // 不进分句统计。
      separators: '(?:[；;。！？!?\\n]+|然后|接着|最后|之后|再|先)',
      minClauseChars: 2,
      minClauses: 2,
    },

    /** F 具体对象：引号内容 / 代码块 / 数字·邮箱·URL 等具体名词模式。 */
    F: {
      lang: 'zh',
      codeFence: '```',
      patterns: {
        quote: '["\'“”‘’「」《》]',
        specific: '\\d{3,}|[\\w.-]+@[\\w-]+\\.[\\w.-]+|https?:\\/\\/\\S+',
      },
    },
  },

  /** 任务量级估计（min_complexity 过滤用；长度只作权重，不作触发条件）。 */
  complexity: {
    longLimit: 80,
    levels: { low: 1, mid: 2, high: 3 },
  },

  /** 硬层提示块预算。 */
  topK: 3,
  descLimit: 50,
  overviewLimit: 260,

  /** 排序权重（A 步脚手架词表 + 声明命中；实测后校准）。 */
  rank: {
    token: 2,
    nameMention: 3,
    declaredKeyword: 4,
    boostRead: { read: 3, glob: 2, grep: 2 },
    boostFile: { read: 1, glob: 1, grep: 1, write: 1, edit: 1, pwsh: 1 },
    boostWrite: { write: 2, edit: 2, todo_write: 1 },
    boostOrg: { todo_write: 2, workflow: 1, subagent: 1, subagent_fork: 1 },
    boostLookup: { web_search: 2, grep: 1, read: 1 },
    hintedFactor: 0.5,
  },

  /**
   * token 化与泛匹配（阶段二调优第一批：2 字符 ASCII token 在英文 description
   * 里子串泛命中大量工具——"ok"→Token/look/took…）。
   * 只约束 ASCII token 匹配；中文走声明 keywords 通道，不受此处影响。
   * nameMention 始终精确匹配（"README" 不误判为点名 "read"）。
   */
  tokens: {
    minLen: 3,
    stopwords: [
      'the', 'and', 'for', 'with', 'you', 'your', 'this', 'that',
      'from', 'into', 'will', 'can', 'please', 'help', 'me', 'what',
      'which', 'when', 'how', 'about', 'then', 'after', 'ok', 'okay',
      'all', 'any', 'are', 'not', 'but', 'has', 'have', 'was', 'were',
      'its', 'our', 'their', 'my', 'his', 'her', 'just', 'some',
      'would', 'could', 'should', 'need', 'want', 'of', 'to', 'in',
      'on', 'at', 'by', 'as', 'or', 'if', 'so', 'no', 'yes', 'also',
      'very', 'more', 'most', 'only', 'over', 'under', 'up', 'down',
      'out', 'off', 'too', 'two', 'one',
    ],
  },
}
