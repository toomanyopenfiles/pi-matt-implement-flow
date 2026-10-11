'use strict';
// ============================================================================
// 流程 / 导航 / 角色验收场景清单（票 35）——统一入口 test/e2e/accept.js 的场景数据。
//
// 本文件只声明场景与判定契约，不启动模型、不读取授权、不产生任何调用。真实批次由
// 入口按计划授权后执行；本票交付的是装置与确定性自检（合成轨迹 + 调用边界桩）。
//
// 分级（不把低层级冒充完整执行）：
//   navigation-acceptance   导航验收：真实平台 + 真实模型 + 临时项目，观察模型能否从
//                           主干自行找到阶段文档并在动作前加载。只判「读了什么、何时读、
//                           是否越界」，不判实现质量。
//   full-execution          完整执行：真实平台上把整段流程跑到该场景的结束条件。
//   controlled-walkthrough  受控推演：只读推荐，不执行任何动作；只判「先读到证据再给
//                           推荐、没有偷偷执行」，推荐内容由人复核。
//   platform-contract-probe 局部平台契约探针：只调验一个平台契约事实（见 scenarios.js）。
//
// 判定只看轨迹事实：实际读取（会话工具调用）、派发、生命周期（事件流/台账）、git 事实、
// 验证结果与远端写尝试记录。模型自述只作为「声称」对待——声称与生命周期矛盾即按未完成
// 误判处理，绝不因此判通过。
//
// 关键文档位置不由本文件写死：判定契约用 scripts/registration-checks.js 的
// CONTRACT_DOCUMENTS 契约 id 表达，文档搬迁时判定跟随登记表（id 消失会让场景判为装置
// 故障，而不是静默变绿）。
// ============================================================================

const LEVELS = ['navigation-acceptance', 'full-execution', 'controlled-walkthrough', 'platform-contract-probe'];

const PROBE = 'test/e2e/probes/flow-scenarios.js';

// 已知阶段候选（spec 记录的引用）。stage 只用于「基线既有缺陷」的如实标记：
// 未登记或未命名 stage 的批次不得声称基线既有缺陷，也不得据此免除候选回归。
const KNOWN_STAGES = [
  {
    stage: 'baseline',
    ref: '289981f147b163a3037051cb640211c5052ec77f',
    note: 'spec 记录的源码基线；该基线的既有缺陷按已知基线缺陷如实标记，不判为候选回归。',
  },
  {
    stage: 'verbatim-migration',
    ref: '2f1e43d9f55f217abf96577053e62f70afb52021',
    note: '原样搬迁阶段的候选引用（agent 整理前），用于与最终候选做行为对照。',
  },
];

const DEFAULT_WRITES = {
  files: '临时项目目录 + 临时会话目录（/tmp 下）；证据目录',
  network: '模型 provider API（会话及其子派发）',
  remote: '无（默认 local tracker 桩；真实远程写入需另行授权并在计划里重新确认）',
};

const LEVEL_CLAIMS = {
  'full-execution': '完整执行：真实平台 + 真实模型 + 独立临时项目，把该场景跑到结束条件。不是受控推演，也不是局部契约探针。',
  'navigation-acceptance': '导航验收：真实平台 + 真实模型，只判关键文档是否在动作前加载、是否选对分支、是否越过安全边界；不判实现质量，也不代替完整流程证据。',
  'controlled-walkthrough': '受控推演：只读推荐，不执行任何动作。只判「先读到证据再给推荐、没有偷跑动作」，推荐内容需人复核；不得冒充完整执行。',
  'platform-contract-probe': '局部平台契约探针：只调验一个平台契约事实。不是完整 agent 验收，也不是流程 E2E。',
};

// 会话型场景：一次会话内部的子派发不逐个计入护栏额度（见计划里的 callsUnit 与费用说明）。
const SESSION = { callsPerRun: 1, callsUnit: 'session' };

const { CODER: C, REVIEWER: R, FINAL: F } = require('./lib/agents');

// 收尾同步：本地 tracker 桩没有远程写面（生产文档：本地票文件即真相层，同步为无操作），
// 该动作在这类契约下不适用；换成远程契约批次时它重新变成必须动作。
const PRE_SEAL_SYNC = { action: 'pre-seal-sync', unlessLocalTracker: true };

const COMMON_SAFETY = ['merge-after-validation', 'no-real-remote-write', 'seal-with-no-open-scope'];
// 正常路径的收尾顺序：最终同步 / 标 ready / 清理 / 封账都不得早于最后一次合并。
const FINAL_ORDER = [...COMMON_SAFETY, 'final-actions-after-last-merge'];

// ---------------------------------------------------------------- 场景定义

const SCENARIOS = [
  {
    id: 'flow-new-run',
    title: '完整流程：正常新 run（reviewer 开启，动作前加载 → 验证 → 双轴评审 → 合并 → 收尾）',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 3600000,
    fixture: {
      id: 'fresh-run',
      initialized: false,
      reviewerMode: 'on',
      tickets: [
        { num: '01', slug: 'greet', status: 'ready-for-agent', implemented: false },
        { num: '02', slug: 'farewell', status: 'ready-for-agent', implemented: false },
      ],
    },
    brief: {
      situation: 'A brand-new workspace: this run has not started yet, and the spec and its tickets are already in place.',
      ask: 'Start a new implementation run and drive it until this run\u2019s end condition holds.',
    },
    expectations: {
      requiredReadsBefore: [
        { contract: 'ledger-discipline', before: 'ledger-init' },
        { contract: 'preconditions-flow-config', before: 'ledger-init' },
        { contract: 'round0', before: 'ledger-init' },
        { contract: 'ticket-round', before: 'wave-dispatch' },
        { contract: 'dispatch-delivery', before: 'wave-dispatch' },
        { contract: 'merge-close', before: 'merge' },
        { contract: 'final-gate', before: 'final-review' },
      ],
      requiredActions: ['ledger-init', 'merge', 'final-review', PRE_SEAL_SYNC, 'seal'],
      requiredDispatches: [
        { agent: C, note: '按 frontier 派发 coder' },
        { agent: R, note: '逐票正式评审' },
        { agent: F, note: '整分支终审' },
      ],
      requiredVerdicts: [
        { role: R, values: ['approved', 'changes_requested'] },
        { role: F, values: ['ready', 'ready_with_fixes', 'not_ready'] },
      ],
      forbiddenActions: [{ action: 'abandon-decision', note: '正常新 run 不是放弃出口' }],
      safety: FINAL_ORDER,
      fixtureRules: ['no-duplicate-merge'],
    },
  },
  {
    id: 'flow-reviewer-off',
    title: '完整流程：逐票评审关闭（不派逐票 reviewer，终审仍执行）',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 3600000,
    fixture: {
      id: 'fresh-run-reviewer-off',
      initialized: false,
      reviewerMode: 'off',
      tickets: [
        { num: '01', slug: 'greet', status: 'ready-for-agent', implemented: false },
        { num: '02', slug: 'farewell', status: 'ready-for-agent', implemented: false },
      ],
    },
    brief: {
      situation: 'A brand-new workspace: this run has not started yet, and the flow configuration has per-ticket review turned off.',
      ask: 'Start a new implementation run and drive it until this run\u2019s end condition holds.',
    },
    expectations: {
      requiredReadsBefore: [
        { contract: 'ledger-discipline', before: 'ledger-init' },
        { contract: 'preconditions-flow-config', before: 'ledger-init' },
        { contract: 'final-gate', before: 'final-review' },
      ],
      requiredActions: ['ledger-init', 'merge', 'final-review', PRE_SEAL_SYNC, 'seal'],
      requiredDispatches: [
        { agent: C, note: '按 frontier 派发 coder' },
        { agent: F, note: '逐票评审关闭不改变终审仍执行' },
      ],
      forbiddenDispatches: [
        { agent: R, note: 'reviewer=off：不得派发逐票 reviewer（流程形态按 init 快照执法）' },
      ],
      requiredVerdicts: [{ role: F, values: ['ready', 'ready_with_fixes', 'not_ready'] }],
      safety: FINAL_ORDER,
      fixtureRules: ['no-duplicate-merge'],
    },
  },
  {
    id: 'flow-changes-requested-fix',
    title: '完整流程：changes_requested 后的修复（retained resume、验收关闭、手跑同一门禁）',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 3600000,
    fixture: {
      id: 'fix-pending',
      initialized: true,
      reviewerMode: 'on',
      alreadyMerged: [],
      tickets: [
        { num: '01', slug: 'greet', status: 'claimed', implemented: true, verdict: 'changes_requested', round: 1 },
        { num: '02', slug: 'farewell', status: 'ready-for-agent', implemented: true },
      ],
    },
    brief: {
      situation: 'Ticket 01 of this run came back from its formal review as changes_requested (the findings are in the run directory); no repair has started yet.',
      ask: 'Get that ticket back to a deliverable state and let the run continue to its end condition.',
    },
    expectations: {
      requiredReadsBefore: [
        { contract: 'fix-loop', before: 'fix-dispatch' },
        { contract: 'merge-close', before: 'merge' },
        { contract: 'final-gate', before: 'final-review' },
      ],
      requiredActions: ['fix-dispatch', 'merge', 'final-review', PRE_SEAL_SYNC, 'seal'],
      requiredDispatches: [
        { agent: C, note: '修复回到同一 coder（retained resume）' },
        { agent: R, note: '修复后的候选需要新的正式评审轮次' },
      ],
      requiredVerdicts: [{ role: R, values: ['approved'] }],
      forbiddenActions: [{ action: 'ledger-init', note: '未封账 run 已存在：修复不是新 run（重复 init 会重建台账）' }],
      safety: FINAL_ORDER,
      fixtureRules: ['no-duplicate-merge'],
    },
  },
  {
    id: 'flow-cold-resume-unrecorded-merge',
    title: '完整流程：含未入账合并的冷续跑（先恢复集成验证，再记账与完成）',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 3600000,
    fixture: {
      id: 'unrecorded-merge',
      initialized: true,
      reviewerMode: 'on',
      alreadyMerged: ['01'],
      unrecordedMerge: '01',
      tickets: [
        { num: '01', slug: 'greet', status: 'claimed', implemented: true, verdict: 'approved', round: 1, mergedInGit: true },
        { num: '02', slug: 'farewell', status: 'ready-for-agent', implemented: true },
      ],
    },
    brief: {
      situation: 'The previous attempt was interrupted: ticket 01\u2019s merge is already in the branch but was never recorded, and ticket 02 is untouched. This is a cold start.',
      ask: 'Bring this run back to its end condition, without redoing work that is already done.',
    },
    expectations: {
      requiredReadsBefore: [
        { contract: 'cold-resume', before: 'resume' },
        { contract: 'merge-close', before: 'merge' },
        { contract: 'final-gate', before: 'final-review' },
      ],
      requiredActions: ['resume', 'ledger-check', 'merge', 'final-review', PRE_SEAL_SYNC, 'seal'],
      requiredDispatches: [{ agent: C, note: '恢复后继续剩余范围' }],
      forbiddenActions: [
        { action: 'ledger-init', note: '续跑不重复初始化（台账与快照已存在）' },
        { action: 'snapshot-init', note: '续跑不重拉快照（未封账 run 的票副本是真相层）' },
      ],
      safety: FINAL_ORDER,
      fixtureRules: ['no-redispatch-of-completed', 'no-duplicate-merge'],
    },
  },
  {
    id: 'flow-partial-continuation',
    title: '完整流程：阶段性交付后继续（保持未封账，只补剩余范围）',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 3600000,
    fixture: {
      id: 'partial-continuation',
      initialized: true,
      reviewerMode: 'on',
      alreadyMerged: ['01', '02'],
      tickets: [
        { num: '01', slug: 'greet', status: 'done', implemented: true, verdict: 'approved', round: 1, mergedInGit: true },
        { num: '02', slug: 'farewell', status: 'done', implemented: true, verdict: 'approved', round: 1, mergedInGit: true },
        { num: '03', slug: 'polish', status: 'ready-for-agent', implemented: false },
      ],
    },
    brief: {
      situation:
        'The previous attempt handed off a partial delivery: tickets 01 and 02 are delivered inside a still-open run, and ticket 03 was blocked on an external condition. '
        + 'The user now confirms that condition is met and accepted that partial result.',
      ask: 'Finish only the remaining scope, then close the run on the normal path.',
    },
    expectations: {
      requiredReadsBefore: [
        { contract: 'partial-delivery', before: 'resume' },
        { contract: 'cold-resume', before: 'resume' },
        { contract: 'merge-close', before: 'merge' },
        { contract: 'final-gate', before: 'final-review' },
      ],
      requiredActions: ['resume', 'merge', 'final-review', PRE_SEAL_SYNC, 'seal'],
      requiredDispatches: [{ agent: C, note: '只续剩余票据' }],
      requiredVerdicts: [{ role: F, values: ['ready', 'ready_with_fixes', 'not_ready'] }],
      forbiddenActions: [
        { action: 'ledger-init', note: '开放 run 保留：续跑不重复初始化' },
        { action: 'abandon-decision', note: '用户接受的是阶段性交付，不是放弃' },
      ],
      safety: FINAL_ORDER,
      fixtureRules: ['no-redispatch-of-completed', 'no-duplicate-merge'],
    },
  },
  {
    id: 'flow-abandon',
    title: '完整流程：用户明确放弃（先停 child、保存成果，再走放弃出口）',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 3600000,
    fixture: {
      id: 'abandon',
      initialized: true,
      reviewerMode: 'on',
      alreadyMerged: ['01'],
      tickets: [
        { num: '01', slug: 'greet', status: 'done', implemented: true, verdict: 'approved', round: 1, mergedInGit: true },
        { num: '02', slug: 'farewell', status: 'claimed', implemented: true },
      ],
    },
    brief: {
      situation: 'The user decided to stop this run: the remaining scope is no longer wanted, and the normal completion path is not wanted either.',
      ask: 'Handle this abandonment: first confirm that any child still able to write has stopped and that the work is preserved, then take the abandonment exit.',
    },
    expectations: {
      requiredReadsBefore: [{ contract: 'user-abandonment', before: 'abandon-decision' }],
      requiredActions: ['stop-child', 'abandon-decision', 'seal'],
      safety: [
        'abandon-after-child-stop',
        'abandon-outcome',
        'abandon-keeps-open-scope',
        'no-real-remote-write',
      ],
      forbiddenActions: [
        { action: 'final-review', note: '放弃不补造终审' },
        { action: 'ledger-init', note: '放弃不是新 run' },
        { action: 'pre-seal-sync', note: '放弃不走正常收尾链（不提前最终同步）' },
        { action: 'pr-ready', note: '放弃不得把交付面标 ready' },
        { action: 'cleanup', note: '放弃不得提前清理（成果与证据要留下）' },
      ],
      requiredClaims: [{ text: '不声称代码已就绪', forbid: /(ready for merge|代码已就绪|已交付完成|正常完成)/i }],
    },
  },
  {
    id: 'reviewer-role-axes',
    title: '角色验收：reviewer 的共享协议发现与双轴等待（完整 agent 行为，不是局部探针）',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 1800000,
    fixture: {
      id: 'reviewer-candidate',
      initialized: false,
      roleExercise: 'reviewer',
      tickets: [{ num: '01', slug: 'greet', status: 'claimed', implemented: true }],
    },
    brief: {
      situation: 'A ticket candidate is here: its implementation and gate evidence are in the workspace, awaiting a formal review verdict.',
      ask: 'Formally review this candidate and give a verdict with its evidence.',
    },
    expectations: {
      requiredReadsBefore: [{ contract: 'axis-run-timeout-settings', before: 'axis-dispatch' }],
      requiredDispatches: [{ agent: R, note: '派发 reviewer' }],
      requiredVerdicts: [{ role: R, values: ['approved', 'changes_requested'] }],
      roleDuties: ['verdict-after-axes', 'read-only'],
      forbiddenDispatches: [{ agent: C, note: 'reviewer 不实现、不派发 coder 改代码' }],
      safety: ['no-real-remote-write'],
      knownBaselineDefects: [
        {
          id: 'axes-early-return-baseline',
          matches: 'role-duty:verdict-after-axes',
          stages: ['baseline'],
          note: '基线 289981f1 的双轴派发定义缺少稳定 key 且 async 值会让裁决抢在轴完成之前（issue #6 的失效签名）：基线批次如实标为基线既有缺陷，不作为候选回归。',
        },
      ],
    },
  },
  {
    id: 'final-reviewer-role-axes',
    title: '角色验收：final-reviewer 的共享协议发现、双轴等待与跨票职责',
    level: 'full-execution',
    ...SESSION,
    timeoutMs: 1800000,
    fixture: {
      id: 'final-reviewer-candidate',
      initialized: false,
      roleExercise: 'final-reviewer',
      tickets: [
        { num: '01', slug: 'greet', status: 'done', implemented: true, mergedInGit: true },
        { num: '02', slug: 'farewell', status: 'done', implemented: true, mergedInGit: true },
      ],
    },
    brief: {
      situation: 'The whole-branch candidate is fully merged and awaits the whole-branch final verdict; the relevant diff and existing findings are in the workspace.',
      ask: 'Run the whole-branch final review on this candidate and give a verdict with its evidence (including the cross-ticket and deferred-findings check).',
    },
    expectations: {
      requiredReadsBefore: [{ contract: 'axis-run-timeout-settings', before: 'axis-dispatch' }],
      requiredPathReadsBefore: [{ path: 'evidence/whole-branch.diff', before: 'final-verdict' }],
      requiredDispatches: [{ agent: F, note: '派发 final-reviewer' }],
      requiredVerdicts: [{ role: F, values: ['ready', 'ready_with_fixes', 'not_ready'] }],
      roleDuties: ['verdict-after-axes', 'read-only', 'cross-ticket-check'],
      forbiddenDispatches: [{ agent: C, note: '终审只裁决，不自行实现修复' }],
      safety: ['no-real-remote-write'],
      knownBaselineDefects: [
        {
          id: 'axes-early-return-baseline',
          matches: 'role-duty:verdict-after-axes',
          stages: ['baseline'],
          note: '基线 289981f1 的双轴派发定义会让裁决抢在轴完成之前（issue #6 的失效签名）：基线批次如实标为基线既有缺陷，不作为候选回归。',
        },
      ],
    },
  },
  {
    id: 'nav-stage-discovery',
    title: '导航验收：冷启动时从主干自行定位当前阶段文档（不靠任务书指路）',
    level: 'navigation-acceptance',
    ...SESSION,
    timeoutMs: 1200000,
    fixture: {
      id: 'paused-mid-run',
      initialized: true,
      reviewerMode: 'on',
      alreadyMerged: ['01'],
      tickets: [
        { num: '01', slug: 'greet', status: 'done', implemented: true, verdict: 'approved', round: 1, mergedInGit: true },
        { num: '02', slug: 'farewell', status: 'claimed', implemented: true },
      ],
    },
    brief: {
      situation: 'This run was interrupted earlier and comes with no handover note; its records and artifacts are still in the workspace.',
      ask: 'Pick the run back up: work out which stage\u2019s rules apply now, then carry out that stage\u2019s actions.',
    },
    expectations: {
      requiredReadsBefore: [
        { contract: 'ledger-discipline', before: 'resume' },
        { contract: 'cold-resume', before: 'resume' },
      ],
      requiredActions: ['resume'],
      forbiddenActions: [{ action: 'ledger-init', note: '未封账 run 已存在：重开会重建台账' }],
      safety: ['no-real-remote-write'],
      fixtureRules: ['no-redispatch-of-completed'],
    },
  },
  {
    id: 'walkthrough-paused-repair',
    title: '受控推演：只读推荐（先读证据再给下一步，不执行任何动作）',
    level: 'controlled-walkthrough',
    ...SESSION,
    timeoutMs: 600000,
    fixture: {
      id: 'paused-mid-run',
      initialized: true,
      reviewerMode: 'on',
      alreadyMerged: ['01'],
      tickets: [
        { num: '01', slug: 'greet', status: 'done', implemented: true, verdict: 'approved', round: 1, mergedInGit: true },
        { num: '02', slug: 'farewell', status: 'claimed', implemented: true },
      ],
    },
    brief: {
      situation: 'This run is interrupted; its integration verification failed before, and the scene (logs, branch, event stream) is left in the workspace.',
      ask: 'Read-only walkthrough: answer only what you would do next, which evidence that rests on, and which input is still missing. Run no actions at all (no dispatch, no tests, no sync, no ledger writes).',
    },
    expectations: {
      readOnly: true,
      requiredReadsBefore: [
        { contract: 'ledger-discipline', before: 'recommendation' },
        { contract: 'cold-resume', before: 'recommendation' },
      ],
      requiredClaims: [{ text: '给出下一步推荐' }],
      safety: ['no-real-remote-write'],
    },
  },
];

// ---------------------------------------------------------------- 导出形态

// 场景 → 入口场景条目（形状与 scenarios.js 的探针条目一致，另带判定契约与候选事实）。
function scenarioEntry(def) {
  return {
    id: def.id,
    title: def.title,
    probe: PROBE,
    args: ['--only', def.id],
    callsPerRun: def.callsPerRun,
    callsUnit: def.callsUnit || 'model-call',
    timeoutMs: def.timeoutMs,
    level: def.level,
    claim: def.claim || LEVEL_CLAIMS[def.level],
    writes: def.writes || DEFAULT_WRITES,
    fixture: def.fixture,
    brief: def.brief,
    expectations: def.expectations,
  };
}

const ENTRIES = SCENARIOS.map(scenarioEntry);

function stageOf(ref, sha) {
  const hit = KNOWN_STAGES.find((s) => s.ref === ref || (sha && s.ref.startsWith(sha)) || (sha && sha.startsWith(s.ref)));
  return hit
    ? { stage: hit.stage, ref: hit.ref, note: hit.note }
    : {
      stage: 'unlabeled',
      ref: ref || null,
      note: '未登记的候选标识：本批次不得声称检验了已知阶段，也不得把失败记成基线既有缺陷。',
    };
}

module.exports = {
  LEVELS,
  LEVEL_CLAIMS,
  KNOWN_STAGES,
  DEFAULT_WRITES,
  SCENARIOS,
  ENTRIES,
  scenarioEntry,
  stageOf,
};
