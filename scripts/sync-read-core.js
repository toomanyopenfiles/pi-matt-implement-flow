'use strict';

// tracker 同步读取层（纯逻辑模块，无 IO）——票 06，同步子命令（ledger.js sync）的
// 纯判定层。把两个外部形态解析成同步规划器（sync-planning-core，票 03）的输入结构：
//   ① 快照 → snapshot：tracker/ 快照目录读出的 spec.md 与 issues/<号>-<slug>.md，
//      解析 Status/Type 行与 ## Comments 节里的同步事实（merge SHA / escalate 原因 /
//      closing 交付指引）。run 期间编排器只写快照（ADR-0003：快照是待推送的真相），
//      本层把这些事实交还规划器。
//   ② gh issue view 产物 → tracker：gh 语义（大写 state、对象数组）归一为规划器
//      的 tracker 状态（小写 open/closed、login/body 字符串数组）。
//
// 快照 Comments 事实约定（写入侧是编排流程文档，票 07 对齐措辞）：
//   - 票文件 Comments 节里 `merge SHA: <sha>`（或收尾评论 `已合并（merge SHA：<sha>）`
//     的自然写法——同一宽容口径）→ mergeSha
//   - 票文件 Comments 节里 `escalate: <原因>`（或 `已升级上报：<原因>`）→ escalateReason
//   - spec.md Comments 节里 `closing: <交付指引>`（或 `收尾：<交付指引>`）→ closingNote
// 事实只认 Comments 节内的行（追加语义：多个 Comments 节取最后一个——最新在最下）；
// 节外的散文提及不算事实。
//
// 本模块不做任何 IO：文件读取与目录枚举以谓词注入（readFile/listDir/exists），
// gh 产物由调用方解析为 JS 数组后直喂。拒绝语义：快照形态不合格整体拒绝（errors
// 点名原因），不在读取层发明猜测性缺省。

const { normalizeTicket } = require('./ledger-schema');

// 与 ledger.js parseTicketFile 的 grab 同一宽容形态：**Status:** x 与 Status: x 皆读
const META_LINE = (label) => new RegExp(`^\\**\\s*${label}\\s*:\\**\\s*(.*)$`, 'mi');

// Comments 节：从最后一个 `## Comments` 标题行到文件尾（local tracker 约定的追加位置；
// 追加语义下若有多个节，最后一个即最新）。
const COMMENTS_HEADING = /(?:^|\n)##\s+Comments\s*(?:$|\n)/g;

// 同步事实行（Comments 节内）：merge SHA（半/全角冒号、是否带列表符皆宽容）、
// escalate（或规划器同源的 已升级上报：前缀）、closing（或中文 收尾：）。
const MERGE_SHA_FACT = /merge\s*SHA\s*[：:]\s*([0-9a-f]{7,40})/i;
const ESCALATE_FACT = /^(?:[-*]\s*)?(?:escalate|已升级上报)\s*[：:]\s*(.+)$/im;
const CLOSING_FACT = /^(?:[-*]\s*)?(?:closing|收尾)\s*[：:]\s*(.+)$/im;

// git SHA 形态取 7–40 位十六进制——与 sync-planning-core 的 SHA_RE 同一口径；
// 形态合法性由规划器统一校验（单一校验点），读取层只忠实提取。

function commentsText(text) {
  const all = [...String(text ?? '').matchAll(COMMENTS_HEADING)];
  if (!all.length) return null;
  const last = all[all.length - 1];
  return String(text).slice(last.index + last[0].length);
}

// 快照票文件文本 → { mergeSha, escalateReason }（事实缺省 null）
function parseCommentsFacts(text) {
  const comments = commentsText(text);
  if (comments == null) return { mergeSha: null, escalateReason: null };
  const sha = MERGE_SHA_FACT.exec(comments);
  const escalate = ESCALATE_FACT.exec(comments);
  return {
    mergeSha: sha ? sha[1] : null,
    escalateReason: escalate ? escalate[1].trim() : null,
  };
}

// spec.md 文本 → { num, repo, url } | null：Source 行记录 tracker 原址（票 05 转写产物），
// 母票号与 owner/repo 都从该行来——同步按它定位收尾对象与 gh -R，不依赖 cwd 的 git remote。
// 解析不出（缺行 / 非 GitHub issue URL）返回 null，调用方按拒绝处理（不猜）。
function parseSourceLine(text) {
  if (text == null) return null;
  const m = /^Source:\s*(\S+)\s*$/m.exec(String(text));
  if (!m) return null;
  const url = m[1];
  const u = /github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d{1,6})/.exec(url);
  if (!u) return null;
  const num = normalizeTicket(u[3]);
  if (!num) return null;
  return { num, repo: `${u[1]}/${u[2]}`, url };
}

// 快照目录 → planTrackerSync 的 snapshot 输入。
// 返回 { ok, tickets, spec, source, errors, warnings }：
//   ok=true   —— tickets: [{ num, status, type, mergeSha, escalateReason }]（数值序），
//                spec: { num, type, closingNote }（spec.md 缺 Type 行时 type=null），
//                source: { repo, url }（spec.md 的 Source 行——gh 收发的 -R 固定于此）
//   ok=false  —— 快照缺失 / spec.md 缺失或 Source 不可解析 / issues 目录缺失：
//                tickets 与 spec 为空，errors 点名原因——调用方不得进入规划。
// 无数字前缀的杂散文件跳过并警告（与账本枚举同一先例）；快照票号重复不在本层去重
// ——原样交给规划器拒绝（单一校验点）。
function readSnapshot({ trackerDir, readFile, listDir, exists }) {
  const errors = [];
  const warnings = [];
  if (!exists?.(trackerDir)) {
    return {
      ok: false,
      tickets: [],
      spec: null,
      source: null,
      errors: [`快照不存在：${trackerDir}`],
      warnings,
    };
  }
  let specText = null;
  try {
    specText = readFile(`${trackerDir}/spec.md`);
  } catch {
    errors.push(`快照缺 spec.md——快照不完整（spec 母票的收尾对象不可定位）`);
  }
  let issueFiles = null;
  try {
    issueFiles = listDir(`${trackerDir}/issues`);
  } catch {
    errors.push(`快照缺 issues 目录——快照不完整（票文件不可枚举）`);
  }
  if (errors.length) return { ok: false, tickets: [], spec: null, source: null, errors, warnings };

  const src = parseSourceLine(specText);
  if (!src) {
    errors.push('spec.md 缺合法的 Source 行（GitHub issue URL）——无法定位 spec 母票与 tracker 原址');
    return { ok: false, tickets: [], spec: null, source: null, errors, warnings };
  }
  const grabSpec = (label) => {
    const m = META_LINE(label).exec(specText);
    return m ? m[1].replace(/\*+/g, '').trim() : null;
  };
  const specComments = commentsText(specText) ?? '';
  const closing = CLOSING_FACT.exec(specComments);
  const spec = {
    num: src.num,
    type: grabSpec('Type'),
    closingNote: closing ? closing[1].trim() : null,
  };

  const tickets = [];
  for (const name of issueFiles.filter((n) => n.endsWith('.md')).sort()) {
    const m = /^(\d+)/.exec(name);
    if (!m) {
      warnings.push(`快照内非票文件跳过：${name}`);
      continue;
    }
    const num = normalizeTicket(m[1]);
    if (!num) {
      warnings.push(`快照票文件名票号非法，跳过：${name}（票号是 1–6 位数字）`);
      continue;
    }
    const text = readFile(`${trackerDir}/issues/${name}`);
    const grab = (label) => {
      const mm = META_LINE(label).exec(text);
      return mm ? mm[1].replace(/\*+/g, '').trim() : null;
    };
    const facts = parseCommentsFacts(text);
    tickets.push({
      num,
      status: grab('Status'),
      type: grab('Type'),
      mergeSha: facts.mergeSha,
      escalateReason: facts.escalateReason,
    });
  }
  tickets.sort((a, b) => Number(a.num) - Number(b.num));
  // source（tracker 原址）：同步的 gh 收发按它固定 -R——快照来自哪个 tracker 就推回哪个，
  // 不依赖 cwd 的 git remote。
  return { ok: true, tickets, spec, source: { repo: src.repo, url: src.url }, errors, warnings };
}

// gh issue view 产物数组 → planTrackerSync 的 tracker.issues。
// gh 语义 → 规划器语义：state 大写归小写、assignees 对象取 login、comments 对象取 body；
// 字段缺省为 []（规划器输入形态的缺省约定）。state 与票号形态合法性由规划器统一校验。
function toTrackerIssues(views) {
  return (views ?? []).map((v) => ({
    num: normalizeTicket(v?.number),
    state: String(v?.state ?? '').trim().toLowerCase(),
    assignees: (v?.assignees ?? []).map((a) => a?.login).filter((l) => typeof l === 'string' && l),
    comments: (v?.comments ?? []).map((c) => c?.body).filter((b) => typeof b === 'string' && b),
  }));
}

module.exports = { parseCommentsFacts, parseSourceLine, readSnapshot, toTrackerIssues };
