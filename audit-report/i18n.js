'use strict';
// 双语输出文案总表 — 审计工具全部面向人类的文本都在这里，zh / en 成对维护。
//
// 约定：
//   - 键名两边完全一致（collect.test.js 有奇偶校验用例），缺键时回落中文并原样渲染键名；
//   - `{{var}}` 插值；变量由调用方负责转义（HTML 片段如术语链接按原样插入）；
//   - 中文文案是行为基线：测试与既有报告以中文断言，翻译只增不改中文。

const DEFAULT_LANG = 'zh';

// 'zh' | 'zh-CN' → 'zh'；'en' → 'en'；不认识返回 null（由调用方决定报错或回落）
function normLang(lang) {
  if (lang == null || lang === '') return DEFAULT_LANG;
  const l = String(lang).toLowerCase();
  if (l === 'zh' || l.startsWith('zh-')) return 'zh';
  if (l === 'en') return 'en';
  return null;
}

const M = {
  zh: {
    // ---------------------------------------------------------------- 角色 / 严重度 / 裁决
    'role.coder': '实现者',
    'role.coder-resume': '实现者（续跑）',
    'role.reviewer': '评审者',
    'role.final-reviewer': '终审',
    'sev.high': '高危',
    'sev.medium': '注意',
    'sev.low': '背景',
    'verdict.approved': '通过',
    'verdict.changes_requested': '需修改',
    'verdict.ready': '可交付',
    'verdict.ready_with_fixes': '可交付但需修',
    'verdict.not_ready': '不可交付',

    // ---------------------------------------------------------------- 归属引用
    'ref.ticket': '票 {{ticket}}',
    'ref.final': 'run 级终审',

    // ---------------------------------------------------------------- 取证警告
    'warn.events-missing': '事件流不存在：{{file}}',
    'warn.events-unreadable': '事件流不可读：{{file}}',
    'warn.event-parse': '第 {{line}} 行不是合法 JSON，已跳过',
    'warn.ticket-file-missing': '票 {{id}} 的票文件未找到（{{dir}} 下无 {{prefix}}*）',
    'warn.artifact-dir-primary-missing': '按仓库路径推导的会话目录不存在：{{dir}}，尝试全局兜底扫描',
    'warn.sessions-root-unreadable': '会话根目录不可读：{{dir}}',
    'warn.session-file-too-large': '主会话文件超过 64MB，跳过：{{file}}',
    'warn.run-evidence-missing': '运行 {{runId}}（{{ctx}}）未找到平台侧证据',
    'warn.main-session-missing': '未找到匹配的主会话记录，派发任务书原文不可恢复（其余证据不受影响）',
    'warn.findings-unreadable-round': '裁决引用的问题清单不可读：{{path}}（票 {{id}} 第 {{round}} 轮）',
    'warn.findings-unreadable-final': '终审裁决引用的问题清单不可读：{{path}}（第 {{round}} 轮终审）',
    'warn.bundle-unreadable': '评审材料包不可读：{{path}}（票 {{id}} 第 {{round}} 轮）',
    'warn.run-ref-dead': '运行引用 {{runId}}（{{ctx}}，key {{key}}，事件 seq {{seq}}）的 runId 不是 UUID 形状——判定为记账污染的死数据：不探测平台证据、不参与证据缺失类风险推导',
    'warn.ctx': '{{role}}，{{ref}}',

    // ---------------------------------------------------------------- 确定性风险
    'risk.recoveredTag': '——后续运行已恢复',
    'risk.correctedTag': '——已被补正',
    'risk.r1.title': '一次 {{role}}运行以失败告终（退出码 {{exit}}）{{tag}}',
    'risk.r1.detail': '{{ref}}（key {{key}}）的这次运行失败或超时。台账只记最终结果，过程中的失败在此原样暴露。{{recovery}}',
    'risk.r2.title': '一次 {{role}}运行的验收被拒收（{{status}}）{{tag}}',
    'risk.r2.detail': '{{ref}}：平台验收检查未通过（可能缺证据、报告形状不对或门禁失败）。工作可能已完成但被要求重报。{{recovery}}',
    'risk.r3.title': '编排器记了一条异常（序号 {{seq}}）',
    'risk.r3.titleCorrected': '编排器记了一条异常（序号 {{seq}}）——已补正',
    'risk.r3.detailCorrected': '{{note}}｜补正依据：本异常指向的 seq {{tseq}}（{{ttype}}，票 {{tticket}}）在 seq {{cseq}} 有同类型后续记录取代之；异常留痕保留，仅报告口径降级。',
    'risk.r4.title': '票 {{ticket}} 被升级给维护者',
    'risk.r4.defaultDetail': '修复预算耗尽，票未关闭，移交人工裁决。',
    'risk.r5.title': '票 {{id}} 的修复轮数用满预算（{{used}}/{{budget}}）',
    'risk.r5.detail': '该票在评审与修复之间反复多次，值得回看每轮问题清单是否在收敛。',
    'risk.r6.title': '运行未封账',
    'risk.r6.detail': '事件流中没有 close 记账，运行可能中途停止或仍进行中——报告反映的可能不是终局。',
    'risk.r7.title': '封账时最新终审裁决为 not_ready（带伤封账）',
    'risk.r7.detail': '整分支终审判定未就绪，运行仍被封账——多半是用户拍板放弃的合法出口，但代码带着已知问题收场，值得回看终审问题清单。',
    'risk.r8.title': '{{count}} 次运行的平台侧证据缺失',
    'risk.r8.detail': '可能已被平台清理或落在其他项目的会话目录。相关票页会标注证据不可用，时间线与 git 事实不受影响。',
    'risk.r8.titleCorrected': '{{count}} 次运行的平台侧证据缺失{{tag}}',
    'risk.r8.detailCorrected': '这些运行引用已被 anomaly 的补正记录取代（指向事件的同票同类型后续记录）——平台证据缺失是记账污染的残留，不是运行时事实；风险本体保留供核对，补正依据见引用。',
    'risk.r9.title': '{{count}} 次派发的任务书原文未恢复',
    'risk.r9.detail': '主会话数据中未匹配到这些派发的脚本原文（{{list}}）。其余证据不受影响。',
    'risk.r10.title': '票 {{id}} 有 {{count}} 轮评审要求修改',
    'risk.r10.detail': '多轮返工不一定有问题，但值得对照各轮问题清单看修复质量。',
    'risk.recoveredNote': '同票的后续运行已恢复：{{who}}已成功 settle——该次事故是过程抖动而非未处置的伤，故降为 medium（事实性豁免：工作确实被打断过，风险本体不删除）。',
    'risk.recoveryWhoRun': '运行 {{runId}}（{{where}}）',
    'risk.recoveryWhoAnon': '同票后续运行（{{where}}）',
    'risk.recoveryWhere': '事件 seq {{seq}}',
    'risk.recoveryWhereSha': '，提交 {{sha}}',
    'risk.listSep': '、',
    'ev.run': '运行',
    'ev.ticket': '票',
    'ev.event': '事件',
    'ev.correction': '补正',
    'ev.recoveryRun': '恢复运行',
    'ev.recoverySettle': '恢复结算',
    'ev.anomaly': '异常',

    // ---------------------------------------------------------------- 页面骨架
    'layout.htmlLang': 'zh-CN',
    'layout.brand': '流程审计报告',
    'layout.nav.overview': '总览',
    'layout.nav.final': '终审与收尾',
    'layout.nav.glossary': '名词表',
    'layout.footer': '由 pi-matt-implement-flow 审计工具生成 · 纯本地旁路取证 · 生成时间 {{ts}}',

    // ---------------------------------------------------------------- 首页 · 总览
    'overview.title': '流程运行总览',
    'overview.lede': '本报告由已完成的流程运行目录离线取证生成：全部内容来自{{eventStream}}、平台留存的子代理证据与 git 事实，收集过程零大模型调用。',
    'ov.dir': '运行目录',
    'ov.repo': '仓库',
    'ov.branch': '功能分支',
    'ov.baseline': '（基线 {{sha}}）',
    'ov.gate': '测试门禁',
    'ov.flowFlags': '逐票评审{{state}} · 每票修复预算 {{fix}} · 并发 {{conc}}',
    'ov.on': '开',
    'ov.off': '关',
    'ov.flowFlagsDefault': '默认（评审开 · 修复预算 2 · 并发 3）',
    'ov.tracker': '票务',
    'ov.pr': '代码评审 PR',
    'ov.prNone': '无（本地分支）',
    'ov.sealed': '已封账',
    'ov.unsealed': '未封账',
    'ov.stat.tickets': '票数',
    'ov.stat.dispatches': '派发次数',
    'ov.stat.reviews': '评审轮次',
    'ov.stat.fixes': '修复轮次',
    'ov.stat.finals': '终审',
    'ov.stat.cost': '子代理总成本',
    'ov.stat.tokens': '子代理总 token',

    // ---------------------------------------------------------------- 首页 · 风险区
    'risk.title': '异常与风险',
    'risk.subtitle': '确定性检出',
    'risk.intro': '以下条目全部由脚本从事件流、平台证据与 git 事实中机械检出，每条可回溯到出处，不含任何模型推断。',
    'risk.empty': '未检出确定性异常。',
    'ai.title': 'AI 分析意见',
    'ai.subtitle': '非事实记录',
    'ai.intro': '以下内容由大模型基于本报告的确定性证据生成（模型：{{model}}，生成于 {{ts}}）。这是<b>观点层</b>，用于提示可能的交叉矛盾与未建模风险；请对照证据核实，勿作为事实采信。',
    'ai.pill': '意见 · {{sev}}',
    'ai.pillPlain': '意见',
    'ai.empty': '（无意见）',
    'ai.refs': '引用证据：',

    // ---------------------------------------------------------------- 首页 · 票目总表
    'table.title': '票目总表',
    'table.ticket': '票',
    'table.heading': '标题',
    'table.status': '状态',
    'table.fixes': '修复轮',
    'table.mergeSha': '合并提交',
    'table.merged': '已合并',
    'table.escalated': '已升级',
    'table.unmerged': '未合并',
    'table.noReviews': '未评审',
    'table.noTitle': '（票面缺失）',

    // ---------------------------------------------------------------- 事件叙述
    'ev.init': '{{record}} <b>运行初始化</b>：分支 <code>{{branch}}</code>（基线 {{base}}），测试门禁 <code>{{gate}}</code>，票务 {{tracker}}。',
    'ev.pr': '代码评审 PR：{{state}}{{urlPart}}。',
    'ev.prUrl': '（{{url}}）',
    'ev.dispatch': '{{dispatch}} 票 {{ticket}}（key <code>{{key}}</code>，运行 <code>{{run}}</code>{{wt}}）。',
    'ev.ownWorktree': '，独立工作树',
    'ev.settled': '票 {{ticket}} {{settled}}：提交 {{sha}}{{gate}}。',
    'ev.gateSuffix': '，门禁：{{gate}}',
    'ev.verdict': '票 {{ticket}} {{verdict}}（第 {{round}} 轮）：<b>{{label}}</b>{{findings}}。',
    'ev.findingsSuffix': '，问题清单 <code>{{file}}</code>',
    'ev.fix': '票 {{ticket}} {{fix}} {{fixNo}}：{{resume}}同一实现者（key <code>{{key}}</code>{{note}}）。',
    'ev.noteSuffix': '——{{note}}',
    'ev.noteComma': '，{{note}}',
    'ev.merge': '票 {{ticket}} <b>合并</b>：merge {{sha}}{{note}}。',
    'ev.final': '{{final}}裁决：<b>{{label}}</b>（运行 <code>{{run}}</code>）{{findings}}。',
    'ev.escalate': '票 {{ticket}} <b class="bad-text">{{escalate}}</b>：{{note}}',
    'ev.escalateDefault': '预算耗尽，移交维护者。',
    'ev.anomaly': '<b class="bad-text">{{anomaly}}</b>：{{note}}',
    'ev.close': '<b>{{close}}</b>：运行终结。{{note}}',
    'ev.unknown': '<b>{{type}}</b>：<code>{{payload}}</code>',

    // ---------------------------------------------------------------- 时间线 / 成本 / 名词表
    'tl.title': '事件时间线',
    'tl.subtitle': '叙述化',
    'tl.intro': '由{{eventStream}}逐条渲染：每条{{record}}都带权威序号与时间戳，可回到运行目录 <code>events.jsonl</code> 对账。',
    'cost.title': '用量与成本',
    'cost.role': '环节',
    'cost.runs': '运行次数',
    'cost.cost': '成本',
    'cost.tokens': 'token',
    'cost.total': '合计',
    'cost.note': '口径：事件流中有运行 ID 记录的子代理（含 run 级终审——其运行 ID 由 final 事件承载）；旧账无 final 事件时终审运行降级为平台证据目录扫描汇集，见 {{link}}。',
    'gl.title': '名词表',
    'gl.intro': '正文中的术语都链接到这里。域词汇与包内 <code>CONTEXT.md</code> 保持一致。',
    'gl.group.domain': '域词汇',
    'gl.group.flow': '流程环节',
    'gl.group.platform': '平台与证据',

    // ---------------------------------------------------------------- 运行证据卡
    'run.evidence': '运行证据',
    'run.missing': '证据缺失（可能已被平台清理）· 运行 <code>{{run}}</code>',
    'run.title': '{{role}}运行 <code>{{run}}</code>',
    'run.modelWord': '模型',
    'run.exitWord': '退出码',
    'run.costWord': '成本',
    'run.tokenWord': 'token',
    'run.acceptanceWord': '验收状态',
    'run.gateHead': '门禁：',
    'run.checkLine': '{{id}}：{{status}}',
    'run.verifyLine': '<b>{{id}}</b> <code>{{command}}</code> — {{statusPart}}',
    'run.verifyMs': '（{{ms}} ms）',
    'run.verifyDetails': '查看门禁输出',
    'run.checksDetails': '验收检查明细',
    'run.childReport': '实现者结构化报告（原始字段）',
    'run.structuredValue': '结构化输出（原始字段）',
    'run.outputMd': '最终输出全文',
    'run.nested': '内部派发（{{count}} 次，{{twoAxis}}轴代理等）',
    'run.nestedAgentScript': '（编排脚本）',
    'run.nestedAgentUnknown': '（未知）',
    'run.transcript': '完整过程记录：<code>{{path}}</code>',

    // ---------------------------------------------------------------- 票页
    'tp.seqMeta': '· {{ts}} · 序号 {{seq}}',
    'tp.brief': '派发任务书原文（从主会话恢复）',
    'tp.briefMissing': '派发任务书原文未能从主会话恢复。',
    'tp.commitAnchor': '提交锚点 {{sha}}',
    'tp.gateSummary': ' · 门禁摘要：{{gate}}',
    'tp.worktreePart': ' · <span class="muted small">工作树 <code>{{path}}</code></span>',
    'tp.verdictStep': '{{verdict}}（第 {{round}} 轮）',
    'tp.verdictResult': '结论 {{pill}}{{note}}',
    'tp.findingsFull': '问题清单全文（{{file}}）',
    'tp.findingsMissing': '问题清单文件缺失或不可读：<code>{{path}}</code>（可能已被清理）',
    'tp.bundleDiff': '评审材料包 diff（{{size}}）',
    'tp.bundleMissing': '评审材料包缺失或不可读：<code>reviews/{{id}}-r{{round}}.diff</code>',
    'tp.truncatedFull': '（原文 {{size}}，已截断展示）',
    'tp.truncatedShort': '（已截断）',
    'tp.fixNote': '问题摘要：{{note}}',
    'tp.fixBrief': '修复任务书原文（续跑指令，从主会话恢复）',
    'tp.fixBriefMissing': '修复任务书原文未能恢复。',
    'tp.mergeStep': '合并',
    'tp.mergeCard': 'merge {{mergeSha}} ← 票头 {{headSha}}{{note}}',
    'tp.mergeSubject': '提交主题：{{subject}}',
    'tp.mergeUnreachable': '（合并提交已不在当前分支可达范围）',
    'tp.roundLabel': '第 {{n}} 轮',
    'tp.fixRoundLabel': '修复轮 {{n}}',
    'tp.pagerPrev': '← 票 {{id}}',
    'tp.pagerHome': '返回总览',
    'tp.pagerNext': '票 {{id}} →',
    'tp.title': '票 {{id}}：{{title}}',
    'tp.ticketFile': '票面文件 <code>{{path}}</code>',
    'tp.ticketFileMissing': '票面文件未找到',
    'tp.ticketBody': '票面原文',
    'tp.noDispatch': '本票没有派发记录。',

    // ---------------------------------------------------------------- 终审与收尾页
    'fp.title': '终审与收尾',
    'fp.intro': '终审运行由{{eventStream}}的 <code>final</code> 事件驱动汇集（runId 与裁决均取自事件）；旧账无 final 事件时降级为平台证据目录扫描。',
    'fp.none': '未找到终审（final-reviewer）运行证据。',
    'fp.stepTitle': '{{final}} 运行 <code>{{run}}</code> <span class="muted">· 模型 {{model}} · 成本 {{cost}}</span>',
    'fp.noVerdict': '（结构化结论未提取，见全文）',
    'fp.seqMeta': ' <span class="muted small">· 记账序号 {{seq}} · {{ts}}</span>',
    'fp.deadRef': '该 final 事件的 runId 明显不是平台运行 ID 形态——判定为记账污染的死数据：不探测平台证据；裁决仍以事件流为准（取证告警另见 run-ref-dead 留痕）。',
    'fp.structured': '结构化结论（原始字段）',
    'fp.reportFull': '终审报告全文',
    'fp.finalBundle': '整分支评审材料包（{{size}}）',
    'fp.anomaliesTitle': '{{anomaly}}与{{escalate}}',
    'fp.anomalyEntry': '<b class="bad-text">异常记录</b>：{{note}}',
    'fp.escalateEntry': '<b class="bad-text">升级</b> 票 {{ticket}}：{{note}}',
    'fp.sealNote': '运行终结。',
    'fp.unsealedTitle': '运行未封账',
    'fp.unsealedDetail': '事件流没有 close 记账，本报告可能不反映终局。',
    'fp.notesTitle': '{{notes}}（全文）',
    'fp.notesFold': '展开阅读 notes.md',

    // ---------------------------------------------------------------- CLI（report.js）
    'cli.usage': `用法: node audit-report/report.js --runtime-dir <流程运行目录> [选项]

选项:
  --lang <zh|en>           报告站点与全部输出的语言（默认 zh）
  --out <dir>              报告输出目录（默认 <runtimeDir>/report）
  --ai-analysis <file>     读取 AI 分析意见 JSON 并渲染为「分析意见」区块
  --ai-brief               额外导出 AI 分析简报 analysis-brief.md（零成本人工/模型分析入口）

说明:
  对一次已完成（或进行中）的流程运行做纯本地旁路取证，生成可浏览的静态报告网站。
  不调用任何大模型；主流程代码零改动，对目标仓库只读。`,
    'cli.badLang': '不支持的语言：{{lang}}（支持 zh / en）',
    'cli.done': '✓ 审计报告已生成（{{ms}} ms，零 LLM 调用）',
    'cli.runtimeDir': '  运行目录: {{v}}',
    'cli.outDir': '  报告输出: {{v}}',
    'cli.pages': '  页面: {{n}} 个（首页 index.html）',
    'cli.risks': '  确定性风险: {{n}} 条（高 {{high}}）',
    'cli.warnings': '  取证降级警告: {{n}} 条（详见报告内标注与 model.json）',
    'cli.aiOpinion': '  AI 分析意见: {{n}} 条（已标注为观点层）',
    'cli.aiBrief': '  AI 分析简报: {{path}}（分析后回填 ai-analysis.json 再重跑即可）',
    'cli.aiMissing': '指定的 AI 意见文件不存在：{{path}}（将只渲染确定性事实区）',
    'cli.aiParseError': 'AI 意见文件解析失败：{{msg}}',
    'cli.invalidRuntimeDir': '不是有效的流程运行目录（缺 events.jsonl）：{{dir}}',

    // ---------------------------------------------------------------- AI 分析简报
    'brief.title': '# 审计分析简报 · {{slug}}',
    'brief.provenance': '> 本简报由审计工具从下列确定性来源机械整理：事件流（{{events}} 条）、平台子代理证据（{{runs}} 次运行）、git 事实。',
    'brief.instruction': '> 请基于本简报做交叉一致性检查与未建模风险识别；每条结论必须引用本简报中的条目编号或运行 ID 作为证据。',
    'brief.s1': '## 一、确定性异常（脚本检出）',
    'brief.s2': '## 二、票目与裁决汇总',
    'brief.s3': '## 三、成本与用量',
    'brief.s4': '## 四、异常记录与升级（事件原文）',
    'brief.s5': '## 五、收尾状态',
    'brief.s6': '## 六、运行清单（runId × 角色 × 状态）',
    'brief.none': '（无）',
    'brief.ticketLine': '- 票 {{id}}「{{title}}」 评审 {{verdicts}}，修复 {{fixes}} 轮，{{merge}}',
    'brief.noVerdicts': '未评审',
    'brief.notMerged': '未合并',
    'brief.roleLine': '- {{role}}: {{runs}} 次运行, ${{cost}}, {{tokens}} tokens',
    'brief.anomalyLine': '- anomaly #{{seq}}: {{note}}',
    'brief.escalateLine': '- escalate #{{seq}} 票 {{ticket}}: {{note}}',
    'brief.sealed': '- 封账: 是（{{note}}）',
    'brief.unsealed': '- 封账: 否 —— 运行未终结',
    'brief.prLine': '- PR: {{value}}',
    'brief.noPr': '无',
    'brief.runLine': '- {{runId}} [{{role}}] {{ref}} key={{key}} {{status}}',
    'brief.runStatus': 'exit={{exit}} 验收={{acceptance}} 模型={{model}}',
    'brief.evidenceMissing': '证据缺失',
    'brief.aiInstructions': `---

## 给分析者的回填说明（大模型或人类）

分析完成后，把结论写入 <报告输出目录>/ai-analysis.json，格式：

{
  "model": "<分析所用模型或 human>",
  "generatedAt": "<ISO 时间>",
  "findings": [
    { "severity": "high|medium|low",
      "title": "一句话风险标题",
      "detail": "推理与依据",
      "evidenceRefs": ["简报中的条目编号 / runId / 票号"] }
  ]
}

然后重跑本工具（带 --ai-analysis <该文件>），意见会渲染进报告的独立「AI 分析意见」区块，
与确定性事实明确分层。
`,
  },

  en: {
    // ---------------------------------------------------------------- roles / severity / verdicts
    'role.coder': 'Coder',
    'role.coder-resume': 'Coder (resumed)',
    'role.reviewer': 'Reviewer',
    'role.final-reviewer': 'Final reviewer',
    'sev.high': 'High',
    'sev.medium': 'Medium',
    'sev.low': 'Low',
    'verdict.approved': 'Approved',
    'verdict.changes_requested': 'Changes requested',
    'verdict.ready': 'Ready',
    'verdict.ready_with_fixes': 'Ready with fixes',
    'verdict.not_ready': 'Not ready',

    // ---------------------------------------------------------------- attribution refs
    'ref.ticket': 'ticket {{ticket}}',
    'ref.final': 'run-level final review',

    // ---------------------------------------------------------------- forensics warnings
    'warn.events-missing': 'Event stream not found: {{file}}',
    'warn.events-unreadable': 'Event stream unreadable: {{file}}',
    'warn.event-parse': 'Line {{line}} is not valid JSON; skipped',
    'warn.ticket-file-missing': 'Ticket file for ticket {{id}} not found (no {{prefix}}* under {{dir}})',
    'warn.artifact-dir-primary-missing': 'Session directory derived from the repo path does not exist: {{dir}}; falling back to a global scan',
    'warn.sessions-root-unreadable': 'Sessions root unreadable: {{dir}}',
    'warn.session-file-too-large': 'Main-session file exceeds 64MB, skipped: {{file}}',
    'warn.run-evidence-missing': 'Run {{runId}} ({{ctx}}): no platform-side evidence found',
    'warn.main-session-missing': 'No matching main-session record found; dispatch briefs cannot be restored (other evidence unaffected)',
    'warn.findings-unreadable-round': 'Findings referenced by the verdict unreadable: {{path}} (ticket {{id}}, round {{round}})',
    'warn.findings-unreadable-final': 'Findings referenced by the final verdict unreadable: {{path}} (final round {{round}})',
    'warn.bundle-unreadable': 'Review bundle unreadable: {{path}} (ticket {{id}}, round {{round}})',
    'warn.run-ref-dead': 'Run reference {{runId}} ({{ctx}}, key {{key}}, event seq {{seq}}) carries a runId that is not UUID-shaped — dead data from bookkeeping pollution: no platform evidence is probed and it takes no part in evidence-missing risk derivation',
    'warn.ctx': '{{role}}, {{ref}}',

    // ---------------------------------------------------------------- deterministic risks
    'risk.recoveredTag': ' — recovered by a later run',
    'risk.correctedTag': ' — corrected',
    'risk.r1.title': 'A {{role}} run ended in failure (exit code {{exit}}){{tag}}',
    'risk.r1.detail': 'This run of {{ref}} (key {{key}}) failed or timed out. The ledger only records final outcomes; failures along the way are surfaced here as they happened.{{recovery}}',
    'risk.r2.title': "A {{role}} run's acceptance was rejected ({{status}}){{tag}}",
    'risk.r2.detail': '{{ref}}: the platform acceptance check failed (missing evidence, a malformed report, or a failing gate). The work may already be done but was asked to be re-reported.{{recovery}}',
    'risk.r3.title': 'The orchestrator recorded an anomaly (seq {{seq}})',
    'risk.r3.titleCorrected': 'The orchestrator recorded an anomaly (seq {{seq}}) — corrected',
    'risk.r3.detailCorrected': '{{note}} | Correction basis: the record it points to, seq {{tseq}} ({{ttype}}, ticket {{tticket}}), has been superseded by a later same-type record at seq {{cseq}}; the anomaly record is kept and only the report posture is downgraded.',
    'risk.r4.title': 'Ticket {{ticket}} was escalated to the maintainer',
    'risk.r4.defaultDetail': 'Fix budget exhausted; the ticket stays open and is handed to a human decision.',
    'risk.r5.title': 'Ticket {{id}} used up its fix-round budget ({{used}}/{{budget}})',
    'risk.r5.detail': 'This ticket went back and forth between review and fixes; worth re-reading each round\u2019s findings to see whether they converge.',
    'risk.r6.title': 'Run not sealed',
    'risk.r6.detail': 'No close event in the stream: the run may have stopped midway or still be in progress — this report may not reflect the end state.',
    'risk.r7.title': 'Sealed with the latest final verdict not_ready (sealed with a wound)',
    'risk.r7.detail': 'The whole-branch final review judged it not ready, yet the run was sealed — most likely a legitimate abandoned exit, but the code ends with known issues; worth re-reading the final findings.',
    'risk.r8.title': 'Platform-side evidence missing for {{count}} {{count|run|runs}}',
    'risk.r8.detail': 'Probably cleaned up by the platform or living in another project\u2019s session directory. Affected ticket pages are marked as evidence-unavailable; the timeline and git facts are unaffected.',
    'risk.r8.titleCorrected': 'Platform-side evidence missing for {{count}} {{count|run|runs}}{{tag}}',
    'risk.r8.detailCorrected': 'These run references have been superseded by anomaly correction records (a later same-type record on the same ticket as the pointed-to event) — the missing platform evidence is residue of bookkeeping pollution, not a runtime fact; the risk itself is kept for cross-checking, with the correction basis in the references.',
    'risk.r9.title': 'Dispatch briefs unrestored for {{count}} {{count|dispatch|dispatches}}',
    'risk.r9.detail': 'The script text of these dispatches was not matched in the main-session data ({{list}}). Other evidence is unaffected.',
    'risk.r10.title': 'Ticket {{id}} has {{count}} review {{count|round|rounds}} requesting changes',
    'risk.r10.detail': 'Multiple rework rounds are not necessarily a problem — but compare each round\u2019s findings against the fixes.',
    'risk.recoveredNote': ' A later run on the same ticket recovered: {{who}} settled successfully — the incident was process jitter rather than an unhandled wound, so it drops to medium (a factual exemption: the work really was interrupted, and the risk item is not deleted).',
    'risk.recoveryWhoRun': 'run {{runId}} ({{where}})',
    'risk.recoveryWhoAnon': 'a later run on the same ticket ({{where}})',
    'risk.recoveryWhere': 'event seq {{seq}}',
    'risk.recoveryWhereSha': ', commit {{sha}}',
    'risk.listSep': ', ',
    'ev.run': 'Run',
    'ev.ticket': 'Ticket',
    'ev.event': 'Event',
    'ev.correction': 'Correction',
    'ev.recoveryRun': 'Recovery run',
    'ev.recoverySettle': 'Recovery settle',
    'ev.anomaly': 'Anomaly',

    // ---------------------------------------------------------------- page skeleton
    'layout.htmlLang': 'en',
    'layout.brand': 'Flow audit report',
    'layout.nav.overview': 'Overview',
    'layout.nav.final': 'Final & close',
    'layout.nav.glossary': 'Glossary',
    'layout.footer': 'Generated by the pi-matt-implement-flow audit tool \u00b7 pure local side-channel forensics \u00b7 {{ts}}',

    // ---------------------------------------------------------------- index · overview
    'overview.title': 'Run overview',
    'overview.lede': 'This report is generated by offline forensics over a finished run directory: everything comes from the {{eventStream}}, the platform\u2019s retained subagent evidence and git facts — zero LLM calls while collecting.',
    'ov.dir': 'Run directory',
    'ov.repo': 'Repo',
    'ov.branch': 'Feature branch',
    'ov.baseline': ' (baseline {{sha}})',
    'ov.gate': 'Test gate',
    'ov.flowFlags': 'per-ticket review {{state}} \u00b7 fix budget {{fix}} \u00b7 concurrency {{conc}}',
    'ov.on': 'on',
    'ov.off': 'off',
    'ov.flowFlagsDefault': 'Default (review on \u00b7 fix budget 2 \u00b7 concurrency 3)',
    'ov.tracker': 'Ticket tracker',
    'ov.pr': 'Code review PR',
    'ov.prNone': 'none (local branch)',
    'ov.sealed': 'sealed',
    'ov.unsealed': 'not sealed',
    'ov.stat.tickets': 'Tickets',
    'ov.stat.dispatches': 'Dispatches',
    'ov.stat.reviews': 'Review rounds',
    'ov.stat.fixes': 'Fix rounds',
    'ov.stat.finals': 'Final reviews',
    'ov.stat.cost': 'Total subagent cost',
    'ov.stat.tokens': 'Total subagent tokens',

    // ---------------------------------------------------------------- index · risks
    'risk.title': 'Anomalies & risks',
    'risk.subtitle': 'deterministic findings',
    'risk.intro': 'Every item below is found mechanically by script from the event stream, platform evidence and git facts; each traces back to its source and contains no model inference.',
    'risk.empty': 'No deterministic anomalies found.',
    'ai.title': 'AI analysis',
    'ai.subtitle': 'non-factual',
    'ai.intro': 'The following was generated by a language model from this report\u2019s deterministic evidence (model: {{model}}, generated {{ts}}). This is the <b>opinion layer</b>, for hinting at cross-evidence contradictions and unmodelled risks — verify against the evidence, do not take it as fact.',
    'ai.pill': 'Opinion \u00b7 {{sev}}',
    'ai.pillPlain': 'Opinion',
    'ai.empty': '(no opinions)',
    'ai.refs': 'Evidence refs: ',

    // ---------------------------------------------------------------- index · ticket table
    'table.title': 'Tickets',
    'table.ticket': 'Ticket',
    'table.heading': 'Title',
    'table.status': 'Status',
    'table.fixes': 'Fix rounds',
    'table.mergeSha': 'Merge commit',
    'table.merged': 'merged',
    'table.escalated': 'escalated',
    'table.unmerged': 'not merged',
    'table.noReviews': 'unreviewed',
    'table.noTitle': '(ticket text missing)',

    // ---------------------------------------------------------------- event narration
    'ev.init': '{{record}} <b>run initialised</b>: branch <code>{{branch}}</code> (baseline {{base}}), test gate <code>{{gate}}</code>, tracker {{tracker}}.',
    'ev.pr': 'Code review PR: {{state}}{{urlPart}}.',
    'ev.prUrl': ' ({{url}})',
    'ev.dispatch': '{{dispatch}} ticket {{ticket}} (key <code>{{key}}</code>, run <code>{{run}}</code>{{wt}}).',
    'ev.ownWorktree': ', own worktree',
    'ev.settled': 'ticket {{ticket}} {{settled}}: commit {{sha}}{{gate}}.',
    'ev.gateSuffix': ', gate: {{gate}}',
    'ev.verdict': 'ticket {{ticket}} {{verdict}} (round {{round}}): <b>{{label}}</b>{{findings}}.',
    'ev.findingsSuffix': ', findings <code>{{file}}</code>',
    'ev.fix': 'ticket {{ticket}} {{fix}} {{fixNo}}: {{resume}} the same coder (key <code>{{key}}</code>{{note}}).',
    'ev.noteSuffix': ' \u2014 {{note}}',
    'ev.noteComma': ', {{note}}',
    'ev.merge': 'ticket {{ticket}} <b>merged</b>: merge {{sha}}{{note}}.',
    'ev.final': '{{final}} verdict: <b>{{label}}</b> (run <code>{{run}}</code>){{findings}}.',
    'ev.escalate': 'ticket {{ticket}} <b class="bad-text">{{escalate}}</b>: {{note}}',
    'ev.escalateDefault': 'budget exhausted, handed to the maintainer.',
    'ev.anomaly': '<b class="bad-text">{{anomaly}}</b>: {{note}}',
    'ev.close': '<b>{{close}}</b>: run ended. {{note}}',
    'ev.unknown': '<b>{{type}}</b>: <code>{{payload}}</code>',

    // ---------------------------------------------------------------- timeline / cost / glossary
    'tl.title': 'Event timeline',
    'tl.subtitle': 'narrated',
    'tl.intro': 'Rendered event by event from the {{eventStream}}: every {{record}} carries an authoritative sequence number and timestamp, and can be reconciled against <code>events.jsonl</code> in the run directory.',
    'cost.title': 'Usage & cost',
    'cost.role': 'Role',
    'cost.runs': 'Runs',
    'cost.cost': 'Cost',
    'cost.tokens': 'Tokens',
    'cost.total': 'Total',
    'cost.note': 'Basis: subagent runs whose run IDs are recorded in the event stream (including run-level final reviews \u2014 their run IDs ride on the final event); for pre-final ledgers the final-review runs fall back to artifact-directory scanning, see {{link}}.',
    'gl.title': 'Glossary',
    'gl.intro': 'Terms in the text link here. Domain vocabulary stays in sync with <code>CONTEXT.md</code> in the package.',
    'gl.group.domain': 'Domain vocabulary',
    'gl.group.flow': 'Flow steps',
    'gl.group.platform': 'Platform & evidence',

    // ---------------------------------------------------------------- run evidence card
    'run.evidence': 'Run evidence',
    'run.missing': 'Evidence missing (possibly cleaned up by the platform) \u00b7 run <code>{{run}}</code>',
    'run.title': '{{role}} run <code>{{run}}</code>',
    'run.modelWord': 'model',
    'run.exitWord': 'exit code',
    'run.costWord': 'cost',
    'run.tokenWord': 'tokens',
    'run.acceptanceWord': 'acceptance',
    'run.gateHead': 'Gates:',
    'run.checkLine': '{{id}}: {{status}}',
    'run.verifyLine': '<b>{{id}}</b> <code>{{command}}</code> \u2014 {{statusPart}}',
    'run.verifyMs': ' ({{ms}} ms)',
    'run.verifyDetails': 'Show gate output',
    'run.checksDetails': 'Acceptance check details',
    'run.childReport': 'Implementer\u2019s structured report (raw fields)',
    'run.structuredValue': 'Structured output (raw fields)',
    'run.outputMd': 'Final output, full text',
    'run.nested': 'Internal dispatches ({{count}}, e.g. {{twoAxis}} axis agents)',
    'run.nestedAgentScript': '(orchestration script)',
    'run.nestedAgentUnknown': '(unknown)',
    'run.transcript': 'Full process transcript: <code>{{path}}</code>',

    // ---------------------------------------------------------------- ticket page
    'tp.seqMeta': '\u00b7 {{ts}} \u00b7 seq {{seq}}',
    'tp.brief': 'Dispatch brief, verbatim (restored from the main session)',
    'tp.briefMissing': 'The dispatch brief could not be restored from the main session.',
    'tp.commitAnchor': 'commit anchor {{sha}}',
    'tp.gateSummary': ' \u00b7 gate summary: {{gate}}',
    'tp.worktreePart': ' \u00b7 <span class="muted small">worktree <code>{{path}}</code></span>',
    'tp.verdictStep': '{{verdict}} (round {{round}})',
    'tp.verdictResult': 'Verdict {{pill}}{{note}}',
    'tp.findingsFull': 'Findings, full text ({{file}})',
    'tp.findingsMissing': 'Findings file missing or unreadable: <code>{{path}}</code> (possibly cleaned up)',
    'tp.bundleDiff': 'Review bundle diff ({{size}})',
    'tp.bundleMissing': 'Review bundle missing or unreadable: <code>reviews/{{id}}-r{{round}}.diff</code>',
    'tp.truncatedFull': '(original {{size}}, truncated for display)',
    'tp.truncatedShort': '(truncated)',
    'tp.fixNote': 'Issue summary: {{note}}',
    'tp.fixBrief': 'Fix brief, verbatim (resume instruction, restored from the main session)',
    'tp.fixBriefMissing': 'The fix brief could not be restored.',
    'tp.mergeStep': 'Merge',
    'tp.mergeCard': 'merge {{mergeSha}} \u2190 ticket head {{headSha}}{{note}}',
    'tp.mergeSubject': 'Commit subject: {{subject}}',
    'tp.mergeUnreachable': '(the merge commit is no longer reachable from the current branch)',
    'tp.roundLabel': 'Round {{n}}',
    'tp.fixRoundLabel': 'Fix round {{n}}',
    'tp.pagerPrev': '\u2190 Ticket {{id}}',
    'tp.pagerHome': 'Back to overview',
    'tp.pagerNext': 'Ticket {{id}} \u2192',
    'tp.title': 'Ticket {{id}}: {{title}}',
    'tp.ticketFile': 'Ticket file <code>{{path}}</code>',
    'tp.ticketFileMissing': 'Ticket file not found',
    'tp.ticketBody': 'Ticket text, verbatim',
    'tp.noDispatch': 'This ticket has no dispatch records.',

    // ---------------------------------------------------------------- final & close page
    'fp.title': 'Final review & close',
    'fp.intro': 'Final-review runs are collected from the <code>final</code> events of the {{eventStream}} (runId and verdict both come from the event); pre-final ledgers fall back to artifact-directory scanning.',
    'fp.none': 'No final-review (final-reviewer) run evidence found.',
    'fp.stepTitle': '{{final}} run <code>{{run}}</code> <span class="muted">\u00b7 model {{model}} \u00b7 cost {{cost}}</span>',
    'fp.noVerdict': '(structured verdict not extracted; see full text)',
    'fp.seqMeta': ' <span class="muted small">\u00b7 event seq {{seq}} \u00b7 {{ts}}</span>',
    'fp.deadRef': 'This final event\u2019s runId is clearly not in the platform run-id shape \u2014 dead data from bookkeeping pollution: no platform evidence is probed; the verdict still comes from the event stream (the forensics warning is kept as run-ref-dead).',
    'fp.structured': 'Structured verdict (raw fields)',
    'fp.reportFull': 'Final review report, full text',
    'fp.finalBundle': 'Whole-branch review bundle ({{size}})',
    'fp.anomaliesTitle': '{{anomaly}} and {{escalate}}',
    'fp.anomalyEntry': '<b class="bad-text">Anomaly</b>: {{note}}',
    'fp.escalateEntry': '<b class="bad-text">Escalation</b> ticket {{ticket}}: {{note}}',
    'fp.sealNote': 'Run ended.',
    'fp.unsealedTitle': 'Run not sealed',
    'fp.unsealedDetail': 'No close event in the stream: this report may not reflect the end state.',
    'fp.notesTitle': '{{notes}} (full text)',
    'fp.notesFold': 'Expand to read notes.md',

    // ---------------------------------------------------------------- CLI (report.js)
    'cli.usage': `Usage: node audit-report/report.js --runtime-dir <run directory> [options]

Options:
  --lang <zh|en>           language of the report site and all output (default zh)
  --out <dir>              report output directory (default <runtimeDir>/report)
  --ai-analysis <file>     read an AI analysis JSON and render it as the analysis section
  --ai-brief               also export an AI analysis brief (analysis-brief.md)

Notes:
  Purely local side-channel forensics over one finished (or in-progress) run, producing a
  browsable static report site. Zero LLM calls; the main flow is untouched and the target
  repo is read-only.`,
    'cli.badLang': 'Unsupported language: {{lang}} (zh / en supported)',
    'cli.done': '\u2713 audit report generated ({{ms}} ms, zero LLM calls)',
    'cli.runtimeDir': '  Run directory: {{v}}',
    'cli.outDir': '  Report output: {{v}}',
    'cli.pages': '  Pages: {{n}} (index.html is the home page)',
    'cli.risks': '  Deterministic risks: {{n}} (high: {{high}})',
    'cli.warnings': '  Forensics downgrade warnings: {{n}} (see in-report annotations and model.json)',
    'cli.aiOpinion': '  AI analysis opinions: {{n}} (marked as the opinion layer)',
    'cli.aiBrief': '  AI analysis brief: {{path}} (analyse, backfill ai-analysis.json, rerun)',
    'cli.aiMissing': 'The specified AI analysis file does not exist: {{path}} (rendering deterministic facts only)',
    'cli.aiParseError': 'Failed to parse the AI analysis file: {{msg}}',
    'cli.invalidRuntimeDir': 'Not a valid run directory (missing events.jsonl): {{dir}}',

    // ---------------------------------------------------------------- AI analysis brief
    'brief.title': '# Audit analysis brief \u00b7 {{slug}}',
    'brief.provenance': '> Assembled mechanically by the audit tool from deterministic sources: event stream ({{events}} {{events|event|events}}), platform subagent evidence ({{runs}} {{runs|run|runs}}), git facts.',
    'brief.instruction': '> Please cross-check consistency and identify unmodelled risks from this brief; every conclusion must cite an item number or run ID from this brief as evidence.',
    'brief.s1': '## 1. Deterministic anomalies (script findings)',
    'brief.s2': '## 2. Tickets and verdicts',
    'brief.s3': '## 3. Cost and usage',
    'brief.s4': '## 4. Anomaly and escalation records (verbatim events)',
    'brief.s5': '## 5. Closing state',
    'brief.s6': '## 6. Run inventory (runId \u00d7 role \u00d7 status)',
    'brief.none': '(none)',
    'brief.ticketLine': '- Ticket {{id}} "{{title}}": review {{verdicts}}, {{fixes}} fix rounds, {{merge}}',
    'brief.noVerdicts': 'unreviewed',
    'brief.notMerged': 'not merged',
    'brief.roleLine': '- {{role}}: {{runs}} {{runs|run|runs}}, ${{cost}}, {{tokens}} tokens',
    'brief.anomalyLine': '- anomaly #{{seq}}: {{note}}',
    'brief.escalateLine': '- escalate #{{seq}} ticket {{ticket}}: {{note}}',
    'brief.sealed': '- Sealed: yes ({{note}})',
    'brief.unsealed': '- Sealed: no \u2014 the run never ended',
    'brief.prLine': '- PR: {{value}}',
    'brief.noPr': 'none',
    'brief.runLine': '- {{runId}} [{{role}}] {{ref}} key={{key}} {{status}}',
    'brief.runStatus': 'exit={{exit}} acceptance={{acceptance}} model={{model}}',
    'brief.evidenceMissing': 'evidence missing',
    'brief.aiInstructions': `---

## Backfill instructions (for the language model or a human)

When the analysis is done, write the conclusions to <report output dir>/ai-analysis.json:

{
  "model": "<model used, or human>",
  "generatedAt": "<ISO timestamp>",
  "findings": [
    { "severity": "high|medium|low",
      "title": "one-line risk title",
      "detail": "reasoning and basis",
      "evidenceRefs": ["item number / runId / ticket id from this brief"] }
  ]
}

Then rerun this tool with --ai-analysis <that file>; opinions render into the dedicated
"AI analysis" section, clearly layered apart from deterministic facts.
`,
  },
};

// 取文案：缺键回落中文（行为基线），仍缺则原样返回键名。vars 按原样插入（HTML 片段由调用方拼装）。
// 返回的函数带 .lang（归一后的语言码），供 term() 等按语言调整展示形态。
function makeT(lang) {
  const l = normLang(lang) || DEFAULT_LANG;
  const cat = M[l];
  const f = (key, vars) => {
    let s = cat[key];
    if (s == null) s = M[DEFAULT_LANG][key];
    if (s == null) return key;
    if (!vars) return s;
    // 先处理词形占位 {{name|单数|复数}}（值为 1 取单数，否则复数；只出词不出数字），再做普通插值
    s = s.replace(/\{\{(\w+)\|([^|}]*)\|([^}]*)\}\}/g, (whole, name, one, many) => {
      const v = vars[name];
      if (v == null) return '';
      return Number(v) === 1 ? one : many;
    });
    return s.replace(/\{\{(\w+)\}\}/g, (whole, name) => (vars[name] != null ? String(vars[name]) : ''));
  };
  f.lang = l;
  return f;
}

// 角色中文/英文标签：未知角色原样展示（新角色未入表时不假装认识）
function roleLabel(lang, role) {
  const key = `role.${role}`;
  const s = makeT(lang)(key);
  return s === key ? role : s;
}

// 显式缺键判断——调用方不再拿「译文等于键名」当隐式哨兵
function hasKey(lang, key) {
  const l = normLang(lang) || DEFAULT_LANG;
  return Object.prototype.hasOwnProperty.call(M[l], key) || Object.prototype.hasOwnProperty.call(M[DEFAULT_LANG], key);
}

module.exports = { DEFAULT_LANG, M, normLang, makeT, roleLabel, hasKey };
