'use strict';

// 票 06：sync 子命令黑盒测试——真实调用 ledger CLI，断言退出码、stdout、gh 调用日志
// 与（gh 桩的）tracker 状态迁移。gh 收发是 best-effort 薄 IO（spec 测试决策：不设缝、
// 不碰网络）——测试通过 PATH 注入 gh 桩二进制供给合成 tracker 状态；生产代码不含任何
// 测试钩子。桩是有状态的：close/comment/edit 真实改写状态文件，幂等矩阵（已关不重关、
// 已评论不重复、部分同步后重跑续作）在外部行为面上端到端验证。
// 快照文件由测试直接落盘（run 期间编排器写快照的产物形态，票 05 转写 + Comments 事实）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initOpenRun, runEvidence, assertOpenEvidence } = require('./fixtures/open-run-evidence');


// 票 02：同步幂等机器 marker——黑盒断言点在 gh 桩的状态与调用日志里。run 标识 = --runtime-dir 的
// 目录名（fixture 下恒 'demo'）；kind = 四类同步写入（merge / escalate / closing / abandon）。

// --- gh 桩（Node 脚本）：状态存 GH_STUB_STATE 指向的 JSON 文件，调用追加进 GH_STUB_LOG ---
// GH_STUB_FAIL：所有调用模拟失败（网络不可用）；GH_STUB_FAIL_WRITE=<num>：该号的写入
// 动作（close/comment/edit）模拟失败；<num>:<command> 只拦该号的指定写命令。
// 每次 gh 调用是独立进程，匹配的调用都会失败；重试去掉环境变量后恢复。
// issue view 的失败不设专门开关：从桩状态里删号即真实缺票（同步对象缺失用例）。

// 同步 fixture 胶水（快照直落 / gh 桩 / sync 入口 / marker 断言助手）在共享模块里——
// 包级系统回归以 MATT_IMPLEMENT_LEDGER 注入 tarball 解包脚本复用同一套铺底。
const {
  LEDGER, RUN, MARK, SHA_A,
  makeFixture, writeSpec, writeTicket, stubState, sync, withGh,
  rawLog, callLog, reEscape, markerNear, stateOf, isViewCall,
} = require('./fixtures/sync-fixture');
function writeEvents(f, events) {
  fs.writeFileSync(
    path.join(f.runtime, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

// 恒定 fixture：合并票 1043（Comments 有 SHA）、升级票 1102（Comments 有原因）、
// 在途票 1044（无事实，不是同步对象）、spec 母票 3001（closing 收尾评论）。
function seedSealFixture(f) {
  writeSpec(f);
  writeTicket(f, '1043', 'merged', { status: 'resolved', comments: [`merge SHA: ${SHA_A}`] });
  writeTicket(f, '1044', 'in-flight', { status: 'claimed' });
  writeTicket(f, '1102', 'escalated', { status: 'claimed', comments: ['escalate: 预算用尽'] });
  stubState(f, {
    1043: { state: 'open', assignees: [], comments: [] },
    1044: { state: 'open', assignees: [], comments: [] },
    1102: { state: 'open', assignees: [], comments: [] },
    3001: { state: 'open', assignees: [], comments: [] },
  });
}

// ====================================================================
// seal 成功路径：合并票关票附 SHA、升级票留评保持开放、spec 收尾关闭
// ====================================================================

test('sync seal 成功：合并票关票附 SHA、升级票只留评保持开放、spec 收尾关闭；输出清理指引', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // tracker 桩状态：合并票已关且评论含 SHA + merge marker；升级票保持开放只有留评
  //（escalate marker）；spec 已关附收尾评论（closing marker）。marker 隐藏在正文尾部，
  // 人类可读正文信息不变；issue #8：固定正文英文（旧版中文只存在于历史评论）。
  assert.deepEqual(stateOf(f, 1043), {
    state: 'closed',
    assignees: [],
    comments: [`Merged (merge SHA: ${SHA_A})\n\n${MARK('merge')}`],
  });
  assert.deepEqual(stateOf(f, 1102), {
    state: 'open',
    assignees: [],
    comments: [`Escalated: 预算用尽\n\n${MARK('escalate')}`],
  });
  assert.deepEqual(stateOf(f, 3001), {
    state: 'closed',
    assignees: [],
    comments: [`已交付：票 1043 合并于主分支，PR #12 待审。\n\n${MARK('closing')}`],
  });
  assert.deepEqual(stateOf(f, 1044), { state: 'open', assignees: [], comments: [] }, '在途票不惊动 tracker');

  const log = callLog(f);
  assert.deepEqual(
    log.filter(isViewCall).map((l) => l.replace(/^-R \S+ /, '').split(' --json')[0]),
    ['issue view 1043', 'issue view 1102', 'issue view 3001'],
    '只拉取同步对象的状态（在途票 1044 不发请求）',
  );
  assert.ok(log.some((l) => l.includes('issue close 1043 --comment Merged (merge SHA: 0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6)')));
  assert.ok(log.some((l) => l.includes('issue comment 1102 --body Escalated: 预算用尽')));
  assert.ok(log.some((l) => /issue close 3001 --comment 已交付：票 1043/.test(l)));
  // 四类同步写入均带 marker —— 逐条验（合并关票=merge、升级留评=escalate、spec 收尾=closing；
  // 各 marker 含本 run 标识）。多行正文折行，按原文窗口断言同一调用内携带。
  assert.ok(markerNear(rawLog(f), 'issue close 1043 --comment ', MARK('merge')), '同步写入携带 marker：merge');
  assert.ok(markerNear(rawLog(f), 'issue comment 1102 --body ', MARK('escalate')), '同步写入携带 marker：escalate');
  assert.ok(markerNear(rawLog(f), 'issue close 3001 --comment ', MARK('closing')), '同步写入携带 marker：closing');

  assert.match(r.stdout, /同步完成：3 个动作/);
  assert.match(r.stdout, /✓ close 1043/);
  assert.match(r.stdout, /✓ comment 1102/);
  assert.match(r.stdout, /✓ close 3001/);
  // 清理指引：快照与 review bundle 清理、findings 与账本三件套留存
  assert.match(r.stdout, /清理 tracker 快照/);
  assert.match(r.stdout, /review bundle/);
  assert.match(r.stdout, /findings/);
  assert.match(r.stdout, /events\.jsonl/);
  assert.match(r.stdout, /notes\.md/);
});

test('sync 幂等重跑：已关不重关、已评论不重复——第二次执行零动作零写入', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const first = sync(f, [], withGh(f));
  assert.equal(first.status, 0, first.stdout);

  const writesAfterFirst = callLog(f).filter((l) => !isViewCall(l)).length;
  const second = sync(f, [], withGh(f));
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /已同步：无待推送动作/);
  assert.match(second.stdout, /幂等|零副作用/);
  assert.equal(
    callLog(f).filter((l) => !isViewCall(l)).length,
    writesAfterFirst,
    '重跑不产生任何新写入',
  );
  // 评论不重复：升级票的留评仍恰一条
  assert.equal(stateOf(f, 1102).comments.length, 1);
  assert.equal(stateOf(f, 1043).comments.length, 1);
});

// 票 02：幂等判定只认 marker——人在 tracker 上翻译/改写/追加已推送评论的正文后，
// 重跑零动作（正文不再参与判定；marker 是唯一键）。
test('sync 幂等重跑：人改写/翻译/追加正文后 rerun 零动作（只认 marker）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const first = sync(f, [], withGh(f));
  assert.equal(first.status, 0, first.stdout);

  // 模拟人类改写：删掉正文原样、换译写、追加补充——只留 marker（HTML 注释人类不可见，
  // 正常编辑正文时不会动它）
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  s.issues[ '1043' ].comments = [`Merged (merge commit: ${SHA_A.slice(0, 7)}, squash).\n\n<!-- matt-implement:${RUN}:merge -->`];
  s.issues[ '1102' ].comments = [`Escalated: budget exhausted（翻译后的升级评论）。\n\n(matt note：细节见 ledger)\n\n<!-- matt-implement:${RUN}:escalate -->`];
  s.issues[ '3001' ].comments = [`Delivered – ticket 1043 merged into main, PR #12 awaiting review.\n\n<!-- matt-implement:${RUN}:closing -->`];
  fs.writeFileSync(f.stateFile, JSON.stringify(s));

  const writesBefore = rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0;
  const second = sync(f, [], withGh(f));
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /已同步：无待推送动作/);
  const writesAfter = rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0;
  assert.equal(writesAfter, writesBefore, '改写正文后重跑：仍是零动作零写入');
  assert.deepEqual(stateOf(f, 1043).comments.length, 1, '不重复推送');
});

// 票 02：历史无 marker 评论（旧 run 形态）在首次 marker 同步后照带重推（语义显式记录），
// 新写入带 marker —— 再重跑按 marker 判重归零。
test('sync 幂等重跑：旧 run 无 marker 历史评论 → 首重跑后照常推送一次，再跑归零', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  // 预置旧形态痕迹：已关 + 无 marker 的合并评论（旧 run 推的）
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  s.issues[ '1043' ].state = 'closed';
  s.issues[ '1043' ].comments = [`已合并（merge SHA：${SHA_A}）`];
  fs.writeFileSync(f.stateFile, JSON.stringify(s));

  const first = sync(f, [], withGh(f));
  assert.equal(first.status, 0, first.stdout);
  assert.match(first.stdout, /✓ comment 1043/, '历史无 marker 评论视为未同步、照常推送一次');
  // issue #8：旧版中文正文与新英文正文同列——旧文识别、新文携带 marker 推送
  assert.deepEqual(stateOf(f, 1043), {
    state: 'closed',
    assignees: [],
    comments: [`已合并（merge SHA：${SHA_A}）`, `Merged (merge SHA: ${SHA_A})\n\n${MARK('merge')}`],
  });

  // 再重跑：marker 已在 → 零动作（新写入不再重复，语义收敛到 marker）
  const writesBefore = rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0;
  const second = sync(f, [], withGh(f));
  assert.equal(second.status, 0, second.stdout);
  assert.deepEqual(
    rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0,
    writesBefore,
    'marker 补推后重跑：零动作',
  );
});

// issue #8：升级前版本推送的旧版中文正文（带 marker）——重跑识别为已同步，零重复推送。
//（无 marker 的旧中文评论按迁移语义照常补推一次，见上一用例；带 marker 的永不重复。）
test('sync 跨语言兼容：旧版中文同步评论（带 marker）→ 重跑识别，零重复推送', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  stubState(f, {
    1043: { state: 'closed', assignees: [], comments: [`已合并（merge SHA：${SHA_A}）\n\n${MARK('merge')}`] },
    1044: { state: 'open', assignees: [], comments: [] },
    1102: { state: 'open', assignees: [], comments: [`已升级上报：预算用尽\n\n${MARK('escalate')}`] },
    3001: { state: 'closed', assignees: [], comments: [`已交付：票 1043 合并于主分支，PR #12 待审。\n\n${MARK('closing')}`] },
  });
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /已同步：无待推送动作/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, 0, '旧中文痕迹识别为已同步：零写入');
  assert.equal(stateOf(f, 1043).comments.length, 1, '合并票评论不重复');
  assert.equal(stateOf(f, 1102).comments.length, 1, '升级票留评不重复');
  assert.equal(stateOf(f, 3001).comments.length, 1, 'spec 收尾评论不重复');
});

// ====================================================================
// 部分失败：逐动作报告已完成/未完成，可安全重跑（重跑只补未完成）
// ====================================================================

test('sync 部分失败：报告已完成/未完成；重跑续作（已完成的动作不重复）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  // spec 收尾（最后一个动作）失败：前两个动作已推送
  const r1 = sync(f, [], { ...withGh(f), GH_STUB_FAIL_WRITE: '3001' });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /同步失败/);
  assert.match(r1.stdout, /已完成/);
  assert.match(r1.stdout, /✓ close 1043/);
  assert.match(r1.stdout, /✓ comment 1102/);
  assert.match(r1.stdout, /未完成/);
  assert.match(r1.stdout, /close 3001/);
  assert.match(r1.stdout, /重跑/);
  assert.equal(stateOf(f, 1043).state, 'closed', '已完成的部分真实生效');
  assert.equal(stateOf(f, 3001).state, 'open', '未完成的动作不落任何状态');

  // 重跑：规划器看到已推送 marker → 只补 spec 收尾，已关不重关、已评论不重复
  const logBefore = rawLog(f).length;
  const r2 = sync(f, [], withGh(f));
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /✓ close 3001/);
  assert.doesNotMatch(r2.stdout, /close 1043/);
  assert.doesNotMatch(r2.stdout, /comment 1102/);
  assert.equal(stateOf(f, 1043).comments.length, 1, '合并票评论不重复');
  assert.equal(stateOf(f, 1102).comments.length, 1, '升级票留评不重复');
  // 重跑只动未完成的票：日志增量的写入调用只有 3001（关票命令）；多行正文折行，
  // 按原文窗口断言，不逐物理行。
  const logAfter = rawLog(f).slice(logBefore);
  assert.doesNotMatch(logAfter, /issue (close|comment|edit) (1043|1102)( |\n)/, '重跑只动未完成的票');
  assert.match(logAfter, /issue close 3001/, '重跑只补未完成的票');
});

// ====================================================================
// abandon 路径：撤占坑（移除 assignee）+ 留评说明
// ====================================================================

// #16：sync 是公开 CLI seam；真实 init 保证开放状态不是测试手写的结论。
// 故障只注入外部 gh 命令，sync 不负责封账、ready 或停止平台 child。
function seedAbandonFixture(f) {
  seedSealFixture(f); // 即使存在 merge/escalate/closing 事实，abandon 也不执行 seal。
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.issues['3001'].assignees = ['alice', 'bob'];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  initOpenRun(f);
}

const ABANDON_ARGS = ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户明确放弃，保留未完成项'];

function assertAbandonTicketsUntouched(f) {
  for (const num of [1043, 1044, 1102]) {
    assert.deepEqual(stateOf(f, num), { state: 'open', assignees: [], comments: [] },
      `abandon 不同步票 ${num}，包括未完成票与远程延迟的已合并票`);
  }
  assert.doesNotMatch(rawLog(f), /issue (view|close|comment|edit) (1043|1044|1102)\b/);
  assert.doesNotMatch(rawLog(f), /issue close |\bpr\b/);
}

test('sync abandon：说明失败保持开放与占坑；重试补说明和撤占坑，不执行 seal/ready', (t) => {
  const f = makeFixture(t);
  seedAbandonFixture(f);
  const before = runEvidence(f);
  const failed = sync(f, ABANDON_ARGS, { ...withGh(f), GH_STUB_FAIL_WRITE: '3001:comment' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /同步失败：comment 3001/);
  assert.match(failed.stdout, /已完成（0\/2）/);
  assert.doesNotMatch(failed.stdout, /清理指引/);
  assert.deepEqual(stateOf(f, 3001), { state: 'open', assignees: ['alice', 'bob'], comments: [] });
  assert.doesNotMatch(rawLog(f), /--remove-assignee/, '说明失败不提前撤占坑');
  assertOpenEvidence(runEvidence(f), before);
  assertAbandonTicketsUntouched(f);

  const offset = rawLog(f).length;
  const retried = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.match(retried.stdout, /同步完成：2 个动作/);
  assert.doesNotMatch(retried.stdout, /PR 标 ready/);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open', assignees: ['bob'],
    comments: [`This run has been abandoned: 用户明确放弃，保留未完成项\n\n${MARK('abandon')}`],
  });
  const retryLog = rawLog(f).slice(offset);
  assert.equal((retryLog.match(/issue comment 3001 /g) ?? []).length, 1);
  assert.equal((retryLog.match(/issue edit 3001 --remove-assignee alice/g) ?? []).length, 1);
  assertOpenEvidence(runEvidence(f), before);
  assertAbandonTicketsUntouched(f);
});

test('sync abandon：撤占坑失败保留已推说明与开放状态；重试只撤占坑，之后零动作', (t) => {
  const f = makeFixture(t);
  seedAbandonFixture(f);
  const before = runEvidence(f);
  const failed = sync(f, ABANDON_ARGS, { ...withGh(f), GH_STUB_FAIL_WRITE: '3001:edit' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /同步失败：unassign 3001/);
  assert.match(failed.stdout, /已完成（1\/2）/);
  assert.doesNotMatch(failed.stdout, /清理指引/);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open', assignees: ['alice', 'bob'],
    comments: [`This run has been abandoned: 用户明确放弃，保留未完成项\n\n${MARK('abandon')}`],
  });
  assertOpenEvidence(runEvidence(f), before);
  assertAbandonTicketsUntouched(f);

  // 人可改写说明正文，marker 仍是重试判重依据。
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.issues['3001'].comments = [`用户已终结此 run；未完成范围仍开放。\n\n${MARK('abandon')}`];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const offset = rawLog(f).length;
  const retried = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.match(retried.stdout, /同步完成：1 个动作/);
  assert.doesNotMatch(retried.stdout, /PR 标 ready/);
  const retryLog = rawLog(f).slice(offset);
  assert.doesNotMatch(retryLog, /issue (comment|close) /);
  assert.equal((retryLog.match(/issue edit 3001 --remove-assignee alice/g) ?? []).length, 1);
  assert.deepEqual(stateOf(f, 3001), { ...state.issues['3001'], assignees: ['bob'] });
  assertOpenEvidence(runEvidence(f), before);
  assertAbandonTicketsUntouched(f);

  const afterRetry = rawLog(f).length;
  const again = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.doesNotMatch(rawLog(f).slice(afterRetry), /issue (close|comment|edit) /);
  assertOpenEvidence(runEvidence(f), before);
});

test('sync abandon：spec 留评放弃说明 + 撤占坑；重跑零动作', (t) => {
  const f = makeFixture(t);
  writeSpec(f, { closing: false });
  writeTicket(f, '1044', 'in-flight', { status: 'claimed' });
  stubState(f, {
    1044: { state: 'open', assignees: [], comments: [] },
    3001: { state: 'open', assignees: ['alice'], comments: [] },
  });
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户拍板放弃：终审 not_ready'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // 放弃留评携带 abandon marker（含 run 标识）——人类可读正文原样保留（issue #8：英文正文，原因原文跟随）
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open',
    assignees: [],
    comments: [`This run has been abandoned: 用户拍板放弃：终审 not_ready\n\n${MARK('abandon')}`],
  });
  assert.ok(markerNear(rawLog(f), 'issue comment 3001 --body ', MARK('abandon')), '放弃留评携带 marker：abandon');
  assert.match(r.stdout, /✓ comment 3001/);
  assert.match(r.stdout, /✓ unassign 3001（alice）/);

  const logBefore = rawLog(f).length;
  const again = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户拍板放弃：终审 not_ready'], withGh(f));
  assert.equal(again.status, 0);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.equal(rawLog(f).slice(logBefore).match(/issue (close|comment|edit) /g), null, '重跑不产生任何新写入');
});

test('sync abandon：占坑者已不在（他人已处理）→ 只留说明', (t) => {
  const f = makeFixture(t);
  writeSpec(f, { closing: false });
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '改期重跑'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open',
    assignees: [],
    comments: [`This run has been abandoned: 改期重跑\n\n${MARK('abandon')}`],
  });
  assert.match(r.stdout, /✓ comment 3001/);
});

// ====================================================================
// 拒绝面：缺快照、已封账、参数缺省
// ====================================================================

test('sync 拒绝：快照不存在（tracker=local 无需同步的提示）', (t) => {
  const f = makeFixture(t);
  fs.rmSync(f.tracker, { recursive: true, force: true });
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /快照不存在/);
  assert.match(r.stdout, /tracker=local 无需同步/);
  assert.equal(callLog(f).length, 0, '拒绝面不触碰 gh');
});

test('sync 拒绝：run 已封账——同步须发生在封账之前', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'close', seq: 9 },
  ]);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /已封账/);
  assert.match(r.stdout, /封账之前/);
  assert.equal(callLog(f).length, 0);
});

test('sync 拒绝：PR 已标 ready（pr --state ready 已入账）——同步须在 PR 标 ready 之前', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'pr', seq: 2, payload: { state: 'ready' } },
  ]);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PR 已标 ready/);
  assert.match(r.stdout, /之前/);
  assert.equal(callLog(f).length, 0, '拒绝面不触碰 gh');
});

test('sync 放行：pr --state opened-draft 不拦同步（时点门只对 ready 生效）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'pr', seq: 2, payload: { state: 'opened-draft' } },
  ]);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /同步完成/);
});

test('sync 拒绝：abandon 缺 claimant/reason、mode 非法、未知旗标（exit 2 用法拒绝）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const noClaimant = sync(f, ['--mode', 'abandon', '--reason', 'r'], withGh(f));
  assert.equal(noClaimant.status, 2);
  assert.match(noClaimant.stdout, /--claimant/);
  const noReason = sync(f, ['--mode', 'abandon', '--claimant', 'alice'], withGh(f));
  assert.equal(noReason.status, 2);
  assert.match(noReason.stdout, /--reason/);
  const badMode = sync(f, ['--mode', 'push'], withGh(f));
  assert.equal(badMode.status, 2);
  assert.match(badMode.stdout, /--mode 非法/);
  const bogus = sync(f, ['--bogus', 'x'], withGh(f));
  assert.equal(bogus.status, 2);
  assert.match(bogus.stdout, /未知旗标 --bogus/);
  assert.equal(callLog(f).length, 0);
});

test('sync 拒绝：快照形态不合格（缺 spec.md）——不触碰 gh', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  fs.rmSync(path.join(f.tracker, 'spec.md'));
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /spec\.md/);
  assert.equal(callLog(f).length, 0);
});

// ====================================================================
// gh 薄 IO 失败：拉取失败整体中止、零写入（无半成品推送）
// ====================================================================

test('sync gh 拉取失败：报错清晰、零写入（规划先行，失败不推送）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = sync(f, [], { ...withGh(f), GH_STUB_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /拉取失败/);
  assert.match(r.stdout, /未执行任何动作|未执行任何写入/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, 0, '零写入');
  // tracker 状态原封未动
  assert.equal(stateOf(f, 1043).state, 'open');
});

test('sync gh 拉取失败：同步对象在 tracker 上缺失（如被删除）→ 点名缺票，零写入', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  // 从桩状态删掉升级票 1102
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  delete s.issues[1102];
  fs.writeFileSync(f.stateFile, JSON.stringify(s));
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /1102/);
  assert.match(r.stdout, /拉取失败/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, 0);
});

// ====================================================================
// 占坑（票 05 claim 子命令）：契约 claim 模板执行——先读状态再写入，冲突不猜测覆盖
// ====================================================================

test('claim 成功：先读状态无人占坑 → claim 模板执行，tracker 桩状态真实更新', (t) => {
  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/3001'], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /占坑/);
  assert.match(r.stdout, /3001/);
  assert.deepEqual(stateOf(f, 3001).assignees, ['@me'], 'tracker 桩状态：占坑落 assignee');
  assert.ok(rawLog(f).includes('issue edit 3001 --add-assignee @me'), 'claim 走契约 claim 模板');
  assert.ok(rawLog(f).includes('issue view 3001'), '先读状态再写入');
});

test('claim 冲突：他人已在位 → 拒绝并点名在位者，不覆盖（无 claim 写入）', (t) => {
  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: ['alice'], comments: [] } });
  const r = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, '--spec', '#3001'], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /占坑冲突/);
  assert.match(r.stdout, /alice/);
  assert.deepEqual(stateOf(f, 3001).assignees, ['alice'], '他人占坑零覆盖');
  assert.equal(rawLog(f).match(/issue edit 3001 --add-assignee/g), null, '冲突路径无 claim 写入');
});

test('claim local 契约 / 缺 setup 产物 / 缺 --spec：显式停下不猜测', (t) => {
  const runClaim = (f, args) =>
    spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, ...args], {
      cwd: f.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
    });

  const local = makeFixture(t, { trackerDoc: 'issue-tracker-local.md' });
  const rl = runClaim(local, ['--spec', '3001']);
  assert.equal(rl.status, 1);
  assert.match(rl.stdout, /tracker=local 无 tracker 写面/);

  const noDoc = makeFixture(t, { trackerDoc: null });
  const rn = runClaim(noDoc, ['--spec', '3001']);
  assert.equal(rn.status, 1);
  assert.match(rn.stdout, /setup-matt-pocock-skills/);

  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const missing = runClaim(f, []);
  assert.equal(missing.status, 2, '用法拒绝（exit 2）');
  assert.match(missing.stdout, /缺少必选参数 --spec/);
  const bogus = runClaim(f, ['--spec', '3001', '--bogus', 'x']);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stdout, /未知旗标 --bogus/);
  assert.equal(callLog(f).length, 0, '拒绝面不触碰 tracker');
});

test('sync abandon（local）：无远程说明或占坑写面，保留开放 run、本地票与证据', (t) => {
  const f = makeFixture(t, { trackerDoc: 'issue-tracker-local.md' });
  fs.writeFileSync(path.join(f.tracker, 'spec.md'), '# Spec: local\n\n**Status:** ready-for-agent\n');
  writeTicket(f, '01', 'unfinished', { status: 'claimed' });
  initOpenRun(f);
  const before = runEvidence(f);
  const r = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(r.status, 1, r.stdout + r.stderr); // local 的既有公开接口：不经 sync CLI。
  assert.match(r.stdout, /tracker=local 无需同步/);
  assert.match(r.stdout, /本地票文件即真相层/);
  assert.doesNotMatch(r.stdout, /PR 标 ready|清理指引/);
  assertOpenEvidence(runEvidence(f), before);

  const claim = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime,
    '--spec', path.join(f.tracker, 'spec.md')], {
    cwd: f.dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, ...withGh(f) },
  });
  assert.equal(claim.status, 1, claim.stdout + claim.stderr);
  assert.match(claim.stdout, /tracker=local 无 tracker 写面/);
  assert.equal(callLog(f).length, 0, 'local claim/abandon 不触碰外部 tracker');
  assertOpenEvidence(runEvidence(f), before);
});

test('sync 拒绝：local 契约（快照/同步为无操作）——票文件即真相层', (t) => {
  const f = makeFixture(t, { trackerDoc: 'issue-tracker-local.md' });
  writeSpec(f);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /tracker=local 无需同步/);
  assert.match(r.stdout, /本地票文件即真相层/);
  assert.equal(callLog(f).length, 0, 'local 契约同步零 tracker 触碰');
});

test('sync 拒绝：缺 setup 产物 → 识别先于一切拉取，指引运行 /setup-matt-pocock-skills', (t) => {
  const f = makeFixture(t, { trackerDoc: null });
  writeSpec(f);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /setup-matt-pocock-skills/);
  assert.equal(callLog(f).length, 0, '识别失败零网络');
});

// ====================================================================
// 仓库作用域（票 05 评审 r1 P0/P1）：跨仓引用必须打到契约仓——issue 命令一律前置 -R <repo>
//（viewIssue / close / comment / unclaim 四面；REST 路径模板自带 <repo> 除外）
// ====================================================================

test('仓库作用域：sync 的 viewIssue/close/comment/unclaim 全部携带 -R <repo>（契约仓，非 cwd）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = callLog(f);
  // viewIssue：三个同步对象的拉取都带 -R o/r（Source 行的 repo）
  const views = log.filter(isViewCall);
  assert.equal(views.length, 3);
  assert.ok(views.every((l) => /^-R o\/r issue view /.test(l)), `view 全部 -R 前置：${views.join(' | ')}`);
  // close / comment：写入动作同样 -R 前置（stub 日志多行正文折行，按原文窗口断言）
  assert.ok(markerNear(rawLog(f), '-R o/r issue close 1043 --comment ', MARK('merge')), 'close 1043 带 -R');
  assert.ok(markerNear(rawLog(f), '-R o/r issue comment 1102 --body ', MARK('escalate')), 'comment 1102 带 -R');
  assert.ok(markerNear(rawLog(f), '-R o/r issue close 3001 --comment ', MARK('closing')), 'close 3001 带 -R');
});

test('仓库作用域：abandon 的 unclaim（撤占坑）同样携带 -R <repo>', (t) => {
  const f = makeFixture(t);
  writeSpec(f, { closing: false });
  stubState(f, { 3001: { state: 'open', assignees: ['alice'], comments: [] } });
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '放弃'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = callLog(f);
  assert.ok(log.some((l) => /^-R o\/r issue view 3001 /.test(l)), 'abandon 母票拉取带 -R');
  assert.ok(log.some((l) => /^-R o\/r issue edit 3001 --remove-assignee alice/.test(l)), 'unclaim 带 -R');
});

test('仓库作用域：跨仓 spec 引用（o/r#号）的 claim 读/写都落在契约仓', (t) => {
  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, '--spec', 'other/repo#3001'], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = callLog(f);
  assert.ok(log.some((l) => /^-R other\/repo issue view 3001 /.test(l)), `view 落在引用声明的契约仓：${log.join(' | ')}`);
  assert.ok(log.some((l) => /^-R other\/repo issue edit 3001 --add-assignee @me/.test(l)), 'claim 落在契约仓');
});

// ====================================================================
// #17 场景轨迹：编排器选择阶段性交付，之后同 run 续跑。
// 这不是模型自主决策测试：notes/不调用 sync/最终清理由 fixture 明确执行；CLI 只提供
// 事实写入、build/check 与正常同步。无 partial 模式、生产 helper 或恢复事件。
// ====================================================================

function continuationCli(f, command, flags = {}, env = {}) {
  const args = [...(Array.isArray(command) ? command : [command]), '--runtime-dir', f.runtime];
  for (const [key, value] of Object.entries(flags)) args.push(`--${key}`, String(value));
  return spawnSync(process.execPath, [LEDGER, ...args], {
    cwd: f.dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, ...withGh(f), ...env },
  });
}

function continuationEvents(f) {
  return fs.readFileSync(path.join(f.runtime, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function continuationAdd(f, type, flags) {
  const before = continuationEvents(f).length;
  const r = continuationCli(f, ['add', type], flags);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = continuationEvents(f);
  assert.equal(after.length, before + 1, `${type} 只追加一条事件`);
  assert.equal(after.at(-1).type, type);
  return after.at(-1);
}

function continuationGit(f, args, cwd = f.dir) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.trim();
}

function continuationGate(f, name, cwd = f.dir, expected = 0) {
  const r = spawnSync(process.execPath, [`${name}-check.js`], { cwd, encoding: 'utf8' });
  fs.writeFileSync(path.join(f.runtime, `${name}-validation.log`), r.stdout + r.stderr + `\nexit=${r.status}\n`);
  assert.equal(r.status, expected, r.stdout + r.stderr);
  return `${name}-validation.log`;
}

function continuationCandidate(f, num, content) {
  const wt = path.join(f.dir, `coder-${num}`);
  continuationGit(f, ['worktree', 'add', '-q', '-b', `ticket-${num}`, wt]);
  fs.writeFileSync(path.join(wt, `work-${num}.txt`), content);
  continuationGit(f, ['add', `work-${num}.txt`], wt);
  continuationGit(f, ['commit', '-qm', `Implement ticket-${num}`], wt);
  continuationAdd(f, 'dispatch', { ticket: num, key: `t-${num}`, 'run-id': `coder-${num}`, worktree: wt });
  return wt;
}

function continuationMerge(f, num, wt, gate) {
  const head = continuationGit(f, ['rev-parse', 'HEAD'], wt);
  continuationAdd(f, 'settled', { ticket: num, round: 1, 'head-sha': head, worktree: wt, gate: 'passed' });
  continuationAdd(f, 'verdict', { ticket: num, round: 1, verdict: 'approved', findings: 'findings/ticket-review.md' });
  continuationGit(f, ['merge', '--no-ff', '-qm', `Merge ticket-${num}: done`, `ticket-${num}`]);
  const merge = continuationGit(f, ['rev-parse', 'HEAD']);
  continuationGate(f, gate); // 集成验证之后才记 merge、写 resolved。
  continuationAdd(f, 'merge', { ticket: num, 'head-sha': head, 'merge-sha': merge });
  writeTicket(f, num, num === '1043' ? 'A' : num === '1044' ? 'B' : 'C', {
    status: 'resolved', comments: [`merge SHA: ${merge}`],
  });
  continuationGit(f, ['worktree', 'remove', wt]);
  continuationGit(f, ['branch', '-d', `ticket-${num}`]);
  const checked = continuationCli(f, 'check');
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  return merge;
}

function seedPartialContinuation(f) {
  continuationGit(f, ['init', '-q', '-b', 'main']);
  continuationGit(f, ['config', 'user.email', 't@example.com']);
  continuationGit(f, ['config', 'user.name', 'T']);
  continuationGit(f, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  // 合成 feature 的验证命令；partial 只验 A/B，不冒充完整 A/B/C 验收。
  for (const [name, nums] of [['A', ['1043']], ['partial', ['1043', '1044']], ['full', ['1043', '1044', '1102']]]) {
    fs.writeFileSync(path.join(f.dir, `${name}-check.js`),
      `const fs = require('node:fs'); const assert = require('node:assert/strict');\n` +
      nums.map((num) => `assert.equal(fs.readFileSync('work-${num}.txt', 'utf8'), '${num} delivered\\n');`).join('\n') +
      `\nconsole.log('${name} validation passed');\n`);
  }
  continuationGit(f, ['add', 'docs', 'A-check.js', 'partial-check.js', 'full-check.js']);
  continuationGit(f, ['commit', '-qm', 'baseline acceptance commands']);
  const baseline = continuationGit(f, ['rev-parse', 'HEAD']);
  continuationGit(f, ['checkout', '-q', '-b', 'feat/demo']);
  stubState(f, Object.fromEntries(['1043', '1044', '1102', '3001'].map((num) =>
    [num, { state: 'open', assignees: [], comments: [] }])));
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.pr = { state: 'OPEN', isDraft: true };
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const claim = continuationCli(f, 'claim', { spec: 'https://github.com/o/r/issues/3001' });
  assert.equal(claim.status, 0, claim.stdout + claim.stderr);
  writeSpec(f, { closing: false });
  for (const [num, slug] of [['1043', 'A'], ['1044', 'B'], ['1102', 'C']]) {
    writeTicket(f, num, slug, { status: 'ready-for-agent' });
  }
  // 导入旧 v3 init fixture，预算 1 是历史字段而不是新 init 旗标；此后所有事件由 CLI 写。
  // 原行作为续跑不可覆写的证据，新会话不会重新 init 或 snapshot-init。
  writeEvents(f, [{ v: 3, seq: 1, ts: '2025-01-01T00:00:00.000Z', head: baseline, type: 'init', payload: {
    branch: 'feat/demo', branchBase: 'main', baselineSha: baseline,
    spec: path.join(f.tracker, 'spec.md'), testCommand: 'node full-check.js', tracker: 'github',
    maxFixRounds: '1', tickets: ['1043', '1044', '1102'],
  } }]);
  fs.mkdirSync(path.join(f.runtime, 'findings'));
  fs.writeFileSync(path.join(f.runtime, 'findings/ticket-review.md'), 'Fixture review: A/B accepted; C requires external permission.\n');
  continuationAdd(f, 'pr', { state: 'opened-draft', url: 'https://github.com/o/r/pull/12' });
  const a = continuationMerge(f, '1043', continuationCandidate(f, '1043', '1043 delivered\n'), 'A');
  const b = continuationMerge(f, '1044', continuationCandidate(f, '1044', '1044 delivered\n'), 'partial');
  continuationAdd(f, 'escalate', { ticket: '1102', note: 'C 缺外部权限；未实现，等待用户提供条件' });
  writeTicket(f, '1102', 'C', { status: 'ready-for-agent', comments: ['escalate: C 缺外部权限'] });
  continuationGate(f, 'partial'); // 对当前分支重验，不只引用历史 merge。
  continuationGate(f, 'full', f.dir, 1); // C 未完成，完整门仍红。
  fs.writeFileSync(path.join(f.runtime, 'notes.md'), [
    '# 阶段性交付与续跑',
    '用户明确接受 A、B 阶段性交付；不放弃 C，不缩小 spec 范围。',
    `交付分支 feat/demo；A merge ${a}；B merge ${b}；当前 HEAD ${b}。`,
    '验证：partial-validation.log exit=0；full-validation.log exit=1（C 未实现）。',
    '未完成：C 缺外部权限，完整功能不可用；风险：A/B 仅覆盖已完成部分，不能标 PR ready。',
    '保留 tracker 快照、findings、验证与事件；暂无 child 执行，running 只表示 run 未终结。',
    '下一步：用户补权限后重读流程、build/check、读取本笔记与证据，仅继续 C。',
    '旧 maxFixRounds=1 为无效历史字段，续跑不追加预算、不改原 init。',
  ].join('\n') + '\n');
  return f;
}

function assertPartialContinuation(f) {
  const events = continuationEvents(f);
  assert.deepEqual(events.filter((e) => e.type === 'merge').map((e) => e.payload.ticket), ['1043', '1044']);
  assert.deepEqual(events.filter((e) => e.type === 'dispatch').map((e) => e.payload.ticket), ['1043', '1044']);
  assert.ok(!events.some((e) => e.type === 'close' || e.type === 'final' || (e.type === 'pr' && e.payload.state === 'ready')));
  assert.match(fs.readFileSync(path.join(f.runtime, 'ledger.md'), 'utf8'), /^state: running$/m);
  assert.match(fs.readFileSync(path.join(f.runtime, 'notes.md'), 'utf8'), /用户明确接受 A、B.*不放弃 C/);
  for (const name of ['tracker/spec.md', 'tracker/issues/1043-A.md', 'tracker/issues/1044-B.md',
    'tracker/issues/1102-C.md', 'findings/ticket-review.md', 'partial-validation.log', 'full-validation.log']) {
    assert.ok(fs.existsSync(path.join(f.runtime, name)), `阶段性交付保留 ${name}`);
  }
  assert.match(fs.readFileSync(path.join(f.tracker, 'issues/1043-A.md'), 'utf8'), /Status:\*\* resolved/);
  assert.match(fs.readFileSync(path.join(f.tracker, 'issues/1044-B.md'), 'utf8'), /Status:\*\* resolved/);
  assert.match(fs.readFileSync(path.join(f.tracker, 'issues/1102-C.md'), 'utf8'), /Status:\*\* ready-for-agent/);
  for (const num of [1043, 1044, 1102, 3001]) assert.equal(stateOf(f, num).state, 'open', '远端仍为延迟镜像');
  assert.deepEqual(stateOf(f, 3001).assignees, ['@me'], '阶段性交付不释放运行占坑');
  assert.doesNotMatch(rawLog(f), /issue (close|comment) |--remove-assignee|pr ready/,
    '这是编排器选择不执行收尾的证据，不是 sync CLI 自动识别 partial');
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).pr.isDraft, true);
}

test('#17 阶段性交付 fixture：A/B 真实合并且当前部分验证通过，C 缺权限，保留开放 run 与延迟快照', (t) => {
  const f = seedPartialContinuation(makeFixture(t));
  assertPartialContinuation(f);
  const before = runEvidence(f);
  const build = continuationCli(f, 'build');
  assert.equal(build.status, 0, build.stdout + build.stderr);
  assert.match(build.stdout, /state: running/);
  const check = continuationCli(f, 'check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.deepEqual(runEvidence(f), before, '再生/对账不覆盖本地已完成票或笔记');
  assertPartialContinuation(f);
  t.diagnostic(`partial: branch=feat/demo HEAD=${continuationGit(f, ['rev-parse', 'HEAD'])}; events=11; A/B resolved; C pending; partial gate=0/full gate=1; tracker open; snapshot/findings retained; no sync/ready/close`);
});

test('#17 续跑 fixture：原 init/已完成 A/B 不变，仅完成 C；同步失败留 anomaly，重试幂等后 ready 与 completed 封账', (t) => {
  const f = seedPartialContinuation(makeFixture(t));
  assertPartialContinuation(f);
  const partialEvents = fs.readFileSync(path.join(f.runtime, 'events.jsonl'), 'utf8');
  const partialCount = continuationEvents(f).length;
  const originalInit = partialEvents.split('\n')[0];
  const abSnapshots = ['1043-A.md', '1044-B.md'].map((name) => fs.readFileSync(path.join(f.tracker, 'issues', name), 'utf8'));
  const logOffset = rawLog(f).length;

  // 模拟新会话：仅根据运行目录重新读取上下文，不依赖前一会话的 merge 返回值。
  // 外部权限的真实性由编排器核验；脚本不会解析 notes 来授予权限或自动恢复。
  const resumed = {
    dir: f.dir, bin: f.bin, runtime: f.runtime, tracker: f.tracker,
    stateFile: f.stateFile, logFile: f.logFile,
  };
  fs.writeFileSync(path.join(resumed.runtime, 'permission-evidence.txt'), 'Fixture user supplied C permission; scope unchanged.\n');
  const notes = fs.readFileSync(path.join(resumed.runtime, 'notes.md'), 'utf8');
  assert.match(notes, /下一步：用户补权限后.*仅继续 C/);
  assert.match(fs.readFileSync(path.join(resumed.runtime, 'partial-validation.log'), 'utf8'), /partial validation passed[\s\S]*exit=0/);
  assert.match(fs.readFileSync(path.join(resumed.runtime, 'findings/ticket-review.md'), 'utf8'), /C requires external permission/);
  assert.match(fs.readFileSync(path.join(resumed.runtime, 'permission-evidence.txt'), 'utf8'), /scope unchanged/);
  fs.appendFileSync(path.join(resumed.runtime, 'notes.md'), '续跑核验：按已确认续跑流程读取 notes、findings 和 partial-validation.log；用户补充权限见 permission-evidence.txt。继续 C，不重跑 A/B。\n');
  const rebuilt = continuationCli(resumed, 'build');
  assert.equal(rebuilt.status, 0, rebuilt.stdout + rebuilt.stderr);
  assert.match(rebuilt.stdout, /historicalMaxFixRounds: 1（历史记录，不再生效）/);
  const checked = continuationCli(resumed, 'check');
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(fs.readFileSync(path.join(resumed.runtime, 'events.jsonl'), 'utf8'), partialEvents);
  assert.deepEqual(['1043-A.md', '1044-B.md'].map((name) => fs.readFileSync(path.join(resumed.tracker, 'issues', name), 'utf8')), abSnapshots);
  assert.doesNotMatch(rawLog(resumed).slice(logOffset), /issue |\bapi\b|pr ready/,
    'build/check 不重拉延迟远端 issue 状态、不重占坑、不收尾');

  const wt = continuationCandidate(resumed, '1102', 'C candidate missing integration\n');
  const head = () => continuationGit(resumed, ['rev-parse', 'HEAD'], wt);
  continuationGate(resumed, 'full', wt, 1);
  fs.copyFileSync(path.join(resumed.runtime, 'full-validation.log'), path.join(resumed.runtime, 'C-initial-failure.log'));
  continuationAdd(resumed, 'settled', { ticket: '1102', round: 1, 'head-sha': head(), worktree: wt, gate: 'failed' });
  continuationAdd(resumed, 'verdict', { ticket: '1102', round: 1, verdict: 'changes_requested' });
  // 两次真实候选修复超过历史配额 1，一次正式重评；不制造授权或恢复事件。
  for (const [n, content, exit] of [[1, 'C diagnostic candidate\n', 1], [2, '1102 delivered\n', 0]]) {
    continuationAdd(resumed, 'fix', { ticket: '1102', 'fix-no': n, key: 't-1102', 'resume-run-id': 'coder-1102' });
    fs.writeFileSync(path.join(wt, 'work-1102.txt'), content);
    continuationGit(resumed, ['add', 'work-1102.txt'], wt);
    continuationGit(resumed, ['commit', '-qm', `Repair C attempt ${n}`], wt);
    continuationGate(resumed, 'full', wt, exit);
    fs.copyFileSync(path.join(resumed.runtime, 'full-validation.log'), path.join(resumed.runtime, `C-fix-${n}.log`));
  }
  const candidate = head();
  continuationAdd(resumed, 'settled', { ticket: '1102', round: 2, 'head-sha': candidate, worktree: wt, gate: 'passed' });
  fs.writeFileSync(path.join(resumed.runtime, 'findings/C-review.md'), `Fixture formal review approved C candidate ${candidate}; C-fix-2.log exit=0.\n`);
  continuationAdd(resumed, 'verdict', { ticket: '1102', round: 2, verdict: 'approved', findings: 'findings/C-review.md' });
  continuationGit(resumed, ['merge', '--no-ff', '-qm', 'Merge ticket-1102: completed C', 'ticket-1102']);
  const cMerge = continuationGit(resumed, ['rev-parse', 'HEAD']);
  continuationGate(resumed, 'full');
  continuationAdd(resumed, 'merge', { ticket: '1102', 'head-sha': candidate, 'merge-sha': cMerge });
  writeTicket(resumed, '1102', 'C', { status: 'resolved', comments: ['escalate: C 缺外部权限', `merge SHA: ${cMerge}`] });
  continuationGit(resumed, ['worktree', 'remove', wt]);
  continuationGit(resumed, ['branch', '-d', 'ticket-1102']);
  const completedCheck = continuationCli(resumed, 'check');
  assert.equal(completedCheck.status, 0, completedCheck.stdout + completedCheck.stderr);
  const beforeFinal = continuationEvents(resumed);
  const delta = beforeFinal.slice(partialCount);
  assert.ok(delta.every((e) => e.payload.ticket === '1102'), '续跑只处理 C');
  assert.deepEqual(delta.map((e) => e.type), ['dispatch', 'settled', 'verdict', 'fix', 'fix', 'settled', 'verdict', 'merge']);
  assert.equal(beforeFinal.filter((e) => e.type === 'init').length, 1);
  assert.equal(fs.readFileSync(path.join(resumed.runtime, 'events.jsonl'), 'utf8').split('\n')[0], originalInit);
  assert.ok(fs.readFileSync(path.join(resumed.runtime, 'events.jsonl'), 'utf8').startsWith(partialEvents), '全部旧行 byte-for-byte 保留');
  for (const num of ['1043', '1044', '1102']) {
    assert.equal(beforeFinal.filter((e) => e.type === 'dispatch' && e.payload.ticket === num).length, 1);
    assert.equal(beforeFinal.filter((e) => e.type === 'merge' && e.payload.ticket === num).length, 1);
  }
  const current = continuationCli(resumed, 'build');
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.match(current.stdout, /^\| 1102 \| C \| done \|/m);
  assert.match(current.stdout, /escalate ticket=1102/, 'C 已完成仍保留升级历史');
  fs.writeFileSync(path.join(resumed.runtime, 'findings/final.md'), 'Fixture full review ready: A/B/C scope and full-validation.log checked.\n');
  continuationAdd(resumed, 'final', {
    'final-verdict': 'ready', 'run-id': 'final-fixture-17', findings: 'findings/final.md',
    note: '完整候选 A/B/C 已验证；fixture 正式终审裁决',
  });
  fs.appendFileSync(path.join(resumed.runtime, 'notes.md'), `C merge ${cMerge}；full-validation.log exit=0；核对终审 findings/final.md，执行正常收尾。\n`);
  fs.appendFileSync(path.join(resumed.tracker, 'spec.md'), '\n- closing: Delivered A/B/C on feat/demo; PR #12 ready for review.\n');

  const beforeSync = runEvidence(resumed);
  const failed = sync(resumed, [], { ...withGh(resumed), GH_STUB_FAIL_WRITE: '3001:close' });
  fs.writeFileSync(path.join(resumed.runtime, 'sync-failed.log'), failed.stdout + failed.stderr);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /同步失败：close 3001/);
  assert.deepEqual(runEvidence(resumed), beforeSync, 'sync 失败不会隐式封账、改快照或事件');
  assert.equal(stateOf(resumed, 3001).state, 'open');
  assert.equal(JSON.parse(fs.readFileSync(resumed.stateFile, 'utf8')).pr.isDraft, true);
  for (const num of [1043, 1044, 1102]) {
    assert.equal(stateOf(resumed, num).state, 'closed');
    assert.equal(stateOf(resumed, num).comments.length, 1);
  }
  const anomaly = continuationAdd(resumed, 'anomaly', { note: '正常同步 spec close 失败；证据 sync-failed.log，保持开放待重试' });
  fs.appendFileSync(path.join(resumed.runtime, 'notes.md'), `anomaly seq=${anomaly.seq}：spec 同步失败；sync-failed.log。重试前保留快照和未封账状态。\n`);
  const retryOffset = rawLog(resumed).length;
  const beforeRetry = runEvidence(resumed);
  const retry = sync(resumed, [], withGh(resumed));
  fs.writeFileSync(path.join(resumed.runtime, 'sync-retry.log'), retry.stdout + retry.stderr);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.match(retry.stdout, /同步完成：1 个动作/);
  assert.match(retry.stdout, /✓ close 3001/);
  assert.doesNotMatch(rawLog(resumed).slice(retryOffset), /issue (close|comment|edit) (1043|1044|1102)\b/);
  assert.deepEqual(runEvidence(resumed), beforeRetry, '成功 sync 只给清理指引，不自行删除快照或封账');
  const syncedLogOffset = rawLog(resumed).length;
  const again = sync(resumed, [], withGh(resumed));
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.doesNotMatch(rawLog(resumed).slice(syncedLogOffset), /issue (close|comment|edit) /);
  for (const num of [1043, 1044, 1102, 3001]) {
    assert.equal(stateOf(resumed, num).state, 'closed');
    assert.equal(stateOf(resumed, num).comments.length, 1, '正常 seal 重试幂等');
    assert.match(stateOf(resumed, num).comments[0], num === 3001 ? /:closing -->/ : /:merge -->/);
  }
  assert.doesNotMatch(stateOf(resumed, 1102).comments[0], /Escalated:/, 'C 合并完成而非永久升级');
  fs.appendFileSync(path.join(resumed.runtime, 'notes.md'), `anomaly seq=${anomaly.seq} 处置：sync-retry.log 成功，幂等重跑零动作；历史 anomaly 保留，不新增 resolve event。\n`);
  const ready = spawnSync('gh', ['-R', 'o/r', 'pr', 'ready', '12'], {
    cwd: resumed.dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${resumed.bin}${path.delimiter}${process.env.PATH}`, ...withGh(resumed) },
  });
  assert.equal(ready.status, 0, ready.stdout + ready.stderr);
  assert.equal(JSON.parse(fs.readFileSync(resumed.stateFile, 'utf8')).pr.isDraft, false);
  assert.ok(rawLog(resumed).lastIndexOf('issue close 3001') < rawLog(resumed).indexOf('pr ready 12'), '正常同步成功之后才 PR ready');
  continuationAdd(resumed, 'pr', { state: 'ready', url: 'https://github.com/o/r/pull/12' });
  const close = continuationAdd(resumed, 'close', { outcome: 'completed', note: '全范围完成，正常同步与 PR ready 后封账' });
  assert.equal(close.payload.outcome, 'completed');
  const sealed = fs.readFileSync(path.join(resumed.runtime, 'events.jsonl'), 'utf8');
  assert.deepEqual(continuationEvents(resumed).slice(beforeFinal.length).map((e) => e.type), ['final', 'anomaly', 'pr', 'close']);
  assert.equal(continuationEvents(resumed).filter((e) => e.type === 'anomaly').length, 1);
  assert.match(fs.readFileSync(path.join(resumed.runtime, 'notes.md'), 'utf8'), /处置：sync-retry.log 成功/);
  assert.match(fs.readFileSync(path.join(resumed.runtime, 'ledger.md'), 'utf8'), /^state: complete（封账 /m);
  assert.ok(fs.existsSync(resumed.tracker), '直到正常 completed 前快照始终存在');
  for (const [type, flags] of [['dispatch', { ticket: '1102', key: 'reopen', 'run-id': 'no-reopen' }],
    ['anomaly', { note: '封账后拒写' }], ['close', { outcome: 'abandoned' }]]) {
    const refused = continuationCli(resumed, ['add', type], flags);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /已封账/);
    assert.equal(fs.readFileSync(path.join(resumed.runtime, 'events.jsonl'), 'utf8'), sealed);
  }
  const sealedLogOffset = rawLog(resumed).length;
  const refusedSync = sync(resumed, [], withGh(resumed));
  assert.equal(refusedSync.status, 1, refusedSync.stdout + refusedSync.stderr);
  assert.match(refusedSync.stdout, /已封账/);
  assert.equal(rawLog(resumed).length, sealedLogOffset, '封账后拒绝 sync，不触碰 tracker');
  // 清理是编排动作，非 sync 自动行为；仅在正常终结流程执行，findings/账本/notes 长存。
  fs.rmSync(resumed.tracker, { recursive: true });
  assert.ok(!fs.existsSync(resumed.tracker));
  for (const name of ['events.jsonl', 'ledger.md', 'notes.md', 'findings/ticket-review.md', 'findings/C-review.md', 'findings/final.md',
    'partial-validation.log', 'C-initial-failure.log', 'C-fix-1.log', 'C-fix-2.log', 'full-validation.log', 'sync-failed.log', 'sync-retry.log']) {
    assert.ok(fs.existsSync(path.join(resumed.runtime, name)), `完成后留存 ${name}`);
  }
  t.diagnostic(`continuation: C merge=${cMerge}; original init/prefix unchanged; C-only events 12-19; full gate=0; final ready seq=20; failed sync exit=1/anomaly seq=${anomaly.seq}; retry exit=0/one action; rerun zero writes; PR ready seq=22; close completed seq=${close.seq}; sealed writes refused; terminal snapshot cleanup/findings retained`);
});
