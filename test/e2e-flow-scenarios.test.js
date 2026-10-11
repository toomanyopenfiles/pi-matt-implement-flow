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
