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

const { ledgerState, trackerState } = require('./flow-fixture');

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
function actionOfCommand(cmd) {
  if (!LEDGER_CMD.test(cmd)) return null;
  if (/\binit\b/.test(cmd) && !/snapshot-init/.test(cmd)) return 'ledger-init';
  if (/\bsnapshot-init\b/.test(cmd)) return 'snapshot-init';
  if (/\bbuild\b/.test(cmd)) return 'resume';
  if (/\bcheck\b/.test(cmd)) return 'ledger-check';
  if (/\bsync\b/.test(cmd)) return 'sync';
  if (/\badd\s+merge\b/.test(cmd)) return 'merge';
  if (/\badd\s+final\b/.test(cmd)) return 'final-review';
  if (/\badd\s+fix\b/.test(cmd)) return 'fix-dispatch';
  if (/\bclose\b/.test(cmd)) return 'seal';
  return null;
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
    const axis = /axis-axes|runs\.all/.test(text) || /['"](standards|spec)['"]/.test(text);
    const resume = /resume|acceptance:\s*false/i.test(text);
    return { agent, axis, resume, file: c };
  }
  return { agent: null, axis: false, resume: false, file: null };
}

// 采集一次真实会话 + 现场 → 轨迹。
function harvestTrace({ def, fx, sessionDir }) {
  const events = [];
  const uncertainty = [];
  let clock = 0;
  const push = (e, ts) => {
    clock += 1;
    events.push({ seq: events.length + 1, at: ts == null ? clock : ts, ...e });
  };

  const transcriptFiles = walk(sessionDir).filter((f) => f.endsWith('.jsonl'));
  const records = transcriptFiles.flatMap((f) => readJsonl(f).map((r) => ({ file: f, rec: r })));
  records.sort((a, b) => (tsOf(a.rec) || 0) - (tsOf(b.rec) || 0));

  let lastValidation = null; // 'pass' | 'fail' | null
  let sessionSealed = false;
  let sawDispatchWithoutAgent = false;

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
          const action = actionOfCommand(cmd);
          if (action === 'merge') {
            push({ kind: 'merge', ticket: ticketOfCommand(cmd), validated: lastValidation === 'pass', source: 'ledger-add' }, ts);
          } else if (action) {
            push({ kind: 'action', action, ticket: ticketOfCommand(cmd), outcome: /--outcome\s+(\S+)/.exec(cmd)?.[1] || null }, ts);
            if (action === 'seal') sessionSealed = true;
          } else if (/\bgit\s+merge\b/.test(cmd)) {
            const ticket = (cmd.match(/ticket-(\d+)/) || [])[1] || null;
            if (ticket) push({ kind: 'merge', ticket, validated: lastValidation === 'pass', source: 'git-merge' }, ts);
          } else if (/\bkill\b/.test(cmd) && /\d+/.test(cmd)) {
            push({ kind: 'action', action: 'stop-child', note: cmd.slice(0, 120) }, ts);
          } else if (/\bnpm\s+(run\s+)?test\b|\bnode\s+--test\b/.test(cmd)) {
            lastValidation = m.isError ? 'fail' : 'pass';
            push({ kind: 'validation', result: lastValidation, command: cmd.slice(0, 120) }, ts);
          }
        }
        if (c.type === 'toolCall' && c.name === 'subagent') {
          const args = c.arguments || {};
          const info = inspectDispatch(args.workflow || null, sessionDir, fx.projectDir);
          if (!info.agent) sawDispatchWithoutAgent = true;
          push({ kind: 'dispatch', agent: info.agent, axis: Boolean(args.axis) || info.axis, resume: info.resume, file: info.file, ticket: (String(args.task || '').match(/ticket[- ]?(\d+)/i) || [])[1] || null }, ts);
        }
        if (c.type === 'toolCall' && /^(write|edit)$/.test(c.name || '')) {
          const p = (c.arguments || {}).path || (c.arguments || {}).file_path || null;
          push({ kind: 'write', actor: (fx.facts.roleExercise || 'orchestrator'), path: p ? String(p) : null }, ts);
        }
      }
      // 收场声称：只取助手文本，作为「声称」而不是事实
      const texts = (m.content || []).filter((c) => c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 30);
      if (texts.length) {
        for (const tx of texts.slice(-1)) push({ kind: 'claim', text: tx.text.slice(0, 2000) }, ts);
      }
    }
  }

  // 轴完成事实：fixture/会话里没有可靠的轴完成标志时如实标记（判定器据此不判通过）。
  const axisKeys = ['standards', 'spec'];
  const hasAxisDispatch = events.some((e) => e.kind === 'dispatch' && e.axis);
  if (hasAxisDispatch && !events.some((e) => e.kind === 'axis')) {
    uncertainty.push('axis-completion:会话记录里没有轴完成标志，双轴等待只能按派发与裁决顺序近似');
  }
  if (sawDispatchWithoutAgent) uncertainty.push('dispatch-agent:有派发脚本没能解析出 agent 名，分支选择判定降级');

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
  const lifecycleEvent = { kind: 'lifecycle', state: lifecycleState, openTickets, source: 'harvest-at-end' };
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
      trackerTickets: tracker.tickets,
      ledgerEvents: ledger.events.length,
      sealed: ledger.seals.length > 0,
    },
    uncertainty,
    events: events.map((e, i) => ({ ...e, seq: i + 1 })),
  };
}

module.exports = { harvestTrace, walk, readJsonl, actionOfCommand, inspectDispatch, LEDGER_CMD };
