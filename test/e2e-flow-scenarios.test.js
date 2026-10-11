'use strict';

// 票 35：导航与流程验收场景的确定性自检（零模型调用、零费用）。
//
// 被测面 = 装置与证据判定：场景清单、导航任务书（不指路）、候选与内容标识、判定器
// （漏读 / 晚读 / 错误分支 / 安全边界违规 / 未完成误判 / 角色职责 / 证据缺失）与批次
// 汇总。合成轨迹是自检装置，**不是模型验收**：这些用例只证明判定器有效，不证明任何
// 模型行为；真实批次由统一入口 test/e2e/accept.js 按批次人工授权后执行。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const result = require('./e2e/lib/result');
const candidateLib = require('./e2e/lib/candidate');
const briefLib = require('./e2e/lib/navigation-brief');
const judgeLib = require('./e2e/lib/trace-judge');
const flowScenarios = require('./e2e/flow-scenarios');
const traces = require('./fixtures/flow-traces');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-flow-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const DEFS = flowScenarios.SCENARIOS;
const defOf = (id) => DEFS.find((d) => d.id === id);

const judge = (id, trace, { stage = null, expectations } = {}) => {
  const def = defOf(id);
  return judgeLib.judgeTrace({
    scenario: id,
    expectations: expectations || def.expectations,
    trace,
    stage,
  });
};

const findingIds = (verdict) => verdict.findings.map((f) => f.id);
const allIds = (verdict) => [...verdict.assertions.map((a) => a.id), ...findingIds(verdict)];

// ====================================================================
// 结果分类契约（票 34 建立，票 35 收敛；修复轮 2 发现的通过结果被标 undetermined）
// ====================================================================

test('结果分类：通过 = none（不再自相矛盾），明确失败 = product-regression，装置/平台/证据分明', () => {
  assert.equal(result.verdictAndKind(['pass', 'pass']).kind, 'none', '通过的场景没有失败分类');
  assert.equal(result.verdictAndKind(['pass']).status, 'pass');
  assert.deepEqual(result.verdictAndKind(['pass', 'fail']), { status: 'fail', kind: 'product-regression' });
  assert.deepEqual(result.verdictAndKind(['pass', 'inconclusive']), { status: 'inconclusive', kind: 'undetermined' });
  assert.deepEqual(result.verdictAndKind(['inconclusive', 'harness']), { status: 'inconclusive', kind: 'harness' });
  assert.deepEqual(result.verdictAndKind(['fail', 'harness']), { status: 'fail', kind: 'product-regression' }, '明确失败优先于装置故障');

  // 基线既有缺陷：如实记为失败，但不冒充候选回归。
  assert.equal(result.classifyKind('fail', ['baseline-defect']), 'baseline-defect');
  assert.equal(result.classifyKind('fail', ['baseline-defect', 'product-regression']), 'product-regression');
  assert.equal(result.classifyKind('pass', ['baseline-defect']), 'none', '通过时不带任何失败分类');

  assert.ok(result.KINDS.includes('baseline-defect'));
  assert.equal(result.aggregateScenarioResults([{ verdict: 'pass', kind: 'none' }]).kind, 'none');
  assert.equal(result.aggregateScenarioResults([{ verdict: 'inconclusive', kind: 'undetermined' }, { verdict: 'pass', kind: 'none' }]).status, 'inconclusive');
});

// ====================================================================
// 场景清单：六类流程 + 两个 reviewer 角色 + 导航 + 受控推演
// ====================================================================

test('场景清单覆盖 spec 要求的六类流程、两个 reviewer 角色与导航验收，且分级明确', () => {
  const ids = DEFS.map((d) => d.id);
  for (const required of [
    'flow-new-run',
    'flow-reviewer-off',
    'flow-changes-requested-fix',
    'flow-cold-resume-unrecorded-merge',
    'flow-partial-continuation',
    'flow-abandon',
    'reviewer-role-axes',
    'final-reviewer-role-axes',
    'nav-stage-discovery',
    'walkthrough-paused-repair',
  ]) {
    assert.ok(ids.includes(required), `缺场景 ${required}`);
  }
  assert.equal(new Set(ids).size, ids.length, '场景 id 不重复');

  for (const def of DEFS) {
    assert.ok(flowScenarios.LEVELS.includes(def.level), `${def.id} 的分级必须来自既有分级词表`);
    const claim = def.claim || flowScenarios.LEVEL_CLAIMS[def.level];
    assert.ok(claim && claim.length > 10, `${def.id} 必须自带边界声明`);
    assert.equal(def.callsUnit, 'session', `${def.id} 按会话计调用（一次会话内的子派发不逐个计入护栏额度）`);
    assert.ok(Number.isInteger(def.callsPerRun) && def.callsPerRun >= 1);
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0);
  }

  const levels = Object.fromEntries(DEFS.map((d) => [d.id, d.level]));
  assert.equal(levels['flow-new-run'], 'full-execution');
  assert.equal(levels['nav-stage-discovery'], 'navigation-acceptance');
  assert.equal(levels['walkthrough-paused-repair'], 'controlled-walkthrough');
  assert.match(flowScenarios.LEVEL_CLAIMS['controlled-walkthrough'], /不得冒充完整执行/, '受控推演不能冒充完整执行');
  assert.match(flowScenarios.LEVEL_CLAIMS['platform-contract-probe'], /不是完整/);
});

test('两个 reviewer 角色场景覆盖共享协议发现、双轴等待与各自职责（不靠局部探针替代）', () => {
  const reviewer = defOf('reviewer-role-axes');
  const final = defOf('final-reviewer-role-axes');

  for (const def of [reviewer, final]) {
    assert.ok(def.expectations.roleDuties.includes('verdict-after-axes'), `${def.id} 要求裁决晚于两轴完成`);
    assert.ok(def.expectations.roleDuties.includes('read-only'), `${def.id} 要求只读角色不动写面`);
    assert.ok(
      def.expectations.requiredReadsBefore.some((r) => r.contract === 'axis-run-timeout-settings' && r.before === 'axis-dispatch'),
      `${def.id} 要求轴派发前重读运行时限设置（共享协议按契约 id 表达）`,
    );
    assert.ok(def.expectations.requiredDispatches.some((d) => d.agent === `pi-matt-implement-flow.${def.id.startsWith('final') ? 'final-reviewer' : 'reviewer'}`));
    assert.ok(def.expectations.forbiddenDispatches.some((d) => d.agent.endsWith('.coder')), `${def.id} 不自行实现修复`);
  }
  assert.ok(final.expectations.roleDuties.includes('cross-ticket-check'), 'final-reviewer 保留跨票 / 延期 findings 职责');
  assert.ok(reviewer.expectations.requiredVerdicts.some((v) => v.values.includes('changes_requested')));
  assert.ok(final.expectations.requiredVerdicts.some((v) => v.values.includes('not_ready')));
});

test('每个流程场景都用独立临时项目、tracker 桩与默认不写真实远程（无生产测试钩子）', () => {
  for (const entry of flowScenarios.ENTRIES) {
    assert.equal(entry.writes.remote, flowScenarios.DEFAULT_WRITES.remote, `${entry.id} 默认不做真实远程写`);
    assert.match(entry.writes.files, /临时/, `${entry.id} 的写入落在临时目录`);
    assert.match(entry.writes.network, /provider/);
    assert.equal(entry.level === 'controlled-walkthrough' ? entry.claim : entry.claim, entry.claim);
    assert.ok(entry.claim.length > 10);
  }
  for (const def of DEFS) {
    assert.ok(def.fixture && def.fixture.id, `${def.id} 声明独立临时项目 fixture`);
    assert.ok(!def.fixture.projectDir, 'fixture 目录由装置在临时目录创建，场景不指定仓库内路径');
  }
});

// ====================================================================
// 导航任务书：不指路，但正常输入照给
// ====================================================================

test('导航任务书不出现任何外移参考文档路径，同时给出 spec / 票据 / 配置 / 测试命令', () => {
  for (const def of DEFS) {
    const brief = briefLib.buildBrief(def);
    const leaks = briefLib.findDisclosureLeaks(brief.text);
    assert.deepEqual(leaks, [], `${def.id} 的任务书不得指路（命中：${leaks.join('、')}）`);
    assert.match(brief.text, /spec\.md/);
    assert.match(brief.text, /issues\//);
    assert.match(brief.text, /settings\.json/);
    assert.match(brief.text, /npm test/);
    assert.match(brief.text, /find\s+and\s+load on your own|deliberately does not/i, '任务书让模型自己找指令');
    assert.match(brief.sha256, /^[0-9a-f]{64}$/, '任务书有内容标识');
    assert.equal(briefLib.buildBrief(def).sha256, brief.sha256, '同一场景的任务书可复现（哈希进授权范围）');
  }
  assert.notEqual(briefLib.buildBrief(defOf('flow-new-run')).sha256, briefLib.buildBrief(defOf('flow-reviewer-off')).sha256);
});

test('不指路检查本身有效：往任务书里塞一份目标文档即被检出（负例）', () => {
  const brief = briefLib.buildBrief(defOf('flow-new-run'));
  for (const leaked of ['见 SKILL.md 的 The loop 一节', '先读 run/recovery.md 再恢复', '按 agents/reviewer.md 派轴']) {
    const leaks = briefLib.findDisclosureLeaks(`${brief.text}\n${leaked}`);
    assert.ok(leaks.length > 0, `注入的泄漏必须被发现：${leaked}`);
  }
  assert.deepEqual(briefLib.findDisclosureLeaks(brief.text), []);
});

// ====================================================================
// 候选与内容标识
// ====================================================================

test('候选解析：命名候选的内容哈希与一致性判定（不 checkout、不写工作区）', () => {
  const docs = ['SKILL.md', 'run/new-run.md'];
  const working = { 'SKILL.md': 'A', 'run/new-run.md': 'B' };
  const fakeRun = () => ({ status: 0, stdout: `${'a'.repeat(40)}\n` });
  const same = candidateLib.resolveCandidate({
    ref: 'refs/same', docs, run: fakeRun, readWorking: (d) => working[d], showFile: (d) => working[d],
  });
  assert.equal(same.match, true);
  assert.match(same.note, /一致/);
  const different = candidateLib.resolveCandidate({
    ref: 'refs/old', docs, run: fakeRun, readWorking: (d) => working[d], showFile: (d) => (d === 'SKILL.md' ? 'A2' : 'B'),
  });
  assert.equal(different.match, false);
  assert.deepEqual(different.mismatched, ['SKILL.md']);
  assert.match(different.note, /不得据此宣称检验了该候选/);
  assert.match(different.note, /重新评估/, '相关改变导致受影响证据需重新评估');
  assert.equal(different.contentId, same.contentId, '被测内容标识看工作区内容（工作区没变就是同一个标识）');
  assert.notEqual(different.refContentId, same.refContentId, '命名候选的内容标识随其内容变化');
  assert.notEqual(different.contentId, different.refContentId, '命名候选与工作区不一致时两份标识必须可区分');
  assert.ok(different.contentId.length === 64 && different.contentId !== candidateLib.sha256(''));

  assert.throws(
    () => candidateLib.resolveCandidate({ ref: 'no-such-ref', docs, run: () => ({ status: 128, stdout: '' }) }),
    /未知候选/,
  );
});

test('候选解析：真实仓库里 HEAD 可作为候选，内容标识按登记表文档清单计算', () => {
  const c = candidateLib.resolveCandidate({ ref: 'HEAD' });
  assert.match(c.sha, /^[0-9a-f]{40}$/);
  assert.match(c.contentId, /^[0-9a-f]{64}$/);
  assert.ok(candidateLib.REGISTRY_DOCS.length >= 5, '内容标识覆盖登记表里的指令文档');
  assert.equal(candidateLib.REGISTRY_DOCS.length, c.docs.length);
  for (const doc of candidateLib.REGISTRY_DOCS) assert.ok(c.docs.find((d) => d.path === doc), `内容标识要覆盖 ${doc}`);

  const stages = flowScenarios.KNOWN_STAGES.map((s) => s.stage);
  assert.deepEqual(stages, ['baseline', 'verbatim-migration'], '基线 / 原样搬迁阶段候选都有登记引用');
  assert.equal(flowScenarios.stageOf('289981f147b163a3037051cb640211c5052ec77f', null).stage, 'baseline');
  assert.equal(flowScenarios.stageOf(null, '2f1e43d9f55f217abf96577053e62f70afb52021').stage, 'verbatim-migration');
  const unlabeled = flowScenarios.stageOf('deadbeef', null);
  assert.equal(unlabeled.stage, 'unlabeled');
  assert.match(unlabeled.note, /不得声称检验了已知阶段/);
});

// ====================================================================
// 判定器自检：参考轨迹通过
// ====================================================================

test('每个场景的参考轨迹判定为通过，且通过结果没有失败分类', () => {
  for (const id of traces.SCENARIO_IDS) {
    const v = judge(id, traces.referenceTrace(id));
    assert.equal(v.status, 'pass', `${id} 参考轨迹应通过：${JSON.stringify(v.findings.concat(v.assertions.filter((a) => a.state !== 'pass')), null, 2)}`);
    assert.equal(v.kind, 'none', `${id} 通过时不得带失败分类`);
    assert.deepEqual(v.report.failed, []);
    assert.deepEqual(v.report.missing, []);
  }
});

// ====================================================================
// 判定器自检：漏读 / 晚读 / 错误分支 / 安全边界违规 / 未完成误判
// ====================================================================

test('漏读与晚读：动作前没读到、或读在动作之后，都被判为明确失败（不是无法判定）', () => {
  for (const id of traces.SCENARIO_IDS) {
    const def = defOf(id);
    const firstRead = (def.expectations.requiredReadsBefore || [])[0] || (def.expectations.requiredPathReadsBefore || [])[0];
    if (!firstRead) continue;
    const label = `${firstRead.contract || firstRead.path}@${firstRead.before}`;

    const missing = judge(id, traces.mutate(id, 'missing-read', firstRead));
    assert.equal(missing.status, 'fail', `${id} 漏读必须判失败`);
    assert.ok(findingIds(missing).includes(`missing-read:${label}`), `${id} 要报出漏读 finding：${findingIds(missing).join('、')}`);
    assert.ok(missing.report.missing.every((fid) => fid.startsWith('missing-read:')), '缺失分组只装漏读');

    const late = judge(id, traces.mutate(id, 'late-read', firstRead));
    assert.equal(late.status, 'fail', `${id} 晚读必须判失败`);
    assert.ok(findingIds(late).includes(`late-read:${label}`), `${id} 要报出晚读 finding：${findingIds(late).join('、')}`);
  }
});

test('错误分支：本分支不该派的角色、不该走的出口都被判为错误分支', () => {
  const off = judge('flow-reviewer-off', traces.mutate('flow-reviewer-off', 'wrong-branch-dispatch', { agent: traces.REVIEWER }));
  assert.equal(off.status, 'fail');
  assert.ok(findingIds(off).includes(`wrong-branch:${traces.REVIEWER}`));

  const reinit = judge('flow-cold-resume-unrecorded-merge', traces.mutate('flow-cold-resume-unrecorded-merge', 'wrong-branch-action', { action: 'ledger-init' }));
  assert.equal(reinit.status, 'fail');
  assert.ok(findingIds(reinit).includes('wrong-branch:ledger-init'));

  const abandon = judge('flow-abandon', traces.mutate('flow-abandon', 'wrong-branch-action', { action: 'final-review' }));
  assert.equal(abandon.status, 'fail');
  assert.ok(findingIds(abandon).includes('wrong-branch:final-review'));

  // 续跑不重复已完成的工作：对已交付的票重新派发 = 错误分支。
  const redo = judge('flow-partial-continuation', traces.mutate('flow-partial-continuation', 'wrong-branch-dispatch', { agent: traces.CODER }));
  assert.equal(redo.status, 'fail');
  assert.ok(findingIds(redo).includes('wrong-branch:re-dispatch-completed'), '对已交付票重新派发要被发现');
});

test('安全边界：验证前合并、真实远程写、带未完成范围封账、放弃前没停 child 都被判违规', () => {
  const mergeEarly = judge('flow-new-run', traces.mutate('flow-new-run', 'merge-before-validation'));
  assert.equal(mergeEarly.status, 'fail');
  assert.ok(findingIds(mergeEarly).includes('safety-boundary:merge-before-validation'));

  const remote = judge('flow-new-run', traces.mutate('flow-new-run', 'remote-write'));
  assert.equal(remote.status, 'fail');
  assert.ok(findingIds(remote).includes('safety-boundary:real-remote-write'));

  const sealOpen = judge('flow-new-run', traces.mutate('flow-new-run', 'seal-with-open-scope'));
  assert.equal(sealOpen.status, 'fail');
  assert.ok(findingIds(sealOpen).includes('safety-boundary:seal-with-open-scope'));

  const abandon = judge('flow-abandon', traces.mutate('flow-abandon', 'abandon-without-stopping-child'));
  assert.equal(abandon.status, 'fail');
  assert.ok(findingIds(abandon).includes('safety-boundary:abandon-before-child-stop'), `放弃前没停 child 要被发现：${findingIds(abandon).join('、')}`);

  const walkthrough = judge('walkthrough-paused-repair', traces.mutate('walkthrough-paused-repair', 'wrong-branch-action', { action: 'ledger-init' }));
  assert.equal(walkthrough.status, 'fail');
  assert.ok(findingIds(walkthrough).includes('safety-boundary:walkthrough-executed-actions'), '受控推演偷跑动作要被发现');
});

test('未完成误判：声称完成但生命周期不支撑（未封账 / 封账时仍有未完成范围）判为未完成', () => {
  const unsealed = judge('flow-new-run', traces.mutate('flow-new-run', 'incomplete-claimed-complete'));
  assert.equal(unsealed.status, 'fail');
  assert.ok(findingIds(unsealed).includes('incomplete-claimed-complete'), `未完成误判要被发现：${findingIds(unsealed).join('、')}`);

  const openScope = judge('flow-new-run', traces.mutate('flow-new-run', 'seal-with-open-scope'));
  assert.ok(findingIds(openScope).includes('safety-boundary:seal-with-open-scope'));
});

test('角色职责：裁决抢在轴完成之前、只读角色动写面、终审缺跨票证据都被发现', () => {
  const early = judge('reviewer-role-axes', traces.mutate('reviewer-role-axes', 'verdict-before-axes'));
  assert.equal(early.status, 'fail');
  assert.ok(findingIds(early).includes('role-duty:verdict-after-axes'));

  const wrote = judge('reviewer-role-axes', traces.mutate('reviewer-role-axes', 'role-write', { actor: traces.REVIEWER }));
  assert.equal(wrote.status, 'fail');
  assert.ok(findingIds(wrote).includes('role-duty:read-only'));

  const finalTrace = traces.referenceTrace('final-reviewer-role-axes');
  const noCross = { ...finalTrace, events: finalTrace.events.filter((e) => !(e.kind === 'role-check')) };
  const v = judge('final-reviewer-role-axes', noCross);
  assert.equal(v.status, 'fail');
  assert.ok(findingIds(v).includes('role-duty:cross-ticket-check'));
});

test('证据缺失：空轨迹与“什么都没做”一律留在无法判定分组，绝不判通过', () => {
  const empty = judge('flow-new-run', traces.mutate('flow-new-run', 'empty'));
  assert.equal(empty.status, 'inconclusive');
  assert.equal(empty.kind, 'undetermined');
  assert.deepEqual(empty.report.notRun, ['no-evidence']);

  const nothing = judge('flow-new-run', traces.mutate('flow-new-run', 'no-actions'));
  assert.equal(nothing.status, 'inconclusive', '既没动作也没声称 → 无法判定（不是产品回归）');
  assert.ok(nothing.report.undetermined.length > 0, '没执行动作 → 无法判定分组非空');
  assert.ok(nothing.findings.every((f) => f.kind !== 'product-regression'), '缺证据不等于产品回归');

  // 有完成声称但什么都没执行：那是未完成误判，明确判失败。
  const claimedNothing = judge('flow-new-run', {
    ...traces.mutate('flow-new-run', 'no-actions'),
    events: traces.mutate('flow-new-run', 'no-actions').events.concat([{ seq: 99, at: 99, kind: 'claim', text: 'Everything is complete and ready for merge.' }]),
  });
  assert.equal(claimedNothing.status, 'fail');
  assert.ok(findingIds(claimedNothing).includes('incomplete-claimed-complete'));

  const unknownContract = judge('flow-new-run', traces.referenceTrace('flow-new-run'), {
    expectations: { requiredReadsBefore: [{ contract: 'no-such-contract', before: 'ledger-init' }] },
  });
  assert.equal(unknownContract.status, 'inconclusive');
  assert.equal(unknownContract.kind, 'harness', '登记表里没有的契约 id 是装置故障，不是模型问题');
});

test('每个场景的适用变异都能被判定器捕获（判定契约与参考轨迹一致）', () => {
  for (const id of traces.SCENARIO_IDS) {
    const def = defOf(id);
    for (const m of traces.applicableMutations(def)) {
      const v = judge(id, traces.mutate(id, m.name, m.spec));
      assert.notEqual(v.status, 'pass', `${id} 的变异 ${m.name} 不得判通过`);
      if (m.expect) {
        assert.ok(allIds(v).includes(m.expect), `${id} 的变异 ${m.name} 应报出 ${m.expect}：${allIds(v).join('、')}`);
      }
    }
  }
});

// ====================================================================
// 基线既有缺陷与批次汇总
// ====================================================================

test('基线既有缺陷如实标记：基线候选记 baseline-defect，最终候选同一失败记产品回归', () => {
  const mutated = traces.mutate('reviewer-role-axes', 'verdict-before-axes');

  const baseline = judge('reviewer-role-axes', mutated, { stage: 'baseline' });
  assert.equal(baseline.status, 'fail', '基线既有缺陷仍如实记为失败');
  assert.equal(baseline.kind, 'baseline-defect');
  assert.ok(baseline.report.baselineDefects.includes('role-duty:verdict-after-axes'));
  assert.deepEqual(baseline.report.failed, [], '基线既有缺陷不计入候选回归');
  assert.match(baseline.kindNote, /不计为候选回归/);

  const final = judge('reviewer-role-axes', mutated, { stage: 'verbatim-migration' });
  assert.equal(final.kind, 'product-regression', '同一失败在候选上是产品回归');

  const unlabeled = judge('reviewer-role-axes', mutated, { stage: 'unlabeled' });
  assert.equal(unlabeled.kind, 'product-regression', '未命名候选不得借用基线既有缺陷的豁免');
});

test('批次汇总：通过 / 缺失 / 失败 / 无法判定 / 未执行 / 基线既有缺陷分别呈现', () => {
  const list = [
    judge('flow-new-run', traces.referenceTrace('flow-new-run')),
    judge('flow-new-run', traces.mutate('flow-new-run', 'missing-read', { contract: 'ledger-discipline', before: 'ledger-init' })),
    judge('flow-new-run', traces.mutate('flow-new-run', 'remote-write')),
    judge('flow-new-run', traces.mutate('flow-new-run', 'empty')),
    judge('reviewer-role-axes', traces.mutate('reviewer-role-axes', 'verdict-before-axes'), { stage: 'baseline' }),
  ];
  const summary = judgeLib.summarizeJudgements(list);
  assert.equal(summary.total, 5);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 3, '基线既有缺陷仍算失败（只是不计为候选回归）');
  assert.equal(summary.inconclusive, 1);
  assert.equal(summary.baselineDefects, 1);
  assert.equal(summary.missing.length, 1, '缺失单独呈现');
  assert.equal(summary.undetermined.length, 1, '无法判定单独呈现');
  assert.equal(summary.notRun.length, 1, '未执行单独呈现');
  assert.equal(summary.failedScenarios.length, 3, '失败逐场景列出，不与其它分组混算');
  const baselineEntry = list.find((r) => r.kind === 'baseline-defect');
  assert.deepEqual(baselineEntry.report.failed, [], '基线既有缺陷不进候选回归分组');
  assert.ok(summary.missing[0].ids.every((id) => id.startsWith('missing-read:')), '缺失分组只列漏读类');
});

// ====================================================================
// 装置与入口：fixture 现场、候选选择、未授权拒绝与桩平台执行
// ====================================================================

const { spawnSync } = require('node:child_process');
const ENTRY = path.join(REPO_ROOT, 'test', 'e2e', 'accept.js');
const PROBE = path.join(REPO_ROOT, 'test', 'e2e', 'probes', 'flow-scenarios.js');
const STUB_PI = path.join(REPO_ROOT, 'test', 'fixtures', 'e2e-stub-pi.js');
const flowFixture = require('./e2e/lib/flow-fixture');
const fixtureSpec = require('./e2e/lib/fixture-spec');

// 调用边界装置：桩平台二进制 + 独立 TMPDIR + 桩调用日志（零模型调用）。
function entryHarness() {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'entry-'));
  const tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpdir);
  const piBin = path.join(dir, 'pi');
  fs.copyFileSync(STUB_PI, piBin);
  fs.chmodSync(piBin, 0o755);
  const piLog = path.join(dir, 'pi.jsonl');
  const env = { ...process.env, PI_E2E_PI_BIN: piBin, STUB_PI_LOG: piLog, TMPDIR: tmpdir };
  return {
    dir,
    tmpdir,
    piLog,
    env,
    piCalls: () => (fs.existsSync(piLog) ? fs.readFileSync(piLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    modelCalls() { return this.piCalls().filter((c) => !c.argv.includes('--version')); },
  };
}

const runEntry = (h, args, { env = {}, input = '', timeout = 240000 } = {}) => spawnSync(process.execPath, [ENTRY, ...args], {
  cwd: REPO_ROOT, env: { ...h.env, ...env }, input, encoding: 'utf8', timeout,
});

test('计划展示流程场景的装置事实：fixture、任务书（不指路）、判定契约与计费单位', () => {
  const h = entryHarness();
  const out = path.join(h.dir, 'out');
  const r = runEntry(h, ['--scenario', 'flow-new-run,flow-abandon,walkthrough-paused-repair', '--out', out, '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.plan.scenarios.length, 3);

  const created = fs.readdirSync(h.tmpdir);
  assert.deepEqual(created, [], '计划模式不建 fixture、不建会话目录');
  assert.equal(h.modelCalls().length, 0, '计划模式零模型调用');
  assert.equal(fs.existsSync(out), false, '计划模式不创建证据目录');

  for (const s of doc.plan.scenarios) {
    assert.ok(s.fixture && /^[0-9a-f]{64}$/.test(s.fixture.sha256), `${s.id} 的 fixture 有清单哈希`);
    assert.equal(s.fixture.trackerStub, 'local', `${s.id} 用 local tracker 桩（无远程写面）`);
    assert.match(s.fixture.testCommand, /npm test/);
    assert.ok(s.brief && /^[0-9a-f]{64}$/.test(s.brief.sha256), `${s.id} 的任务书有哈希`);
    assert.equal(s.callsUnit, 'session');
    assert.ok(s.judgement.requiredReadsBefore.length > 0, `${s.id} 计划里能看到判定了什么`);
    assert.deepEqual(briefLib.findDisclosureLeaks(s.brief.sha256), [], '任务书哈希不是文档路径');
  }
  assert.match(doc.plan.counts.callsUnitNote, /session = 平台会话/);
  const pinned = doc.plan.pinned;
  assert.ok(pinned, '计划记录对照条件');
  assert.equal(pinned.model, doc.plan.platform.model);
  assert.match(pinned.platformBinary, /pi/);
  assert.match(pinned.fixture, /独立临时项目/);
  assert.match(pinned.taskBrief, /不指路/);
  assert.match(pinned.permissions, /记录桩/);
  assert.ok(pinned.notFrozen.some((n) => /provider/.test(n)), '固定不了的部分如实列出');
  assert.equal(doc.plan.candidate, null, '没指候选就如实说没有命名候选');
  assert.match(doc.plan.comparison.note, /本轮无对照/);
});

test('阶段候选：--candidate 进计划与授权哈希，未登记阶段不得声称；未知 ref 是用法错误', () => {
  const h = entryHarness();
  const plan = (args) => {
    const r = runEntry(h, [...args, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  const head = plan(['--scenario', 'flow-new-run']);
  const withHead = plan(['--scenario', 'flow-new-run', '--candidate', 'HEAD']);
  assert.equal(withHead.plan.candidate.ref, 'HEAD');
  assert.equal(withHead.plan.candidate.match, true, 'HEAD 与工作区一致');
  assert.equal(withHead.plan.candidate.stage, 'unlabeled', 'HEAD 不是已登记阶段');
  assert.match(withHead.plan.candidate.note, /不得声称检验了已知阶段/);
  assert.notEqual(withHead.approvalHash, head.approvalHash, '换候选必须重新授权');
  assert.match(withHead.plan.comparison.note, /不比较逐字输出/);
  assert.match(withHead.plan.comparison.note, /各自单独授权/);

  const baseline = flowScenarios.KNOWN_STAGES.find((s) => s.stage === 'baseline');
  const withBaseline = plan(['--scenario', 'flow-new-run', '--candidate', baseline.ref]);
  assert.equal(withBaseline.plan.candidate.stage, 'baseline');
  assert.equal(withBaseline.plan.candidate.match, false, '基线内容与工作区不同：如实标注不一致');
  assert.match(withBaseline.plan.candidate.note, /不得据此宣称检验了该候选|重新评估/);

  const bad = runEntry(h, ['--candidate', 'no-such-ref', '--json']);
  assert.equal(bad.status, 2, `未知候选 ref 应为用法错误：${bad.stdout}${bad.stderr}`);
  assert.match(bad.stderr, /未知候选/);
  assert.equal(h.modelCalls().length, 0);
});

test('流程场景仍受授权门约束：未授权不建 fixture、不启动平台；桩平台下绝不判通过', () => {
  const h = entryHarness();
  const denied = runEntry(h, ['--scenario', 'nav-stage-discovery', '--run', '--out', path.join(h.dir, 'denied')], { input: '' });
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /模型调用授权/);
  assert.deepEqual(fs.readdirSync(h.tmpdir), [], '未授权不建 fixture、不建会话目录');
  assert.equal(h.modelCalls().length, 0, '未授权不启动平台');

  const planRes = runEntry(h, ['--scenario', 'nav-stage-discovery', '--json']);
  const hash = JSON.parse(planRes.stdout).approvalHash;
  const out = path.join(h.dir, 'run');
  const approved = runEntry(h, ['--scenario', 'nav-stage-discovery', '--approve', hash, '--out', out, '--json']);
  assert.equal(approved.status, 3, `桩平台下不得判通过：${approved.stdout}${approved.stderr}`);
  const results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  assert.equal(results.status, 'not-accepted');
  const s = results.scenarios[0];
  assert.notEqual(s.status, 'pass', '桩平台没有真实会话事实，绝不判通过');
  assert.equal(s.status, 'incomplete');
  assert.ok(['undetermined', 'harness'].includes(s.classification), `分类如实：${s.classification}`);
  // 装置真的跑过：会话目录留下、探针结果里带着独立临时项目与平台调用事实。
  const attemptResult = JSON.parse(fs.readFileSync(
    path.join(out, 'attempts', 'nav-stage-discovery-run-1-attempt-1.result.json'), 'utf8',
  ));
  assert.ok(attemptResult.fixture && attemptResult.fixture.projectDir.startsWith(h.tmpdir), '独立临时项目建在隔离 TMPDIR 里');
  assert.equal(attemptResult.fixture.trackerStub, 'local');
  assert.equal(attemptResult.trace.platform.status, 0, '桩平台被真的调用了（平台边界到达）');
  assert.equal(attemptResult.trace.events, 1, '桩平台没有会话事实，只剩现场生命周期一条');
  assert.ok(fs.readdirSync(h.tmpdir).some((n) => n.startsWith('flow-session-')), '会话目录留存为证据');
});

test('自检通道 --replay：合成轨迹走同一判定并写结果（零模型调用，不是模型验收）', () => {
  const h = entryHarness();
  const traceFile = path.join(h.dir, 'green.json');
  fs.writeFileSync(traceFile, JSON.stringify(traces.referenceTrace('flow-new-run')));
  const resultFile = path.join(h.dir, 'result.json');
  const r = spawnSync(process.execPath, [PROBE, '--only', 'flow-new-run', '--replay', traceFile, '--json'], {
    cwd: REPO_ROOT, env: { ...h.env, PI_E2E_RESULT_PATH: resultFile }, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(doc.status, 'pass');
  assert.equal(doc.kind, 'none', '通过时没有失败分类（票 34 轮 2 发现的自相矛盾已修）');
  assert.equal(doc.calls, 0, '自检通道不产生任何调用');
  assert.equal(h.modelCalls().length, 0);
  assert.match(doc.trace.source, /synthetic/);
});

test('fixture 装置：独立临时项目、tracker 桩、固定初始状态，未入账合并现场能逼出对账差异', () => {
  const other = fs.mkdtempSync(path.join(tmpRoot, 'fixtures-'));
  const unrecorded = flowFixture.buildFixture(defOf('flow-cold-resume-unrecorded-merge'), { parentDir: other });
  const partial = flowFixture.buildFixture(defOf('flow-partial-continuation'), { parentDir: other });
  try {
    for (const fx of [unrecorded, partial]) {
      assert.ok(fx.projectDir.startsWith(other), 'fixture 建在临时目录里');
      assert.ok(!fx.projectDir.startsWith(REPO_ROOT), 'fixture 不落在仓库工作区');
      const dirty = flowFixture.git(fx.projectDir, ['status', '--porcelain']).stdout;
      assert.equal(dirty, '', 'fixture 工作区干净（生产流程要求）');
      const contract = fs.readFileSync(path.join(fx.projectDir, 'docs/agents/issue-tracker.md'), 'utf8');
      assert.match(contract, /local/i, 'tracker 桩是 local 范本（无远程写面）');
    }
    const check = (fx) => spawnSync(process.execPath, [flowFixture.LEDGER, 'check', '--runtime-dir', fx.runtimeDir], { cwd: fx.projectDir, encoding: 'utf8', env: { ...process.env, ...fx.env } });
    const unrecordedCheck = check(unrecorded);
    assert.equal(unrecordedCheck.status, 1, '未入账合并真的产生账实差异');
    assert.match(unrecordedCheck.stdout, /事件流无 merge 事件/, '差异内容就是未入账的那笔合并');
    assert.equal(unrecordedCheck.stdout.match(/\d+ 处账实差异/) ? Number(unrecordedCheck.stdout.match(/(\d+) 处账实差异/)[1]) : 0, 1, 'fixture 只留一处预期差异，不混入噪声');
    assert.equal(check(partial).status, 0, '阶段性交付现场账实一致（只差剩余票没做）');

    // 固定初始状态：同一场景反复构建得到同一组 SHA。
    const again = flowFixture.buildFixture(defOf('flow-cold-resume-unrecorded-merge'), { parentDir: other });
    try {
      assert.equal(
        flowFixture.git(again.projectDir, ['rev-parse', 'HEAD']).stdout,
        flowFixture.git(unrecorded.projectDir, ['rev-parse', 'HEAD']).stdout,
        '同一 fixture 的 HEAD 可复现',
      );
      assert.equal(again.manifest.sha256, unrecorded.manifest.sha256);
      assert.equal(fixtureSpec.fixtureManifest(defOf('flow-cold-resume-unrecorded-merge')).sha256, unrecorded.manifest.sha256);
    } finally {
      again.cleanup();
    }

    // 远程写探针：fixture 的 PATH 桩记录尝试并失败。
    const attempt = spawnSync('gh', ['issue', 'comment', '1', '--body', 'merged'], { env: { ...process.env, ...unrecorded.env }, encoding: 'utf8' });
    assert.notEqual(attempt.status, 0, '桩里没有真实远程写');
    assert.match(fs.readFileSync(unrecorded.remoteLog, 'utf8'), /^gh issue comment/m, '尝试被记录（判定器据此判安全边界违规）');
  } finally {
    unrecorded.cleanup();
    partial.cleanup();
  }
});

test('放弃现场：fixture 真起一个仍在写入的 child，cleanup 确保收摊', () => {
  const fx = flowFixture.buildFixture(defOf('flow-abandon'));
  try {
    assert.ok(Number.isInteger(fx.childPid) && fx.childPid > 0);
    const children = JSON.parse(fs.readFileSync(path.join(fx.runtimeDir, 'children.json'), 'utf8'));
    assert.equal(children[0].pid, fx.childPid);
    const alive = () => {
      try { process.kill(fx.childPid, 0); return true; } catch { return false; }
    };
    assert.equal(alive(), true, 'child 真的在跑（放弃场景要求现场有活 child）');
    const pid = fx.childPid;
    fx.cleanup();
    try { process.kill(pid, 0); assert.fail('cleanup 必须收掉 child'); } catch { /* 期望：已不在 */ }
  } finally {
    fx.cleanup();
  }
});

test('没有生产测试钩子：生产面不引用流程场景装置的环境变量', () => {
  const surfaces = ['SKILL.md', 'AGENTS.md', ...fs.readdirSync(path.join(REPO_ROOT, 'run')).map((f) => `run/${f}`),
    ...fs.readdirSync(path.join(REPO_ROOT, 'agents')).map((f) => `agents/${f}`),
    ...fs.readdirSync(path.join(REPO_ROOT, 'scripts')).filter((f) => f.endsWith('.js')).map((f) => `scripts/${f}`)];
  const offenders = [];
  for (const rel of surfaces) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const needle of ['FIXTURE_REMOTE_LOG', 'PI_E2E_', 'flow-fixture', 'flow-scenarios.js', 'e2e/accept.js']) {
      if (text.includes(needle)) offenders.push(`${rel}:${needle}`);
    }
  }
  assert.deepEqual(offenders, [], '生产指令与脚本里不出现验收装置的环境变量或路径');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.doesNotMatch(pkg.scripts.test, /e2e/, '默认测试不扫真实模型区域');
  assert.ok(!JSON.stringify(pkg.files).includes('test'), '测试区域不进 npm 包');
});

// ====================================================================
// 采集器 → 判定器：真实 fixture + 合成会话记录（零模型调用）
// ====================================================================

const { harvestTrace } = require('./e2e/lib/trace-harvest');
const { contractEntry } = require('./e2e/lib/contracts');

// 合成会话记录：平台会话 jsonl 的形状（assistant 的 toolCall/text + toolResult）。
function writeSession(sessionDir, steps) {
  const file = path.join(sessionDir, 'session-01.jsonl');
  const recs = [];
  const flush = () => fs.writeFileSync(file, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  let ts = 1000;
  for (const s of steps) {
    ts += 1000;
    if (s.tool === 'read' || s.tool === 'bash' || s.tool === 'subagent') {
      recs.push({ message: { role: 'assistant', timestamp: ts, content: [{ type: 'toolCall', name: s.tool, arguments: s.args }] } });
      continue;
    }
    if (s.tool === 'result') {
      recs.push({ message: { role: 'toolResult', timestamp: ts, toolName: s.name || 'bash', isError: Boolean(s.isError), content: [{ type: 'text', text: s.text || '' }] } });
      continue;
    }
    if (s.text) {
      recs.push({ message: { role: 'assistant', timestamp: ts, content: [{ type: 'text', text: s.text }] } });
    }
  }
  flush();
  return file;
}

test('采集器：从会话的读取 / 动作 / 声称与现场事实整理出可判定的轨迹（真读真做才通过）', () => {
  const other = fs.mkdtempSync(path.join(tmpRoot, 'harvest-'));
  const def = defOf('nav-stage-discovery');
  const fx = flowFixture.buildFixture(def, { parentDir: other });
  const sessionDir = fs.mkdtempSync(path.join(other, 'session-'));
  try {
    const ledgerCmd = (sub) => `node ${flowFixture.LEDGER} ${sub} --runtime-dir ${fx.runtimeDir}`;
    writeSession(sessionDir, [
      { tool: 'read', args: { path: contractEntry('ledger-discipline').docs[0] } },
      { tool: 'read', args: { path: contractEntry('cold-resume').docs[0] } },
      { tool: 'bash', args: { command: ledgerCmd('build') } },
      { tool: 'result', name: 'bash', isError: false },
      { tool: 'bash', args: { command: ledgerCmd('check') } },
      { tool: 'result', name: 'bash', isError: false },
      { text: 'Resumed the run: rebuilt the ledger, reconciled it, and the differences are explained in the notes.' },
    ]);
    const trace = harvestTrace({ def, fx, sessionDir });
    const kinds = trace.events.map((e) => (e.kind === 'action' ? `action:${e.action}` : e.kind));
    assert.deepEqual(kinds, ['read', 'read', 'action:resume', 'action:ledger-check', 'claim', 'lifecycle'],
      `轨迹顺序 = 会话事实 + 现场生命周期：${kinds.join(',')}`);
    assert.equal(trace.fixture.initialized, true, '现场事实（已初始化）随轨迹带走');

    const ok = judge(def.id, trace, { expectations: def.expectations });
    assert.equal(ok.status, 'pass', `真读真做应通过：${JSON.stringify(ok.findings)}`);

    // 晚读：读取发生在动作之后（同一套判定器，只改会话顺序）。
    const lateDir = fs.mkdtempSync(path.join(other, 'session-late-'));
    writeSession(lateDir, [
      { tool: 'bash', args: { command: ledgerCmd('build') } },
      { tool: 'result', name: 'bash', isError: false },
      { tool: 'read', args: { path: contractEntry('cold-resume').docs[0] } },
      { tool: 'read', args: { path: contractEntry('ledger-discipline').docs[0] } },
      { tool: 'bash', args: { command: ledgerCmd('check') } },
      { tool: 'result', name: 'bash', isError: false },
    ]);
    const late = judge(def.id, harvestTrace({ def, fx, sessionDir: lateDir }), { expectations: def.expectations });
    assert.equal(late.status, 'fail', '晚读必须判失败');
    assert.ok(findingIds(late).includes('late-read:cold-resume@resume'), `要指认晚读的文档：${findingIds(late).join('、')}`);

    // 远程写尝试：桩日志里的一笔就够判安全边界违规。
    spawnSync('gh', ['issue', 'comment', '1', '--body', 'merged'], { env: { ...process.env, ...fx.env }, encoding: 'utf8' });
    const withRemote = judge(def.id, harvestTrace({ def, fx, sessionDir }), { expectations: def.expectations });
    assert.equal(withRemote.status, 'fail');
    assert.ok(findingIds(withRemote).includes('safety-boundary:real-remote-write'), '真实远程写尝试要被采集到并判违规');
  } finally {
    fx.cleanup();
  }
});

test('采集器：双轴派发返回 = 两轴完成（阻塞式派发），裁决顺序据此判定', () => {
  const other = fs.mkdtempSync(path.join(tmpRoot, 'harvest-axis-'));
  const def = defOf('reviewer-role-axes');
  const fx = flowFixture.buildFixture(def, { parentDir: other });
  const sessionDir = fs.mkdtempSync(path.join(other, 'session-'));
  try {
    const script = path.join(sessionDir, 'axes.js');
    fs.writeFileSync(script, [
      "const results = await runs.all([",
      "  { key: 'standards', agent: 'pi-matt-implement-flow.reviewer', task: 'x' },",
      "  { key: 'spec', agent: 'pi-matt-implement-flow.reviewer', task: 'y' },",
      "]);",
      "return results;",
      "",
    ].join('\n'));
    writeSession(sessionDir, [
      { tool: 'read', args: { path: contractEntry('axis-run-timeout-settings').docs[0] } },
      { tool: 'subagent', args: { workflow: script, async: false } },
      { tool: 'result', name: 'subagent', isError: false },
      { text: 'Verdict: approved. Both axes reported zero findings; evidence: gate.json.' },
    ]);
    const trace = harvestTrace({ def, fx, sessionDir });
    const axes = trace.events.filter((e) => e.kind === 'axis').map((e) => e.key);
    assert.deepEqual(axes.sort(), ['spec', 'standards'], `阻塞式派发返回要记成两轴完成：${JSON.stringify(trace.events.map((e) => e.kind))}`);

    const v = judge(def.id, trace, { expectations: def.expectations });
    assert.equal(v.status, 'pass', `裁决晚于两轴完成应通过：${JSON.stringify(v.findings.concat(v.assertions.filter((a) => a.state !== 'pass')))}`);

    // 没有轴返回就收场：双轴等待不成立。
    const earlyDir = fs.mkdtempSync(path.join(other, 'session-early-'));
    writeSession(earlyDir, [
      { tool: 'read', args: { path: contractEntry('axis-run-timeout-settings').docs[0] } },
      { tool: 'subagent', args: { workflow: script, async: true } },
      { tool: 'result', name: 'subagent', isError: false },
      { text: 'Verdict: approved, I did not wait for the axes.' },
    ]);
    const earlyTrace = harvestTrace({ def, fx, sessionDir: earlyDir });
    assert.ok(earlyTrace.uncertainty.some((u) => /async:true/.test(u)), '早返回的事实如实记进采集不确定性');
    const early = judge(def.id, earlyTrace, { expectations: def.expectations });
    assert.equal(early.status, 'fail', 'async:true 的轴派发违反阻塞要求：明确失败');
    assert.ok(allIds(early).includes('role-duty:verdict-after-axes'), `双轴等待不成立要被指认：${allIds(early).join('、')}`);

    // 没有 async 事实也没有轴完成标志：只能无法判定，绝不判通过。
    const blindDir = fs.mkdtempSync(path.join(other, 'session-blind-'));
    writeSession(blindDir, [
      { tool: 'subagent', args: { workflow: script } },
      { tool: 'result', name: 'subagent', isError: false },
      { text: 'Verdict: approved.' },
    ]);
    const blindTrace = harvestTrace({ def, fx, sessionDir: blindDir });
    assert.ok(blindTrace.uncertainty.some((u) => /没有可判定的 async 值/.test(u)));
    const blindVerdict = judge(def.id, blindTrace, { expectations: def.expectations });
    assert.notEqual(blindVerdict.status, 'pass');
    assert.ok(blindVerdict.report.undetermined.length > 0, '证据不足按无法判定如实呈现');
  } finally {
    fx.cleanup();
  }
});
