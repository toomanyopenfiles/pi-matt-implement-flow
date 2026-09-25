'use strict';

// tracker 同步核心——同步规划纯函数（无 IO、无网络、无时钟、无随机）。
// 规划器只回答一件事：给定（快照状态, tracker 状态），封账前的单点同步该执行哪些
// 幂等动作（ADR-0003：进度延迟、锁实时；同步幂等可重入）。
// 同一输入重复规划得到同一动作列表；执行过的动作改变 tracker 状态后，重新规划不再产生它
// ——幂等语义由「快照事实 + tracker 已有痕迹」共同决定，不含任何时间或随机因素。
//
// 输入形态（从快照票文件与 gh 输出解析到这些结构是读取层的职责，本模块不做文本解析）：
//   snapshot.tickets: [{ num, status, type, mergeSha, escalateReason }]
//     - num: tracker 原生票号（经 normalizeTicket 归一后对键：'1042'、1042 同键）
//     - mergeSha: 合并收尾时记录进快照 Comments 的 merge SHA（无则 null）
//     - escalateReason: 升级上报时记录进快照 Comments 的升级原因（无则 null）
//   snapshot.spec: { num, type, closingNote } | null —— spec 母票（num 由 Source 行解析）
//     - closingNote: 收尾评论（交付指引），封账前同步要求已写入快照
//   tracker.issues: [{ num, state: 'open' | 'closed', assignees: string[], comments: string[] }]
//     - state 用 gh 语义的小写 'open'/'closed'（大写原始值由读取层归一）
//     - assignees / comments 缺省为 []
//   options: { mode: 'seal' } | { mode: 'abandon', claimant: string, reason: string }
//
// 动作集（每个动作与一条 gh 调用一一对应，执行属票 06 的薄 IO）：
//   { kind: 'close',    num, body }   → gh issue close <num> --comment <body>（body=null 不附评论）
//   { kind: 'comment',  num, body }   → gh issue comment <num> --body <body>
//   { kind: 'unassign', num, login }  → gh issue edit <num> --remove-assignee <login>
//
// 幂等矩阵（每个动作三档，测试收敛于 planTrackerSync 的输入输出）：
//   未同步   → 完整动作（关票附评论 / 留评 / 撤占坑+留评）
//   部分同步 → 只补缺的一半（评论已在而未关 → 仅关票不重评；已关而评论缺 → 仅补评论）
//   已同步   → 零动作
// 合并事实优先于升级事实：已合并的票只关票附 SHA，不再补升级评论（无接手人需要上下文）。
// 升级票只留评、不产生任何状态动作——「保持开放」是动作的缺席，不是一条 reopen 指令。
// 非 spec 母票 Status 为 resolved 而无 mergeSha、wontfix 等无合并事实的收尾不在本规划器
// 职责内（对账层的事），规划为零动作。

const { normalizeTicket } = require('./ledger-schema.js');

function reject(reason) {
  throw new Error(`同步规划拒绝：${reason}`);
}

// 评论幂等标记：空白归一后的包含判定——重跑规划不产生重复评论，
// 人工在已推送评论后追加文字也不改判（包含即视为已同步）。
function normalizeText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function hasCommented(comments, marker) {
  const m = normalizeText(marker);
  if (!m) return false;
  return comments.some((c) => normalizeText(c).includes(m));
}

// git SHA 形态：7–40 位十六进制（短 SHA 到完整 SHA 都允许，按原文携带）
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function ticketKey(raw, what) {
  const key = normalizeTicket(raw);
  if (!key) reject(`${what}票号非法：${JSON.stringify(raw ?? null)}`);
  return key;
}

function stringsOrEmpty(value, what) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    reject(`${what} 必须是字符串数组`);
  }
  return value;
}

function planMergeActions(ticket, num, issue) {
  const sha = ticket.mergeSha;
  const body = `已合并（merge SHA：${sha}）`;
  const commented = hasCommented(issue.comments, sha);
  if (issue.state === 'open') {
    // 评论已在（部分同步）→ 仅关票不重评；否则关票附评论
    return [{ kind: 'close', num, body: commented ? null : body }];
  }
  // tracker 已关 → 仅补评论（已含 SHA = 已同步，零动作）
  return commented ? [] : [{ kind: 'comment', num, body }];
}

// spec 收尾：评论携带交付指引（closingNote，封账前已写入快照）后关闭。
// 同样三档幂等：已关已评 → 零动作；未关已评 → 仅关票；已关未评 → 仅补评论。
// 母票仍开放而快照无收尾评论 = 收尾协议未完成，拒绝放行（不猜一个评论去关票）。
function planSpecActions(spec, issue) {
  const note = spec.closingNote;
  if (note == null) {
    if (issue.state === 'open') {
      reject(`spec 母票 ${spec.num} 仍开放但快照无收尾评论（closingNote）——先在快照写入交付指引再同步`);
    }
    return []; // 已关且无待推评论：已同步
  }
  if (typeof note !== 'string' || !note.trim()) {
    reject(`spec 母票收尾评论（closingNote）非法：${JSON.stringify(note)}`);
  }
  if (issue.state === 'open') {
    const commented = hasCommented(issue.comments, note);
    return [{ kind: 'close', num: spec.num, body: commented ? null : note }];
  }
  return hasCommented(issue.comments, note) ? [] : [{ kind: 'comment', num: spec.num, body: note }];
}

// 封账前同步（seal）：合并票关票附 SHA、升级票留评保持开放、spec 母票收尾关闭。
// 票动作按票号数值序（ADR-0004），spec 收尾固定殿后。
function planSeal(snapshot, issues) {
  const actions = [];
  // 先验形态再规划：快照票号逐个归一、重复立即拒绝（验证档），不与动作生成交织
  const tickets = snapshot.tickets
    .map((t) => ({ t, num: ticketKey(t?.num, '快照') }))
    .sort((a, b) => Number(a.num) - Number(b.num));
  const seen = new Set();
  for (const { num } of tickets) {
    if (seen.has(num)) reject(`快照票号重复：${num}`);
    seen.add(num);
  }
  for (const { t, num } of tickets) {
    if (t.mergeSha != null) {
      if (typeof t.mergeSha !== 'string' || !SHA_RE.test(t.mergeSha.trim())) {
        reject(`快照票 ${num} mergeSha 非法：${JSON.stringify(t.mergeSha)}`);
      }
      const issue = issues.get(num);
      if (!issue) reject(`tracker 缺快照票 ${num} 的状态——合并票需要同步关票`);
      actions.push(...planMergeActions(t, num, issue));
    } else if (t.escalateReason != null) {
      if (typeof t.escalateReason !== 'string' || !t.escalateReason.trim()) {
        reject(`快照票 ${num} escalateReason 非法：${JSON.stringify(t.escalateReason)}`);
      }
      const issue = issues.get(num);
      if (!issue) reject(`tracker 缺快照票 ${num} 的状态——升级票需要同步留评`);
      if (!hasCommented(issue.comments, t.escalateReason)) {
        actions.push({ kind: 'comment', num, body: `已升级上报：${t.escalateReason}` });
      }
      // 保持开放：不产生任何状态动作
    }
    // 既无 mergeSha 也无 escalateReason：在途票（claimed/ready）不是同步对象
  }
  const spec = snapshot.spec;
  if (spec) {
    const num = ticketKey(spec.num, 'spec');
    if (spec.type != null && spec.type !== 'spec') {
      reject(`spec 母票 Type 非法：${JSON.stringify(spec.type)}——应为 'spec'`);
    }
    const issue = issues.get(num);
    if (!issue) reject(`tracker 缺 spec 母票 ${num} 的状态——封账前同步需要母票状态`);
    actions.push(...planSpecActions({ ...spec, num }, issue));
  }
  return actions;
}

// 放弃路径（abandon）：撤占坑（移除占坑者 assignee）+ 留评说明；先评论后撤占，
// 部分失败重跑各自续作。放弃只处理占坑面——合并事实的关票由封账同步负责，不在本档。
function planAbandon(snapshot, issues, options) {
  const claimant = options.claimant;
  const reason = options.reason;
  if (typeof claimant !== 'string' || !claimant.trim()) {
    reject('abandon 需要 claimant（占坑的 tracker 用户名）');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    reject('abandon 需要 reason（放弃说明，用于留评）');
  }
  if (!snapshot.spec) reject('abandon 需要快照 spec——撤占坑的对象');
  const num = ticketKey(snapshot.spec.num, 'spec');
  const issue = issues.get(num);
  if (!issue) reject(`tracker 缺 spec 母票 ${num} 的状态——撤占坑需要母票状态`);
  const actions = [];
  if (!hasCommented(issue.comments, reason)) {
    actions.push({ kind: 'comment', num, body: `本 run 已放弃：${reason}` });
  }
  if (issue.assignees.includes(claimant)) {
    actions.push({ kind: 'unassign', num, login: claimant });
  }
  return actions;
}

// （快照状态, tracker 状态）→ 幂等动作列表。拒绝一切形态不合格的输入（拒绝档）。
function planTrackerSync(snapshot, tracker, options) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.tickets)) {
    reject('snapshot.tickets 必须是数组');
  }
  if (!tracker || typeof tracker !== 'object' || !Array.isArray(tracker.issues)) {
    reject('tracker.issues 必须是数组');
  }
  if (!options || typeof options !== 'object') reject('缺 options');
  if (options.mode !== 'seal' && options.mode !== 'abandon') {
    reject(`mode 非法：${JSON.stringify(options.mode ?? null)}——应为 'seal' | 'abandon'`);
  }
  const issues = new Map();
  for (const raw of tracker.issues) {
    const num = ticketKey(raw?.num, 'tracker');
    if (issues.has(num)) reject(`tracker 票号重复：${num}`);
    if (raw.state !== 'open' && raw.state !== 'closed') {
      reject(`tracker 票 ${num} state 非法：${JSON.stringify(raw.state ?? null)}——应为 'open' | 'closed'`);
    }
    issues.set(num, {
      state: raw.state,
      assignees: stringsOrEmpty(raw.assignees, `tracker 票 ${num} assignees`),
      comments: stringsOrEmpty(raw.comments, `tracker 票 ${num} comments`),
    });
  }
  return options.mode === 'seal' ? planSeal(snapshot, issues) : planAbandon(snapshot, issues, options);
}

module.exports = { planTrackerSync };
