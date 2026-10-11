'use strict';
// ============================================================================
// 真实模型验收的「执行」层：只执行已获授权的那一批计划，并把额度、重试、
// 取消与失败分类如实落进证据。
//
// 承重约定：
//   - 额度是护栏：每次尝试的调用数从批准额度里预留，探针事后报告实际调用数后
//     对账；超出额度立即停止新增调用，整批不判通过（需重新授权）。
//   - 重试计入额度，且只对"无法判定"的尝试重试；明确的产品失败不重跑。
//   - 未完成、无法判定、未运行都不判通过；所有尝试（含失败尝试）保留在证据里。
//   - 取消停止新增调用，记录直接子进程的终止方式，并如实声明观测边界：
//     不假设子进程终止等于全部后台工作终止。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const planLib = require('./plan');

const RESULTS_SCHEMA = 'e2e-results-1';
const SCENARIO_RESULT_SCHEMA = 'e2e-scenario-result-1';
const STATUSES = ['pass', 'fail', 'inconclusive'];
const KINDS = ['none', 'product-regression', 'infrastructure', 'harness', 'undetermined'];
// 探针退出码约定：0 通过、1 明确失败、2 无法判定。结果文件与退出码不一致时不信任报告。
const EXIT_BY_STATUS = { pass: 0, fail: 1, inconclusive: 2 };

const PROCESS_NOTE = '只记录本入口直接启动的子进程及其终止方式。子进程可能自行留下的后台工作（平台子会话、独立进程、远端任务）不在观测范围内；不假设子代理或子进程终止等于全部后台工作终止，取消后仍需另行核验平台会话与已知测试进程状态。';
const SCAN_NOTE = '相关进程扫描是 best-effort：只按已知路径（探针脚本、平台二进制）匹配当前进程表，命令名不含这些路径的后台工作（例如平台子会话）不会出现在这里。匹配为空不等于后台工作已结束。';

// ---------------------------------------------------------------- 脱敏

// 运行证据不复现凭证：把子进程环境里形状像密钥的值从一切落盘/打印文本里抹掉。
function createSanitizer(env) {
  const secrets = Object.entries(env || {})
    .filter(([k, v]) => typeof v === 'string' && v.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(k))
    .map(([k, v]) => [k, v]);
  return (text) => secrets.reduce((acc, [k, v]) => acc.split(v).join(`<redacted:${k}>`), String(text));
}

// ---------------------------------------------------------------- 探针结果契约

function parseAttemptResult(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'no-result-file' };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'result-not-json' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'result-not-object' };
  if (doc.schema !== SCENARIO_RESULT_SCHEMA) return { ok: false, reason: `result-schema:${doc.schema}` };
  if (!STATUSES.includes(doc.status)) return { ok: false, reason: `result-status:${doc.status}` };
  if (doc.kind != null && !KINDS.includes(doc.kind)) return { ok: false, reason: `result-kind:${doc.kind}` };
  if (doc.calls != null && !(Number.isInteger(doc.calls) && doc.calls >= 0)) return { ok: false, reason: `result-calls:${doc.calls}` };
  return { ok: true, doc };
}

function sanitizeFile(file, sanitize) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const clean = sanitize(text);
    if (clean !== text) fs.writeFileSync(file, clean);
  } catch { /* 文件不在（未写入）或不可读：无需脱敏 */ }
}

// 单次尝试的判定：探针结果文件是权威，退出码/信号/超时用于交叉核验与兜底分类。
function classifyAttempt({ parsed, exitCode, signal, timedOut, cancelled }) {
  if (cancelled) return { status: 'cancelled', kind: 'cancelled', reason: '取消：尝试被终止' };
  if (timedOut) return { status: 'inconclusive', kind: 'infrastructure', reason: '超时：本次尝试未给出判定' };
  if (!parsed.ok) {
    if (signal) return { status: 'inconclusive', kind: 'infrastructure', reason: `尝试被信号终止: ${signal}` };
    return { status: 'inconclusive', kind: 'harness', reason: `测试装置故障：${parsed.reason}（不判通过）` };
  }
  const doc = parsed.doc;
  const expected = EXIT_BY_STATUS[doc.status];
  if (exitCode != null && exitCode !== expected) {
    return { status: 'inconclusive', kind: 'harness', reason: `探针报告 ${doc.status} 但退出码 ${exitCode}（期望 ${expected}）：报告与退出码矛盾，不判通过` };
  }
  return { status: doc.status, kind: doc.kind || 'none', reason: doc.notes || '' };
}

// 只有"无法判定"的尝试才重试：status=fail 是明确判定，永不重跑（不得重试到绿）。
function isRetryable(attempt) {
  return attempt.status === 'inconclusive';
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// best-effort：在进程表里找命令行仍指向本批已知路径的进程（取消后复核“相关 child / 已知测试进程”）。
function scanRelatedProcesses(needles) {
  const wanted = [...new Set(needles.filter(Boolean))];
  if (wanted.length === 0) return { available: false, matches: [], note: SCAN_NOTE };
  const r = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return { available: false, matches: [], note: SCAN_NOTE };
  const matches = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, command] = m;
    if (Number(pid) === process.pid) continue;
    if (wanted.some((n) => command.includes(n))) {
      matches.push({ pid: Number(pid), ppid: Number(ppid), command: command.slice(0, 200) });
    }
  }
  return { available: true, matches, note: SCAN_NOTE };
}

// ---------------------------------------------------------------- 单次尝试

async function runAttempt({ plan, scenario, run, attempt, artifactsDir, env, state, sanitize }) {
  const attemptsDir = path.join(artifactsDir, 'attempts');
  const logsDir = path.join(artifactsDir, 'logs');
  fs.mkdirSync(attemptsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const resultFile = path.join(attemptsDir, `${scenario.id}-run-${run}-attempt-${attempt}.result.json`);
  const logFile = path.join(logsDir, `${scenario.id}-run-${run}-attempt-${attempt}.log`);

  const argv = [
    planLib.resolveProbe({ probe: scenario.probe }),
    ...scenario.args,
    '--model', plan.platform.model,
    '--thinking', plan.platform.thinking,
  ];
  const startedAt = Date.now();

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const child = spawn(process.execPath, argv, {
    cwd: planLib.REPO_ROOT,
    env: {
      ...env,
      PI_E2E_PI_BIN: plan.platform.binary,
      PI_E2E_RESULT_PATH: resultFile,
      PI_E2E_RUN: String(run),
      PI_E2E_ATTEMPT: String(attempt),
      PI_E2E_SCENARIO: scenario.id,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, scenario.attemptTimeoutMs);
  state.killCurrent = () => child.kill('SIGTERM');
  if (state.cancelled) state.killCurrent();

  const { code, signal } = await new Promise((resolve) => {
    child.on('error', (err) => {
      stderr += `spawn error: ${err.message}\n`;
      resolve({ code: null, signal: null });
    });
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(timer);
  state.killCurrent = null;

  const endedAt = Date.now();
  const cancelled = state.cancelled;
  const parsed = parseAttemptResult(resultFile);
  const verdict = classifyAttempt({ parsed, exitCode: code, signal, timedOut, cancelled });
  const reportedCalls = parsed.ok && Number.isInteger(parsed.doc.calls) ? parsed.doc.calls : null;

  fs.writeFileSync(logFile, sanitize(
    `$ node ${argv.join(' ')}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
  ));
  // 探针自己写的原始结果同样过一道脱敏：运行证据里不留凭证值。
  sanitizeFile(resultFile, sanitize);

  const record = {
    run,
    attempt,
    status: verdict.status,
    kind: verdict.kind,
    reason: sanitize(verdict.reason),
    pid: child.pid,
    endedBy: timedOut ? 'timeout:SIGTERM' : signal ? `signal:${signal}` : 'exit',
    exitCode: code,
    signal: signal || null,
    aliveAfterClose: isAlive(child.pid),
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    callsPlanned: scenario.callsPerRun,
    callsReported: reportedCalls,
    log: planLib.displayPath(logFile),
    resultFile: planLib.displayPath(resultFile),
    assertions: parsed.ok && Array.isArray(parsed.doc.assertions) ? parsed.doc.assertions : undefined,
  };
  return record;
}

// ---------------------------------------------------------------- 批次执行

// 场景聚合：明确失败永远赢（已经通过的重复不得掩盖它），其次是取消；
// 只有批准范围内的每一次重复都通过才算通过，否则是未完成（不判通过）。
function scenarioOutcome(record) {
  const attempts = record.attempts;
  if (attempts.some((a) => a.status === 'fail')) return 'fail';
  if (attempts.some((a) => a.status === 'cancelled')) return 'cancelled';
  if (attempts.length === 0) return 'not-run';
  if (record.runs.passed === record.runs.planned) return 'pass';
  return 'incomplete';
}

async function executeBatch({ plan, approvalHash, artifactsDir, runId, env, sanitize = createSanitizer(env) }) {
  const state = { cancelled: false, signal: null, killCurrent: null, overrun: false };
  const children = [];
  const records = [];
  const budget = { callCap: plan.counts.callCap, plannedCalls: plan.counts.plannedCalls, usedCalls: 0 };
  const startedAt = Date.now();

  const onSignal = (sig) => {
    if (state.cancelled) return;
    state.cancelled = true;
    state.signal = sig;
    if (state.killCurrent) state.killCurrent();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const cancelReason = () => `cancelled: 收到 ${state.signal}，停止新增调用`;
  const overrunReason = () => `budget-overrun: 实际调用 ${budget.usedCalls} 超出批准额度 ${budget.callCap}，停止新增调用`;

  try {
    for (const scenario of plan.scenarios) {
      const record = {
        id: scenario.id, title: scenario.title, level: scenario.level,
        status: 'not-run', reason: null, classification: null, calls: 0,
        runs: { planned: scenario.runs, attempted: 0, passed: 0 },
        attempts: [],
      };
      records.push(record);
      if (state.overrun) {
        record.reason = overrunReason();
        continue;
      }
      if (state.cancelled) {
        record.reason = cancelReason();
        continue;
      }

      // 批准范围里的每一次重复都要执行（额度与取消除外）；重试额度只用于无法判定的尝试。
      for (let run = 1; run <= scenario.runs; run++) {
        let decided = null;
        for (let attempt = 1; attempt <= scenario.attemptsPerRun; attempt++) {
          if (state.overrun) { record.reason = overrunReason(); decided = 'stopped'; break; }
          if (state.cancelled) { record.reason = cancelReason(); decided = 'stopped'; break; }
          if (budget.usedCalls + scenario.callsPerRun > budget.callCap) {
            record.reason = `budget-exhausted: 已用 ${budget.usedCalls}/${budget.callCap}，本次尝试还需 ${scenario.callsPerRun}`;
            decided = 'stopped';
            break;
          }

          budget.usedCalls += scenario.callsPerRun; // 先预留，事后按探针报告的实际调用数对账
          if (attempt === 1) record.runs.attempted += 1; // 已开始的重复（重试不重复计数）
          const attemptRecord = await runAttempt({ plan, scenario, run, attempt, artifactsDir, env, state, sanitize });
          const charged = attemptRecord.callsReported == null ? scenario.callsPerRun : attemptRecord.callsReported;
          budget.usedCalls = budget.usedCalls - scenario.callsPerRun + charged;
          record.calls += charged;
          record.attempts.push(attemptRecord);
          children.push({
            scenario: scenario.id,
            run,
            attempt,
            pid: attemptRecord.pid,
            endedBy: attemptRecord.endedBy,
            exitCode: attemptRecord.exitCode,
            signal: attemptRecord.signal,
            aliveAfterClose: attemptRecord.aliveAfterClose,
          });

          if (budget.usedCalls > budget.callCap) state.overrun = true;
          if (attemptRecord.status === 'pass') { decided = 'pass'; break; }
          if (attemptRecord.status === 'cancelled') { decided = 'cancelled'; break; }
          if (!isRetryable(attemptRecord)) {
            attemptRecord.retryNote = 'definitive-failure: 明确失败不重试（重试不得掩盖失败）';
            decided = 'fail';
            break;
          }
          if (attempt >= scenario.attemptsPerRun) {
            attemptRecord.retryNote = `retry-budget-exhausted: 本次重复已尝试 ${attempt}/${scenario.attemptsPerRun}，仍未判定`;
          }
        }

        if (decided === 'pass') record.runs.passed += 1;
        if (decided === 'fail') {
          record.reason = run < scenario.runs
            ? `definitive-failure: 明确失败，剩余 ${scenario.runs - run} 次重复未运行（不重跑掩盖失败）`
            : 'definitive-failure: 明确失败（不重试、不判通过）';
          break;
        }
        if (decided === 'stopped' || decided === 'cancelled') break;
      }

      record.status = scenarioOutcome(record);
      const last = record.attempts[record.attempts.length - 1];
      record.classification = last ? last.kind : 'undetermined';
      if (record.status === 'incomplete' && !record.reason) record.reason = last ? last.reason : '无判定';
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  const endedAt = Date.now();
  let status;
  let reason = null;
  if (state.cancelled) {
    status = 'cancelled';
    reason = cancelReason();
  } else if (state.overrun) {
    status = 'not-accepted';
    reason = overrunReason();
  } else if (records.length > 0 && records.every((r) => r.status === 'pass')) {
    status = 'passed';
  } else {
    status = 'not-accepted';
    reason = '存在未通过 / 未运行 / 无法判定的场景：不得标为通过';
  }

  const results = {
    schema: RESULTS_SCHEMA,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    status,
    reason,
    approvalHash,
    plan: { ...plan, approvalHash },
    budget,
    processes: {
      children,
      note: PROCESS_NOTE,
      cancelSignal: state.signal,
      relatedScan: scanRelatedProcesses([
        ...plan.scenarios.map((s) => planLib.resolveProbe({ probe: s.probe })),
        plan.platform.binary,
      ]),
    },
    scenarios: records,
    artifactsDir: planLib.displayPath(artifactsDir),
  };
  return results;
}

const EXIT_BY_BATCH = { passed: 0, 'not-accepted': 3, cancelled: 4 };

function renderResults(results) {
  const lines = [];
  lines.push(`══ 真实模型验收结果：${results.status} ══`);
  if (results.reason) lines.push(`说明       ${results.reason}`);
  lines.push(`被测版本   ${results.plan.target.name} ${results.plan.target.version} @ ${results.plan.target.headSha}`);
  lines.push(`模型       ${results.plan.platform.model}（thinking ${results.plan.platform.thinking}）；平台 ${results.plan.platform.binary} ${results.plan.platform.version}`);
  lines.push(`额度       用了 ${results.budget.usedCalls} / 上限 ${results.budget.callCap}（计划内 ${results.budget.plannedCalls}）`);
  for (const s of results.scenarios) {
    lines.push(`  ${s.status === 'pass' ? '✔' : s.status === 'not-run' ? '□' : '✖'} ${s.id}  ${s.status}${s.classification ? ` [${s.classification}]` : ''} 重复通过 ${s.runs.passed}/${s.runs.planned}（已尝试 ${s.runs.attempted}）调用 ${s.calls} 尝试 ${s.attempts.length}${s.reason ? ` —— ${s.reason}` : ''}`);
    for (const a of s.attempts) {
      lines.push(`      重复 ${a.run} 尝试 ${a.attempt}: ${a.status}${a.kind ? ` [${a.kind}]` : ''} 调用 ${a.callsReported == null ? '?' : a.callsReported}，${a.endedBy}${a.reason ? ` —— ${a.reason}` : ''}${a.retryNote ? ` —— ${a.retryNote}` : ''}`);
    }
  }
  lines.push(`证据       ${results.artifactsDir}/results.json（全部尝试与失败分类保留）`);
  const alive = results.processes.children.filter((c) => c.aliveAfterClose).length;
  lines.push(`进程       ${results.processes.children.length} 个直接子进程已记录结束方式${alive ? `（观测时仍有 ${alive} 个存活）` : ''}；${results.processes.note}`);
  return `${lines.join('\n')}\n`;
}

module.exports = {
  RESULTS_SCHEMA,
  SCENARIO_RESULT_SCHEMA,
  PROCESS_NOTE,
  SCAN_NOTE,
  createSanitizer,
  parseAttemptResult,
  classifyAttempt,
  isRetryable,
  scanRelatedProcesses,
  executeBatch,
  renderResults,
  EXIT_BY_BATCH,
};
