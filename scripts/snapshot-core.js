'use strict';

// 快照布局核心（纯逻辑模块，无 IO）——票 05，快照初始化子命令（ledger.js snapshot-init）的
// 纯判定层。把三件事编排成一份快照文件清单：
//   ① 票集解析（tracker-set-core.resolveTicketSet，票 04：sub-issues → ## Parent 反查 →
//      init 票号清单三层兜底）——快照只含本 run 票集边界内的票；
//   ② 转写（tracker-sync-core，票 02）：spec 母票带 Source: 行（tracker 原址）与 Type: spec
//      豁免标记，工单走同一张状态/类型/阻塞映射表——与 local 票文件同构；
//   ③ 文件名布局：spec.md + issues/<号>-<slug>.md（文件名带 tracker 原生票号，票号归一
//      共用 ledger-schema.normalizeTicket 单一转换点）。
//
// slug 口径：标题折成 ASCII [a-z0-9] kebab 词段（符号/空白/CJK 一律折叠为分隔或删除）；
// 折叠后为空（如纯中文标题）→ 裸 <号>.md——文件名仍带原生票号。不猜音译：确定性优先于
// 可读性（同一批 issue 数据任何时刻得到同一文件名）。
//
// 落盘（临时目录整体改名、全部成功才可见）与 gh 收发（best-effort 薄 IO）属 ledger.js，
// 不在本模块；快照已存在的拒绝判定（checkOverwrite）以 exists 谓词注入保持纯函数。

const { normalizeTicket } = require('./ledger-schema');
const { resolveTicketSet } = require('./tracker-set-core');
const { transcribeSpec, transcribeTicket } = require('./tracker-sync-core');

// 标题 → 文件名 slug（确定性；无 locale、无随机）
function slugify(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 工单文件名：issues/<号>-<slug>.md；slug 为空退化 issues/<号>.md
function ticketFileRel(num, title) {
  const slug = slugify(title);
  return slug ? `issues/${num}-${slug}.md` : `issues/${num}.md`;
}

// ------------------------------------------------------------------
// 快照布局规划
// ------------------------------------------------------------------

// 输入：tracker 的 issue 集合表示（gh 拉取产物，票 04 的调用方契约）+ spec 引用 +
// 可选 init 票号清单（兜底层，与 add init --tickets 同一清单）。
// 返回 { ok, specNum, source, spec, tickets, errors, warnings }：
//   ok=true   —— spec: { rel, text, source（tracker 原址 URL）}；tickets: [{num, rel, text}]
//                （spec.md 在前，票按数值序）；source 为票集解析命中的层。
//   ok=false  —— 票集边界不可定 / 转写拒绝（如缺 Source）：spec 为 null、tickets 为空、
//                errors 点名原因——调用方不得落盘。
function planSnapshot({ issues, specRef, initTickets } = {}) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(issues) ? issues : [];

  const set = resolveTicketSet({ issues: list, specRef, initTickets });
  warnings.push(...set.warnings);
  if (!set.ok) {
    return {
      ok: false,
      specNum: set.specNum,
      source: null,
      spec: null,
      tickets: [],
      errors: [...set.errors],
      warnings,
    };
  }

  // 票号 → issue（批内重号取首个：resolveTicketSet 的集合口径以先见者为准）
  const byNum = new Map();
  for (const it of list) {
    const n = normalizeTicket(it?.number);
    if (n && !byNum.has(n)) byNum.set(n, it);
  }

  // 边界票号不在拉取集合中是用户可见事实，不是内部不变量：--tickets 清单笔误/越界
  //（用户输入）与 gh issue list --limit 1000 截断（拉取不全）都会造成缺口——诊断点名
  // 两种成因与重跑前置，不伪装成程序错误。
  const missing = set.tickets.filter((num) => !byNum.has(num));
  if (missing.length) {
    errors.push(
      `票集边界内的票 ${missing.join('、')} 不在拉取的 issue 集合中——` +
        (set.source === 'init-list'
          ? '--tickets 清单笔误或越界（用户输入），'
          : '票集边界指向了未被拉到的票，') +
        '或 gh issue list --limit 1000 截断导致拉取不全；核对票号与 tracker 状态后重跑'
    );
    return {
      ok: false,
      specNum: set.specNum,
      source: null,
      spec: null,
      tickets: [],
      errors,
      warnings,
    };
  }

  try {
    const specIssue = byNum.get(set.specNum);
    const spec = transcribeSpec({ issue: specIssue });
    // transcribeSpec 不回传 Source 值——从同一 issue 再取一次（同源，无第二真相面）
    const sourceUrl = specIssue.url ?? specIssue.html_url ?? null;
    const tickets = set.tickets.map((num) => {
      const issue = byNum.get(num);
      return { num, rel: ticketFileRel(num, issue.title), text: transcribeTicket(issue) };
    });
    return {
      ok: true,
      specNum: set.specNum,
      source: set.source,
      spec: { rel: 'spec.md', text: spec, source: sourceUrl },
      tickets,
      errors,
      warnings,
    };
  } catch (e) {
    errors.push(`快照转写拒绝：${e.message}`);
    return {
      ok: false,
      specNum: set.specNum,
      source: null,
      spec: null,
      tickets: [],
      errors,
      warnings,
    };
  }
}

// ------------------------------------------------------------------
// 续跑保护：快照已存在的拒绝判定
// ------------------------------------------------------------------

// snapshotDir 是快照根目录（<runtime-dir>/tracker）的绝对路径；fileExists 谓词注入。
// 快照是一个整体（spec + 全部票文件）：根目录已存在即视为快照已存在，拒绝执行——
// 既有内容零覆盖；续跑经台账再生与对账重建状态，绝不重新拉取（ADR-0003）。
function checkOverwrite({ snapshotDir, fileExists }) {
  const conflicts = fileExists?.(snapshotDir) ? [snapshotDir] : [];
  return { ok: !conflicts.length, conflicts };
}

module.exports = { slugify, planSnapshot, checkOverwrite };
