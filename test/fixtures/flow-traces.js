'use strict';
// ============================================================================
// 合成轨迹装置（票 35 自检用，不启动任何模型）。
//
// 每个流程 / 角色 / 导航场景配一份「应当通过」的参考轨迹：事件序列是**手写的期望行为
// 记录**，与场景的判定契约相互独立（判定契约说该判什么，参考轨迹说正确行为长什么样）。
// 轨迹里只出现内容标识（契约 id）与 fixture 相对路径；文档路径由
// scripts/registration-checks.js 的登记表解析——文档搬迁时参考轨迹自动跟随。
//
// 变异装置按判定契约的声明生成缺陷（漏读 / 晚读 / 错误分支 / 安全边界违规 / 未完成
// 误判 / 角色职责违规 / 证据缺失），供确定性自检断言「装置真的能发现这些缺陷」。
// 合成轨迹不是模型验收：它只证明判定器与装置有效，不证明任何模型行为。
// ============================================================================

const { contractEntry } = require('../e2e/lib/contracts');

const CODER = 'pi-matt-implement-flow.coder';
const REVIEWER = 'pi-matt-implement-flow.reviewer';
const FINAL = 'pi-matt-implement-flow.final-reviewer';

const docOf = (contract) => contractEntry(contract).docs[0];

const read = (contract) => ({ kind: 'read', path: docOf(contract) });
const readPath = (p) => ({ kind: 'read', path: p });
const action = (name, extra = {}) => ({ kind: 'action', action: name, ...extra });
const dispatch = (agent, extra = {}) => ({ kind: 'dispatch', agent, ...extra });
const axis = (key) => ({ kind: 'axis', key, state: 'complete' });
const verdict = (role, value) => ({ kind: 'verdict', role, value });
const validation = (result = 'pass', command = 'npm test') => ({ kind: 'validation', result, command });
const merge = (ticket, validated = true) => ({ kind: 'merge', ticket, validated });
const lifecycle = (openTickets, state = 'running') => ({ kind: 'lifecycle', state, openTickets });
const claim = (text) => ({ kind: 'claim', text });
const child = (state) => ({ kind: 'child', pid: 4242, state });

const READY = claim('Run complete: all tickets merged and closed, final verdict ready, pre-seal sync done, run sealed.');

// 参考轨迹（每个场景手写；fixture 事实只写判定需要的那几项）。
const REFERENCE = {
  'flow-new-run': {
    fixture: { initialized: false, reviewerMode: 'on', alreadyMerged: [], openTickets: ['01', '02'] },
    events: [
      read('ledger-discipline'),
      read('preconditions-flow-config'),
      read('round0'),
      action('ledger-init'),
      read('ticket-round'),
      read('dispatch-delivery'),
      action('ledger-check'),
      dispatch(CODER, { ticket: '01' }),
      validation(),
      dispatch(REVIEWER, { ticket: '01', axis: true }),
      axis('standards'),
      axis('spec'),
      verdict(REVIEWER, 'approved'),
      merge('01'),
      lifecycle(1),
      read('merge-close'),
      dispatch(CODER, { ticket: '02' }),
      validation(),
      dispatch(REVIEWER, { ticket: '02', axis: true }),
      axis('standards'),
      axis('spec'),
      verdict(REVIEWER, 'approved'),
      merge('02'),
      lifecycle(0),
      read('final-gate'),
      dispatch(FINAL),
      axis('standards'),
      axis('spec'),
      verdict(FINAL, 'ready'),
      action('pre-seal-sync'),
      action('seal'),
      READY,
    ],
  },
  'flow-reviewer-off': {
    fixture: { initialized: false, reviewerMode: 'off', alreadyMerged: [], openTickets: ['01', '02'] },
    events: [
      read('ledger-discipline'),
      read('preconditions-flow-config'),
      read('round0'),
      action('ledger-init'),
      read('ticket-round'),
      dispatch(CODER, { ticket: '01' }),
      validation(),
      merge('01'),
      lifecycle(1),
      dispatch(CODER, { ticket: '02' }),
      validation(),
      merge('02'),
      lifecycle(0),
      read('final-gate'),
      dispatch(FINAL),
      axis('standards'),
      axis('spec'),
      verdict(FINAL, 'ready'),
      action('pre-seal-sync'),
      action('seal'),
      READY,
    ],
  },
  'flow-changes-requested-fix': {
    fixture: { initialized: true, reviewerMode: 'on', alreadyMerged: [], openTickets: ['01', '02'] },
    events: [
      read('fix-loop'),
      action('fix-dispatch'),
      dispatch(CODER, { ticket: '01', resume: true }),
      validation(),
      dispatch(REVIEWER, { ticket: '01', axis: true }),
      axis('standards'),
      axis('spec'),
      verdict(REVIEWER, 'approved'),
      merge('01'),
      lifecycle(1),
      read('merge-close'),
      dispatch(CODER, { ticket: '02' }),
      validation(),
      dispatch(REVIEWER, { ticket: '02', axis: true }),
      axis('standards'),
      axis('spec'),
      verdict(REVIEWER, 'approved'),
      merge('02'),
      lifecycle(0),
      read('final-gate'),
      dispatch(FINAL),
      axis('standards'),
      axis('spec'),
      verdict(FINAL, 'ready_with_fixes'),
      action('pre-seal-sync'),
      action('seal'),
      READY,
    ],
  },
  'flow-cold-resume-unrecorded-merge': {
    fixture: { initialized: true, reviewerMode: 'on', alreadyMerged: ['01'], openTickets: ['01', '02'] },
    events: [
      read('cold-resume'),
      action('resume'),
      action('ledger-check'),
      read('merge-close'),
      validation('pass', 'npm test'),
      merge('01'),
      dispatch(CODER, { ticket: '02' }),
      validation(),
      dispatch(REVIEWER, { ticket: '02', axis: true }),
      axis('standards'),
      axis('spec'),
      verdict(REVIEWER, 'approved'),
      merge('02'),
      lifecycle(0),
      read('final-gate'),
      dispatch(FINAL),
      axis('standards'),
      axis('spec'),
      verdict(FINAL, 'ready'),
      action('pre-seal-sync'),
      action('seal'),
      READY,
    ],
  },
  'flow-partial-continuation': {
    fixture: { initialized: true, reviewerMode: 'on', alreadyMerged: ['01', '02'], openTickets: ['01', '02', '03'] },
    events: [
      read('partial-delivery'),
      read('cold-resume'),
      action('resume'),
      action('ledger-check'),
      dispatch(CODER, { ticket: '03' }),
      validation(),
      dispatch(REVIEWER, { ticket: '03', axis: true }),
      axis('standards'),
      axis('spec'),
      verdict(REVIEWER, 'approved'),
      merge('03'),
      lifecycle(0),
      read('final-gate'),
      dispatch(FINAL),
      axis('standards'),
      axis('spec'),
      verdict(FINAL, 'ready'),
      action('pre-seal-sync'),
      action('seal'),
      READY,
    ],
  },
  'flow-abandon': {
    fixture: { initialized: true, reviewerMode: 'on', alreadyMerged: ['01'], openTickets: ['02'] },
    events: [
      read('user-abandonment'),
      action('stop-child'),
      child('stopped'),
      action('abandon-decision'),
      lifecycle(1, 'complete'),
      action('seal'),
      claim('Abandoned on user request: the writer child was stopped and verified, branch and artifacts preserved, ticket 02 stays open, and no merge is authorized here.'),
    ],
  },
  'nav-stage-discovery': {
    fixture: { initialized: true, reviewerMode: 'on', alreadyMerged: ['01'], openTickets: ['02'] },
    events: [
      read('ledger-discipline'),
      read('cold-resume'),
      action('resume'),
      action('ledger-check'),
    ],
  },
  'reviewer-role-axes': {
    fixture: { initialized: false, roleExercise: 'reviewer' },
    events: [
      read('axis-run-timeout-settings'),
      dispatch(REVIEWER, { ticket: '01' }),
      dispatch(REVIEWER, { ticket: '01', axis: true }),
      dispatch(REVIEWER, { ticket: '01', axis: true }),
      axis('standards'),
      axis('spec'),
      verdict(REVIEWER, 'changes_requested'),
      claim('Verdict changes_requested, based on the two axis reports and the gate output in the workspace.'),
    ],
  },
  'final-reviewer-role-axes': {
    fixture: { initialized: false, roleExercise: 'final-reviewer' },
    events: [
      read('axis-run-timeout-settings'),
      readPath('evidence/whole-branch.diff'),
      dispatch(FINAL),
      dispatch(FINAL, { axis: true }),
      dispatch(FINAL, { axis: true }),
      axis('standards'),
      axis('spec'),
      { kind: 'role-check', role: FINAL, id: 'cross-ticket' },
      verdict(FINAL, 'ready_with_fixes'),
      claim('Final verdict ready_with_fixes; the cross-ticket and deferred-findings check is recorded in the findings file.'),
    ],
  },
  'walkthrough-paused-repair': {
    fixture: { initialized: true, reviewerMode: 'on', alreadyMerged: ['01'], openTickets: ['02'] },
    events: [
      read('ledger-discipline'),
      read('cold-resume'),
      claim('Next step: reproduce the failing integration case on the current branch, then dispatch one directly scoped repair; missing input: none.'),
    ],
  },
};

const SCENARIO_IDS = Object.keys(REFERENCE);

function referenceTrace(scenarioId) {
  const ref = REFERENCE[scenarioId];
  if (!ref) throw new Error(`没有该场景的参考轨迹: ${scenarioId}`);
  return {
    schema: 'e2e-trace-1',
    scenario: scenarioId,
    source: 'synthetic',
    fixture: { ...ref.fixture },
    events: ref.events.map((e, i) => ({ seq: i + 1, at: i + 1, ...e })),
  };
}

// ---------------------------------------------------------------- 变异装置

function clone(trace) {
  return JSON.parse(JSON.stringify(trace));
}

function withEvents(trace, events) {
  return { ...trace, events: events.map((e, i) => ({ seq: i + 1, at: i + 1, ...e })) };
}

// 漏读：目标文档在整个轨迹里一次也没读到。
const removeReadFor = (trace, entry) => {
  const docs = entry.contract ? contractEntry(entry.contract).docs : [entry.path];
  const hit = (e) => e.kind === 'read' && docs.some((d) => e.path === d || e.path.endsWith(d));
  const before = trace.events.filter(hit).length;
  if (before === 0) throw new Error(`参考轨迹里没有该读取事件: ${docs.join('、')}`);
  return withEvents(trace, trace.events.filter((e) => !hit(e)));
};

// 晚读：目标文档的读取全部挪到锚点动作之后（先动后读）。
const moveReadAfter = (trace, entry, anchor) => {
  const docs = entry.contract ? contractEntry(entry.contract).docs : [entry.path];
  const events = trace.events.slice();
  const hit = (e) => e.kind === 'read' && docs.some((d) => e.path === d || e.path.endsWith(d));
  const moved = events.filter(hit);
  if (moved.length === 0) throw new Error(`参考轨迹里没有该读取事件: ${docs.join('、')}`);
  for (let i = events.length - 1; i >= 0; i--) if (hit(events[i])) events.splice(i, 1);
  // 放到锚点动作之后（锚点用与判定器同名的动作语义：这里按事件形状近似定位）
  const anchorIdx = events.findIndex((e) => {
    if (anchor === 'ledger-init') return e.kind === 'action' && e.action === 'ledger-init';
    if (anchor === 'wave-dispatch') return e.kind === 'dispatch' && e.agent === CODER;
    if (anchor === 'merge') return e.kind === 'merge';
    if (anchor === 'final-review') return e.kind === 'dispatch' && e.agent === FINAL;
    if (anchor === 'fix-dispatch') return e.kind === 'action' && e.action === 'fix-dispatch';
    if (anchor === 'axis-dispatch') return e.kind === 'dispatch' && (e.axis === true || e.agent === REVIEWER || e.agent === FINAL);
    if (anchor === 'resume') return e.kind === 'action' && e.action === 'resume';
    if (anchor === 'abandon-decision') return e.kind === 'action' && e.action === 'abandon-decision';
    if (anchor === 'recommendation') return e.kind === 'claim';
    throw new Error(`变异装置不认识锚点 ${anchor}`);
  });
  if (anchorIdx < 0) throw new Error(`参考轨迹里没有锚点事件: ${anchor}`);
  events.splice(anchorIdx + 1, 0, ...moved);
  return withEvents(trace, events);
};

const MUTATIONS = {
  'missing-read': (trace, entry) => removeReadFor(trace, entry),
  'late-read': (trace, entry) => moveReadAfter(trace, entry, entry.before),
  'wrong-branch-dispatch': (trace, spec) => withEvents(trace, [...trace.events, { kind: 'dispatch', agent: spec.agent, ticket: '01' }]),
  'wrong-branch-action': (trace, spec) => withEvents(trace, [{ kind: 'action', action: spec.action }, ...trace.events]),
  'role-write': (trace, spec) => withEvents(trace, [...trace.events, { kind: 'write', actor: spec.actor, path: 'src/greet.js' }]),
  'remote-write': (trace) => withEvents(trace, [...trace.events, { kind: 'remote-attempt', tool: 'gh', command: 'gh issue comment 1 --body merged' }]),
  'merge-before-validation': (trace) => {
    const events = trace.events.filter((e) => e.kind !== 'validation').map((e) => (e.kind === 'merge' ? { ...e, validated: false } : e));
    return withEvents(trace, events);
  },
  'seal-with-open-scope': (trace) => {
    const events = trace.events.slice();
    const sealIdx = events.findIndex((e) => e.kind === 'action' && e.action === 'seal');
    if (sealIdx < 0) throw new Error('参考轨迹里没有封账动作');
    events.splice(sealIdx, 0, { kind: 'lifecycle', state: 'running', openTickets: 2 });
    return withEvents(trace, events);
  },
  'incomplete-claimed-complete': (trace) => withEvents(trace, trace.events.filter((e) => !(e.kind === 'action' && e.action === 'seal'))),
  'verdict-before-axes': (trace) => {
    const events = trace.events.slice();
    const vIdx = events.findIndex((e) => e.kind === 'verdict');
    if (vIdx < 0) throw new Error('参考轨迹里没有裁决事件');
    const [v] = events.splice(vIdx, 1);
    const aIdx = events.findIndex((e) => e.kind === 'axis');
    if (aIdx < 0) throw new Error('参考轨迹里没有轴事件');
    events.splice(aIdx, 0, v);
    return withEvents(trace, events);
  },
  empty: (trace) => withEvents(trace, []),
  // 什么都没做：没有动作，也没有任何声称（纯静态轨迹）。
  'no-actions': (trace) => withEvents(trace, trace.events.filter((e) => !['action', 'dispatch', 'merge', 'claim'].includes(e.kind))),
  // 放弃前没停 child：停 child 的动作缺失，且 child 仍在写入。
  'abandon-without-stopping-child': (trace) => withEvents(
    trace,
    trace.events
      .filter((e) => !(e.kind === 'action' && e.action === 'stop-child'))
      .map((e) => (e.kind === 'child' ? { ...e, state: 'running' } : e)),
  ),
};

// 按判定契约生成该场景适用的变异，并给出应当被捕获的 finding id。
function applicableMutations(def) {
  const ex = def.expectations || {};
  const out = [];
  const firstRead = (ex.requiredReadsBefore || [])[0] || (ex.requiredPathReadsBefore || [])[0];
  if (firstRead) {
    const label = `${firstRead.contract || firstRead.path}@${firstRead.before}`;
    out.push({ name: 'missing-read', spec: firstRead, expect: `missing-read:${label}` });
    out.push({ name: 'late-read', spec: firstRead, expect: `late-read:${label}` });
  }
  const badDispatch = (ex.forbiddenDispatches || [])[0];
  if (badDispatch) out.push({ name: 'wrong-branch-dispatch', spec: badDispatch, expect: `wrong-branch:${badDispatch.agent}` });
  const badAction = (ex.forbiddenActions || [])[0];
  if (badAction) out.push({ name: 'wrong-branch-action', spec: badAction, expect: `wrong-branch:${badAction.action}` });
  if ((ex.roleDuties || []).includes('read-only')) {
    out.push({ name: 'role-write', spec: { actor: def.level === 'full-execution' && def.id.startsWith('final') ? FINAL : REVIEWER }, expect: 'role-duty:read-only' });
  }
  if ((ex.roleDuties || []).includes('verdict-after-axes')) {
    out.push({ name: 'verdict-before-axes', spec: {}, expect: 'role-duty:verdict-after-axes' });
  }
  if ((ex.safety || []).includes('abandon-after-child-stop')) {
    out.push({ name: 'abandon-without-stopping-child', spec: {}, expect: 'safety-boundary:abandon-before-child-stop' });
  }
  if ((ex.safety || []).includes('no-real-remote-write')) out.push({ name: 'remote-write', spec: {}, expect: 'safety-boundary:real-remote-write' });
  if ((ex.safety || []).includes('merge-after-validation')) out.push({ name: 'merge-before-validation', spec: {}, expect: 'safety-boundary:merge-before-validation' });
  if ((ex.safety || []).includes('seal-with-no-open-scope')) out.push({ name: 'seal-with-open-scope', spec: {}, expect: 'safety-boundary:seal-with-open-scope' });
  if ((ex.safety || []).includes('seal-with-no-open-scope')) out.push({ name: 'incomplete-claimed-complete', spec: {}, expect: 'incomplete-claimed-complete' });
  out.push({ name: 'empty', spec: {}, expect: null });
  out.push({ name: 'no-actions', spec: {}, expect: null });
  return out;
}

function mutate(scenarioId, name, spec = {}) {
  const fn = MUTATIONS[name];
  if (!fn) throw new Error(`未知变异: ${name}`);
  return fn(clone(referenceTrace(scenarioId)), spec);
}

module.exports = {
  CODER,
  REVIEWER,
  FINAL,
  REFERENCE,
  SCENARIO_IDS,
  MUTATIONS,
  referenceTrace,
  applicableMutations,
  mutate,
  docOf,
};
