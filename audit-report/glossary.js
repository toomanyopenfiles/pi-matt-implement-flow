'use strict';
// 术语表 — 与包内 CONTEXT.md 的域词汇对齐，另补流程环节词与平台词。
// 报告正文中的术语一律通过 term() 链接到首页名词表，避免中英混杂无解释。

const TERMS = [
  // —— 域词汇（与 CONTEXT.md 对齐）——
  { id: 'ledger', zh: '台账', en: 'ledger', def: '人类可读的运行状态视图：头部（运行是否终结）、票表格、事件时间线、对账结论。由脚本从事件流与真相层（git、工作树、票状态）全量再生，任何人不手写手改。' },
  { id: 'event-stream', zh: '事件流', en: 'event stream', def: '只追加的 JSONL 机器事实文件，一行一条结构化事件，由脚本盖权威时间戳、单调序号与 git 锚点。它是编排器的唯一状态写面，也是本报告时间线与状态机的主要数据源。' },
  { id: 'notes', zh: '编排笔记', en: 'orchestration notes', def: '散文记忆：过程叙事、教训、维护者口头拍板等非结构化内容。「何时何事」归事件流，「为何学到什么」归编排笔记。' },
  { id: 'record', zh: '记账', en: 'record', def: '编排器通过脚本向事件流写入一条事件的动作。每个状态转换（派发、结算、裁决、修复、合并、升级、封账）都要记账。' },
  { id: 'close', zh: '封账', en: 'seal', def: '记账 close 事件：台账头部标记运行终结。封账后记账命令拒绝一切新事件——终结的运行不可能再被误认为进行中。' },
  { id: 'reconcile', zh: '对账', en: 'reconcile', def: '核验台账记录与实际世界（git、工作树、票文件状态）的差异。每次派发与合并前执行；发现漂移会逐条列出并阻断。' },
  { id: 'flow-shape', zh: '流程形态', en: 'flow shape', def: '一次运行的流程开关组合：是否逐票评审、每票修复预算、并发实现者数量。在运行初始化时冻结进事件流，中途改配置不影响进行中的运行。' },

  // —— 流程环节词 ——
  { id: 'frontier', zh: '前沿', en: 'frontier', def: '当前所有阻塞已解除、可以立即派发的票的集合。编排器每轮从前沿取票并行派发，合并后重算前沿直至清空。' },
  { id: 'dispatch', zh: '派发', en: 'dispatch', def: '编排器把一张票交给一个实现者子代理执行。每个实现者在独立的 git 工作树中工作，完成后报告提交锚点与测试结果。' },
  { id: 'settled', zh: '实现结算', en: 'settle', def: '实现者完成一票后的锚定动作：从 git 真值确认提交存在，把提交 SHA 与工作树位置记入事件流，作为后续评审与合并的依据。' },
  { id: 'verdict', zh: '评审裁决', en: 'verdict', def: '评审者对一票实现的结论：通过（approved）或需修改（changes_requested）。裁决与发现的问题清单一并记入事件流。' },
  { id: 'two-axis', zh: '双轴评审', en: 'two-axis review', def: '评审者从两个独立视角审查：规范轴（代码是否符合仓库既有规范）与需求轴（代码是否符合票面与 spec 的要求）。两轴可各派一个只读子代理并行执行。' },
  { id: 'fix-round', zh: '修复轮', en: 'fix round', def: '评审要求修改后，编排器把问题清单发回同一个实现者（续跑原会话）返工。每票修复轮数有预算上限（默认 2），耗尽即升级给维护者。' },
  { id: 'escalate', zh: '升级', en: 'escalate', def: '修复预算耗尽仍未通过时，票保持未关闭状态、移交维护者裁决，不再阻塞其余票的推进。' },
  { id: 'integration-gate', zh: '集成测试门', en: 'integration gate', def: '每票合并到功能分支后立即运行全量测试套件。票级评审看不到的跨票集成问题在此暴露，红了就派无隔离修复者当场修。' },
  { id: 'final-review', zh: '终审', en: 'final review', def: '全部票合并后，对整条功能分支做一次整体双轴评审，结论为：可交付（ready）/ 可交付但需修（ready_with_fixes）/ 不可交付（not_ready）。' },
  { id: 'anomaly', zh: '异常记录', en: 'anomaly', def: '编排器与校验器意见不合时的正式出路：不伪造事实、不绕过校验，把分歧原样记入事件流并停下上报。异常记录是审计的重点关注对象。' },

  // —— 平台词 ——
  { id: 'acceptance-contract', zh: '验收合同', en: 'acceptance contract', def: '派发时冻结的证据契约：实现者必须声明满足了哪些验收标准，并提交变更文件、新增测试、运行命令、验证输出与 no-staged-files 五项派发证据（每项空仓时用 [] 占位；residualRisks 是建议项，从不构成拒收理由）。这五项证据缺失或不合格会导致这次运行被拒收。' },
  { id: 'structured-output', zh: '结构化输出', en: 'structured output', def: '子代理按约定模式返回的机器可读结果（如提交 SHA、测试结果、评审结论），区别于自由文本。编排器据此机械校验，不轻信散文。' },
  { id: 'worktree', zh: '工作树', en: 'worktree', def: 'git 工作树：同一仓库的独立检出目录。每个实现者在自己的工作树与分支上干活，互不干扰，合并时才汇入功能分支。' },
  { id: 'gate', zh: '门禁', en: 'gate', def: '派发时约定的验证命令（通常是全量测试套件）。实现者跑不绿就不算完成；合并后编排器会再跑一遍作为集成测试门。' },
  { id: 'run', zh: '运行', en: 'run', def: '一次子代理执行的完整记录单元，有唯一运行 ID。同一运行可被续跑（resume）以完成修复轮，续跑共享同一运行 ID。' },
  { id: 'resume', zh: '续跑', en: 'resume', def: '让同一个子代理在保留的会话上下文中继续工作（典型场景：修复轮）。相对地，若保留的工作树已丢失则退回全新派发，事件流里两种路径都有记录。' },
];

const TERM_INDEX = new Map();
for (const t of TERMS) {
  TERM_INDEX.set(t.id, t);
  TERM_INDEX.set(t.en.toLowerCase(), t);
  TERM_INDEX.set(t.zh, t);
}

// 查术语：优先按 id，其次英文名，再次中文名。未命中返回 null（调用方原样展示文本）。
function lookup(idOrName) {
  if (!idOrName) return null;
  return TERM_INDEX.get(idOrName) || TERM_INDEX.get(String(idOrName).toLowerCase()) || null;
}

module.exports = { TERMS, lookup };
