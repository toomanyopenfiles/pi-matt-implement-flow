'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collect,
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

// ---------------------------------------------------------------- 终审入流 fixture 工厂

// 终审运行的 runId 常量：事件驱动路径的唯一锚点
const FINAL_RUN_ID = '44444444-dddd-4ddd-8ddd-dddddddddddd';
const FINAL_RUN_ID_2 = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';
// 同项目会话里未被任何 final 事件引用的终审运行（窗口内/窗口外各一，用于分辨两条路径）
const STRAY_IN_WINDOW = '66666666-ffff-4fff-8fff-ffffffffffff';
const STRAY_HISTORIC = '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function writeRunArtifact(ad, runId, agentName, { ts, cost = 0.01, input = 1000, output = 100, structured = null, outputMd = '输出全文。\n' } = {}) {
  fs.writeFileSync(path.join(ad, `${runId}_${agentName}_meta.json`), JSON.stringify({
    runId, agent: agentName, exitCode: 0, model: 'test/model', timestamp: ts,
    usage: { input, output, cost }, acceptance: { status: 'not-required' },
  }));
  fs.writeFileSync(path.join(ad, `${runId}_${agentName}_output.md`), outputMd);
  const lines = structured
    ? [{ type: 'message', timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', name: 'structured_output', id: 'tc1', arguments: { value: structured } }] } }]
    : [];
  fs.writeFileSync(path.join(ad, `${runId}_${agentName}_transcript.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// 终审入流 fixture：事件流（可含 final 事件）+ 伪造平台证据目录。
// finals: [{runId, verdict, findings?}] 按入账顺序写入 final 事件；
// stray: [{runId, ts, verdict?, cost?}] 只存在于平台证据目录、不被任何事件引用。
function makeFinalFixture({ finals = [], deadFinals = [], stray = [], findingsFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-final-'));
  const repo = path.join(dir, 'repo');
  const runtimeDir = path.join(repo, '.pi', 'matt-implement', 'demo');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.scratch', 'demo', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'spec.md'), '# demo spec\n');
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'issues', '01-first.md'), '# 01: 第一张票\n\n做一件事。\n');
  for (const [rel, text] of Object.entries(findingsFiles)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }

  const events = [
    { v: 2, seq: 1, ts: '2026-09-18T18:00:00.000Z', head: 'aa0', type: 'init', payload: { branch: 'feat/demo', branchBase: 'main', baselineSha: 'aa0000', spec: '.scratch/demo/spec.md', testCommand: 'npm test', tracker: 'local', reviewer: 'on', maxFixRounds: 2, maxConcurrent: 3 } },
    { v: 2, seq: 2, ts: '2026-09-18T18:10:00.000Z', head: 'aa0', type: 'dispatch', payload: { ticket: '01', key: 't-01', runId: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', worktree: 'true' } },
    { v: 2, seq: 3, ts: '2026-09-18T18:20:00.000Z', head: 'aa0', type: 'settled', payload: { ticket: '01', round: 1, headSha: 'bb1111', gate: 'npm test 5/5' } },
    { v: 2, seq: 4, ts: '2026-09-18T18:25:00.000Z', head: 'aa0', type: 'verdict', payload: { ticket: '01', round: 1, verdict: 'approved', revRunId: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
    { v: 2, seq: 5, ts: '2026-09-18T18:30:00.000Z', head: 'aa0', type: 'merge', payload: { ticket: '01', headSha: 'bb1111', mergeSha: 'cc2222' } },
  ];
  finals.forEach((f, i) => {
    events.push({
      v: 2, seq: events.length + 1, ts: `2026-09-18T18:4${i}:00.000Z`, head: 'aa0', type: 'final',
      payload: { finalVerdict: f.verdict, runId: f.runId, ...(f.findings ? { findings: f.findings } : {}) },
    });
  });
  // 死 runId 的 final 事件（记账污染形态）：事件照旧入流，平台侧不存在任何可探测的证据
  deadFinals.forEach((f, i) => {
    events.push({
      v: 2, seq: events.length + 1, ts: `2026-09-18T18:5${i}:00.000Z`, head: 'aa0', type: 'final',
      payload: { finalVerdict: f.verdict, runId: f.runId, ...(f.findings ? { findings: f.findings } : {}) },
    });
  });
  events.push({ v: 2, seq: events.length + 1, ts: '2026-09-18T19:00:00.000Z', head: 'aa0', type: 'close', payload: { note: '运行终结。' } });
  fs.writeFileSync(path.join(runtimeDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const sessionDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${repo.split(path.sep).filter(Boolean).join('-')}--`);
  const ad = path.join(sessionDir, 'subagent-artifacts');
  fs.mkdirSync(ad, { recursive: true });
  writeRunArtifact(ad, '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pi-matt-implement-flow.coder', { ts: Date.parse('2026-09-18T18:15:00.000Z'), cost: 0.05 });
  writeRunArtifact(ad, '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'pi-matt-implement-flow.reviewer', { ts: Date.parse('2026-09-18T18:24:00.000Z'), cost: 0.03, structured: { verdict: 'approved' } });
  finals.forEach((f, i) => {
    writeRunArtifact(ad, f.runId, 'pi-matt-implement-flow.final-reviewer', {
      ts: Date.parse(`2026-09-18T18:4${i}:30.000Z`), cost: 0.02, input: 800, output: 80,
      structured: { verdict: f.verdict, standards: 'ok', spec: 'ok' }, outputMd: '终审报告全文。\n',
    });
  });
  for (const s of stray) {
    writeRunArtifact(ad, s.runId, 'pi-matt-implement-flow.final-reviewer', {
      ts: Date.parse(s.ts), cost: s.cost == null ? 0.5 : s.cost,
      structured: { verdict: s.verdict || 'ready_with_fixes' },
    });
  }

  return {
    dir, repo, runtimeDir, sessionDir, ad,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
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

// ---------------------------------------------------------------- 终审入流：事件驱动优先 + 旧账降级

test('collect：含 final 事件的账走事件驱动路径——终审进成本表、清单与裁决来自事件、不触发目录扫描', () => {
  const fx = makeFinalFixture({
    finals: [
      { runId: FINAL_RUN_ID, verdict: 'ready_with_fixes', findings: '.pi/matt-implement/demo/findings/final-r1.md' },
      { runId: FINAL_RUN_ID_2, verdict: 'ready', findings: '.pi/matt-implement/demo/findings/final-r2.md' },
    ],
    // 窗口内但不被任何 final 事件引用的终审运行：扫描路径会收，事件驱动路径不得收
    stray: [{ runId: STRAY_IN_WINDOW, ts: '2026-09-18T18:35:00.000Z', cost: 9 }],
    findingsFiles: { '.pi/matt-implement/demo/findings/final-r1.md': '## P1 — 终审发现\n跨票漂移。\n' },
  });
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    assert.equal(model.finalReviewSource, 'event', '有 final 事件即走事件驱动路径');
    assert.equal(model.finalReviews.length, 2, '终审清单 = final 事件数');
    assert.deepEqual(model.finalReviews.map((f) => f.runId), [FINAL_RUN_ID, FINAL_RUN_ID_2], '终审运行 ID 取自事件');
    assert.deepEqual(model.finalReviews.map((f) => f.verdict), ['ready_with_fixes', 'ready'], '裁决取自事件');
    assert.ok(model.finalReviews.every((f) => f.found), '事件引用的 runId 直接定位平台证据');
    assert.ok(!model.finalReviews.some((f) => f.runId === STRAY_IN_WINDOW), '不扫目录：未被事件引用的终审不得混入');
    assert.ok(!model.warnings.some((w) => w.code === 'run-evidence-missing' && w.detail.includes(FINAL_RUN_ID)), '被引用的终审证据齐备时不得报证据缺失');

    // 成本表：终审桶（角色「终审」）+ 成本/用量计入总计
    const bucket = model.stats.byRole['final-reviewer'];
    assert.ok(bucket, '终审进成本表');
    assert.equal(bucket.runs, 2);
    assert.ok(Math.abs(bucket.cost - 0.04) < 1e-9, `终审桶成本应为 0.04，得到 ${bucket.cost}`);
    assert.equal(bucket.tokens, 2 * 880);
    assert.ok(Math.abs(model.stats.totalCost - 0.12) < 1e-9, `总计应含终审成本（0.05+0.03+0.04），得到 ${model.stats.totalCost}`);
    assert.equal(model.stats.finalReviews, 2);

    // findings 原文按路径收录；不可读的路径标警告而非崩溃
    assert.match(model.findingsFiles['.pi/matt-implement/demo/findings/final-r1.md'].text, /跨票漂移/);
    assert.ok(
      model.warnings.some((w) => w.code === 'findings-unreadable' && /终审/.test(w.detail)),
      '终审 findings 缺失应警告',
    );

    // 封账时最新终审为 ready（非 not_ready）→ 不产出带伤封账风险项
    assert.ok(!model.risks.some((r) => /not_ready/.test(r.title)));

    // 渲染：终审页展示事件裁决与 findings 原文（缺失则占位）
    const out = path.join(fx.dir, 'report');
    renderAll(model, out, null);
    const finalPage = fs.readFileSync(path.join(out, 'final.html'), 'utf8');
    assert.ok(finalPage.includes('可交付但需修'), '终审裁决渲染进报告');
    assert.ok(finalPage.includes('跨票漂移'), '终审 findings 原文收录进报告');
    assert.ok(finalPage.includes('缺失或不可读'), '不可读的 findings 渲染占位');
    assert.ok(fs.readFileSync(path.join(out, 'index.html'), 'utf8').includes('终审'), '成本表含终审桶');
  } finally {
    fx.cleanup();
  }
});

test('collect：final 事件上是死 runId（非 UUID 形状）→ 不探测平台证据，只留 run-ref-dead 告警（无矛盾的证据缺失告警）', () => {
  // 记账污染形态（真实事故：shell 变量被写进 --run-id）：final 事件照旧入流，runId 不是 UUID
  const DEAD_FINAL_RUN_ID = 'demo-polluted-final-runid';
  const fx = makeFinalFixture({ deadFinals: [{ runId: DEAD_FINAL_RUN_ID, verdict: 'ready' }] });
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    // 事件级事实不删：终审条目保留、裁决仍取自事件（只是没有可核验的平台证据）
    const entry = model.finalReviews.find((f) => f.runId === DEAD_FINAL_RUN_ID);
    assert.ok(entry, 'final 事件仍进终审清单（裁决权威在事件流）');
    assert.equal(entry.verdict, 'ready');
    assert.equal(entry.found, false);
    assert.equal(entry.deadRunRef, true, '死数据引用显式标注，供报告区分');
    // 与 runRefs 同一分流：死留痕、不探测、不产出互相矛盾的告警
    assert.ok(model.deadRunRefs.some((r) => r.runId === DEAD_FINAL_RUN_ID), '死 runRef 单独留痕');
    assert.ok(model.warnings.some((w) => w.code === 'run-ref-dead' && w.detail.includes(DEAD_FINAL_RUN_ID)), '死数据以告警留痕');
    assert.ok(!model.warnings.some((w) => w.code === 'run-evidence-missing' && w.detail.includes(DEAD_FINAL_RUN_ID)), '不探测平台证据：无证据缺失告警');
    // 终审页对死数据条目给出缘由，裁决照旧展示
    const out = path.join(fx.dir, 'report');
    renderAll(model, out, null);
    const finalPage = fs.readFileSync(path.join(out, 'final.html'), 'utf8');
    assert.ok(finalPage.includes('可交付'), '裁决照旧渲染');
    assert.ok(finalPage.includes('记账污染'), '终审页标注死数据缘由（不探测平台证据）');
  } finally {
    fx.cleanup();
  }
});

test('collect：无 final 事件的旧账整体降级为目录扫描 + 时间窗过滤（行为与现状一致，不双计）', () => {
  const fx = makeFinalFixture({
    finals: [],
    stray: [
      { runId: STRAY_IN_WINDOW, ts: '2026-09-18T18:35:00.000Z', verdict: 'ready_with_fixes', cost: 0.14 },
      { runId: STRAY_HISTORIC, ts: '2026-09-01T10:00:00.000Z', verdict: 'not_ready', cost: 0.99 },
    ],
  });
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    assert.equal(model.finalReviewSource, 'scan', '无 final 事件即降级为目录扫描');
    assert.deepEqual(model.finalReviews.map((f) => f.runId), [STRAY_IN_WINDOW], '时间窗过滤仍在：历史终审不得混入');
    assert.equal(model.finalReviews[0].verdict, 'ready_with_fixes', '降级路径裁决仍取自终审运行的结构化输出');
    assert.equal(model.stats.finalReviews, 1);
    assert.equal(model.stats.byRole['final-reviewer'], undefined, '降级路径终审不进成本表（与现状一致，不与事件路径双计）');
    assert.ok(!model.risks.some((r) => /not_ready/.test(r.title)), '风险项以 final 事件为准，不采信扫描结果');
  } finally {
    fx.cleanup();
  }
});

test('collect：封账时最新终审为 not_ready → 一条 medium 风险项；后续裁决覆盖即消失', () => {
  const fx = makeFinalFixture({
    finals: [{ runId: FINAL_RUN_ID, verdict: 'ready' }, { runId: FINAL_RUN_ID_2, verdict: 'not_ready' }],
  });
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    const risk = model.risks.find((r) => r.title.includes('not_ready'));
    assert.ok(risk, '封账时最新终审 not_ready 应产出风险项');
    assert.equal(risk.severity, 'medium');
    assert.ok(risk.evidence.some((e) => String(e.ref).includes('seq')), '风险项可回溯到 final 事件序号');
    // 未封账的运行不产出该风险项（未封账另有风险项）
    assert.ok(!deriveRisks({ ...model, run: { ...model.run, sealed: false } }).some((r) => r.title.includes('not_ready')));
  } finally {
    fx.cleanup();
  }

  const fx2 = makeFinalFixture({
    finals: [{ runId: FINAL_RUN_ID, verdict: 'not_ready' }, { runId: FINAL_RUN_ID_2, verdict: 'ready' }],
  });
  try {
    const model2 = collect({ runtimeDir: fx2.runtimeDir });
    assert.ok(!model2.risks.some((r) => r.title.includes('not_ready')), '一律以最新裁决为准：后续 ready 覆盖 not_ready');
  } finally {
    fx2.cleanup();
  }
});

test('deriveRisks：证据缺失与任务书未恢复降级为 low 且不崩溃', () => {
  // 运行 ID 必须是 UUID 形状：非 UUID 形状的 runRef 是记账污染的死数据（另有用例覆盖），
  // 本用例要考的是「活运行但平台证据缺失」这条路径。
  const ghostRunId = '99999999-9999-4999-8999-999999999999';
  const model = {
    run: { init: { maxFixRounds: 2 }, anomalies: [], escalates: [], sealed: false, prs: [] },
    tickets: new Map([['01', { id: '01', dispatches: [{ key: 't-01', ts: 't', runId: ghostRunId }], verdicts: [], fixes: [], merges: [] }]]),
    runRefs: [{ runId: ghostRunId, ticket: '01', key: 't-01', role: 'coder' }],
    childRuns: { [ghostRunId]: { runId: ghostRunId, found: false } },
    briefs: [],
  };
  const risks = deriveRisks(model);
  const codes = risks.map((r) => r.title).join('|');
  assert.ok(codes.includes('证据缺失'));
  assert.ok(codes.includes('任务书原文未恢复'));
  assert.ok(codes.includes('未封账'));
  // 未被补正的普通缺失不带补正标注（零变化）：补正标注只在 anomaly 指向它时出现
  assert.ok(!risks.some((r) => r.title.includes('已被补正')));
});

// ---------------------------------------------------------------- 审计严密度（票 02）：已恢复降级 + 死 runRef 机判

// 运行 ID 常量：被拒/失败的运行（平台证据带 acceptance 拒收或非零退出码）、补正后的运行、污染 runId
const REJECTED_RUN_ID = 'a1a1a1a1-1111-4111-8111-111111111111';
const FAILED_RUN_ID = 'a3a3a3a3-3333-4333-8333-333333333333';
const REVIEW_RUN_ID = 'a4a4a4a4-4444-4444-8444-444444444444';
const CORRECTED_RUN_ID = 'b2b2b2b2-2222-4222-8222-222222222222';
const REVIEW2_RUN_ID = 'b3b3b3b3-3333-4333-8333-333333333333';
// 记账污染的死数据：真实事故里 shell 变量被写进 --run-id，runId 成了包名（非 UUID 形状）
const DEAD_RUN_ID = 'demo-broken-runid';

// 审计严密度 fixture：事件流 + 平台证据 + 主会话。
//   recovery=false      → 拒收后无同票后续结算（未恢复用例）
//   doubleRejection=true → 票 01 先拒收、再失败（两次事故）、最后一次被后续成功 settle 恢复
// 票 02 恒有一条污染 runId 的 dispatch + 一条补正后的 dispatch（死 runRef 机判用例）。
function makeHardeningFixture({ recovery = true, doubleRejection = false, absoluteSpec = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-hardening-'));
  const repo = path.join(dir, 'repo');
  const runtimeDir = path.join(repo, '.pi', 'matt-implement', 'demo');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.scratch', 'demo', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'spec.md'), '# demo spec\n');
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'issues', '01-first.md'), '# 01: 第一张票\n\n做一件事。\n');
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'issues', '02-second.md'), '# 02: 第二张票\n\n做另一件事。\n');

  const base = Date.parse('2026-09-18T18:00:00.000Z');
  const events = [];
  const push = (type, payload) => {
    events.push({ v: 2, seq: events.length + 1, ts: new Date(base + events.length * 60000).toISOString(), head: 'aa0', type, payload });
    return events.length; // 返回该事件的序号，供断言引用
  };

  push('init', { branch: 'feat/demo', branchBase: 'main', baselineSha: 'aa0000', spec: absoluteSpec ? path.join(repo, '.scratch', 'demo', 'spec.md') : '.scratch/demo/spec.md', testCommand: 'npm test', tracker: 'local', reviewer: 'on', maxFixRounds: 2, maxConcurrent: 3 });
  const seqs = {};
  seqs.rejected = push('dispatch', { ticket: '01', key: 't-01', runId: REJECTED_RUN_ID, worktree: '/tmp/wt-a' });
  if (doubleRejection) seqs.failed = push('dispatch', { ticket: '01', key: 't-01-fresh', runId: FAILED_RUN_ID, worktree: '/tmp/wt-b' });
  if (recovery) {
    push('fix', { ticket: '01', fixNo: 1, key: 'fix-01-r1', resumeRunId: doubleRejection ? FAILED_RUN_ID : REJECTED_RUN_ID, note: '补全验收报告字段后重报' });
    seqs.settle = push('settled', { ticket: '01', round: 2, headSha: 'dd3333', worktree: '/tmp/wt-a', gate: 'npm test 5 pass / 0 fail' });
    push('verdict', { ticket: '01', round: 2, verdict: 'approved', revRunId: REVIEW_RUN_ID, note: '补正后零 findings' });
    push('merge', { ticket: '01', headSha: 'dd3333', mergeSha: 'ee4444', note: '合并后全量绿' });
  }
  seqs.dead = push('dispatch', { ticket: '02', key: 't-02', runId: DEAD_RUN_ID, worktree: '/tmp/wt-c' }); // 污染记账：死数据
  push('dispatch', { ticket: '02', key: 't-02-corrected', runId: CORRECTED_RUN_ID, worktree: '/tmp/wt-c', note: '修正污染记录的 runId' });
  push('settled', { ticket: '02', round: 1, headSha: 'ff5555', worktree: '/tmp/wt-c', gate: 'npm test 6 pass / 0 fail' });
  push('verdict', { ticket: '02', round: 1, verdict: 'approved', revRunId: REVIEW2_RUN_ID, note: '零 findings' });
  push('merge', { ticket: '02', headSha: 'ff5555', mergeSha: 'aa6666', note: '合并后全量绿' });
  push('close', { note: '两票闭环。' });
  fs.writeFileSync(path.join(runtimeDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // 主会话：一波派发脚本（key 里只有 t-01 与补正后的 t-02-corrected——污染记录 key t-02 不在其中）+ 一次 resume
  const sessionDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${repo.split(path.sep).filter(Boolean).join('-')}--`);
  const ad = path.join(sessionDir, 'subagent-artifacts');
  fs.mkdirSync(ad, { recursive: true });
  const waveScript = `const root = ${JSON.stringify(repo)};
const results = await runs.all([
  { key: 't-01', agent: 'pi-matt-implement-flow.coder', task: 'Ticket 01: 第一张票。Base commit: aa0000. Test command: npm test.', worktree: true },
  { key: 't-02-corrected', agent: 'pi-matt-implement-flow.coder', task: 'Ticket 02: 第二张票。Base commit: aa0000. Test command: npm test.', worktree: true },
]);
return results;`;
  const resumeScript = `const r = await runs.run('fix-01-r1', { resume: '${doubleRejection ? FAILED_RUN_ID : REJECTED_RUN_ID}', task: '验收报告缺字段：补齐后重报。' });`;
  const sessionFile = path.join(sessionDir, '2026-09-18T17-59-00-000Z_demo.jsonl');
  fs.writeFileSync(sessionFile, [
    { type: 'message', timestamp: '2026-09-18T17:59:59.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'subagent', id: 'tc1', arguments: { workflowScript: waveScript, async: true } }] } },
    { type: 'message', timestamp: '2026-09-18T18:05:59.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'subagent', id: 'tc2', arguments: { workflowScript: resumeScript, async: true } }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  // 平台证据：被拒的运行（acceptance rejected）/ 失败的运行（退出码 1）/ 补正后的运行（验收通过）
  const writeCoder = (runId, acceptance, exitCode = 0) => {
    fs.writeFileSync(path.join(ad, `${runId}_pi-matt-implement-flow.coder_meta.json`), JSON.stringify({
      runId, agent: 'pi-matt-implement-flow.coder', exitCode, model: 'test/model', usage: { input: 1000, output: 100, cost: 0.01 },
      ...(acceptance ? { acceptance } : {}),
    }));
    fs.writeFileSync(path.join(ad, `${runId}_pi-matt-implement-flow.coder_output.md`), '实现完成。\n');
  };
  const writeReviewer = (runId, verdict) => {
    fs.writeFileSync(path.join(ad, `${runId}_pi-matt-implement-flow.reviewer_meta.json`), JSON.stringify({
      runId, agent: 'pi-matt-implement-flow.reviewer', exitCode: 0, model: 'test/model', usage: { input: 500, output: 50, cost: 0.005 }, acceptance: { status: 'not-required' },
    }));
    fs.writeFileSync(path.join(ad, `${runId}_pi-matt-implement-flow.reviewer_output.md`), '两轴聚合完成。\n');
    fs.writeFileSync(path.join(ad, `${runId}_pi-matt-implement-flow.reviewer_transcript.jsonl`),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'structured_output', arguments: { value: { verdict } } }] } }) + '\n');
  };
  writeCoder(REJECTED_RUN_ID, {
    status: 'rejected', evidenceStatus: 'missing',
    runtimeChecks: [{ id: 'evidence:residual-risks', status: 'failed', message: 'missing' }],
    verifyRuns: [{ id: 'gate', command: 'npm test', status: 'passed', exitCode: 0, durationMs: 100, stdout: '5 pass 0 fail' }],
    childReport: { headSha: 'dd3333' },
  });
  if (doubleRejection) writeCoder(FAILED_RUN_ID, null, 1);
  writeCoder(CORRECTED_RUN_ID, { status: 'passed', evidenceStatus: 'complete' });
  writeReviewer(REVIEW_RUN_ID, 'approved');
  writeReviewer(REVIEW2_RUN_ID, 'approved');

  return {
    dir, repo, runtimeDir, sessionDir, ad, seqs,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

test('collect：拒收的运行同票后续成功 settle → 降 medium 标「后续运行已恢复」并附恢复运行引用', () => {
  const fx = makeHardeningFixture();
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    const risk = model.risks.find((r) => r.title.includes('验收被拒收'));
    assert.ok(risk, '被拒收的运行应产出风险项');
    assert.equal(risk.severity, 'medium', '同票后续有成功 settle：降为 medium（不删除风险本体）');
    assert.ok(risk.title.includes('后续运行已恢复'), '标题标注「后续运行已恢复」');
    assert.ok(risk.detail.includes('后续运行已恢复'), 'detail 说明降级依据（哪个后续运行恢复了它）');
    assert.ok(risk.title.includes(`（rejected）`), '风险本体文案保留：标签不替换事实');
    assert.ok(risk.evidence.some((e) => e.label === '恢复运行' && e.ref === REJECTED_RUN_ID), 'evidence 附恢复运行 runRef（resume 复用同一运行）');
    assert.ok(risk.evidence.some((e) => e.ref === `seq ${fx.seqs.settle}`), 'evidence 附恢复结算事件序号');
  } finally {
    fx.cleanup();
  }
});

test('collect：拒收后同票无后续成功 settle → 维持 high 原样（零行为变化）', () => {
  const fx = makeHardeningFixture({ recovery: false });
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    const risk = model.risks.find((r) => r.title.includes('验收被拒收'));
    assert.ok(risk, '被拒收的运行仍应产出风险项');
    assert.equal(risk.severity, 'high', '从未恢复：维持 high');
    assert.ok(!risk.title.includes('后续运行已恢复'), '不得标注「已恢复」');
    assert.ok(!/恢复/.test(risk.detail), 'detail 不得出现恢复叙述');
    assert.ok(!risk.evidence.some((e) => e.label === '恢复运行' || e.label === '恢复结算'), '不得附恢复引用');
    assert.ok(risk.evidence.some((e) => e.label === '运行' && e.ref === REJECTED_RUN_ID), '原有运行引用不变');
  } finally {
    fx.cleanup();
  }
});

test('collect：非 UUID 形状 runId 的 runRef 是死数据——不探测平台证据、不产出证据缺失类风险', () => {
  const fx = makeHardeningFixture();
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    assert.ok(!model.runRefs.some((r) => r.runId === DEAD_RUN_ID), '死 runRef 不进运行清单（不当作一次运行）');
    assert.deepEqual(model.deadRunRefs.map((r) => r.runId), [DEAD_RUN_ID], '死 runRef 单独留痕，供人核对');
    assert.ok(!model.childRuns[DEAD_RUN_ID], '不为其探测平台证据（childRuns 无该键）');
    assert.ok(model.warnings.some((w) => w.code === 'run-ref-dead' && w.detail.includes(DEAD_RUN_ID)), '死数据以告警留痕而非静默');
    assert.ok(!model.warnings.some((w) => w.code === 'run-evidence-missing' && w.detail.includes(DEAD_RUN_ID)), '不产出「平台证据缺失」告警');
    assert.ok(!model.risks.some((r) => r.title.includes('证据缺失')), '不参与证据缺失类风险推导');
    assert.ok(!model.risks.some((r) => r.title.includes('任务书原文未恢复')), '污染派发不产出衍生风险');
    assert.ok(!JSON.stringify(model.risks).includes(DEAD_RUN_ID), '风险清单里零死 runRef 痕迹');
    // 补正后的同一票运行照常取证（不因同票有死数据而放弃探测）
    assert.equal(model.childRuns[CORRECTED_RUN_ID].found, true, '补正运行照常探测平台证据');
    assert.equal(model.runRefs.filter((r) => r.ticket === '02' && r.role === 'coder').length, 1, '票 02 的活实现者运行只剩补正后那次');
  } finally {
    fx.cleanup();
  }
});

test('collect：拒绝→失败→成功不被一次成功抹平——只有各自有后续恢复的那次降 medium', () => {
  const fx = makeHardeningFixture({ doubleRejection: true });
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    const rejected = model.risks.find((r) => r.title.includes('验收被拒收'));
    const failed = model.risks.find((r) => r.title.includes('以失败告终'));
    assert.ok(rejected && failed, '两次事故各自产出风险项（风险本体一条都不删）');
    assert.equal(rejected.severity, 'high', '前一次拒收之后同票又出事故：它未被恢复，维持 high');
    assert.ok(!rejected.title.includes('后续运行已恢复'), '前一次事故不得被后续那一次成功豁免');
    assert.equal(failed.severity, 'medium', '后一次失败之后同票成功 settle：降 medium');
    assert.ok(failed.title.includes('后续运行已恢复'), '后一次事故标注「后续运行已恢复」');
    assert.ok(failed.evidence.some((e) => e.label === '恢复运行' && e.ref === FAILED_RUN_ID), '恢复引用指向被 resume 的那次运行');
    assert.ok(rejected.evidence.some((e) => e.label === '运行' && e.ref === REJECTED_RUN_ID), '前一次事故仍指向自己的运行');
  } finally {
    fx.cleanup();
  }
});

test('deriveRisks：装置未分流时死 runRef 走同一分流函数剔除（单一分流实现）', () => {
  // 直接调用 deriveRisks 的装置可能没经过 collect 的顶层分流：兜底必须复用同一实现，
  // 而不是在推导里各写一份 filter(isUuidRunId)。
  const model = {
    run: { init: { maxFixRounds: 2 }, anomalies: [], escalates: [], sealed: true, prs: [] },
    tickets: new Map(),
    runRefs: [{ runId: DEAD_RUN_ID, ticket: '02', key: 't-02', role: 'coder' }],
    childRuns: {},
    briefs: [],
  };
  assert.ok(
    !deriveRisks(model).some((r) => r.title.includes('证据缺失')),
    '死 runRef 不参与证据缺失类推导（与 collect 顶层分流同一规则）',
  );
});

test('collect + render：fixture 账首页风险区——恢复类风险 medium 带引用，死 runRef 零衍生风险', () => {
  const fx = makeHardeningFixture();
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    const out = path.join(fx.dir, 'report');
    renderAll(model, out, null);
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const riskSection = index.split('<section class="section" id="risks">')[1].split('</section>')[0];
    assert.ok(riskSection.includes('后续运行已恢复'), '首页风险区标出「抖动」：恢复类风险带已恢复标注');
    assert.ok(riskSection.includes('risk-medium') && riskSection.includes('pill medium'), '恢复类风险以 medium 分级渲染');
    assert.ok(riskSection.includes(REJECTED_RUN_ID), '恢复运行引用进首页（可一键跳到恢复现场）');
    assert.ok(!riskSection.includes(DEAD_RUN_ID), '首页风险区不得出现死 runRef 衍生风险');
    assert.ok(!riskSection.includes('证据缺失'), '首页风险区无证据缺失类风险');
    assert.ok(index.includes(DEAD_RUN_ID.slice(0, 8)), '时间线仍如实渲染污染 dispatch 事件（事件级事实不删）');
  } finally {
    fx.cleanup();
  }
});

test('collect：init spec 记成绝对主仓库路径 → 票文件照常加载，不再产出 ticket-file-missing', () => {
  const fx = makeHardeningFixture({ absoluteSpec: true });
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    const first = (model.tickets || []).find((t) => t.id === '01');
    assert.ok(first && first.file && first.title && first.body, '绝对 spec 路径下票文件、标题、票面照常加载');
    assert.match(first.title, /第一张票/, '票标题解析不受路径形态影响');
    assert.ok(!model.warnings.some((w) => w.code === 'ticket-file-missing'), '不再产生 ticket-file-missing 警告');
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------- 票 03：anomaly refSeq 补正链（R3 降级）

// 被污染的 dispatch 及其同票补正记录（形状取自真实旧账 final-verdict-event seq 15/16/17）
const POLLUTED_DISPATCH = { v: 2, seq: 2, ts: 't2', head: 'aa0', type: 'dispatch', payload: { ticket: '03', key: 't-03', runId: 'pi-matt-implement-flow' } };
const POLLUTION_ANOMALY = { v: 3, seq: 3, ts: 't3', head: 'aa0', type: 'anomaly', payload: { note: 'seq=2 的 dispatch 字段被 shell 污染', refSeq: 2 } };
const CORRECTED_DISPATCH = { v: 3, seq: 4, ts: 't4', head: 'aa0', type: 'dispatch', payload: { ticket: '03', key: 't-03-corrected', runId: 'b56132cd-3267-4027-a963-c3ea19b49461' } };

// deriveRisks 的最小模型装置：R3 只看 run.anomalies + events，其余推导喂空装置
function risksFor(events) {
  const { run } = buildRunModel(events);
  return deriveRisks({ run, events, tickets: new Map(), runRefs: [], childRuns: {}, briefs: [] });
}

test('deriveRisks R3：anomaly 带 refSeq 且被指向事件同票后续有补正记录 → 降 medium 标「已补正」', () => {
  const risks = risksFor([POLLUTED_DISPATCH, POLLUTION_ANOMALY, CORRECTED_DISPATCH]);
  const risk = risks.find((r) => r.title.includes('异常'));
  assert.ok(risk, '异常留痕不删除：风险项照旧产出');
  assert.equal(risk.severity, 'medium', '补正在案 → 降 medium（工作确实被打断过，不消项）');
  assert.match(risk.title, /已补正/);
  assert.match(risk.detail, /seq 4/, '降级依据必须给出补正记录的事件序号');
  assert.ok(risk.evidence.some((e) => String(e.ref).includes('seq 3')), '仍可回跳异常事件本身');
  assert.ok(risk.evidence.some((e) => String(e.ref).includes('seq 4')), '可回跳补正记录');
});

test('deriveRisks R3：无 refSeq / 补正缺失 / 指向别的票 / 悬空 refSeq → 一律维持 high 原样', () => {
  const cases = {
    '无 refSeq（散文时代形态）': [POLLUTED_DISPATCH, { ...POLLUTION_ANOMALY, payload: { note: '散文异常，无链接' } }],
    '被指向事件同票后续无补正记录': [POLLUTED_DISPATCH, POLLUTION_ANOMALY, { v: 3, seq: 4, ts: 't4', head: 'aa0', type: 'pr', payload: { state: 'ready' } }],
    '后续同类型记录属于别的票': [POLLUTED_DISPATCH, POLLUTION_ANOMALY, { v: 3, seq: 4, ts: 't4', head: 'aa0', type: 'dispatch', payload: { ticket: '04', key: 't-04', runId: 'r4' } }],
    'refSeq 悬空（指向不存在的事件）': [POLLUTED_DISPATCH, { ...POLLUTION_ANOMALY, payload: { note: '指向洞里', refSeq: 99 } }],
  };
  for (const [name, events] of Object.entries(cases)) {
    const risk = risksFor(events).find((r) => r.title.includes('异常'));
    assert.equal(risk.severity, 'high', `${name}：未补正即维持 high`);
    assert.doesNotMatch(risk.title, /已补正/, name);
  }
});

// ---------------------------------------------------------------- 票 03 × 票 02：衍生风险与补正链共存

// UUID 形状却错值（复制粘贴污染）：形状合法 → 死 runRef 机判（票 02）覆盖不到它，
// 「平台证据缺失」衍生风险存活；anomaly 的 refSeq 指向它 → 必须在报告里标注「已被补正」
// （spec 用户故事 5；Implementation Decisions「审计消费 refSeq」）。
const WRONG_UUID_RUN_ID = 'c1c1c1c1-1111-4111-8111-111111111111';
const UUID_POLLUTION_CORRECTED_RUN_ID = 'd2d2d2d2-2222-4222-8222-222222222222';

function makeUuidPollutionFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-uuid-pollution-'));
  const repo = path.join(dir, 'repo');
  const runtimeDir = path.join(repo, '.pi', 'matt-implement', 'demo');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.scratch', 'demo', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'spec.md'), '# demo spec\n');
  fs.writeFileSync(path.join(repo, '.scratch', 'demo', 'issues', '03-third.md'), '# 03: 第三张票\n\n做第三件事。\n');

  const events = [
    { v: 3, seq: 1, ts: '2026-09-18T18:00:00.000Z', head: 'aa0', type: 'init', payload: { branch: 'feat/demo', branchBase: 'main', baselineSha: 'aa0000', spec: '.scratch/demo/spec.md', testCommand: 'npm test', tracker: 'local' } },
    { v: 3, seq: 2, ts: '2026-09-18T18:02:00.000Z', head: 'aa0', type: 'dispatch', payload: { ticket: '03', key: 't-03', runId: WRONG_UUID_RUN_ID, worktree: '/tmp/wt-a' } },
    // 真实写点形态：refSeq 按旗标原文入账（字符串），审计侧经单一转换点归一
    { v: 3, seq: 3, ts: '2026-09-18T18:03:00.000Z', head: 'aa0', type: 'anomaly', payload: { note: 'seq=2 的 dispatch runId 复制粘贴错值；下一条 dispatch 为修正记录', refSeq: '2' } },
    { v: 3, seq: 4, ts: '2026-09-18T18:04:00.000Z', head: 'aa0', type: 'dispatch', payload: { ticket: '03', key: 't-03-corrected', runId: UUID_POLLUTION_CORRECTED_RUN_ID, worktree: '/tmp/wt-a', note: '修正污染记录的 runId' } },
    { v: 3, seq: 5, ts: '2026-09-18T18:05:00.000Z', head: 'aa0', type: 'settled', payload: { ticket: '03', round: 1, headSha: 'ff5555', gate: 'npm test 6 pass / 0 fail' } },
    { v: 3, seq: 6, ts: '2026-09-18T18:06:00.000Z', head: 'aa0', type: 'merge', payload: { ticket: '03', headSha: 'ff5555', mergeSha: 'aa6666' } },
    { v: 3, seq: 7, ts: '2026-09-18T18:07:00.000Z', head: 'aa0', type: 'close', payload: { note: '运行终结。' } },
  ];
  fs.writeFileSync(path.join(runtimeDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // 主会话：两个 key 都有任务书（污染只发生在 runId，不波及 key）——派发不产出「任务书未恢复」噪声
  const sessionDir = path.join(os.homedir(), '.pi', 'agent', 'sessions', `--${repo.split(path.sep).filter(Boolean).join('-')}--`);
  const ad = path.join(sessionDir, 'subagent-artifacts');
  fs.mkdirSync(ad, { recursive: true });
  const waveScript = `const ids = ['${WRONG_UUID_RUN_ID}', '${UUID_POLLUTION_CORRECTED_RUN_ID}'];
const results = await runs.all([
  { key: 't-03', agent: 'pi-matt-implement-flow.coder', task: 'Ticket 03: 第三张票。Test command: npm test.', worktree: true },
  { key: 't-03-corrected', agent: 'pi-matt-implement-flow.coder', task: 'Ticket 03: 第三张票。Test command: npm test.', worktree: true },
]);
return results;`;
  fs.writeFileSync(
    path.join(sessionDir, '2026-09-18T17-59-00-000Z_demo.jsonl'),
    JSON.stringify({ type: 'message', timestamp: '2026-09-18T18:01:30.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'subagent', id: 'tc1', arguments: { workflowScript: waveScript, async: true } }] } }) + '\n',
  );
  // 平台证据：补正后的运行证据齐备；错值 runId 查无证据（形状合法 → 机判不剔除它）
  writeRunArtifact(ad, UUID_POLLUTION_CORRECTED_RUN_ID, 'pi-matt-implement-flow.coder', { ts: Date.parse('2026-09-18T18:04:30.000Z'), cost: 0.01 });

  return {
    dir, repo, runtimeDir, sessionDir, ad,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

test('collect：UUID 形状错值的污染 dispatch + refSeq anomaly → 衍生「证据缺失」风险标注「已被补正」', () => {
  const fx = makeUuidPollutionFixture();
  try {
    const model = collect({ runtimeDir: fx.runtimeDir });
    // 形状合法 → 不是死 runRef 机判的对象：仍被探测（查无证据本身是事实），告警照旧
    assert.equal(model.childRuns[WRONG_UUID_RUN_ID].found, false, '错值 runId 存活于运行清单（形状合法）');
    assert.ok(
      model.warnings.some((w) => w.code === 'run-evidence-missing' && w.detail.includes(WRONG_UUID_RUN_ID)),
      '证据缺失告警照旧（机判不覆盖形状合法的错值）',
    );
    // 衍生风险存活 → 必须带「已被补正」标注（补正链机器可读，不必人读散文）
    const missing = model.risks.filter((r) => r.title.includes('证据缺失'));
    assert.equal(missing.length, 1, '仅污染运行缺证据（补正后的运行证据齐备）');
    assert.match(missing[0].title, /已被补正/, '衍生风险标注处置状态（风险本体不删除）');
    assert.equal(missing[0].severity, 'low');
    assert.ok(missing[0].evidence.some((e) => e.label === '运行' && e.ref === WRONG_UUID_RUN_ID));
    assert.ok(missing[0].evidence.some((e) => String(e.ref) === 'seq 3'), '补正依据可回跳 anomaly 事件（seq 3）');
    assert.ok(missing[0].evidence.some((e) => String(e.ref) === 'seq 4'), '可回跳补正记录（seq 4）');
    // R3 自身照旧：anomaly 留痕降 medium 标「已补正」（票 03 行为零变化）
    const anomalyRisk = model.risks.find((r) => r.title.includes('异常'));
    assert.equal(anomalyRisk.severity, 'medium');
    assert.match(anomalyRisk.title, /已补正/);
    // 首页风险区：衍生风险的标注进渲染
    const out = path.join(fx.dir, 'report');
    renderAll(model, out, null);
    const riskSection = fs.readFileSync(path.join(out, 'index.html'), 'utf8').split('<section class="section" id="risks">')[1].split('</section>')[0];
    assert.ok(riskSection.includes('已被补正'), '首页风险区可区分「补正后的残留」与「真伤」');
  } finally {
    fx.cleanup();
  }
});
