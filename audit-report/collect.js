'use strict';
// 收集器：从一次已完成的流程运行目录出发，汇集全部旁路证据，产出中间模型（纯数据，无渲染）。
//
// 数据源（全部只读）：
//   1. <runtimeDir>/events.jsonl      事件流（时间线与状态机的骨架）
//   2. <repo>/.scratch|spec|issues    票文件与 spec（票标题、票面原文）
//   3. <runtimeDir>/notes.md          编排笔记（散文记忆）
//   4. <runtimeDir>/reviews|findings  评审材料包与问题清单（评审者的输入与输出）
//   5. ~/.pi/agent/sessions/<repo>--/subagent-artifacts/<runId>_*   每个子代理运行的证据四件套
//   6. ~/.pi/agent/sessions/<repo>--/*.jsonl   主会话（恢复每次派发的原始任务书全文）
//   7. git（只读查询）                提交存在性与标题
//
// 设计原则：任何一层缺失都降级为标注（warnings），绝不因单点缺失崩溃；
// 不调用 LLM。对主流程文件与目标仓库源码只读；报告默认写入运行目录下的
// report/（该路径已被 gitignore，属运行期产物区），可用 --out 指到仓库外。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const MAX_TEXT = 400 * 1024; // 单文件收录上限，超出截断并标注

// ---------------------------------------------------------------- 基础工具

function readText(file, { max = MAX_TEXT } = {}) {
  try {
    if (!fs.existsSync(file)) return null;
    const s = fs.readFileSync(file, 'utf8');
    if (s.length > max) return { truncated: true, length: s.length, text: s.slice(0, max) };
    return { truncated: false, length: s.length, text: s };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { parseError: String(e.message || e) };
  }
}

function warn(warnings, code, detail) {
  warnings.push({ code, detail });
}

// ---------------------------------------------------------------- 事件流

function parseEvents(runtimeDir, warnings) {
  const file = path.join(runtimeDir, 'events.jsonl');
  if (!fs.existsSync(file)) {
    warn(warnings, 'events-missing', `事件流不存在：${file}`);
    return [];
  }
  const raw = readText(file);
  if (!raw || typeof raw.text !== 'string') {
    warn(warnings, 'events-unreadable', `事件流不可读：${file}`);
    return [];
  }
  const events = [];
  for (const [i, line] of raw.text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      warn(warnings, 'event-parse', `第 ${i + 1} 行不是合法 JSON，已跳过`);
    }
  }
  events.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return events;
}

// ---------------------------------------------------------------- 运行模型（票 × 轮）

const RUN_ROLE_BY_TYPE = {
  dispatch: 'coder',
  fix: 'coder-resume',
  verdict: 'reviewer',
};

// 角色 → 中文标签：全工具唯一共享表（collect 与 render 共用，避免双表漂移）
const ROLE_LABEL = {
  coder: '实现者',
  'coder-resume': '实现者（续跑）',
  reviewer: '评审者',
  'final-reviewer': '终审',
};

function emptyTicket(id) {
  return { id, title: null, file: null, dispatches: [], settles: [], verdicts: [], fixes: [], merges: [] };
}

function buildRunModel(events) {
  const run = { init: null, prs: [], close: null, anomalies: [], escalates: [] };
  const tickets = new Map();
  const runRefs = []; // {runId, ticket, key, role, seq, ts}
  const ticketOf = (id) => {
    if (!tickets.has(id)) tickets.set(id, emptyTicket(id));
    return tickets.get(id);
  };
  for (const e of events) {
    const p = e.payload || {};
    switch (e.type) {
      case 'init': run.init = { ...p, seq: e.seq, ts: e.ts }; break;
      case 'pr': run.prs.push({ ...p, seq: e.seq, ts: e.ts }); break;
      case 'anomaly': run.anomalies.push({ seq: e.seq, ts: e.ts, note: p.note || '' }); break;
      case 'escalate': run.escalates.push({ seq: e.seq, ts: e.ts, ticket: p.ticket, note: p.note || '' }); break;
      case 'close': run.close = { seq: e.seq, ts: e.ts, note: p.note || '' }; break;
      case 'dispatch': {
        const t = ticketOf(p.ticket);
        // 修复后的重派发（fallback fresh coder）事件无 round 字段：按该票已消耗的修复数归入下一轮
        const round = p.round != null ? Number(p.round) : t.fixes.length + 1;
        t.dispatches.push({ seq: e.seq, ts: e.ts, key: p.key, runId: p.runId, worktree: p.worktree, note: p.note || '', round });
        if (p.runId) runRefs.push({ runId: p.runId, ticket: p.ticket, key: p.key, role: RUN_ROLE_BY_TYPE.dispatch, seq: e.seq, ts: e.ts });
        break;
      }
      case 'settled': {
        const t = ticketOf(p.ticket);
        t.settles.push({ seq: e.seq, ts: e.ts, round: p.round, headSha: p.headSha, worktree: p.worktree, gate: p.gate || '', note: p.note || '' });
        break;
      }
      case 'verdict': {
        const t = ticketOf(p.ticket);
        t.verdicts.push({ seq: e.seq, ts: e.ts, round: p.round, verdict: p.verdict, findings: p.findings || '', revRunId: p.revRunId, note: p.note || '' });
        if (p.revRunId) runRefs.push({ runId: p.revRunId, ticket: p.ticket, key: `rev-${p.ticket}-r${p.round}`, role: RUN_ROLE_BY_TYPE.verdict, seq: e.seq, ts: e.ts });
        break;
      }
      case 'fix': {
        const t = ticketOf(p.ticket);
        t.fixes.push({ seq: e.seq, ts: e.ts, fixNo: p.fixNo, key: p.key, resumeRunId: p.resumeRunId, note: p.note || '' });
        if (p.resumeRunId) runRefs.push({ runId: p.resumeRunId, ticket: p.ticket, key: p.key, role: RUN_ROLE_BY_TYPE.fix, seq: e.seq, ts: e.ts });
        break;
      }
      case 'merge': {
        const t = ticketOf(p.ticket);
        t.merges.push({ seq: e.seq, ts: e.ts, headSha: p.headSha, mergeSha: p.mergeSha, note: p.note || '' });
        break;
      }
      default: break; // 未知事件类型原样保留在时间线，不建模
    }
  }
  run.sealed = !!run.close;
  return { run, tickets, runRefs: dedupe(runRefs) };
}

function dedupe(runRefs) {
  const seen = new Map();
  for (const r of runRefs) {
    const prev = seen.get(r.runId);
    // 同一运行被多个事件引用（如 resume 复用）时保留最早一次的角色
    if (!prev || r.seq < prev.seq) seen.set(r.runId, r);
  }
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------- 票标题与票面

function loadTicketFiles(runtimeDir, repoPath, run, tickets, warnings) {
  const slug = path.basename(runtimeDir);
  const specPath = run.init && run.init.spec ? run.init.spec : null;
  // spec 形如 .scratch/<slug>/spec.md → issues 目录是其同级 issues/
  const issuesDir = specPath
    ? path.join(repoPath, path.dirname(specPath), 'issues')
    : path.join(repoPath, '.scratch', slug, 'issues');
  const files = fs.existsSync(issuesDir) ? fs.readdirSync(issuesDir).filter((f) => f.endsWith('.md')).sort() : [];
  for (const t of tickets.values()) {
    const prefix = `${String(t.id).padStart(2, '0')}-`;
    const hit = files.find((f) => f.startsWith(prefix));
    if (!hit) { warn(warnings, 'ticket-file-missing', `票 ${t.id} 的票文件未找到（${issuesDir} 下无 ${prefix}*）`); continue; }
    const abs = path.join(issuesDir, hit);
    t.file = abs;
    const content = readText(abs, { max: 64 * 1024 });
    if (content && typeof content.text === 'string') {
      const m = content.text.match(/^#\s+(.+)$/m);
      if (m) t.title = m[1].replace(new RegExp(`^${String(t.id).padStart(2, '0')}[:：]\\s*`), '').trim();
      t.body = content.text;
    }
  }
}

// ---------------------------------------------------------------- 会话目录与子代理证据定位

function sessionsRoot() {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

function sessionDirName(repoPath) {
  // 真实目录名形如 --Users-gaosong-...-project-- ：路径段用 '-' 连接，首尾各加 '--'
  return '--' + repoPath.split(path.sep).filter(Boolean).join('-') + '--';
}

function artifactDirCandidates(repoPath, warnings) {
  const root = sessionsRoot();
  const primary = path.join(root, sessionDirName(repoPath), 'subagent-artifacts');
  if (fs.existsSync(primary)) return [primary];
  warn(warnings, 'artifact-dir-primary-missing', `按仓库路径推导的会话目录不存在：${primary}，尝试全局兜底扫描`);
  // 全局兜底：收集所有含 subagent-artifacts 的会话目录
  const out = [];
  try {
    for (const d of fs.readdirSync(root)) {
      const cand = path.join(root, d, 'subagent-artifacts');
      if (fs.existsSync(cand)) out.push(cand);
    }
  } catch (e) {
    warn(warnings, 'sessions-root-unreadable', `会话根目录不可读：${root}`);
  }
  return out;
}

function findFilesForRun(candidates, runId) {
  for (const dir of candidates) {
    try {
      const hits = fs.readdirSync(dir).filter((f) => f.startsWith(runId));
      if (hits.length) return { dir, files: hits };
    } catch { /* 目录不可读，试下一个 */ }
  }
  return null;
}

// ---------------------------------------------------------------- 主会话：恢复派发任务书原文

function mainSessionCandidates(repoPath, runIds, warnings) {
  const dir = path.join(sessionsRoot(), sessionDirName(repoPath));
  if (!fs.existsSync(dir)) return [];
  const needles = runIds.slice(0, 3); // 用前几个 runId 做内容预筛，避免逐行解析全部历史
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const abs = path.join(dir, f);
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 64 * 1024 * 1024) {
        warn(warnings, 'session-file-too-large', `主会话文件超过 64MB，跳过：${f}`);
        continue;
      }
      const buf = fs.readFileSync(abs);
      const needleHit = needles.some((id) => buf.includes(id));
      const briefHit = buf.includes('workflowScript') || buf.includes('pi-matt-implement-flow');
      if (needleHit && briefHit) out.push(abs);
    } catch { /* 跳过不可读文件 */ }
  }
  return out;
}

// 从一条派发脚本里提取关联 key：runs.all 数组元素里的 key: 't-01'，及 runs.run('fix-01-r2', {resume:...})
function extractKeysFromScript(script) {
  const keys = [...script.matchAll(/\bkey:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const resumeKeys = [...script.matchAll(/runs\.run\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return { keys: [...new Set(keys)], resumeKeys: [...new Set(resumeKeys)] };
}

function extractBriefs(sessionFiles) {
  const briefs = [];
  for (const file of sessionFiles) {
    const raw = readText(file, { max: 32 * 1024 * 1024 });
    if (!raw || typeof raw.text !== 'string') continue;
    for (const line of raw.text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== 'message' || !rec.message || rec.message.role !== 'assistant') continue;
      for (const c of rec.message.content || []) {
        if (c.type !== 'toolCall' || !/subagent/i.test(c.name || '')) continue;
        const args = c.arguments || c.input || {};
        if (typeof args.workflowScript === 'string' && args.workflowScript.length > 40) {
          const { keys, resumeKeys } = extractKeysFromScript(args.workflowScript);
          briefs.push({
            ts: rec.timestamp || null,
            kind: 'wave',
            keys,
            resumeKeys,
            text: args.workflowScript,
            file: path.basename(file),
          });
        } else if (args.agent && typeof args.task === 'string') {
          briefs.push({ ts: rec.timestamp || null, kind: 'single', agent: args.agent, keys: [], resumeKeys: [], text: args.task, file: path.basename(file) });
        }
      }
    }
  }
  briefs.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return briefs;
}

// 为一次派发/修复找任务书：key 匹配 + 时间最近（允许派发脚本略晚于记账 ≤120s）
function findBriefFor(briefs, key, eventTs) {
  if (!key) return null;
  const t = eventTs ? Date.parse(eventTs) : NaN;
  let best = null;
  for (const b of briefs) {
    if (!b.keys.includes(key) && !b.resumeKeys.includes(key)) continue;
    if (isNaN(t)) { best = b; break; }
    const bt = b.ts ? Date.parse(b.ts) : NaN;
    if (isNaN(bt)) continue;
    if (bt <= t + 120000 && (!best || bt > (Date.parse(best.ts) || 0))) best = b;
  }
  return best;
}

// ---------------------------------------------------------------- 子代理运行证据

function loadChildRun(dirs, ref, warnings) {
  const hit = findFilesForRun(dirs, ref.runId);
  if (!hit) {
    warn(warnings, 'run-evidence-missing', `运行 ${ref.runId}（${ref.role}，票 ${ref.ticket}）未找到平台侧证据`);
    return { runId: ref.runId, found: false };
  }
  const { dir, files } = hit;
  const pick = (suffix) => files.find((f) => f.endsWith(suffix));
  const metaFile = pick('_meta.json');
  const meta = metaFile ? readJson(path.join(dir, metaFile)) : null;
  const output = pick('_output.md');
  const transcriptFile = pick('_transcript.jsonl');

  const run = {
    runId: ref.runId,
    found: true,
    dir,
    agent: meta && !meta.parseError ? meta.agent : null,
    model: meta && !meta.parseError ? meta.model : null,
    exitCode: meta && !meta.parseError ? meta.exitCode : null,
    usage: meta && !meta.parseError ? meta.usage : null,
    _metaTs: meta && !meta.parseError && Number.isFinite(meta.timestamp) ? meta.timestamp : null,
    task: meta && typeof meta.task === 'string' ? meta.task : null, // 平台存档为红断占位时无审计价值，仅作存在性
    acceptance: null,
    childReport: null,
    structuredValue: null, // 从 transcript 的 structured_output 调用提取（评审裁决等）
    outputMd: null,
    toolCalls: null,
    nestedDispatches: [],
    transcriptPath: transcriptFile ? path.join(dir, transcriptFile) : null,
  };

  if (meta && !meta.parseError && meta.acceptance) {
    run.acceptance = {
      status: meta.acceptance.status,
      evidenceStatus: meta.acceptance.evidenceStatus,
      runtimeChecks: meta.acceptance.effectiveAcceptance?.runtimeChecks || meta.acceptance.runtimeChecks || [],
      verifyRuns: (meta.acceptance.effectiveAcceptance?.verifyRuns || meta.acceptance.verifyRuns || []).map((v) => ({
        id: v.id, command: v.command, status: v.status, exitCode: v.exitCode, durationMs: v.durationMs,
        stdout: typeof v.stdout === 'string' ? v.stdout.slice(0, 8 * 1024) : v.stdout,
      })),
    };
    run.childReport = meta.acceptance.childReport || null;
  }

  if (output) {
    const o = readText(path.join(dir, output), { max: 256 * 1024 });
    if (o && typeof o.text === 'string') run.outputMd = o.text;
  }

  if (transcriptFile) {
    const t = readText(path.join(dir, transcriptFile), { max: 64 * 1024 * 1024 });
    if (t && typeof t.text === 'string') {
      const counts = {};
      const values = [];
      const nested = [];
      for (const line of t.text.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        for (const c of (rec.message && rec.message.content) || []) {
          if (c.type !== 'toolCall') continue;
          counts[c.name] = (counts[c.name] || 0) + 1;
          const args = c.arguments || c.input || {};
          if (/structured/i.test(c.name || '') && args.value) values.push(args.value);
          if (/subagent/i.test(c.name || '')) {
            const a = args;
            if (a.task || a.workflowScript) {
              nested.push({
                ts: rec.timestamp || null,
                agent: a.agent || (a.workflowScript ? '(编排脚本)' : '(未知)'),
                excerpt: String(a.task || a.workflowScript || '').slice(0, 500),
              });
            }
          }
        }
      }
      run.toolCalls = counts;
      run.structuredValue = values.length ? values[values.length - 1] : null;
      run.nestedDispatches = nested;
    }
  }
  return run;
}

// ---------------------------------------------------------------- 终审运行（不在事件流，按 agent 名扫描）

function findFinalReviews(candidates, timeWindow) {
  const out = [];
  for (const dir of candidates) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    const runIds = new Set(
      files.filter((f) => f.includes('final-reviewer') && f.endsWith('_meta.json')).map((f) => f.split('_')[0]),
    );
    for (const runId of runIds) {
      const ref = { runId, ticket: 'final', key: 'final-review', role: 'final-reviewer', seq: null, ts: null };
      // findFinalReviews 直接读取，不产生「证据缺失」警告
      const run = loadChildRun([dir], ref, []);
      if (!run.found) continue;
      // 只收本次流程时间窗内的终审运行，避免混入同项目其他会话的历史终审
      if (timeWindow && run._metaTs != null && (run._metaTs < timeWindow.start - 5000 || run._metaTs > timeWindow.end + 5000)) continue;
      out.push(run);
    }
  }
  return out;
}

// ---------------------------------------------------------------- git 事实（只读）

function gitFacts(repoPath, shas) {
  const map = {};
  for (const sha of [...new Set(shas.filter(Boolean))]) {
    try {
      const subject = execFileSync('git', ['-C', repoPath, 'log', '--format=%s', '-n', '1', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      map[sha] = { exists: true, subject };
    } catch {
      map[sha] = { exists: false, subject: null };
    }
  }
  return map;
}

// ---------------------------------------------------------------- 确定性风险推导

function deriveRisks(model) {
  const risks = [];
  const add = (severity, title, detail, evidence) => risks.push({ severity, title, detail, evidence: evidence || [] });

  // R1 失败的子代理运行
  for (const r of model.runRefs) {
    const c = model.childRuns[r.runId];
    if (c && c.found && c.exitCode != null && c.exitCode !== 0) {
      add('high', `一次 ${roleName(r.role)}运行以失败告终（退出码 ${c.exitCode}）`,
        `票 ${r.ticket}（key ${r.key || '—'}）的这次运行失败或超时。台账只记最终结果，过程中的失败在此原样暴露。`,
        [{ label: '运行', ref: r.runId }, { label: '票', ref: `ticket-${r.ticket}.html` }]);
    }
  }
  // R2 验收被拒
  for (const r of model.runRefs) {
    const c = model.childRuns[r.runId];
    if (c && c.found && c.acceptance && /reject/i.test(String(c.acceptance.status))) {
      add('high', `一次 ${roleName(r.role)}运行的验收被拒收（${c.acceptance.status}）`,
        `票 ${r.ticket}：平台验收检查未通过（可能缺证据、报告形状不对或门禁失败）。工作可能已完成但被要求重报。`,
        [{ label: '运行', ref: r.runId }]);
    }
  }
  // R3 异常记录
  for (const a of model.run.anomalies) {
    add('high', `编排器记了一条异常（序号 ${a.seq}）`, a.note, [{ label: '事件', ref: `seq ${a.seq}` }]);
  }
  // R4 升级
  for (const e of model.run.escalates) {
    add('medium', `票 ${e.ticket} 被升级给维护者`, e.note || '修复预算耗尽，票未关闭，移交人工裁决。', [{ label: '事件', ref: `seq ${e.seq}` }]);
  }
  // R5 修复预算耗尽
  const budget = model.run.init && model.run.init.maxFixRounds != null ? Number(model.run.init.maxFixRounds) : 2;
  for (const t of model.tickets.values()) {
    if (t.fixes.length >= budget && !model.run.escalates.some((e) => e.ticket === t.id)) {
      add('medium', `票 ${t.id} 的修复轮数用满预算（${t.fixes.length}/${budget}）`,
        '该票在评审与修复之间反复多次，值得回看每轮问题清单是否在收敛。',
        [{ label: '票', ref: `ticket-${t.id}.html` }]);
    }
  }
  // R6 未封账
  if (!model.run.sealed) {
    add('medium', '运行未封账', '事件流中没有 close 记账，运行可能中途停止或仍进行中——报告反映的可能不是终局。', []);
  }
  // R7 证据缺失
  const missing = model.runRefs.filter((r) => !model.childRuns[r.runId] || !model.childRuns[r.runId].found);
  if (missing.length) {
    add('low', `${missing.length} 次运行的平台侧证据缺失`, '可能已被平台清理或落在其他项目的会话目录。相关票页会标注证据不可用，时间线与 git 事实不受影响。',
      missing.slice(0, 5).map((r) => ({ label: '运行', ref: r.runId })));
  }
  // R8 任务书未恢复
  const noBrief = [];
  for (const t of model.tickets.values()) {
    for (const d of t.dispatches) {
      if (!findBriefFor(model.briefs, d.key, d.ts)) noBrief.push(`${t.id}/${d.key}`);
    }
  }
  if (noBrief.length) {
    add('low', `${noBrief.length} 次派发的任务书原文未恢复`, `主会话数据中未匹配到这些派发的脚本原文（${noBrief.slice(0, 5).join('、')}${noBrief.length > 5 ? '…' : ''}）。其余证据不受影响。`, []);
  }
  // R9 需修改裁决多
  for (const t of model.tickets.values()) {
    const cr = t.verdicts.filter((v) => v.verdict === 'changes_requested').length;
    if (cr >= 2) {
      add('low', `票 ${t.id} 有 ${cr} 轮评审要求修改`, '多轮返工不一定有问题，但值得对照各轮问题清单看修复质量。',
        [{ label: '票', ref: `ticket-${t.id}.html` }]);
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  risks.sort((a, b) => order[a.severity] - order[b.severity]);
  return risks;
}

function roleName(role) {
  return ROLE_LABEL[role] || role;
}

// ---------------------------------------------------------------- 成本统计

function buildStats(model) {
  const byRole = {};
  let totalCost = 0;
  let totalTokens = 0;
  for (const r of model.runRefs) {
    const c = model.childRuns[r.runId];
    if (!c || !c.found) continue;
    const role = r.role;
    const bucket = (byRole[role] = byRole[role] || { runs: 0, cost: 0, tokens: 0 });
    bucket.runs += 1;
    if (c.usage) {
      bucket.cost += c.usage.cost || 0;
      bucket.tokens += (c.usage.input || 0) + (c.usage.output || 0);
      totalCost += c.usage.cost || 0;
      totalTokens += (c.usage.input || 0) + (c.usage.output || 0);
    }
  }
  return { byRole, totalCost, totalTokens, finalReviews: model.finalReviews.length };
}

// ---------------------------------------------------------------- 顶层收集

// 从运行目录推断仓库根：约定 <repo>/.pi/matt-implement/<slug>（向上三级）；
// 若约定层级无 .git，则逐级向上探测 .git（兼容 worktree 与自定义深度）。
function inferRepoPath(runtimeDir) {
  const conventional = path.resolve(runtimeDir, '..', '..', '..');
  if (fs.existsSync(path.join(conventional, '.git'))) return conventional;
  let cur = path.dirname(path.resolve(runtimeDir));
  while (cur !== path.parse(cur).root) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    cur = path.dirname(cur);
  }
  return conventional;
}

function collect({ runtimeDir }) {
  const warnings = [];
  runtimeDir = path.resolve(runtimeDir);
  if (!fs.existsSync(path.join(runtimeDir, 'events.jsonl'))) {
    throw new Error(`不是有效的流程运行目录（缺 events.jsonl）：${runtimeDir}`);
  }
  const repoPath = inferRepoPath(runtimeDir);
  const slug = path.basename(runtimeDir);

  const events = parseEvents(runtimeDir, warnings);
  const { run, tickets, runRefs } = buildRunModel(events);

  const candidates = artifactDirCandidates(repoPath, warnings);
  const childRuns = {};
  for (const ref of runRefs) childRuns[ref.runId] = loadChildRun(candidates, ref, warnings);

  const sessionFiles = mainSessionCandidates(repoPath, runRefs.map((r) => r.runId), warnings);
  if (!sessionFiles.length) warn(warnings, 'main-session-missing', '未找到匹配的主会话记录，派发任务书原文不可恢复（其余证据不受影响）');
  const briefs = extractBriefs(sessionFiles);

  // 终审时间窗：从首事件到末事件（容忍 5s 边界）
  const timeWindow = events.length ? {
    start: Date.parse(events[0].ts),
    end: Date.parse(events[events.length - 1].ts),
  } : null;
  const finalReviews = findFinalReviews(candidates, timeWindow && timeWindow.start && timeWindow.end ? timeWindow : null);

  const ticketList = [...tickets.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  loadTicketFiles(runtimeDir, repoPath, run, tickets, warnings);

  // 评审材料包与问题清单；有路径但读不到时告警（spec：证据缺失必须标注而非静默）
  const bundles = {};
  const findingsFiles = {};
  for (const t of ticketList) {
    for (const v of t.verdicts) {
      if (v.findings) {
        const abs = path.join(repoPath, v.findings);
        const c = readText(abs, { max: 256 * 1024 });
        if (c && typeof c.text === 'string') findingsFiles[v.findings] = c;
        else warn(warnings, 'findings-unreadable', `裁决引用的问题清单不可读：${v.findings}（票 ${t.id} 第 ${v.round} 轮）`);
      }
      const bundleRel = `.pi/matt-implement/${slug}/reviews/${String(t.id).padStart(2, '0')}-r${v.round || 1}.diff`;
      const b = readText(path.join(repoPath, bundleRel), { max: 512 * 1024 });
      if (b && typeof b.text === 'string') bundles[bundleRel] = b;
      else warn(warnings, 'bundle-unreadable', `评审材料包不可读：${bundleRel}（票 ${t.id} 第 ${v.round} 轮）`);
    }
  }
  const finalBundleRel = `.pi/matt-implement/${slug}/reviews/final.diff`;
  const fb = readText(path.join(repoPath, finalBundleRel), { max: 512 * 1024 });
  if (fb && typeof fb.text === 'string') bundles[finalBundleRel] = fb;

  // 编排笔记
  const notesRaw = readText(path.join(runtimeDir, 'notes.md'), { max: 256 * 1024 });
  const notes = notesRaw && typeof notesRaw.text === 'string' ? notesRaw.text : null;

  // git 事实
  const shas = [run.init && run.init.baselineSha];
  for (const t of ticketList) {
    for (const s of t.settles) shas.push(s.headSha);
    for (const m of t.merges) { shas.push(m.headSha); shas.push(m.mergeSha); }
  }
  const git = fs.existsSync(path.join(repoPath, '.git')) ? gitFacts(repoPath, shas) : {};

  const model = {
    version: 1,
    generatedAt: new Date().toISOString(),
    slug,
    runtimeDir,
    repoPath,
    events,
    run,
    tickets: ticketList,
    runRefs,
    childRuns,
    briefs,
    finalReviews,
    notes,
    bundles,
    findingsFiles,
    git,
  };
  model.stats = buildStats(model);
  model.risks = deriveRisks(model);
  model.warnings = warnings;
  return model;
}

module.exports = {
  collect,
  parseEvents,
  buildRunModel,
  extractKeysFromScript,
  extractBriefs,
  findBriefFor,
  deriveRisks,
  artifactDirCandidates,
  sessionDirName,
  ROLE_LABEL,
};
