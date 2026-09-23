'use strict';

// 票集解析（tracker 同步核心的第三组纯函数；票 04，ADR-0005）。
// 从 spec 引用与 tracker 的 issue 集合表示解析出一次 run 的票号集合——三层兜底：
//   ① spec issue 的原生 sub-issues（最高优先）
//   ② `## Parent` 边反查（上游 issue-template 自带的正文边：每张工单正文引用 spec issue）
//   ③ init 票号清单（兜底层；同一清单以 --tickets 旗标冻结进账本，防中途偷加票）
// spec 母票不进任务票集合——封账门按 Type: spec 豁免，解析产物与票 02 的转写口径一致。
// 本模块不做任何 IO；票号归一与账本共用 ledger-schema 的 normalizeTicket（单一转换点）。
//
// issue 集合表示（快照初始化的拉取产物，形态由调用方供给）：
//   [{ number: <issue 号>, body: '<正文>', subIssues?: [<issue 号>, ...] }]

const { normalizeTicket } = require('./ledger-schema');

// spec 引用 → issue 号（单一转换点）：GitHub 的 spec 引用是 issue 号 / #号 / issue URL
//（可带 owner/repo 前缀）；local 的 spec 引用是文件路径，不经票号解析（返回 null）。
// 形态外（散文、超 6 位、空值）一律解析不出——调用方按「引用不可用」处理。
function parseSpecRef(specRef) {
  const s = String(specRef ?? '').trim();
  if (/^\d{1,6}$/.test(s)) return normalizeTicket(s);
  let m = /^#(\d{1,6})$/.exec(s);
  if (m) return normalizeTicket(m[1]);
  m = /^[\w.-]+\/[\w.-]+#(\d{1,6})$/.exec(s);
  if (m) return normalizeTicket(m[1]);
  m = /\/issues\/(\d{1,6})(?:[?#].*)?$/.exec(s);
  if (m) return normalizeTicket(m[1]);
  return null;
}

// 正文里的 `## Parent` 边（上游 issue-template 的父子关系信号）。三值返回：
//   null  —— 正文没有 `## Parent` 节（没有边）
//   []    —— 有节但没引用任何 issue 号（有边、无引用）
//   [num] —— 节内引用的 issue 号（去重归一；只支持单一父票，多条即多义，由调用方裁决）
// 节的范围：`## Parent` 独占一行起，到下一个任意级别的标题行（或正文结尾）为止；
// 引用认 `#号` 与 `/issues/号`（URL）两种写法；节外的散文数字不算引用。
const PARENT_HEADING = /^##\s+Parent\s*$/;
const HEADING_LINE = /^#{1,6}\s+\S/;
const NUM_IN_SECTION = /#(\d{1,6})\b|\/issues\/(\d{1,6})\b/g;

function parseParentEdge(body) {
  if (body == null) return null;
  const lines = String(body).split('\n');
  const start = lines.findIndex((l) => PARENT_HEADING.test(l.trim()));
  if (start === -1) return null;
  const refs = [];
  const seen = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_LINE.test(lines[i])) break;
    for (const m of lines[i].matchAll(NUM_IN_SECTION)) {
      const n = normalizeTicket(m[1] ?? m[2]);
      if (n && !seen.has(n)) {
        seen.add(n);
        refs.push(n);
      }
    }
  }
  return refs;
}

// ------------------------------------------------------------------
// 三层解析：spec 引用 + issue 集合表示 → 票号集合
// ------------------------------------------------------------------

// 返回 { ok, specNum, tickets, source, errors, warnings }：
//   ok=true   —— tickets 即本 run 的任务票集合（去重、数值序；不含 spec 母票），
//                source 标记命中的层：'sub-issues' | 'parent-edges' | 'init-list'
//   ok=false  —— 票集边界不可定（spec 引用不可用 / 不在集合、非法票号、多义 Parent、
//                三层皆空）；tickets 为空，errors 点名原因
// 拒绝语义（票 04）：非法票号与空集合拒绝；多义 Parent 只在边涉及本 spec 时拒绝——
// 不涉本 spec 的多义边是别家 spec 的共享票，与本 run 的票集边界无关。
function resolveTicketSet({ issues, specRef, initTickets } = {}) {
  const errors = [];
  const warnings = [];
  const no = () => ({ ok: false, specNum: null, tickets: [], source: null, errors, warnings });

  const specNum = parseSpecRef(specRef);
  if (!specNum) {
    errors.push(
      `spec 引用无法解析出 issue 号：${JSON.stringify(specRef ?? '')}——` +
        'GitHub 传 issue 号 / #号 / issue URL（local 传 spec 文件路径，不经此解析）'
    );
    return no();
  }

  const list = Array.isArray(issues) ? issues : [];
  const numOf = (it) => (it == null ? null : normalizeTicket(it.number));
  const spec = list.find((it) => numOf(it) === specNum);
  if (!spec) {
    errors.push(`spec 引用指向的 issue ${specNum} 不在 issue 集合中——快照拉取不全或引用有误`);
    return no();
  }

  const dedupeSorted = (nums) => [...new Set(nums)].sort((a, b) => Number(a) - Number(b));
  // 收集一层票号：非法形态整层拒绝；spec 母票排除（封账门 Type: spec 豁免的产物口径）。
  const collect = (tokens, what) => {
    const nums = [];
    for (const tok of tokens ?? []) {
      const n = normalizeTicket(tok);
      if (!n) {
        errors.push(`${what} 含非法票号：${JSON.stringify(tok)}（票号是 1–6 位数字）`);
        return null;
      }
      nums.push(n);
    }
    return dedupeSorted(nums.filter((n) => n !== specNum));
  };

  // init 票号清单（层 ③ 兜底源，也是 --tickets 冻结边界的同一清单）：无论命中哪一层，
  // 先做形态校验——吞掉非法清单会掩盖冻结边界的坏数据。
  const initList = collect(initTickets ?? [], 'init 票号清单');
  if (initList === null) return no();

  // 层 ①：spec issue 的原生 sub-issues
  const layer1 = collect(spec.subIssues ?? [], `spec ${specNum} 的 sub-issues`);
  if (layer1 === null) return no();

  // 层 ②：## Parent 边反查（仅当层 ① 无成员才作为定界依据——兜底链不合并）。
  // 多义边只在引用了本 spec 时拒绝（边界因此不定）；与他 spec 的多义边与本 run 无关。
  let layer2 = [];
  if (!layer1.length) {
    const candidates = [];
    for (const it of list) {
      const num = numOf(it);
      if (!num || num === specNum) continue;
      const refs = parseParentEdge(it.body);
      if (refs === null) continue;
      if (refs.length > 1 && refs.includes(specNum)) {
        errors.push(
          `多义 Parent：票 ${num} 的 ## Parent 边同时引用 ${refs.join('、')}——` +
            '无法判定其父票，票集边界不定；先在 tracker 修正该 issue 的 Parent 边再重跑'
        );
        return no();
      }
      if (refs.length === 1 && refs[0] === specNum) candidates.push(num);
    }
    layer2 = dedupeSorted(candidates);
  }

  // 层 ③：init 票号清单兜底（上两层任一有成员即不启用）
  let layer3 = [];
  if (!layer1.length && !layer2.length) layer3 = initList;

  if (layer1.length) return { ok: true, specNum, tickets: layer1, source: 'sub-issues', errors, warnings };
  if (layer2.length) return { ok: true, specNum, tickets: layer2, source: 'parent-edges', errors, warnings };
  if (layer3.length) return { ok: true, specNum, tickets: layer3, source: 'init-list', errors, warnings };
  errors.push(
    `票集边界三层皆空：spec ${specNum} 无 sub-issues，## Parent 反查无子票，` +
      'init 票号清单未提供或为空——无法确定本 run 的票集；' +
      '先在 tracker 补齐关系，或以 init --tickets 显式给定清单'
  );
  return no();
}

module.exports = { parseSpecRef, parseParentEdge, resolveTicketSet };
