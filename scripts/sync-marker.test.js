'use strict';

// 票 02 专项：同步幂等机器 marker（纯函数面）。
// marker 是同步评论的幂等键：隐藏 HTML 注释 <!-- matt-implement:<runId>:<kind> -->，
// 人类不可见；幂等判定只认 marker——正文改写/翻译/追加都不改判。
// marker 构造与判定同置本模块（sync-planning-core）：构造与判定一处成对，正文该长什么样
// 是规划器的私有约定；外部只见「带 marker 的完整正文」与三档幂等矩阵。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { syncMarker, hasSyncMarker } = require('./sync-planning-core.js');

// ------------------------------------------------------------------
// marker 构造：HTML 注释形态，人类不可见
// ------------------------------------------------------------------

test('marker 构造：<!-- matt-implement:<runId>:<kind> -->，含 run 标识与动作种类', () => {
  assert.equal(
    syncMarker('d573c461', 'merge'),
    '<!-- matt-implement:d573c461:merge -->',
  );
  assert.equal(
    syncMarker('d573c461', 'escalate'),
    '<!-- matt-implement:d573c461:escalate -->',
  );
  assert.equal(
    syncMarker('d573c461', 'closing'),
    '<!-- matt-implement:d573c461:closing -->',
  );
  assert.equal(
    syncMarker('d573c461', 'abandon'),
    '<!-- matt-implement:d573c461:abandon -->',
  );
});

// ------------------------------------------------------------------
// marker 拒绝面：runId/kind 不合格在构造点拒绝（不产生污染 marker 的正文）
// ------------------------------------------------------------------

test('marker 构造拒绝：runId/kind 为空或含注入性字符（冒号/注释箭头/尖括号/换行——防伪造 marker）', () => {
  for (const runId of ['', '   ', null, undefined, 'r:1', 'r-->x', 'a<b', 'c>d', 'x\ny']) {
    assert.throws(() => syncMarker(runId, 'merge'), /marker runId/, `runId=${JSON.stringify(runId)}`);
  }
  for (const kind of ['', '   ', null, undefined, 'merge:x', 'ab-->andon', 'a<b', 'c>d', 'x\ny']) {
    assert.throws(() => syncMarker('d573c461', kind), /marker kind/, `kind=${JSON.stringify(kind)}`);
  }
});

// ------------------------------------------------------------------
// marker 判定：只认 marker，不认正文
// ------------------------------------------------------------------

test('marker 判定：评论带同 run 同 kind 的 marker → 命中；其他一律未同步', () => {
  const marked = `已合并（merge SHA：0f3a9c4）\n\n<!-- matt-implement:d573c461:merge -->`;
  assert.equal(hasSyncMarker([marked], 'd573c461', 'merge'), true);

  assert.equal(hasSyncMarker([], 'd573c461', 'merge'), false, '无评论 = 未同步');
  assert.equal(hasSyncMarker(['正文乱写的评论，不含 marker'], 'd573c461', 'merge'), false);
  // 无 marker 的历史评论（旧 run 形态）= 未同步——语义显式记录的默认面
  assert.equal(hasSyncMarker(['已合并（merge SHA：0f3a9c4）'], 'd573c461', 'merge'), false);
});

test('marker 判定：run 或 kind 不匹配 → 不命中（幂等键 = runId + kind 二元组）', () => {
  const marked = 'x\n\n<!-- matt-implement:d573c461:merge -->';
  assert.equal(hasSyncMarker([marked], '另一个run', 'merge'), false, '他 run 的 marker 不算本 run 同步');
  assert.equal(hasSyncMarker([marked], 'd573c461', 'closing'), false, '他 kind 的 marker 不遮本动作');
});

test('marker 判定：人类改写、翻译、追加正文后依然命中（含判定废除的意义所在）', () => {
  const rewritten = '「已合并，merge SHA 是 0f3a9c4」（Christian says: merged & squashed。）\n<!-- matt-implement:d573c461:merge -->';
  assert.equal(hasSyncMarker([rewritten], 'd573c461', 'merge'), true);

  const translated = 'Merged (merge SHA: 0f3a9c4)\n\n<!-- matt-implement:d573c461:merge -->';
  assert.equal(hasSyncMarker([translated], 'd573c461', 'merge'), true);

  const appended = '已合并（merge SHA：0f3a9c4）<!-- matt-implement:d573c461:merge -->\n（人类补一句：已上预发。）';
  assert.equal(hasSyncMarker([appended], 'd573c461', 'merge'), true);
});

test('marker 判定：裸 needle（无注释包裹）不算 marker——判定必须认完整注释形态，不容错也不认半截', () => {
  assert.equal(hasSyncMarker(['ab\nmatt-implement:d573c461:merge\ncd'], 'd573c461', 'merge'), false);
  assert.equal(hasSyncMarker(['<!-- matt-implement:d573c461:merge -->'], 'd573c461', 'merge'), true);
  assert.equal(hasSyncMarker(['<!-- matt-implement:d573c461:merge --> 行内前后带文字'], 'd573c461', 'merge'), true);
});

test('marker 判定：外层 HTML 注释可分离出 ——（这不是生成的 marker；人类也可以手写 marker）', () => {
  const inseparable = '正文 <!-- matt-implement:d573c461:merge --> 正文';
  assert.equal(hasSyncMarker([inseparable], 'd573c461', 'merge'), true);
});

test('marker 判定拒绝：runId/kind 不合格在判定点拒绝（与构造同一校验档）', () => {
  assert.throws(() => hasSyncMarker(['x'], '', 'merge'), /marker runId/);
  assert.throws(() => hasSyncMarker(['x'], 'd573c461', ''), /marker kind/);
});
