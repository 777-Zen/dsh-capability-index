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

  /**
   * 软层总览分组（规模优化 c，2026-08-25）：工具数超过 groupedThreshold 时，
   * 总览从"全量平铺"改为"分类聚合摘要"——260 字符预算下截断先打在"其他"尾部，
   * 而不是任意腰斩清单。分组是纯数据（按部署实际工具名单定制，换环境改这里）；
   * 未列入任何组的工具进"其他"。schema 不暴露工具→插件归属映射，
   * 分类聚合是无 harness 改动前提下可用的最优近似（README 已知问题节有记录）。
   */
  overview: {
    groupedThreshold: 24,
    groups: [
      { label: '文件', names: ['read', 'write', 'edit', 'glob', 'grep', 'read_image'] },
      { label: '文本处理', names: ['echo', 'concat_text', 'format_text', 'batch_transform'] },
      { label: '任务协调', names: ['todo_write', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'send_message', 'interrupt_agent', 'list_agents', 'job_output', 'job_list', 'job_kill'] },
      { label: '插件管理', names: ['skill', 'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self', 'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine'] },
      { label: '目标与确认', names: ['get_goal', 'create_goal', 'update_goal', 'ask_user_question', 'exit_plan_mode'] },
      { label: '系统', names: ['pwsh', 'web_search'] },
    ],
  },

  /**
   * plan 阶段只推只读工具（避免与 plan-mode 规则相抵；实测校准只改这里）。
   * 名单为内置兜底：只读 = 不改写任何文件/状态、不产生副作用的工具。
   */
  plan: {
    readonlyTools: [
      'read', 'read_image', 'glob', 'grep', 'web_search',
      'job_list', 'job_output', 'list_agents', 'skill',
      'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
      'get_goal', 'echo',
    ],
  },

  /**
   * 向量层（v0.2 M2）：相似度阈值与候选数。
   * threshold 初值来自查证 A 实测（bge-small-zh-v1.5：相关句 0.45–0.53，
   * 无关句 0.28–0.32）；M3 用数据校准，不拍脑袋。
   * 2026-08-25 用户拍板：0.35 → 0.58。依据 calibrate-report 首轮扫描：0.58 处
   * 反例噪音 6/6→1/6、violations→0，代价仅 S1（echo 0.508）掉出纯语义路径——
   * B 组实测证明 echo 无提示也会被调用，损失可接受；直接针对 S13/S15 短口语过触发。
   * 注意：生产为 link 部署，本改动需重启 dsh 进程生效。
   */
  embed: {
    threshold: 0.58,
    topK: 3,
  },

  /**
   * 排序权重（A 步脚手架词表 + 声明命中；实测后校准）。 */
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
   * not_for 守门闸（M3 立项 plan-notfor-gate，2026-08-26 实施）。
   * 双信号：① 关键词——声明 not_for 分词与消息词集求交（ASCII 复用 TOKEN_RE+
   * STOPWORDS 口径；中文走 CJK 二元组——TOKEN_RE 是 ASCII 口径，S9 类纯中文
   * 消息没有任何 ASCII token，只复用它则信号结构性失灵）；外加可选显式补词
   * decl.not_for_keywords（子串匹配）。② 嵌入——cosine(任务向量, vec(not_for))。
   * 两档：关键词 ∧ 嵌入≥hardSim → 硬拦（候选移除）；恰一信号命中，或嵌入落
   * [softSim, hardSim) → 软处理（窗口内降位 + 卡片警示行），模型终判权不变。
   * 初值定案依据（2026-08-26 首轮扫描 + probe/notfor-diag.mjs 实测）：
   *  - hardSim 0.62：全部网格档位零附带硬拦；若压到 0.58 虽能硬拦 S9
   *    （S9×batch_transform not_for = 0.582），但距合法工具 S10×format_text
   *    （0.561，shouldUse）仅 0.002 余量，离线语料为生产近似，不可靠——
   *    S9 走软警示路径同样满足验收口径（"消失或带警示行"，plan §4.5）。
   *  - softSim 0.50：0.45 时纯噪音警示偏多（S6-concat 0.474 / S8-format 0.526
   *    均误警），0.55 又贴近 S10-format 0.561 边际；0.50 居中，随样本积累再校准。
   *  - 实现语义修正（首轮校准发现）：软处理为"窗口内降位"，不做池级沉底——
   *    池级沉底实测召回 0.714→0.286（低分噪音反超），已证伪弃用。
   */
  notForGate: {
    enabled: true,
    hardSim: 0.62,
    softSim: 0.5,
    demoteFactor: 0.5,
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
