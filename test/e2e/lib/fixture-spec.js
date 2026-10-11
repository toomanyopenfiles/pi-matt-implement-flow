'use strict';
// ============================================================================
// 场景 fixture 的纯描述（票 35）：事实摘要与清单哈希。
//
// 与 flow-fixture.js（真的建目录、跑 git/ledger）分开：计划阶段要拿 fixture 标识进授权
// 哈希，但**不能有副作用**——这里只做纯计算，同一个场景反复算得到同一个标识。
// ============================================================================

const crypto = require('node:crypto');

const STAGE_CANDIDATE_NOTE =
  'fixture 初始状态固定（固定提交时间/作者 + 固定内容）：同一场景反复构建得到同一组 SHA，可对照比较行为。';

// def.fixture 的关键事实：进计划、进授权哈希，也进判定器的轨迹上下文。
function fixtureFacts(def) {
  const f = def.fixture || {};
  const tickets = (f.tickets || []).map((t) => ({
    num: t.num,
    slug: t.slug,
    status: t.status,
    implemented: Boolean(t.implemented),
    mergedInGit: Boolean(t.mergedInGit),
  }));
  return {
    id: f.id,
    initialized: Boolean(f.initialized),
    reviewerMode: f.reviewerMode || 'on',
    roleExercise: f.roleExercise || null,
    alreadyMerged: tickets.filter((t) => t.mergedInGit).map((t) => t.num),
    unrecordedMerge: f.unrecordedMerge || null,
    openTickets: tickets.filter((t) => t.status !== 'done' && t.status !== 'resolved').map((t) => t.num),
    tickets,
    testCommand: 'npm test',
    branch: `feat/${f.id}`,
    trackerStub: 'local',
  };
}

function fixtureManifest(def, facts = fixtureFacts(def)) {
  const stable = [
    `fixture:${facts.id}`,
    `initialized:${facts.initialized}`,
    `reviewer:${facts.reviewerMode}`,
    `tickets:${facts.tickets.map((t) => `${t.num}:${t.status}:${t.implemented ? 'impl' : 'open'}:${t.mergedInGit ? 'merged' : 'unmerged'}`).join(',')}`,
    `test:${facts.testCommand}`,
    `tracker:${facts.trackerStub}`,
    `note:${STAGE_CANDIDATE_NOTE}`,
  ].join('\n');
  return {
    id: facts.id,
    sha256: crypto.createHash('sha256').update(stable).digest('hex'),
    trackerStub: facts.trackerStub,
    testCommand: facts.testCommand,
    note: STAGE_CANDIDATE_NOTE,
  };
}

// 判定契约摘要（进计划，便于复核「这批到底判了什么」；完整契约仍在场景定义里）。
function judgementSummary(expectations = {}) {
  const reads = [...(expectations.requiredReadsBefore || []), ...(expectations.requiredPathReadsBefore || [])]
    .map((r) => `${r.contract || r.path}@${r.before}`);
  return {
    requiredReadsBefore: reads,
    requiredActions: expectations.requiredActions || [],
    requiredDispatches: (expectations.requiredDispatches || []).map((d) => d.agent),
    forbiddenDispatches: (expectations.forbiddenDispatches || []).map((d) => d.agent),
    forbiddenActions: (expectations.forbiddenActions || []).map((a) => a.action),
    roleDuties: expectations.roleDuties || [],
    safety: expectations.safety || [],
    readOnly: Boolean(expectations.readOnly),
    knownBaselineDefects: (expectations.knownBaselineDefects || []).map((d) => ({ id: d.id, matches: d.matches, stages: d.stages || [] })),
  };
}

module.exports = { STAGE_CANDIDATE_NOTE, fixtureFacts, fixtureManifest, judgementSummary };
