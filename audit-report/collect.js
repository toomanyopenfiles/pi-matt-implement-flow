'use strict';
// 收集器：从一次已完成的流程运行目录出发，汇集全部旁路证据，产出中间模型（纯数据，无渲染）。
//
// 数据源（全部只读）：
//   1. <runtimeDir>/events.jsonl      事件流（时间线与状态机的骨架；run 级终审裁决取其中的 final 事件）
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
// refSeq 的数值形态经 schema 的单一转换点归一（与写点校验、check 对账共用同一实现）
const { refSeqNumber } = require('../scripts/ledger-schema');

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

// payload 里的路径（init.spec / verdict --findings / final --findings）按约定是 repo 相对
// 路径，但编排器也可能记成绝对主仓库路径（brief 的 path rule）：绝对路径直接用，
// 相对路径才拼 repo 根。真实事故语料：postmortem-hardening 运行的 init --spec 记了
// 绝对路径，拼接后路径重复 → 票面原文层全量降级。
function resolvePayloadPath(repoPath, p) {
  return p && path.isAbsolute(p) ? p : path.join(repoPath, p);
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
  const run = { init: null, prs: [], close: null, anomalies: [], escalates: [], finals: [] };
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
      case 'anomaly': run.anomalies.push({ seq: e.seq, ts: e.ts, note: p.note || '', refSeq: refSeqNumber(p.refSeq) }); break;
      case 'escalate': run.escalates.push({ seq: e.seq, ts: e.ts, ticket: p.ticket, note: p.note || '' }); break;
      case 'close': run.close = { seq: e.seq, ts: e.ts, note: p.note || '' }; break;
      case 'final': {
        // run 级终审裁决：无 ticket，runId 必选（事件驱动审计与平台证据核验的唯一锚点）。
        // 多轮终审 = 多条事件，一律以最新一条为准；派发终审的动作本身不记事件。
        run.finals.push({ seq: e.seq, ts: e.ts, finalVerdict: p.finalVerdict, runId: p.runId, findings: p.findings || '', note: p.note || '' });
        if (p.runId) runRefs.push({ runId: p.runId, ticket: 'final', key: `final-r${run.finals.length}`, role: 'final-reviewer', seq: e.seq, ts: e.ts });
        break;
      }
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

// ---------------------------------------------------------------- runId 形状机判（死数据识别）

// 平台 runId 一律 UUID 形状（36 位十六进制-连字符）。不匹配者是记账污染的直接形态
// （真实事故：shell 变量被写进 --run-id，runId 成了包名）——死数据：
// 不探测平台证据、不参与风险推导（不写、不猜、不补造它对应的运行）。
const RUN_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_UUID.test(runId);
}

// 分流：live 进运行清单与平台证据探测；dead 单独留痕（warning），不参与任何推导
function splitRunRefs(runRefs) {
  const live = [];
  const dead = [];
  for (const r of runRefs) (isUuidRunId(r.runId) ? live : dead).push(r);
  return { live, dead };
}

// ---------------------------------------------------------------- 票标题与票面

function loadTicketFiles(runtimeDir, repoPath, run, tickets, warnings) {
  const slug = path.basename(runtimeDir);
  const specPath = run.init && run.init.spec ? run.init.spec : null;
  // spec 形如 .scratch/<slug>/spec.md → issues 目录是其同级 issues/
  const issuesDir = specPath
    ? path.join(resolvePayloadPath(repoPath, path.dirname(specPath)), 'issues')
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
    warn(warnings, 'run-evidence-missing', `运行 ${ref.runId}（${ref.role}${ref.ticket && ref.ticket !== 'final' ? `，票 ${ref.ticket}` : '，run 级终审'}）未找到平台侧证据`);
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

// ---------------------------------------------------------------- 终审运行（两条路径：事件驱动优先，旧账降级为目录扫描）

// 事件驱动路径（ADR-0002 Decision 8）：终审运行引用直接取自 final 事件的 runId，
// 裁决也取自事件（裁决权威在事件流）。不扫目录，因此时间窗过滤不适用——
// 不存在“同项目历史终审混入”的问题，也不存在与降级路径双计的问题。
function finalReviewsFromEvents(finals, candidates, warnings) {
  return finals.map((f, i) => {
    const ref = { runId: f.runId, ticket: 'final', key: `final-r${i + 1}`, role: 'final-reviewer', seq: f.seq, ts: f.ts };
    // 死 runRef 分流同样适用于终审路径（与 runRefs 同一机判）：runId 存在但不是 UUID 形状
    // = 记账污染，不探测平台证据（否则与 run-ref-dead 告警并存产出互相矛盾的「证据缺失」
    // 告警）。事件级事实不删：终审条目保留、裁决仍取自事件，只是没有可核验的平台证据；
    // runId 缺失的残缺记账不在此列（照旧走证据探测并告警）。
    const child = f.runId && !isUuidRunId(f.runId)
      ? { runId: f.runId, found: false, deadRunRef: true }
      : loadChildRun(candidates, ref, warnings);
    return {
      ...child,
      source: 'event',
      round: i + 1,
      seq: f.seq,
      ts: f.ts,
      verdict: f.finalVerdict || null,
      findings: f.findings || null,
      note: f.note || '',
    };
  });
}

// 降级路径（无 final 事件的旧账）：现有「目录名扫描 + 时间窗过滤」行为不变。
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
  // 分流规则只有 splitRunRefs 一处实现：collect 顶层已分流（model.runRefs 即 live），
  // 直接调用 deriveRisks 的测试装置未分流时在此复用同一函数兜底。
  const { live: liveRefs } = splitRunRefs(model.runRefs || []);
  // 「已被补正」判定同样只有 correctionFor 一处实现，一次批量取用（R3 与衍生风险共用）
  const corrections = correctionsByRefSeq(model.events || [], model.run.anomalies);
  const incidents = incidentRefs(model, liveRefs);

  // R1 失败的子代理运行
  for (const r of liveRefs) {
    const c = model.childRuns[r.runId];
    if (c && c.found && c.exitCode != null && c.exitCode !== 0) {
      const rec = recoveryFor(model, r, incidents);
      add(rec ? 'medium' : 'high', `一次 ${roleName(r.role)}运行以失败告终（退出码 ${c.exitCode}）${rec ? RECOVERED_TAG : ''}`,
        `${ticketRef(r)}（key ${r.key || '—'}）的这次运行失败或超时。台账只记最终结果，过程中的失败在此原样暴露。${recoveryNote(rec)}`,
        [{ label: '运行', ref: r.runId }, ...(r.ticket === 'final' ? [] : [{ label: '票', ref: `ticket-${r.ticket}.html` }]), ...recoveryEvidence(rec)]);
    }
  }
  // R2 验收被拒
  for (const r of liveRefs) {
    const c = model.childRuns[r.runId];
    if (c && c.found && c.acceptance && /reject/i.test(String(c.acceptance.status))) {
      const rec = recoveryFor(model, r, incidents);
      add(rec ? 'medium' : 'high', `一次 ${roleName(r.role)}运行的验收被拒收（${c.acceptance.status}）${rec ? RECOVERED_TAG : ''}`,
        `${ticketRef(r)}：平台验收检查未通过（可能缺证据、报告形状不对或门禁失败）。工作可能已完成但被要求重报。${recoveryNote(rec)}`,
        [{ label: '运行', ref: r.runId }, ...recoveryEvidence(rec)]);
    }
  }
  // R3 异常记录
  for (const a of model.run.anomalies) {
    const fix = corrections.get(a.refSeq);
    if (fix) {
      // 已补正（票 03）：anomaly 带 refSeq 且被指向事件同票后续有补正记录——留痕不删除，
      // 只把报告口径降为 medium 并标注处置状态（降级依据必须可复核）。
      add('medium', `编排器记了一条异常（序号 ${a.seq}）——已补正`,
        `${a.note}｜补正依据：本异常指向的 seq ${fix.target.seq}（${fix.target.type}，票 ${fix.target.payload.ticket}）在 seq ${fix.correction.seq} 有同类型后续记录取代之；异常留痕保留，仅报告口径降级。`,
        [{ label: '事件', ref: `seq ${a.seq}` }, { label: '补正', ref: `seq ${fix.correction.seq}` }]);
    } else {
      add('high', `编排器记了一条异常（序号 ${a.seq}）`, a.note, [{ label: '事件', ref: `seq ${a.seq}` }]);
    }
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
  // R7 带伤封账：封账时最新终审裁决为 not_ready（用户拍板放弃的合法出口，但代码带着已知问题收场）
  const finals = model.run.finals || [];
  const latestFinal = finals.length ? finals[finals.length - 1] : null;
  if (model.run.sealed && latestFinal && latestFinal.finalVerdict === 'not_ready') {
    add('medium', '封账时最新终审裁决为 not_ready（带伤封账）',
      '整分支终审判定未就绪，运行仍被封账——多半是用户拍板放弃的合法出口，但代码带着已知问题收场，值得回看终审问题清单。',
      [{ label: '事件', ref: `seq ${latestFinal.seq}` }, { label: '运行', ref: latestFinal.runId }]);
  }
  // R8 证据缺失（死 runRef 已在上游分流，此处只判活运行）。两种机制共存：形状合法但错值的
  // runId（复制粘贴污染）机判覆盖不到，其衍生风险照旧存活——若 anomaly.refSeq 指向引入它的
  // 那次记账，则标注「已被补正」（风险本体不删除，与 R3 同哲学）；未被补正者维持原口径。
  const missing = liveRefs.filter((r) => !model.childRuns[r.runId] || !model.childRuns[r.runId].found);
  const correctedMissing = missing.filter((r) => corrections.has(r.seq));
  const plainMissing = missing.filter((r) => !corrections.has(r.seq));
  if (plainMissing.length) {
    add('low', `${plainMissing.length} 次运行的平台侧证据缺失`, '可能已被平台清理或落在其他项目的会话目录。相关票页会标注证据不可用，时间线与 git 事实不受影响。',
      plainMissing.slice(0, 5).map((r) => ({ label: '运行', ref: r.runId })));
  }
  if (correctedMissing.length) {
    add('low', `${correctedMissing.length} 次运行的平台侧证据缺失${CORRECTED_TAG}`,
      '这些运行引用已被 anomaly 的补正记录取代（指向事件的同票同类型后续记录）——平台证据缺失是记账污染的残留，不是运行时事实；风险本体保留供核对，补正依据见引用。',
      correctedMissing.slice(0, 5).flatMap((r) => {
        const fix = corrections.get(r.seq);
        return [
          { label: '运行', ref: r.runId },
          { label: '异常', ref: `seq ${fix.anomaly.seq}` },
          { label: '补正', ref: `seq ${fix.correction.seq}` },
        ];
      }));
  }
  // R9 任务书未恢复（死 runRef 的派发是记账污染的记录，不是事实：不产出衍生风险）
  const noBrief = [];
  for (const t of model.tickets.values()) {
    for (const d of t.dispatches) {
      if (d.runId && !isUuidRunId(d.runId)) continue;
      if (!findBriefFor(model.briefs, d.key, d.ts)) noBrief.push(`${t.id}/${d.key}`);
    }
  }
  if (noBrief.length) {
    add('low', `${noBrief.length} 次派发的任务书原文未恢复`, `主会话数据中未匹配到这些派发的脚本原文（${noBrief.slice(0, 5).join('、')}${noBrief.length > 5 ? '…' : ''}）。其余证据不受影响。`, []);
  }
  // R10 需修改裁决多
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

// ---------------------------------------------------------------- 「已恢复」判定（R1/R2 的事实性豁免）

// 判定完全在审计侧的派生阶段做，台账与事件流零变更。一次失败/拒收被判定为「已恢复」的条件：
//   同票存在更晚序号的成功 settled 运行，且该次失败与那个 settle 之间没有同票的另一次事故。
// settled 在写点即校验 headSha 在 git 中真实存在（成功结算的定义），故「存在更晚序号的 settle」
// 就是「成功 settle」的证据。
// 设计红线：事实性豁免而非补偿性豁免——降级只到 medium（工作确实被打断过）、detail 必须给出
// 恢复运行的引用、风险本体不删除；拒绝→拒绝→成功不被一次成功抹平（前一次失败之后的下一个
// 同票事实仍是失败，故它维持 high，只有各自有后续恢复的那次才降级）。
const RECOVERED_TAG = '——后续运行已恢复';
// 补正链的标注口径（票 03 × 票 02）：anomaly.refSeq 指向的事件已有同票同类型后续记录取代之时，
// 其衍生风险（证据缺失类）带此标注——风险本体保留，只把处置状态变成机器可读。
const CORRECTED_TAG = '——已被补正';

// 一次运行是否构成事故：平台证据里退出码非零（失败）或验收被拒收（拒收）
function incidentOf(ref, model) {
  const c = model.childRuns && model.childRuns[ref.runId];
  if (!c || !c.found) return false;
  const failed = c.exitCode != null && c.exitCode !== 0;
  const rejected = !!(c.acceptance && /reject/i.test(String(c.acceptance.status)));
  return failed || rejected;
}

function incidentRefs(model, liveRefs) {
  return liveRefs.filter((r) => incidentOf(r, model));
}

function recoveryFor(model, ref, incidents) {
  if (ref.ticket === 'final') return null; // run 级终审无票：不存在「同票后续运行」这一判据
  // model.tickets 即真相来源（collect 产物是渲染用的排序数组、测试装置是 Map）：
  // 用 .values() 统一取票（与 R5/R9/R10 同一取法），不再为此重建一份 Map。
  const ticket = [...(model.tickets || []).values()].find((t) => t.id === ref.ticket);
  if (!ticket || !(ticket.settles || []).length) return null;
  const seq = Number(ref.seq) || 0;
  const settle = ticket.settles
    .filter((s) => Number(s.seq) > seq)
    .sort((a, b) => Number(a.seq) - Number(b.seq))[0];
  if (!settle) return null;
  // 该次事故之后、该 settle 之前若还有同票事故，本次不算被恢复（一次成功不抹平多次事故）
  const interrupted = incidents.some((i) => i.ticket === ref.ticket && i.runId !== ref.runId
    && Number(i.seq) > seq && Number(i.seq) < Number(settle.seq));
  if (interrupted) return null;
  // 恢复运行：该 settle 之前同票最后一次活运行（resume 复用同一 runId 时即被拒的那次运行）
  const before = (model.runRefs || [])
    .filter((r) => r.ticket === ref.ticket && Number(r.seq) <= Number(settle.seq))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const run = before.length ? before[before.length - 1] : null;
  return { settle, runId: run ? run.runId : null };
}

function recoveryNote(rec) {
  if (!rec) return '';
  const where = `事件 seq ${rec.settle.seq}${rec.settle.headSha ? `，提交 ${String(rec.settle.headSha).slice(0, 12)}` : ''}`;
  const who = rec.runId ? `运行 ${rec.runId}（${where}）` : `同票后续运行（${where}）`;
  return `同票的后续运行已恢复：${who}已成功 settle——该次事故是过程抖动而非未处置的伤，故降为 medium（事实性豁免：工作确实被打断过，风险本体不删除）。`;
}

function recoveryEvidence(rec) {
  if (!rec) return [];
  return [
    ...(rec.runId ? [{ label: '恢复运行', ref: rec.runId }] : []),
    { label: '恢复结算', ref: `seq ${rec.settle.seq}` },
  ];
}

function roleName(role) {
  return ROLE_LABEL[role] || role;
}

// R3 的「已补正」判定（票 03）：anomaly 的 refSeq 指向的既有事件，若同票、序号更晚处存在
// 同类型（取代性重记）事件，则视为补正记录在案。无 refSeq（旧账/散文时代）、目标事件
// 不存在、或同票后续没有同类型记录 → 返回 null，R3 维持 high 原样。
function correctionFor(events, anomaly) {
  if (anomaly.refSeq == null) return null;
  const target = events.find((e) => e.seq === anomaly.refSeq);
  const ticket = target && target.payload && target.payload.ticket;
  if (!ticket) return null;
  const correction = events.find(
    (e) => e.seq > target.seq && e.type === target.type && e.payload && e.payload.ticket === ticket
  );
  return correction ? { target, correction } : null;
}

// 补正链索引（票 03 的 correctionFor 是唯一判定，此处只做一次批量取用）：
// anomaly.refSeq → { anomaly, target, correction }；R3 本体与衍生风险（证据缺失类）共用。
function correctionsByRefSeq(events, anomalies) {
  const map = new Map();
  for (const a of anomalies || []) {
    const fix = correctionFor(events, a);
    if (fix) map.set(a.refSeq, { anomaly: a, ...fix });
  }
  return map;
}

// 风险文案里的运行归属：票级运行写票号，run 级终审写“run 级终审”
function ticketRef(ref) {
  return ref.ticket === 'final' ? 'run 级终审' : `票 ${ref.ticket}`;
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
  const { live: liveRefs, dead: deadRefs } = splitRunRefs(runRefs);
  for (const r of deadRefs) {
    warn(warnings, 'run-ref-dead',
      `运行引用 ${r.runId}（${r.ticket === 'final' ? 'run 级终审' : `票 ${r.ticket}`}，key ${r.key || '—'}，事件 seq ${r.seq}）的 runId 不是 UUID 形状——判定为记账污染的死数据：不探测平台证据、不参与证据缺失类风险推导`);
  }

  const candidates = artifactDirCandidates(repoPath, warnings);
  const childRuns = {};
  for (const ref of liveRefs) childRuns[ref.runId] = loadChildRun(candidates, ref, warnings);

  const sessionFiles = mainSessionCandidates(repoPath, liveRefs.map((r) => r.runId), warnings);
  if (!sessionFiles.length) warn(warnings, 'main-session-missing', '未找到匹配的主会话记录，派发任务书原文不可恢复（其余证据不受影响）');
  const briefs = extractBriefs(sessionFiles);

  // 终审汇集：事件驱动优先（ADR-0002 Decision 8）。账上有 final 事件 → 从事件取 runId 建终审运行
  // 引用并入成本表与终审清单，不触发目录扫描（时间窗过滤对事件驱动路径不适用）；账上无 final
  // 事件的旧账整体降级为现有「目录名扫描 + 时间窗过滤」路径，行为与升级前一致，两条路径不双计。
  // 「记账前崩溃」的孤儿终审不补扫——恢复流程中被重派发的终审取代。
  let finalReviews;
  let finalReviewSource;
  if (run.finals.length) {
    finalReviewSource = 'event';
    finalReviews = finalReviewsFromEvents(run.finals, candidates, warnings);
  } else {
    finalReviewSource = 'scan';
    // 终审时间窗：从首事件到末事件（容忍 5s 边界）
    const timeWindow = events.length ? {
      start: Date.parse(events[0].ts),
      end: Date.parse(events[events.length - 1].ts),
    } : null;
    finalReviews = findFinalReviews(candidates, timeWindow && timeWindow.start && timeWindow.end ? timeWindow : null)
      .map((r) => ({ ...r, source: 'scan', verdict: (r.structuredValue && r.structuredValue.verdict) || null }));
  }

  const ticketList = [...tickets.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  loadTicketFiles(runtimeDir, repoPath, run, tickets, warnings);

  // 评审材料包与问题清单；有路径但读不到时告警（spec：证据缺失必须标注而非静默）
  const bundles = {};
  const findingsFiles = {};
  for (const t of ticketList) {
    for (const v of t.verdicts) {
      if (v.findings) {
        const abs = resolvePayloadPath(repoPath, v.findings);
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

  // 终审问题清单：与票级同构——按 final 事件的 findings 路径收录原文，不可读则告警而非静默
  run.finals.forEach((f, i) => {
    if (!f.findings) return;
    const c = readText(resolvePayloadPath(repoPath, f.findings), { max: 256 * 1024 });
    if (c && typeof c.text === 'string') findingsFiles[f.findings] = c;
    else warn(warnings, 'findings-unreadable', `终审裁决引用的问题清单不可读：${f.findings}（第 ${i + 1} 轮终审）`);
  });

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
    runRefs: liveRefs,
    deadRunRefs: deadRefs,
    childRuns,
    briefs,
    finalReviews,
    finalReviewSource,
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
