'use strict';
// ============================================================================
// 真实轨迹采集（票 35）：把一次真实会话 + fixture 现场整理成判定器吃的轨迹。
//
// 采集只写「看得见的事实」，够不着的部分如实标进 trace.uncertainty——判定器对不确定的
// 检查一律不判通过：
//   - 会话事件：文件读取、bash 命令（台账动作、测试命令、git 合并、kill）、subagent 派发、
//     收场声称，全部取自平台会话记录（jsonl），不采信任何自述总结；
//   - 派发角色：从派发脚本文件里的 agent 名解析；解析不到就记 agent: null + uncertainty，
//     对照「本分支该派谁」的判定随即降级为无法判定；
//   - 验证与合并顺序：以会话里的验证结果与台账 merge 事件的实际先后判定；
//   - 生命周期：票副本状态与事件流状态在采集时读取（封账那一刻的范围事实按采集时状态
//     近似，标进 uncertainty）。
// 采集器不改动 fixture，也不做任何模型调用。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ledgerState, trackerState, isProcessAlive } = require('./flow-fixture');
const { REVIEWER, FINAL } = require('./agents');

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function tsOf(rec) {
  const m = rec && rec.message;
  if (m && Number.isFinite(m.timestamp)) return m.timestamp;
  if (rec && Number.isFinite(rec.timestamp)) return rec.timestamp;
  return null;
}

const LEDGER_CMD = /scripts\/ledger\.js|ledger\.js\s/;

// bash 命令 → 流程动作（名字与判定器的锚点词表一致）。
//
// 放弃出口的两种形态都要认：有远程写面的契约走 `sync --mode abandon`（放弃同步）；
// 没有远程写面（local / fixture 桩）时那一步不存在，放弃决定就落在
// `add close --outcome abandoned` 上——两者都记 abandon-decision（见下面的补记）。
function actionOfCommand(cmd) {
  if (LEDGER_CMD.test(cmd)) {
    if (/\binit\b/.test(cmd) && !/snapshot-init/.test(cmd)) return 'ledger-init';
    if (/\bsnapshot-init\b/.test(cmd)) return 'snapshot-init';
    if (/\bbuild\b/.test(cmd)) return 'resume';
    if (/\bcheck\b/.test(cmd)) return 'ledger-check';
    if (/\bsync\b/.test(cmd)) return /--mode\s+abandon\b/.test(cmd) ? 'abandon-decision' : 'sync';
    if (/\badd\s+merge\b/.test(cmd)) return 'merge';
    if (/\badd\s+final\b/.test(cmd)) return 'final-review';
    if (/\badd\s+verdict\b/.test(cmd)) return 'verdict';
    if (/\badd\s+fix\b/.test(cmd)) return 'fix-dispatch';
    if (/\badd\s+pr\b/.test(cmd)) return /--state\s+ready\b/.test(cmd) ? 'pr-ready' : 'pr-draft';
    if (/\bclose\b/.test(cmd)) return 'seal';
    return null;
  }
  // 收尾清理（生产第 5、7 步）：只认指向运行目录 / 评审包 / 工作树的删除与移除。
  if (/git\s+worktree\s+remove\b/.test(cmd)) return 'cleanup';
  if (/\brm\s+-[a-z]*[rf]/.test(cmd) && /(\.pi\/matt-implement|\/reviews\b|\.scratch\/)/.test(cmd)) return 'cleanup';
  return null;
}

function flagOf(cmd, flag) {
  const m = cmd.match(new RegExp(`--${flag}\\s+(\\S+)`));
  return m ? m[1] : null;
}

function ticketOfCommand(cmd, fallback = null) {
  const m = cmd.match(/--ticket\s+(\S+)/);
  return m ? m[1] : fallback;
}

// 派发脚本里的 agent 名与形态（文件派发：workflow: "<path>.js"）。
function inspectDispatch(workflowPath, sessionDir, fixtureDir) {
  const candidates = [
    workflowPath,
    path.join(fixtureDir || '.', workflowPath || ''),
    path.join(sessionDir || '.', workflowPath || ''),
  ].filter(Boolean);
  for (const c of candidates) {
    let text = null;
    try { text = fs.readFileSync(c, 'utf8'); } catch { continue; }
    const agent = (text.match(/agent:\s*['"]([\w.-]+)['"]/) || [])[1] || null;
    const axisKeys = ['standards', 'spec'].filter((k) => text.includes(`'${k}'`) || text.includes(`"${k}"`));
    const axis = /axis-axes|runs\.all/.test(text) || axisKeys.length > 0;
    const resume = /resume|acceptance:\s*false/i.test(text);
    return { agent, axis, axisKeys, resume, file: c };
  }
  return { agent: null, axis: false, axisKeys: [], resume: false, file: null };
}

const REVIEWER_VALUES = ['approved', 'changes_requested'];
const FINAL_VALUES = ['ready', 'ready_with_fixes', 'not_ready'];
const VERDICT_RE = /verdict\s*[:：]?\s*`?([a-z_]+)`?/i;

// reviewer 类角色的裁决值来自它的回复文本（角色的输出本身就是裁决）；
// 值不在词表内就不记，绝不猜。
function extractVerdict(text, roleExercise) {
  // 流程场景的裁决必须来自台账记账（add verdict / add final）：模型自述不是裁决证据。
  // 只有角色演练（reviewer / final-reviewer 本身在被测）才从回复文本里取裁决值——
  // 角色的输出就是它的裁决，而双轴等待仍由平台侧事实判定。
  if (!roleExercise) return null;
  const m = String(text || '').match(VERDICT_RE);
  if (!m) return null;
  const value = m[1].toLowerCase();
  const allowed = roleExercise === 'final-reviewer' ? FINAL_VALUES : REVIEWER_VALUES;
  if (!allowed.includes(value)) return null;
  const role = roleExercise === 'final-reviewer' ? FINAL : REVIEWER;
  return { role, value };
}

// 采集一次真实会话 + 现场 → 轨迹。
function harvestTrace({ def, fx, sessionDir }) {
  const events = [];
  const uncertainty = [];
  let clock = 0;
  const push = (e, ts) => {
    clock += 1;
    const ev = { seq: events.length + 1, at: ts == null ? clock : ts, ...e };
    events.push(ev);
    return ev;
  };

  // git 历史里的合并事实（每个 ticket-NN 令牌一条）：用于检测「同一张票被合并了不止一次」。
  // 它们是**历史事实**，不是本次会话的动作——顺序类判定只认会话里的合并动作。
  const gitMerges = spawnSync('git', ['log', '--merges', '--pretty=%H %s'], { cwd: fx.projectDir, encoding: 'utf8' });
  const historyMerges = [];
  if (gitMerges.status === 0) {
    for (const line of (gitMerges.stdout || '').split('\n').filter(Boolean)) {
      const m = line.match(/^([0-9a-f]{40})\s+(.*ticket-(\d+).*)$/i);
      if (!m) continue;
      historyMerges.push({ ticket: m[3], mergeSha: m[1], subject: m[2].slice(0, 120) });
    }
  }
  for (const h of historyMerges) {
    push({ kind: 'merge', ticket: h.ticket, mergeSha: h.mergeSha, source: 'git-log', validated: null, note: h.subject }, null);
  }

  const transcriptFiles = walk(sessionDir).filter((f) => f.endsWith('.jsonl'));
  const records = transcriptFiles.flatMap((f) => readJsonl(f).map((r) => ({ file: f, rec: r })));
  records.sort((a, b) => (tsOf(a.rec) || 0) - (tsOf(b.rec) || 0));

  let lastValidation = null; // 'pass' | 'fail' | null
  let sessionSealed = false;
  let sawDispatchWithoutAgent = false;
  let pendingBashEvents = []; // 本条 bash 命令推入的事件：命令失败就标记为未发生
  let pendingAxisKeys = []; // 阻塞式双轴派发：调用返回 = 两轴都已完成
  let sawNonBlockingAxis = false;
  let sawUnknownAxisAsync = false;
  let lastSyncIdx = -1;

  for (const { rec } of records) {
    const m = rec.message;
    if (!m) continue;
    const ts = tsOf(rec);
    if (m.role === 'assistant') {
      for (const c of m.content || []) {
        if (c.type === 'toolCall' && c.name === 'read' && c.arguments && c.arguments.path) {
          push({ kind: 'read', path: String(c.arguments.path) }, ts);
        }
        if (c.type === 'toolCall' && c.name === 'bash' && c.arguments && c.arguments.command) {
          const cmd = String(c.arguments.command);
          // 台账拒收的命令（exit != 0）不算「发生了这个动作」：采集时把本条命令推入的事件
          // 标成 failed，判定器据此不把它当证据（拒绝的写点不能冒充已记账）。
          pendingBashEvents = [];
          const track = (ev) => { pendingBashEvents.push(ev); return ev; };
          const action = actionOfCommand(cmd);
          if (action === 'merge') {
            track(push({
              kind: 'merge',
              ticket: ticketOfCommand(cmd),
              mergeSha: flagOf(cmd, 'merge-sha'),
              validated: lastValidation === 'pass',
              source: 'ledger-add',
            }, ts));
          } else if (action === 'verdict') {
            track(push({ kind: 'verdict', role: REVIEWER, value: flagOf(cmd, 'verdict'), ticket: ticketOfCommand(cmd), round: flagOf(cmd, 'round'), source: 'ledger-add' }, ts));
          } else if (action === 'final-review') {
            track(push({ kind: 'verdict', role: FINAL, value: flagOf(cmd, 'final-verdict'), source: 'ledger-add' }, ts));
            track(push({ kind: 'action', action: 'final-review', source: 'ledger-add' }, ts));
          } else if (action) {
            track(push({
              kind: 'action',
              action,
              ticket: ticketOfCommand(cmd),
              outcome: /--outcome\s+(\S+)/.exec(cmd)?.[1] || null,
              source: 'ledger-add',
            }, ts));
            if (action === 'sync') lastSyncIdx = events.length - 1;
            if (action === 'seal') sessionSealed = true;
          } else if (/\bgit\s+merge\b/.test(cmd)) {
            const ticket = (cmd.match(/ticket-(\d+)/) || [])[1] || null;
            if (ticket) track(push({ kind: 'merge', ticket, validated: lastValidation === 'pass', source: 'git-merge' }, ts));  // 会话里真的发起的合并
          } else if (/\bkill\b/.test(cmd) && /\d+/.test(cmd)) {
            track(push({ kind: 'action', action: 'stop-child', note: cmd.slice(0, 120) }, ts));
          } else if (/\bnpm\s+(run\s+)?test\b|\bnode\s+--test\b/.test(cmd)) {
            lastValidation = m.isError ? 'fail' : 'pass';
            track(push({ kind: 'validation', result: lastValidation, command: cmd.slice(0, 120) }, ts));
          }
        }
        if (c.type === 'toolCall' && c.name === 'subagent') {
          const args = c.arguments || {};
          const info = inspectDispatch(args.workflow || null, sessionDir, fx.projectDir);
          if (!info.agent) sawDispatchWithoutAgent = true;
          // async 值的实际形态：调用立即返回（true）时，返回不代表两轴完成——issue #6 的失效
          // 条件；这里如实记下来，判定器便不会把「早返回」当成「等到轴完成」。
          const asyncArg = args.async === true || args.async === 'true';
          push({
            kind: 'dispatch', agent: info.agent, axis: Boolean(args.axis) || info.axis, resume: info.resume,
            file: info.file, async: asyncArg, ticket: (String(args.task || '').match(/ticket[- ]?(\d+)/i) || [])[1] || null,
          }, ts);
          if (info.axis && info.axisKeys.length) {
            // 只有明确 async:false（阻塞）时，调用返回才等于两轴完成；没带 async 值时
            // 不能拿返回当证据——一律如实标进不确定性。
            if (args.async === undefined) sawUnknownAxisAsync = true;
            else if (asyncArg) sawNonBlockingAxis = true;
            else pendingAxisKeys = info.axisKeys;
          }
        }
        if (c.type === 'toolCall' && /^(write|edit)$/.test(c.name || '')) {
          const p = (c.arguments || {}).path || (c.arguments || {}).file_path || null;
          push({ kind: 'write', actor: (fx.facts.roleExercise || 'orchestrator'), path: p ? String(p) : null }, ts);
        }
      }
      // 收场文本：作为「声称」记录；若这就是一条裁决本身（reviewer 类角色的输出），
      // 另外记一条 verdict——裁决值是角色的通信内容，双轴等待仍由平台侧事实判定。
      const texts = (m.content || []).filter((c) => c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 30);
      if (texts.length) {
        for (const tx of texts.slice(-1)) {
          push({ kind: 'claim', text: tx.text.slice(0, 2000) }, ts);
          const verdict = extractVerdict(tx.text, (fx.facts && fx.facts.roleExercise) || null);
          if (verdict) push({ kind: 'verdict', role: verdict.role, value: verdict.value, source: 'reply-text' }, ts);
        }
      }
    }
    if (m.role === 'toolResult' && /bash/i.test(m.toolName || '')) {
      if (m.isError) for (const ev of pendingBashEvents) ev.failed = true;
      pendingBashEvents = [];
    }
    // 阻塞式派发的返回：轴派发返回 = 两轴各自已完成（定义要求 async: false，调用阻塞到轴返回）。
    if (m.role === 'toolResult' && /subagent/i.test(m.toolName || '') && pendingAxisKeys.length) {
      for (const key of pendingAxisKeys) {
        push({ kind: 'axis', key, state: 'complete', source: 'blocking-dispatch-returned' }, ts);
      }
      pendingAxisKeys = [];
    }
  }

  // 封账前的最后一次同步 = pre-seal sync（生产流程顺序固定，这里按实际先后判定）。
  if (sessionSealed && lastSyncIdx >= 0) {
    events[lastSyncIdx] = { ...events[lastSyncIdx], action: 'pre-seal-sync', source: 'sync-before-seal' };
  }

  // 放弃决定：没有远程写面的契约没有放弃同步这一步，决定落在 outcome=abandoned 的封账上。
  const abandonSealIdx = events.findIndex((e) => e.kind === 'action' && e.action === 'seal' && e.outcome === 'abandoned');
  if (abandonSealIdx >= 0 && !events.some((e) => e.kind === 'action' && e.action === 'abandon-decision')) {
    events.splice(abandonSealIdx, 0, {
      seq: 0,
      at: clock++,
      kind: 'action',
      action: 'abandon-decision',
      source: 'abandoned-seal-no-remote-surface',
    });
  }

  // 轴完成事实：fixture/会话里没有可靠的轴完成标志时如实标记（判定器据此不判通过）。
  const hasAxisDispatch = events.some((e) => e.kind === 'dispatch' && e.axis);
  if (sawNonBlockingAxis) {
    uncertainty.push('axis-completion:轴派发是 async:true（调用立即返回），返回不代表两轴完成——不得据此判双轴等待成立');
  } else if (sawUnknownAxisAsync && !events.some((e) => e.kind === 'axis')) {
    uncertainty.push('axis-completion:轴派发没有可判定的 async 值，返回不能当作两轴完成的证据');
  } else if (hasAxisDispatch && !events.some((e) => e.kind === 'axis')) {
    uncertainty.push('axis-completion:会话记录里没有轴完成标志，双轴等待只能按派发与裁决顺序近似');
  }
  if (sawDispatchWithoutAgent) uncertainty.push('dispatch-agent:有派发脚本没能解析出 agent 名，分支选择判定降级');

  // 仍在写入的 child：fixture 现场列了 pid，采集时逐个核验是否仍在（放弃场景的「先停 child」证据）。
  const childrenFile = path.join(fx.runtimeDir, 'children.json');
  if (fs.existsSync(childrenFile)) {
    for (const child of JSON.parse(fs.readFileSync(childrenFile, 'utf8'))) {
      const alive = isProcessAlive(child.pid);
      push({ kind: 'child', pid: child.pid, role: child.role || null, state: alive ? 'running' : 'stopped', checkedAt: 'harvest' }, null);
    }
  }

  // 远程写尝试：fixture 的 PATH 桩把每次 gh / glab 调用记在日志里（桩会失败，
  // 所以真实远程写不可能成功——这里记录的是「尝试」这个事实）。
  const remoteLog = (fx.env && fx.env.FIXTURE_REMOTE_LOG) || null;
  if (remoteLog && fs.existsSync(remoteLog)) {
    for (const line of fs.readFileSync(remoteLog, 'utf8').split('\n').filter(Boolean)) {
      const m = line.match(/^(\S+)\s+(.*)$/);
      push({ kind: 'remote-attempt', tool: m ? m[1] : 'unknown', command: m ? m[2].slice(0, 200) : line.slice(0, 200), source: 'fixture-path-stub' }, null);
    }
  }

  // 生命周期：票副本 + 事件流在采集时的状态（封账范围事实按此近似）
  const tracker = trackerState(fx);
  const ledger = ledgerState(fx);
  const lifecycleState = ledger.seals.length ? 'complete' : 'running';
  const openTickets = tracker.open;
  if (sessionSealed) uncertainty.push('lifecycle-openTickets:封账时刻的未完成范围按采集时状态近似');

  const sealIdx = events.findIndex((e) => e.kind === 'action' && e.action === 'seal');
  const lifecycleEvent = {
    kind: 'lifecycle',
    state: lifecycleState,
    openTickets,
    openTicketIds: tracker.openIds,
    source: 'harvest-at-end',
  };
  if (sealIdx >= 0) events.splice(sealIdx, 0, { seq: 0, at: clock++, ...lifecycleEvent });
  else events.push({ seq: 0, at: clock++, ...lifecycleEvent });

  return {
    schema: 'e2e-trace-1',
    scenario: def.id,
    source: 'harvested',
    sessionDir,
    fixture: {
      ...fx.facts,
      openTickets,
      openTicketIds: tracker.openIds,
      openTicketsBefore: (fx.facts.openTickets || []).slice(),
      trackerTickets: tracker.tickets,
      ledgerEvents: ledger.events.length,
      sealed: ledger.seals.length > 0,
    },
    uncertainty,
    events: events.map((e, i) => ({ ...e, seq: i + 1 })),
  };
}

module.exports = { harvestTrace, walk, readJsonl, actionOfCommand, inspectDispatch, extractVerdict, LEDGER_CMD };
