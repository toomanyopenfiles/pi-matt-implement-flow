'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEvents,
  buildRunModel,
  extractKeysFromScript,
  findBriefFor,
  deriveRisks,
} = require('./collect');
const { renderAll } = require('./render');

// ---------------------------------------------------------------- fixture 工厂

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixture-'));
  // repo: <tmp>/repo，runtimeDir: <repo>/.pi/matt-implement/demo
  const repo = path.join(dir, 'repo');
  const runtimeDir = path.join(repo, '.pi', 'matt-implement', 'demo');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); // 让 git 事实层感知到（内容为空仓库也不报错）
  fs.mkdirSync(path.join(repo, '.scratch', 'demo', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'spec.md'), '# demo spec\n');
  fs.writeFileSync(
    path.join(repo, '.scratch', 'demo', 'issues', '01-first.md'),
    '# 01: 第一张票\n\n做一件事。\n\n**Blocked by:** None\n',
  );
  fs.writeFileSync(
    path.join(repo, '.scratch', 'demo', 'issues', '02-second.md'),
    '# 02: 第二张票\n\n做另一件事。\n\n**Blocked by:** 01\n',
  );

  const events = [
    { v: 1, seq: 1, ts: '2026-09-18T18:14:54.068Z', head: 'aa0', type: 'init', payload: { branch: 'feat/demo', branchBase: 'main', baselineSha: 'aa0000', spec: '.scratch/demo/spec.md', testCommand: 'npm test', tracker: 'local', reviewer: 'on', maxFixRounds: 2, maxConcurrent: 3 } },
    { v: 1, seq: 2, ts: '2026-09-18T18:20:00.000Z', head: 'aa0', type: 'dispatch', payload: { ticket: '01', key: 't-01', runId: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', worktree: 'true' } },
    { v: 1, seq: 3, ts: '2026-09-18T18:30:00.000Z', head: 'aa0', type: 'settled', payload: { ticket: '01', round: 1, headSha: 'bb1111', worktree: '/tmp/wt-1', gate: 'npm test 5/5' } },
    { v: 1, seq: 4, ts: '2026-09-18T18:35:00.000Z', head: 'aa0', type: 'verdict', payload: { ticket: '01', round: 1, verdict: 'changes_requested', findings: '.pi/matt-implement/demo/findings/01-r1.md', revRunId: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
    { v: 1, seq: 5, ts: '2026-09-18T18:40:00.000Z', head: 'aa0', type: 'fix', payload: { ticket: '01', fixNo: 1, key: 'fix-01-r1', resumeRunId: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', note: '修 P1' } },
    { v: 1, seq: 6, ts: '2026-09-18T18:50:00.000Z', head: 'aa0', type: 'verdict', payload: { ticket: '01', round: 2, verdict: 'approved', findings: '.pi/matt-implement/demo/findings/01-r2.md', revRunId: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
    { v: 1, seq: 7, ts: '2026-09-18T18:55:00.000Z', head: 'aa0', type: 'merge', payload: { ticket: '01', headSha: 'bb1111', mergeSha: 'cc2222', note: 'merge 后全量绿' } },
    { v: 1, seq: 8, ts: '2026-09-18T19:00:00.000Z', head: 'aa0', type: 'dispatch', payload: { ticket: '02', key: 't-02', runId: '33333333-cccc-4ccc-8ccc-cccccccccccc', worktree: 'true' } },
    { v: 1, seq: 9, ts: '2026-09-18T19:10:00.000Z', head: 'aa0', type: 'anomaly', payload: { note: '示例异常：某结构与校验器预期不符' } },
  ];
  fs.writeFileSync(path.join(runtimeDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(runtimeDir, 'notes.md'), '# 编排笔记\n\n维护者拍板：票 02 提前开工。\n');
  fs.mkdirSync(path.join(runtimeDir, 'findings'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'findings', '01-r1.md'), '## P1 — 示例问题\n返回值没有测试。\n');
  fs.mkdirSync(path.join(runtimeDir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'reviews', '01-r1.diff'), 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-old\n+new\n');

  // 主会话（含两段派发脚本：一次 wave、一次 resume）
  const sessionDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${repo.split(path.sep).filter(Boolean).join('-')}--`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const waveScript = `const root = ${JSON.stringify(repo)};
const results = await runs.all([
  { key: 't-01', agent: 'pi-matt-implement-flow.coder', task: 'Ticket 01: 第一张票。Base commit: aa0000. Test command: npm test.', worktree: true },
]);
return results;`;
  const fixScript = `const r = await runs.run('fix-01-r1', { resume: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', task: 'Review round 1 found issues: read findings/01-r1.md. Fix them.' });
return r;`;
  const sessionLines = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '开始实现' }] } },
    { type: 'message', timestamp: '2026-09-18T18:19:59.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'subagent', id: 'tc1', arguments: { workflowScript: waveScript, async: true } }] } },
    { type: 'message', timestamp: '2026-09-18T18:39:59.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'subagent', id: 'tc2', arguments: { workflowScript: fixScript, async: true } }] } },
  ];
  const sessionFile = path.join(sessionDir, '2026-09-18T18-13-00-000Z_demo.jsonl');
  fs.writeFileSync(sessionFile, sessionLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // 平台证据（一个 coder run：验收被拒 → 触发 R2；一个 reviewer run）
  const ad = path.join(sessionDir, 'subagent-artifacts');
  fs.mkdirSync(ad, { recursive: true });
  const coderId = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const revId = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fs.writeFileSync(path.join(ad, `${coderId}_pi-matt-implement-flow.coder_meta.json`), JSON.stringify({
    runId: coderId, agent: 'pi-matt-implement-flow.coder', exitCode: 0, model: 'test/model',
    usage: { input: 1000, output: 100, cost: 0.01 },
    acceptance: {
      status: 'rejected', evidenceStatus: 'missing',
      runtimeChecks: [{ id: 'evidence:validation-output', status: 'failed', message: 'missing' }],
      verifyRuns: [{ id: 'gate', command: 'npm test', status: 'passed', exitCode: 0, durationMs: 100, stdout: '5 pass 0 fail' }],
      childReport: { headSha: 'bb1111', testResult: 'ok' },
    },
  }));
  fs.writeFileSync(path.join(ad, `${coderId}_pi-matt-implement-flow.coder_output.md`), '实现完成。\n');
  const revTranscript = [
    {"type":"message","timestamp":"2026-09-18T18:34:59.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"structured_output","id":"tc3","arguments":{"value":{"verdict":"changes_requested","standards":"ok","spec":"缺测试","findings":[{"severity":"P1","file":"a.js","issue":"无测试"}]}}}]}},
    { type: 'message', timestamp: '2026-09-18T18:35:30.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'subagent', id: 'tc4', arguments: { agent: 'reviewer', task: 'You are a READ-ONLY reviewer child (spec axis).' } }] } },
  ];
  fs.writeFileSync(path.join(ad, `${revId}_pi-matt-implement-flow.reviewer_transcript.jsonl`), revTranscript.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(ad, `${revId}_pi-matt-implement-flow.reviewer_meta.json`), JSON.stringify({ runId: revId, agent: 'pi-matt-implement-flow.reviewer', exitCode: 0, model: 'test/model', usage: { input: 500, output: 50, cost: 0.005 }, acceptance: { status: 'not-required' } }));
  fs.writeFileSync(path.join(ad, `${revId}_pi-matt-implement-flow.reviewer_output.md`), '两轴聚合完成。\n');

  return {
    dir, repo, runtimeDir, sessionDir, ad,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      // 假会话目录写在 ~/.pi/agent/sessions/ 下，必须一并清理，避免污染真实会话数据
      fs.rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- 单元：事件与模型

test('parseEvents 解析并按序号排序，坏行跳过并告警', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ev-'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    JSON.stringify({ v: 1, seq: 2, ts: 't2', type: 'close', payload: {} }),
    'not-json',
    JSON.stringify({ v: 1, seq: 1, ts: 't1', type: 'init', payload: {} }),
  ].join('\n'));
  const warnings = [];
  const events = parseEvents(dir, warnings);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'init');
  assert.equal(events[1].type, 'close');
  assert.ok(warnings.some((w) => w.code === 'event-parse'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildRunModel 重组票状态机并收集运行引用', () => {
  const { run, tickets, runRefs } = buildRunModel([
    { seq: 1, ts: 't', type: 'init', payload: { branch: 'b' } },
    { seq: 2, ts: 't', type: 'dispatch', payload: { ticket: '01', key: 't-01', runId: 'r1', worktree: 'true' } },
    { seq: 3, ts: 't', type: 'fix', payload: { ticket: '01', fixNo: 1, key: 'fix-01-r1', resumeRunId: 'r1' } },
    { seq: 4, ts: 't', type: 'verdict', payload: { ticket: '01', round: 1, verdict: 'approved', revRunId: 'r2' } },
    { seq: 5, ts: 't', type: 'merge', payload: { ticket: '01', headSha: 'h', mergeSha: 'm' } },
    { seq: 6, ts: 't', type: 'close', payload: {} },
  ]);
  assert.equal(run.sealed, true);
  const t = tickets.get('01');
  assert.equal(t.dispatches.length, 1);
  assert.equal(t.fixes.length, 1);
  assert.equal(t.verdicts.length, 1);
  assert.equal(t.merges.length, 1);
  // r1 被 dispatch 与 fix 各引用一次，去重后保留一次
  assert.deepEqual(runRefs.map((r) => r.runId).sort(), ['r1', 'r2']);
  assert.equal(runRefs.find((r) => r.runId === 'r1').role, 'coder');
});

test('extractKeysFromScript 提取 runs.all 的 key 与 runs.run 的 resume key', () => {
  const { keys, resumeKeys } = extractKeysFromScript(`await runs.all([{ key: 't-01', task: 'x' },{ key: 't-02' }]);`);
  assert.deepEqual(keys, ['t-01', 't-02']);
  const r = extractKeysFromScript(`await runs.run('fix-01-r1', { resume: 'x' })`);
  assert.deepEqual(r.resumeKeys, ['fix-01-r1']);
});

test('findBriefFor 按 key + 时间就近匹配', () => {
  const briefs = [
    { ts: '2026-09-18T18:19:59.000Z', keys: ['t-01'], resumeKeys: [], text: 'W1' },
    { ts: '2026-09-18T19:19:59.000Z', keys: ['t-01'], resumeKeys: [], text: 'W2' },
  ];
  assert.equal(findBriefFor(briefs, 't-01', '2026-09-18T18:20:00.000Z').text, 'W1');
  assert.equal(findBriefFor(briefs, 't-01', '2026-09-18T19:20:00.000Z').text, 'W2');
  assert.equal(findBriefFor(briefs, 't-99', '2026-09-18T19:20:00.000Z'), null);
});

// ---------------------------------------------------------------- 端到端（合成 fixture）

test('collect + render 全链路：模型、风险、页面', () => {
  const fx = makeFixture();
  try {
    const { collect } = require('./collect');
    const model = collect({ runtimeDir: fx.runtimeDir });

    // 票与轮次
    assert.equal(model.tickets.length, 2);
    assert.equal(model.tickets[0].title, '第一张票');
    assert.equal(model.tickets[0].verdicts.length, 2);

    // 任务书恢复
    assert.ok(model.briefs.length >= 2, '应从主会话恢复两段脚本');
    const { findBriefFor } = require('./collect');
    const wave = findBriefFor(model.briefs, 't-01', '2026-09-18T18:20:00.000Z');
    assert.ok(wave && wave.text.includes('Ticket 01'), 'wave 任务书应含 brief 原文');
    const fix = findBriefFor(model.briefs, 'fix-01-r1', '2026-09-18T18:40:00.000Z');
    assert.ok(fix && fix.text.includes('fix-01-r1'), 'resume 任务书应按 resume key 匹配');

    // 平台证据
    const coder = model.childRuns['11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
    assert.equal(coder.found, true);
    assert.equal(coder.acceptance.status, 'rejected');
    const rev = model.childRuns['22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    assert.equal(rev.structuredValue.verdict, 'changes_requested');
    assert.equal(rev.nestedDispatches.length, 1, '评审者的轴代理派发应从 transcript 恢复');

    // 确定性风险：验收被拒（high）+ 异常记录（high）+ 未封账（medium）
    const titles = model.risks.map((r) => r.title).join('|');
    assert.ok(titles.includes('验收被拒收'), '应有验收被拒风险');
    assert.ok(titles.includes('异常'), '应有异常记录风险');
    assert.ok(titles.includes('未封账'), '应有未封账风险');
    assert.equal(model.risks[0].severity, 'high');

    // 票 01 第 2 轮的 findings 与 bundle 在 fixture 中故意不存在 → 必须告警且票页占位，不得静默
    assert.ok(model.warnings.some((w) => w.code === 'findings-unreadable'), 'findings 缺失应有 warning');
    assert.ok(model.warnings.some((w) => w.code === 'bundle-unreadable'), 'bundle 缺失应有 warning');

    // 渲染烟测
    const out = path.join(fx.dir, 'report');
    renderAll(model, out, null);
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(index.includes('异常与风险'));
    assert.ok(index.includes('名词表'));
    assert.ok(index.includes('g-verdict'), '术语锚点应存在');
    assert.ok(index.includes('第一张票'));
    assert.ok(index.includes('示例异常'), '异常原文应进首页风险区');
    assert.ok(!index.includes('ai-analysis'), '无 AI 意见文件时不应渲染观点区');
    const ticketPage = fs.readFileSync(path.join(out, 'ticket-01.html'), 'utf8');
    assert.ok(ticketPage.includes('Ticket 01: 第一张票'), '派发任务书原文应内嵌票页');
    assert.ok(ticketPage.includes('5 pass 0 fail'), '门禁输出应展示');
    assert.ok(ticketPage.includes('You are a READ-ONLY reviewer child'), '轴代理派发应展示');
    assert.ok(ticketPage.includes('缺失或不可读'), '第 2 轮 findings/bundle 缺失应渲染占位标注');
    assert.ok(fs.existsSync(path.join(out, 'final.html')));
    assert.ok(fs.existsSync(path.join(out, 'assets', 'style.css')));
  } finally {
    fx.cleanup();
  }
});

test('buildRunModel：无 round 的 fallback 重派发按已耗修复数归入下一轮', () => {
  const { tickets } = buildRunModel([
    { seq: 1, type: 'dispatch', payload: { ticket: '01', key: 't-01', runId: 'r1' } },
    { seq: 2, type: 'fix', payload: { ticket: '01', fixNo: 1, key: 'fix-01-r1', resumeRunId: 'r1' } },
    { seq: 3, type: 'dispatch', payload: { ticket: '01', key: 'fix-01-r1', runId: 'r2' } },
  ]);
  const t = tickets.get('01');
  assert.equal(t.dispatches[0].round, 1);
  assert.equal(t.dispatches[1].round, 2);
});

test('deriveRisks：证据缺失与任务书未恢复降级为 low 且不崩溃', () => {
  const model = {
    run: { init: { maxFixRounds: 2 }, anomalies: [], escalates: [], sealed: false, prs: [] },
    tickets: new Map([['01', { id: '01', dispatches: [{ key: 't-01', ts: 't' }], verdicts: [], fixes: [], merges: [] }]]),
    runRefs: [{ runId: 'ghost', ticket: '01', key: 't-01', role: 'coder' }],
    childRuns: { ghost: { runId: 'ghost', found: false } },
    briefs: [],
  };
  const risks = deriveRisks(model);
  const codes = risks.map((r) => r.title).join('|');
  assert.ok(codes.includes('证据缺失'));
  assert.ok(codes.includes('任务书原文未恢复'));
  assert.ok(codes.includes('未封账'));
});
