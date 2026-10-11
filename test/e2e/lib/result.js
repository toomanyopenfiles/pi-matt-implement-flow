'use strict';
// ============================================================================
// 场景结果分类的单一来源（票 34 建立契约，票 35 收敛聚合形状）。
//
// 判定词表与失败分类只在这里定义：探针（含双轴契约探针）、流程场景判定器与入口的
// 结果校验都从这里取，避免同一份聚合口径在几处各写一遍而互相漂移。
//
//   status: pass | fail | inconclusive
//   kind:   none | product-regression | infrastructure | harness | undetermined | baseline-defect
//
//   - pass  → kind 必须是 none（通过的结果没有失败分类；这是 ticket 34 轮 2 发现的
//             标签自相矛盾：通过的保证型探针被标成 undetermined）。
//   - fail  → product-regression（被测候选的明确回归）。
//   - baseline-defect → 明确失败，但该失败是已登记的基线既有缺陷：如实呈现为失败
//             （不判通过），但不计入候选回归。
//   - inconclusive → harness（本仓库测试装置故障）/ infrastructure（平台或 provider）
//             / undetermined（证据不足）。
// ============================================================================

const STATUSES = ['pass', 'fail', 'inconclusive'];
const KINDS = ['none', 'product-regression', 'infrastructure', 'harness', 'undetermined', 'baseline-defect'];

// 断言状态：探针内部断言用 pass / fail / inconclusive / harness 四态。
const ASSERTION_STATES = ['pass', 'fail', 'inconclusive', 'harness'];

// 明确失败赢；装置故障优先于无法判定；证据不足绝不判通过。
function aggregateVerdict(states) {
  const list = Array.isArray(states) ? states : [];
  if (list.some((s) => s === 'fail')) return 'fail';
  if (list.some((s) => s === 'harness')) return 'inconclusive';
  if (list.some((s) => s === 'inconclusive')) return 'inconclusive';
  return 'pass';
}

const KIND_PRECEDENCE = ['product-regression', 'harness', 'infrastructure', 'baseline-defect', 'undetermined', 'none'];

function pickKind(kinds) {
  const known = kinds.filter((k) => KINDS.includes(k));
  for (const k of KIND_PRECEDENCE) if (known.includes(k)) return k;
  return 'undetermined';
}

// 场景判定 → 失败分类。verdict 为 pass 时没有失败分类，恒为 none。
function classifyKind(verdict, kinds) {
  if (verdict === 'pass') return 'none';
  const decided = (kinds || []).filter((k) => k && k !== 'none');
  if (verdict === 'fail') {
    if (decided.includes('product-regression')) return 'product-regression';
    if (decided.length > 0 && decided.every((k) => k === 'baseline-defect')) return 'baseline-defect';
    if (decided.includes('baseline-defect')) return 'product-regression';
    return 'product-regression';
  }
  if (decided.includes('harness')) return 'harness';
  if (decided.includes('infrastructure')) return 'infrastructure';
  return 'undetermined';
}

// 探针内部：断言状态列表 → { status, kind }。
function verdictAndKind(states) {
  const verdict = aggregateVerdict(states);
  return { status: verdict, kind: classifyKind(verdict, (states || []).map(assertionKind)) };
}

function assertionKind(state) {
  if (state === 'fail') return 'product-regression';
  if (state === 'harness') return 'harness';
  if (state === 'inconclusive') return 'undetermined';
  return 'none';
}

// 批次内多场景聚合：任一明确失败即失败；结果分类沿用同一优先级。
function aggregateScenarioResults(entries) {
  const verdict = aggregateVerdict(entries.map((e) => e.verdict || e.status));
  const kind = classifyKind(verdict, entries.map((e) => e.kind));
  return { status: verdict, kind };
}

module.exports = {
  STATUSES,
  KINDS,
  ASSERTION_STATES,
  KIND_PRECEDENCE,
  aggregateVerdict,
  classifyKind,
  verdictAndKind,
  assertionKind,
  aggregateScenarioResults,
};
