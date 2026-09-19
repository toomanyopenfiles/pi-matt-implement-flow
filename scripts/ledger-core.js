'use strict';

// 台账核心判定（纯逻辑，真相层 IO 由 CLI 注入为 truth 对象）：
//   - gateAdd     add 写点的三档校验：拒绝（schema/枚举/状态机/确定矛盾）→ 警告（此刻尚不可核实）→ 矛盾拒绝
//   - closeBlockers 封账资格：每票须有 merge/escalate 事件，或属非任务票（spec 母票 / resolved 研究票）
//   - reconcile   账实差异核验（check 子命令与 build 的对账结论段共用同一判定）
//   - renderLedger 四段台账再生：头部 / 表格 / 时间线 / 对账结论（临时文件+原子替换由 CLI 负责）
//
// 本模块不做任何 IO。truth 注入形状（ledger.js 采集）：
//   {
//     head: '<sha>|null', repoRoot: '<path>|null',
//     worktrees: ['<abs path>', ...],
//     branchExists(name): bool, shaExists(sha): bool, isAncestor(a, b): bool,
//     commitMessage(sha): 'string|null', fileExists(p): bool,
//     mergesWithTokens: [{sha, subject, tokens: ['01',...]}] | null,   // 无 init 基线 → null
//     remoteUrl: 'string|null', probeGh(branch): 'opened-draft'|'ready'|'none'|null,
//     tickets: [{num, file, title, status, type, blockedBy: [...]}],    // 本地 tracker 枚举
//     ticketsWarning: 'string|null',                                   // 枚举不可用的原因
//   }

const TICKET_BRANCH = (num) => `ticket-${num}`;
const short = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');
const pad2 = (n) => String(Number(n)).padStart(2, '0');

function compactTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const emptyIdx = () => ({
  dispatches: [],
  settles: [],
  verdicts: [],
  fixes: [],
  merges: [],
  escalates: [],
});

// 票号 → 该票各类事件的索引（seq 序）。桶名由事件类型映射——分类学加事件时只改这一张表。
const TICKET_BUCKETS = {
  dispatch: 'dispatches',
  settled: 'settles',
  verdict: 'verdicts',
  fix: 'fixes',
  merge: 'merges',
  escalate: 'escalates',
};

function indexByTicket(events) {
  const idx = new Map();
  for (const e of events) {
    const num = e.payload && e.payload.ticket;
    if (!num) continue;
    const t = idx.get(num) ?? emptyIdx();
    const bucket = TICKET_BUCKETS[e.type];
    if (bucket) t[bucket].push(e);
    idx.set(num, t);
  }
  return idx;
}

// 出现过事件的去重票数（renderRecon 与 check 的共用口径）
function countTickets(events) {
  return new Set(events.filter((e) => e.payload?.ticket).map((e) => e.payload.ticket)).size;
}

const isTaskFile = (file) => !file || !file.type || file.type === 'task';

// 本 run 的流程形态（init 快照旗标；D20）。旧账本无旗标 = 默认形态（reviewer on /
// 预算 2 / 并发 3），自然兼容。reviewer=off 时：不记 verdict/fix，merge 无需 verdict。
function flowShape(events) {
  const p = events.find((e) => e.type === 'init')?.payload ?? {};
  return {
    reviewer: p.reviewer === undefined ? true : p.reviewer === 'on',
    maxFixRounds: p.maxFixRounds === undefined ? 2 : Number(p.maxFixRounds),
    maxConcurrent: p.maxConcurrent === undefined ? 3 : Number(p.maxConcurrent),
  };
}

// ------------------------------------------------------------------
// 封账资格：非任务票排除（spec 母票 / resolved 研究票 / wontfix）
// ------------------------------------------------------------------

function closeBlockers({ events, truth }) {
  const idx = indexByTicket(events);
  const blockers = [];
  const seen = new Set();
  const consider = (num, file) => {
    if (seen.has(num)) return;
    seen.add(num);
    if (file) {
      if (file.type === 'spec') return; // spec 母票（永不派发），任意状态不阻塞
      if (file.status === 'wontfix') return;
      if (!isTaskFile(file) && (file.status === 'resolved' || file.status === 'wontfix')) {
        return; // 已 resolved 的研究票等非任务票
      }
    }
    const t = idx.get(num);
    if (t && (t.merges.length || t.escalates.length)) return;
    blockers.push({ num, reason: file ? `Status=${file.status ?? '?'}` : '票文件缺失' });
  };
  for (const t of truth.tickets) consider(t.num, t);
  for (const num of idx.keys()) {
    consider(num, truth.tickets.find((x) => x.num === num) ?? null);
  }
  return blockers;
}

// ------------------------------------------------------------------
// add 写点执法（最小状态机；其余一切只警告不拒绝——编排职权留在 skill）
// ------------------------------------------------------------------

function gateAdd({ events, type, payload, truth }) {
  const reasons = [];
  const warnings = [];

  if (events.some((e) => e.type === 'close')) {
    return {
      ok: false,
      reasons: ['运行已封账（close 已入账，state=complete）——封账后不再接受任何事件；如确需补充，向用户上报并协商'],
      warnings,
    };
  }

  if (type === 'init') {
    if (events.length) reasons.push('init 只能是第一条事件（Round 0 只记账一次）');
    if (payload.baselineSha && !truth.shaExists(payload.baselineSha)) {
      reasons.push(`baselineSha ${payload.baselineSha} 在 git 中不存在——确定性矛盾`);
    }
    if (payload.spec && !truth.fileExists(payload.spec)) {
      reasons.push(
        `spec 文件不存在：${payload.spec}——前置检查结论必须经脚本核实，未验证的结论不得进账`
      );
    }
  } else if (!events.length) {
    reasons.push('运行未初始化：第一条事件必须是 init');
  }
  if (reasons.length) return { ok: false, reasons, warnings };

  const idx = indexByTicket(events);
  const flow = flowShape(events);
  const num = payload.ticket;
  const t = num ? (idx.get(num) ?? emptyIdx()) : null;
  const lastVerdict = t ? t.verdicts.at(-1) : null;
  const fixCount = t ? t.fixes.length : 0;

  switch (type) {
    case 'dispatch': {
      if (payload.worktree && !truth.hasWorktree(payload.worktree)) {
        warnings.push(
          `worktree ${payload.worktree} 尚未出现在 git worktree 列表——此刻尚不可核实（警告不拒绝）`
        );
      }
      if (t && t.dispatches.some((e) => e.payload.key === payload.key)) {
        warnings.push(`派发 key ${payload.key} 在票 ${num} 上已入账过——请确认不是重复派发`);
      }
      break;
    }
    case 'settled': {
      if (!truth.shaExists(payload.headSha)) {
        reasons.push(`headSha ${payload.headSha} 在 git 中不存在——确定性矛盾（拒绝）`);
      }
      if (fixCount + 1 !== Number(payload.round)) {
        warnings.push(
          `settled round=${payload.round} ≠ fix 事件数+1（${fixCount + 1}）——非常规轮次（如集成修复），仅警告`
        );
      }
      if (payload.worktree && !truth.hasWorktree(payload.worktree)) {
        warnings.push(`worktree ${payload.worktree} 不在 git worktree 列表——警告不拒绝`);
      }
      break;
    }
    case 'verdict': {
      if (!flow.reviewer) {
        reasons.push(
          '本 run 的 init 快照 reviewer=off——无评审形态不得记 verdict（流程形态由 init 冻结，中途不改）'
        );
        break;
      }
      if (t && t.verdicts.some((e) => Number(e.payload.round) === Number(payload.round))) {
        reasons.push(`票 ${num} 第 ${payload.round} 轮 verdict 已入账——同票同轮去重，历史不可双写`);
      }
      if (fixCount + 1 !== Number(payload.round)) {
        reasons.push(
          `轮号恒等式违规：verdict round=${payload.round}，但该票已入账 ${fixCount} 条 fix 事件（期望 ${fixCount + 1}）`
        );
      }
      if (t && !t.dispatches.length) {
        warnings.push(`票 ${num} 尚无 dispatch 事件就有 verdict——reviewer 之前的 coder 派发未入账（警告）`);
      }
      if (t && t.merges.length) {
        warnings.push(`票 ${num} 已 merge 又收到 verdict——顺序异常（警告）`);
      }
      break;
    }
    case 'fix': {
      if (!flow.reviewer) {
        reasons.push(
          '本 run 的 init 快照 reviewer=off——无评审形态不存在修复循环，不得记 fix'
        );
        break;
      }
      if (Number(payload.fixNo) !== fixCount + 1) {
        reasons.push(`fixNo=${payload.fixNo} 与已入账 fix 事件数不符（期望 ${fixCount + 1}）`);
      }
      if (fixCount >= flow.maxFixRounds) {
        reasons.push(
          `修复预算已耗尽：票 ${num} 已入账 ${fixCount} 条 fix 事件（本 run 上限 ${flow.maxFixRounds}，来自 init 快照 --max-fix-rounds）——` +
            `应升级上报：add escalate --ticket ${num}，并在票文件留 tracker 评论，不要继续派发修复`
        );
      }
      if (t && !t.dispatches.length) {
        warnings.push(`票 ${num} 尚无 dispatch 事件就有 fix——原 coder 派发未入账（警告）`);
      }
      break;
    }
    case 'merge': {
      if (t && t.merges.length) {
        reasons.push(
          `票 ${num} 已有 merge 事件（mergeSha ${short(t.merges.at(-1).payload.mergeSha)}）——不得重复记账`
        );
      }
      if (flow.reviewer && (!lastVerdict || lastVerdict.payload.verdict !== 'approved')) {
        reasons.push(
          `merge 须该票最近 verdict=approved（当前：${lastVerdict ? lastVerdict.payload.verdict : '无 verdict'}）`
        );
      }
      if (!truth.shaExists(payload.headSha)) {
        reasons.push(`headSha ${payload.headSha} 在 git 中不存在`);
      }
      if (!truth.shaExists(payload.mergeSha)) {
        reasons.push(`mergeSha ${payload.mergeSha} 在 git 中不存在`);
      } else {
        if (truth.head && !truth.isAncestor(payload.mergeSha, truth.head)) {
          reasons.push(
            `mergeSha ${short(payload.mergeSha)} 不是当前 HEAD 的祖先——该合并提交不在特性分支历史中`
          );
        }
        const msg = truth.commitMessage(payload.mergeSha);
        if (msg && !new RegExp(`ticket-${num}`).test(msg)) {
          reasons.push(
            `合并提交信息不含 ticket-${num} 令牌（硬规则：merge 提交信息必须含 ticket-NN，脚本交叉核对依赖该令牌）`
          );
        }
        if (truth.shaExists(payload.headSha) && !truth.isAncestor(payload.headSha, payload.mergeSha)) {
          reasons.push(
            `headSha ${short(payload.headSha)} 不是 mergeSha ${short(payload.mergeSha)} 的祖先——记录的合并与被合并工作不对应`
          );
        }
      }
      break;
    }
    case 'escalate': {
      if (t && t.escalates.length) warnings.push(`票 ${num} 已有 escalate 事件——重复升级（警告）`);
      if (t && !t.dispatches.length) warnings.push(`票 ${num} 尚无 dispatch 事件就升级（警告）`);
      break;
    }
    case 'close': {
      const blockers = closeBlockers({ events, truth });
      if (blockers.length) {
        reasons.push(
          `封账被拒：${blockers.length} 张票未闭环——` +
            blockers.map((b) => `票 ${b.num}（${b.reason}，无 merge/escalate）`).join('；') +
            '。先合并或升级；spec 母票 / resolved 研究票等非任务票不阻塞'
        );
      }
      break;
    }
    default:
      break; // pr / anomaly：无额外门
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

// ------------------------------------------------------------------
// 对账：账实差异核验（check 的退出码语义由此驱动）
// ------------------------------------------------------------------

function reconcile({ events, truth }) {
  const diffs = [];
  const warnings = [...(truth.ticketsWarning ? [truth.ticketsWarning] : [])];
  const sealed = events.some((e) => e.type === 'close');
  const idx = indexByTicket(events);

  // 1) 事件流完整性：单调序号从 1 连续；时间戳不回拨
  events.forEach((e, i) => {
    if (e.seq !== i + 1) {
      diffs.push(`事件流序号异常：第 ${i + 1} 行 seq=${e.seq}，期望 ${i + 1}（append-only 被破坏？）`);
    }
  });
  for (let i = 1; i < events.length; i++) {
    if (String(events[i].ts) < String(events[i - 1].ts)) {
      warnings.push(`第 ${i + 1} 行时间戳早于前一行（时钟回拨？）：${events[i].ts}`);
    }
  }

  const trackerOk = !truth.ticketsWarning;
  const files = new Map(truth.tickets.map((t) => [t.num, t]));

  // 2) 票文件缺失（仅在 tracker 枚举成功时才可判定）
  if (trackerOk) {
    for (const num of idx.keys()) {
      if (!files.has(num)) diffs.push(`票 ${num} 在事件流中出现，但票文件缺失`);
    }
  }

  // 3) 票文件 Status vs 账（含零事件票：任务票被手工 resolved 而账上无迹，同样算漂移）
  for (const [num, file] of files) {
    const t = idx.get(num);
    if (t?.merges.length && file.status !== 'resolved') {
      diffs.push(`票 ${num} 文件 Status 为 ${file.status}，账上已有 merge（应 resolved）`);
    }
    if (isTaskFile(file) && file.status === 'resolved' && !t?.merges.length && !t?.escalates.length) {
      diffs.push(`票 ${num} 文件 Status 为 resolved，账上无 merge/escalate 事件`);
    }
  }

  // 4) 未入账合并：git 有 ticket-NN 令牌的合并提交，事件流无对应 merge 事件
  if (truth.mergesWithTokens === null) {
    if (events.length) warnings.push('无 init 基线——未入账合并扫描不可用（降级）');
  } else {
    for (const m of truth.mergesWithTokens) {
      for (const num of m.tokens) {
        if (!idx.get(num)?.merges.length) {
          diffs.push(`git 有票 ${num} 的合并提交 ${short(m.sha)}，事件流无 merge 事件`);
        }
      }
    }
  }

  // 5) 分支存在性（封账后清理属正常，跳过）
  if (!sealed) {
    const nums = new Set([...files.keys(), ...idx.keys()]);
    for (const num of nums) {
      const t = idx.get(num);
      if (!t) continue;
      const merged = t.merges.length > 0;
      const escalated = t.escalates.length > 0;
      // 分支期望自锚定（settled）起成立：仅派发未结算的票，分支尚未由编排器建立，不核验
      const anchored = t.settles.length > 0;
      const bname = TICKET_BRANCH(num);
      if (!merged && !escalated && anchored && !truth.branchExists(bname)) {
        diffs.push(`票 ${num} 未合并但分支 ${bname} 不存在`);
      }
      if (merged && truth.branchExists(bname)) {
        diffs.push(`票 ${num} 已合并但分支 ${bname} 仍存在（应清理）`);
      }
    }
  }

  return { diffs, warnings };
}

// ------------------------------------------------------------------
// 台账再生（四段 markdown）
// ------------------------------------------------------------------

const TABLE_HEADER =
  '| ticket | title | status | blockedBy | coderRunId | coderWorktree | branch | headSha | mergedIn | fixes | escalated |';
const TABLE_RULE = '|---|---|---|---|---|---|---|---|---|---|---|';

function prState({ events, truth }) {
  const prs = events.filter((e) => e.type === 'pr');
  if (prs.length) return prs.at(-1).payload.state;
  if (!truth.remoteUrl) return 'none';
  if (!/github/i.test(truth.remoteUrl)) return 'unknown';
  const init = events.find((e) => e.type === 'init');
  if (!init) return 'unknown';
  return truth.probeGh(init.payload.branch) ?? 'unknown';
}

function deriveRows({ events, truth, degraded }) {
  const idx = indexByTicket(events);
  const nums = new Map(truth.tickets.map((t) => [t.num, t]));
  for (const num of idx.keys()) if (!nums.has(num)) nums.set(num, null);
  const rows = [];
  for (const num of [...nums.keys()].sort()) {
    const file = nums.get(num);
    const t = idx.get(num) ?? emptyIdx();
    const touched = t.dispatches.length || t.settles.length || t.verdicts.length || t.fixes.length;

    let status;
    if (degraded) status = file?.status ?? 'unknown';
    else if (t.escalates.length) status = 'escalated';
    else if (t.merges.length) status = 'done';
    else if (touched) status = 'claimed';
    else status = isTaskFile(file) ? 'open' : (file?.status ?? 'open');

    const blockedBy = file?.blockedBy?.length ? file.blockedBy.join(', ') : '—';
    const title = String(file?.title ?? '(票文件缺失)').replace(/\|/g, '\\|'); // 转义竖线防破表

    let coderRunId;
    if (degraded) coderRunId = touched || t.merges.length ? 'unknown' : '—';
    else if (t.fixes.length) {
      coderRunId = `${t.dispatches[0]?.payload.runId ?? '?'}→fix ${t.fixes.at(-1).payload.resumeRunId}`;
    } else if (t.dispatches.length) coderRunId = t.dispatches.at(-1).payload.runId;
    else coderRunId = '—';

    let coderWorktree;
    if (degraded) coderWorktree = 'unknown';
    else {
      const wts = [...t.dispatches, ...t.settles].filter((e) => e.payload.worktree);
      if (!wts.length) coderWorktree = '—';
      else {
        const wt = wts.at(-1).payload.worktree;
        coderWorktree = truth.hasWorktree(wt) ? wt : '(已清理)';
      }
    }

    const bname = TICKET_BRANCH(num);
    let branch;
    if (degraded) branch = truth.branchExists(bname) ? bname : '—';
    else if (touched || t.merges.length) {
      branch = bname + (t.merges.length && !truth.branchExists(bname) ? '(已删)' : '');
    } else branch = '—';

    let headSha;
    if (degraded) headSha = touched || t.merges.length ? 'unknown' : '—';
    else {
      const sha = t.settles.at(-1)?.payload.headSha ?? t.merges.at(-1)?.payload.headSha;
      headSha = sha ? short(sha) : '—';
    }

    let mergedIn;
    if (degraded) mergedIn = t.merges.length ? 'unknown' : '—';
    else mergedIn = t.merges.length ? short(t.merges.at(-1).payload.mergeSha) : '—';

    const fixes = degraded ? (t.fixes.length ? 'unknown' : '—') : String(t.fixes.length);
    const escalated = degraded ? (t.escalates.length ? 'unknown' : '—') : t.escalates.length ? 'escalated' : '—';

    rows.push({
      num,
      cells: [num, title, status, blockedBy, coderRunId, coderWorktree, branch, headSha, mergedIn, fixes, escalated],
    });
  }
  return rows;
}

function renderHeader({ events, truth }) {
  const init = events.find((e) => e.type === 'init');
  const close = events.find((e) => e.type === 'close');
  const lines = [];
  if (!init) {
    lines.push('state: unknown（事件流缺失——降级再生）', '');
    return lines.join('\n');
  }
  const p = init.payload;
  lines.push(close ? `state: complete（封账 ${compactTime(close.ts)}）` : 'state: running');
  lines.push(`branch: ${p.branch}`);
  lines.push(`branchBase: ${p.branchBase}`);
  lines.push(`baselineSha: ${p.baselineSha}`);
  lines.push(`spec: ${p.spec}`);
  lines.push(`testCommand: \`${p.testCommand}\``);
  lines.push(`tracker: ${p.tracker}`);
  const flow = flowShape(events);
  lines.push(
    `flow: reviewer=${flow.reviewer ? 'on' : 'off'}, maxFixRounds=${flow.maxFixRounds}, maxConcurrent=${flow.maxConcurrent}`
  );
  lines.push(`pr: ${prState({ events, truth })}`);
  lines.push('');
  return lines.join('\n');
}

function renderTable({ events, truth, degraded }) {
  const rows = deriveRows({ events, truth, degraded });
  const lines = [TABLE_HEADER, TABLE_RULE];
  for (const r of rows) lines.push(`| ${r.cells.join(' | ')} |`);
  lines.push('');
  return lines.join('\n');
}

function renderEvent(e) {
  const p = e.payload ?? {};
  const parts = [];
  switch (e.type) {
    case 'init':
      parts.push(
        `branch=${p.branch}`,
        `branchBase=${p.branchBase}`,
        `baselineSha=${short(p.baselineSha)}`,
        `spec=${p.spec}`,
        `testCommand=\`${p.testCommand}\``,
        `tracker=${p.tracker}`
      );
      if (p.reviewer !== undefined) parts.push(`reviewer=${p.reviewer}`);
      if (p.maxFixRounds !== undefined) parts.push(`maxFixRounds=${p.maxFixRounds}`);
      if (p.maxConcurrent !== undefined) parts.push(`maxConcurrent=${p.maxConcurrent}`);
      break;
    case 'dispatch':
      parts.push(`ticket=${p.ticket}`, `key=${p.key}`, `runId=${p.runId}`);
      if (p.worktree) parts.push(`worktree=${p.worktree}`);
      break;
    case 'settled':
      parts.push(`ticket=${p.ticket}`, `round=${p.round}`, `headSha=${short(p.headSha)}`);
      if (p.worktree) parts.push(`worktree=${p.worktree}`);
      if (p.gate) parts.push(`gate="${p.gate}"`);
      break;
    case 'verdict':
      parts.push(`ticket=${p.ticket}`, `round=${p.round}`, `verdict=${p.verdict}`);
      if (p.findings) parts.push(`findings=${p.findings}`);
      if (p.revRunId) parts.push(`revRunId=${p.revRunId}`);
      break;
    case 'fix':
      parts.push(`ticket=${p.ticket}`, `fixNo=${p.fixNo}`, `key=${p.key}`, `resumeRunId=${p.resumeRunId}`);
      break;
    case 'merge':
      parts.push(`ticket=${p.ticket}`, `headSha=${short(p.headSha)}`, `mergeSha=${short(p.mergeSha)}`);
      break;
    case 'escalate':
      parts.push(`ticket=${p.ticket}`);
      break;
    case 'pr':
      parts.push(`state=${p.state}`);
      if (p.url) parts.push(`url=${p.url}`);
      break;
    case 'close':
      break;
    default:
      for (const [k, v] of Object.entries(p)) parts.push(`${k}=${v}`);
  }
  if (p.note) parts.push(`note="${p.note}"`);
  let line = `[${e.seq}] ${compactTime(e.ts)} ${e.type}${parts.length ? ' ' + parts.join(' ') : ''}`;
  if (e.warn?.length) line += `  ⚠ ${e.warn.join('；')}`;
  return line;
}

function renderTimeline({ events, degraded }) {
  const lines = ['## 时间线', ''];
  if (degraded || !events.length) {
    lines.push('（事件流缺失——时间线不可再生）', '');
    return lines.join('\n');
  }
  for (const e of events) lines.push(`- ${renderEvent(e)}`);
  lines.push('');
  return lines.join('\n');
}

function renderRecon({ events, recon }) {
  const lines = ['## 对账结论', ''];
  if (!recon.diffs.length) {
    lines.push(`✓ 账实一致（票 ${countTickets(events)} 张，事件 ${events.length} 条）`);
  } else {
    lines.push(`✗ 发现 ${recon.diffs.length} 处账实差异：`);
    recon.diffs.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
  }
  for (const w of recon.warnings) lines.push(`⚠ ${w}`);
  lines.push('');
  return lines.join('\n');
}

function renderLedger({ slug, events, truth, recon, degraded }) {
  const lines = [`# ${slug} — implement ledger`, ''];
  lines.push(renderHeader({ events, truth }));
  lines.push(renderTable({ events, truth, degraded }));
  lines.push(renderTimeline({ events, degraded }));
  lines.push(renderRecon({ events, recon }));
  return lines.join('\n');
}

module.exports = {
  TICKET_BRANCH,
  closeBlockers,
  countTickets,
  flowShape,
  gateAdd,
  indexByTicket,
  reconcile,
  renderLedger,
};
