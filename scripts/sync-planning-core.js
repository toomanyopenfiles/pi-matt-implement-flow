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
//   options: { mode: 'seal', runId } | { mode: 'abandon', claimant, reason, runId }
//     - runId: 本 run 的稳定标识（幂等 marker 的 run 标识，必选；非法形态拒绝）
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
// 幂等键（票 02）：隐藏机器 marker `<!-- matt-implement:<runId>:<kind> -->`——同步写到
// tracker 的每条评论以它收尾（HTML 注释，渲染不可见；run 标识 + 动作种类），重入判定
// **只认 marker**：人类改写 / 翻译 / 追加评论正文不影响判定。中文自然语言文本包含判定
// 废除，不留双轨。历史无 marker 评论（旧 run 形态）一律视为未同步、照常推送一次——
// 推送即携带 marker，此后重跑归入 marker 判重（迁移语义：一次性重复，非静默丢失）。
// runId 由调用方传入（CLI 取 --runtime-dir 的目录名，即 feature slug——同一次 run 的
// 稳定标识）；kind 是动作种类词表：merge | escalate | closing | abandon，与四类同步
// 写入（合并关票 / 升级留评 / spec 收尾 / 放弃撤占坑）一一对应。
// 合并事实优先于升级事实：已合并的票只关票附 SHA，不再补升级评论（无接手人需要上下文）。
// 升级票只留评、不产生任何状态动作——「保持开放」是动作的缺席，不是一条 reopen 指令。
// 非 spec 母票 Status 为 resolved 而无 mergeSha、wontfix 等无合并事实的收尾不在本规划器
// 职责内（对账层的事），规划为零动作。

const { normalizeTicket } = require('./ledger-schema.js');

function reject(reason) {
  throw new Error(`同步规划拒绝：${reason}`);
}

// ------------------------------------------------------------------
// 同步幂等机器 marker（票 02）：同步评论的幂等键。
// ------------------------------------------------------------------

// 形态：<!-- matt-implement:<runId>:<kind> -->——HTML 注释，tracker 渲染上人类不可见，
// 照常出现在评论源文里。run 标识 + 动作种类二元组即幂等键：同一 run 的同一动作
// 已推过即视为已同步。
// runId 或任一 kind 中出现界定性字符（冒号 / 注释箭头 / 尖括号 / 换行）都可能在含
// marker 的正文里伪造另一个 marker，构造点即拒绝——不是猜测，是 marker 语法的闭合性。
const MARKER_PART_BAD = /[<>\r\n:]|-->|^\s|\s$/;

function checkMarkerPart(value, what) {
  if (typeof value !== 'string' || !value.trim() || MARKER_PART_BAD.test(value)) {
    reject(`marker ${what} 非法：${JSON.stringify(value ?? null)}——须为非空且不含 < > 回车 或 --> 的字符串`);
  }
  return value;
}

// runId / kind 合法性，判定点与构造点同一校验档。导出给 CLI 入口复用（同一转换点）。
function checkRunId(runId) {
  return checkMarkerPart(runId, 'runId');
}

function ensureKind(kind) {
  return checkMarkerPart(kind, 'kind');
}

// 动作种类（kind）词表：四类同步写入一一对应。词表本身是模块私有约定，判型不依赖；
// 与 tracker 形态无关（后续的契约预设只换命令模板，kind 词表不变）。

// run 标识 + 动作种类 → 隐藏机器 marker 行。
function syncMarker(runId, kind) {
  checkRunId(runId);
  ensureKind(kind);
  return `<!-- matt-implement:${runId}:${kind} -->`;
}

// marker 判定只认完整注释形态 <!-- matt-implement:<runId>:<kind> -->：裸 needle 子串
// （人类引用或无意露出的「matt-implement:…」文字）不算 marker——marker 得是注释形态。
const MARKER_RE = (runId, kind) =>
  new RegExp(`<!--\\s*matt-implement:\\s*${escapeRe(runId)}:\\s*${escapeRe(kind)}\\s*-->`);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// comments 中是否已有（runId, kind）的 marker。幂等判定只认 marker：
// 人类改写 / 翻译 / 追加评论正文不影响判定；无 marker 的历史评论（旧 run 形态）
// 一律视为未同步、照常推送一次——语义见本文件头注。
function hasSyncMarker(comments, runId, kind) {
  checkRunId(runId);
  ensureKind(kind);
  const re = MARKER_RE(runId, kind);
  for (const c of comments ?? []) {
    if (typeof c === 'string' && re.test(c)) return true;
  }
  return false;
}

// 评论幂等（票 02）：幂等键是隐藏机器 marker——幂等判定只认 marker，
// 中文自然语言文本包含判定废除。正文（merge SHA / 升级原因 / 交付指引 / 放弃说明）
// 只面向 tracker 上的人类，不参与任何判定；判重不依赖文本包含（无双重判定遗留）。

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

// 正文 + marker：人类可读正文在首行，marker（隐藏 HTML 注释）附后，不干扰阅读。
const withMarker = (body, kind, runId) => `${body}\n\n${syncMarker(runId, kind)}`;

function planMergeActions(ticket, num, issue, runId) {
  const sha = ticket.mergeSha;
  const body = withMarker(`已合并（merge SHA：${sha}）`, 'merge', runId);
  const commented = hasSyncMarker(issue.comments, runId, 'merge');
  if (issue.state === 'open') {
    // marker 已在（部分同步）→ 仅关票不重评；否则关票附评论
    return [{ kind: 'close', num, body: commented ? null : body }];
  }
  // tracker 已关 → 仅补评论（marker 已在 = 已同步，零动作）
  return commented ? [] : [{ kind: 'comment', num, body }];
}

// spec 收尾：评论携带交付指引（closingNote，封账前已写入快照）后关闭。
// 同样三档幂等：已关已评 → 零动作；未关已评 → 仅关票；已关未评 → 仅补评论。
// 母票仍开放而快照无收尾评论 = 收尾协议未完成，拒绝放行（不猜一个评论去关票）。
function planSpecActions(spec, issue, runId) {
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
  const body = withMarker(note, 'closing', runId);
  const commented = hasSyncMarker(issue.comments, runId, 'closing');
  if (issue.state === 'open') {
    return [{ kind: 'close', num: spec.num, body: commented ? null : body }];
  }
  return commented ? [] : [{ kind: 'comment', num: spec.num, body }];
}

// 封账前同步（seal）：合并票关票附 SHA、升级票留评保持开放、spec 母票收尾关闭。
// 票动作按票号数值序（ADR-0004），spec 收尾固定殿后。
function planSeal(snapshot, issues, runId) {
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
      actions.push(...planMergeActions(t, num, issue, runId));
    } else if (t.escalateReason != null) {
      if (typeof t.escalateReason !== 'string' || !t.escalateReason.trim()) {
        reject(`快照票 ${num} escalateReason 非法：${JSON.stringify(t.escalateReason)}`);
      }
      const issue = issues.get(num);
      if (!issue) reject(`tracker 缺快照票 ${num} 的状态——升级票需要同步留评`);
      if (!hasSyncMarker(issue.comments, runId, 'escalate')) {
        actions.push({ kind: 'comment', num, body: withMarker(`已升级上报：${t.escalateReason}`, 'escalate', runId) });
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
    actions.push(...planSpecActions({ ...spec, num }, issue, runId));
  }
  return actions;
}

// 放弃路径（abandon）：撤占坑（移除占坑者 assignee）+ 留评说明；先评论后撤占，
// 部分失败重跑各自续作。放弃只处理占坑面——合并事实的关票由封账同步负责，不在本档。
function planAbandon(snapshot, issues, options) {
  const runId = checkRunId(options.runId);
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
  if (!hasSyncMarker(issue.comments, runId, 'abandon')) {
    actions.push({ kind: 'comment', num, body: withMarker(`本 run 已放弃：${reason}`, 'abandon', runId) });
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
  // 幂等键（票 02）：run 标识必选——marker <!-- matt-implement:<runId>:<kind> --> 的
  // 中段；合法性在 syncMarker/hasSyncMarker 的构造与判定点统一校验。
  if (typeof options.runId !== 'string' || !options.runId.trim()) {
    reject('options.runId 必选：同步幂等 marker 的 run 标识（本 run 的稳定标识，各写入各自携带）');
  }
  const runId = options.runId;
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
  return options.mode === 'seal' ? planSeal(snapshot, issues, runId) : planAbandon(snapshot, issues, options);
}

module.exports = { planTrackerSync, syncMarker, hasSyncMarker };
