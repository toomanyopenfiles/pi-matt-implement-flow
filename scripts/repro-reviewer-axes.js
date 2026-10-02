#!/usr/bin/env node
'use strict';
// ============================================================================
// repro-reviewer-axes.js —— issue #6 的复现 / 验收探针（红绿同源）
//
// 被测断言（guarantee 极性，exit 0 = 保证成立 = 修复后验收通过）：
//   G0 contract-extracted   从被测定义抽出轴派发契约（async 值 + 稳定 key）
//   G1 workflow-accepted    该契约实例化的双轴 workflow 调用被平台接受
//   G2 axes-keyed           双轴结果带稳定 key：standards / spec（定义须规定）
//   G3 verdict-after-axes   收场（裁决点）不得早于两根轴各自的完成时刻
//
// 构型说明（为什么不是「真 reviewer 直跑」）：
//   真 reviewer 车辆被两个与 #6 无关的平台级缺陷堵死（见探针报告与事件证据）：
//   (a) aihubmix / commandcode 的约束采样把 `workflow: true` 布尔强制转成字符串，
//       回复围栏形态的 workflow 在这两个 provider 上不可达；
//   (b) 子运行上下文里模型无法把 ```js workflow 围栏块与工具调用放进同一条消息
//       （顶层会话可以），而平台要求两者同回复。
//   因此本探针从被测定义【抽取】轴派发契约，再由纪律化调用方（pi -p 顶层会话，
//   文件形态 workflow，无格式噪音）【实例化】该契约。被测变量只有一个：定义里的
//   `async` 值——现状 `async: true`（调用立即返回，失效状态可达 → 红）；
//   修复后 `async: false`（调用阻塞到两轴返回，失效状态结构性不可达 → 绿）。
//
// 证据源（全部为平台真实落盘，不依赖 issue 文档）：
//   - <sessionRoot>/*.jsonl               pi -p 顶层会话（toolCall / toolResult 时间戳）
//   - <asyncDir>/status.json              运行生命周期（endedAt = 轴完成时刻）
//   - <asyncDir>/events.jsonl             异步事件日志（生命周期事件流）
//
// 恒定对抗条件（诱导提前收尾，红绿两态完全相同）：
//   调用一返回，调用方必须立刻以纯文本收场（= 裁决点），不得轮询、等待。
//   `async: true` 时调用立即返回 → 收场必然抢在轴完成之前（rev-362 签名）；
//   `async: false` 时调用阻塞到两轴返回 → 收场必然晚于两轴完成。
//
// 用法：
//   node scripts/repro-reviewer-axes.js [--only keyless|reviewer|final-reviewer|all]
//        [--model provider/id] [--dump]
//
// 不进默认 `npm test`（真实模型调用、分钟级、需 API 凭证）；npm run repro 手动跑。
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const DEF_FILES = {
  reviewer: 'agents/reviewer.md',
  'final-reviewer': 'agents/final-reviewer.md',
};

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { only: 'all', model: 'opencode-go/muse-spark-1.3-contributor', dump: false, timeout: 900 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--dump') args.dump = true;
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  return args;
}

// ---------------------------------------------------------------- 基础 IO

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file) {
  const t = readText(file);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function readJsonl(file) {
  const t = readText(file);
  if (t == null) return [];
  const out = [];
  for (const line of t.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function fmtRel(ts, t0) {
  if (ts == null) return '        ?  ';
  const rel = (ts - t0) / 1000;
  return `T+${rel >= 0 ? ' ' : ''}${rel.toFixed(1).padStart(6)}s`;
}

function tsOfMessage(entry) {
  const m = entry && entry.message;
  if (m && Number.isFinite(m.timestamp)) return m.timestamp;
  if (entry && entry.timestamp) {
    const t = Date.parse(entry.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// ---------------------------------------------------------------- pi -p 执行

function runPi(prompt, { model, sessionRoot, timeoutSec }) {
  const argv = ['-p', '--mode', 'json', '--tools', 'subagent', '--session-dir', sessionRoot];
  if (model) argv.push('--model', model);
  argv.push(prompt);
  const r = spawnSync('pi', argv, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutSec * 1000,
    cwd: sessionRoot, // 请求 cwd = 探针目录：workflow 文件用 ./ 相对路径加载
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------------------------------------------------------------- 契约抽取（被测定义 → 探针实例化）

// 从 agent 定义文本抽轴派发契约：async 值 + 稳定 key。
// 与 scripts/registration-checks.js 的 checkAxisSpawnContract（静态断言）同源互补：
// 那边钉文案合规，这边把文案实例化成真实 harness 行为。
function extractAxisContract(defText) {
  const asyncMatch = defText.match(/async:\s*(true|false)/);
  const keyMatches = [...defText.matchAll(/key[^\n]*?[`'"]?(standards|spec)[`'"]?/gi)].map((m) => m[1].toLowerCase());
  const keys = [...new Set(keyMatches)];
  return {
    asyncMode: asyncMatch ? asyncMatch[1] : null,
    keys,
    hasStableKeys: keys.includes('standards') && keys.includes('spec'),
  };
}

// ---------------------------------------------------------------- 运行证据

// 递归收集任意对象树里带 runId 的运行元组（key / asyncDir / endedAt 一并带走）
function harvestRuns(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const v of node) harvestRuns(v, out, depth + 1);
    return out;
  }
  if (typeof node.runId === 'string') {
    out.push({
      runId: node.runId,
      key: typeof node.key === 'string' ? node.key : null,
      asyncDir: typeof node.asyncDir === 'string' ? node.asyncDir : null,
      endedAt: Number.isFinite(node.endedAt) ? node.endedAt : null,
    });
  }
  for (const v of Object.values(node)) harvestRuns(v, out, depth + 1);
  return out;
}

function dedupeRuns(runs) {
  const byId = new Map();
  for (const r of runs) {
    const prev = byId.get(r.runId);
    if (!prev) byId.set(r.runId, r);
    else byId.set(r.runId, { ...prev, ...r, key: r.key || prev.key, asyncDir: r.asyncDir || prev.asyncDir, endedAt: r.endedAt || prev.endedAt });
  }
  return [...byId.values()];
}

// 轴完成时刻：status.json 的 endedAt 权威，缺失则退化到转录最后一条消息时间
function runCompletionTs(sessionRoot, runId, asyncDir) {
  const statusFile = asyncDir && path.join(asyncDir, 'status.json');
  const st = statusFile && readJson(statusFile);
  if (st && Number.isFinite(st.endedAt)) return { ts: st.endedAt, source: 'status.json:endedAt' };
  for (const f of walk(sessionRoot)) {
    if (f.includes(runId) && f.endsWith('_transcript.jsonl')) {
      const recs = readJsonl(f);
      for (let i = recs.length - 1; i >= 0; i--) {
        const ts = tsOfMessage(recs[i]);
        if (ts != null) return { ts, source: 'transcript:last-message' };
      }
    }
  }
  // 兜底：asyncDir 事件流最后一条
  const evFile = asyncDir && path.join(asyncDir, 'events.jsonl');
  const evs = evFile ? readJsonl(evFile) : [];
  for (let i = evs.length - 1; i >= 0; i--) {
    if (Number.isFinite(evs[i].ts)) return { ts: evs[i].ts, source: 'events.jsonl:last' };
  }
  return { ts: null, source: 'unavailable' };
}

// ---------------------------------------------------------------- 场景 1：keyless 契约事实

function scenarioKeyless(args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-keys-'));
  // workflow 脚本走文件路径形态（workflow: "./keyless-probe.js"），无模型转述失真。
  // runs.all 条目故意不带 key —— 与当前 agents/*.md 指示一致（其原文只说
  // "a runs.all of two children"，从未要求 key）。预期：平台拒绝该调用。
  fs.writeFileSync(
    path.join(root, 'keyless-probe.js'),
    'const results = await runs.all([\n' +
      '  { agent: "delegate", task: "Reply exactly: A" },\n' +
      '  { agent: "delegate", task: "Reply exactly: B" },\n' +
      ']);\n' +
      'return results;\n',
  );
  const prompt =
    'Make exactly one tool call to the `subagent` tool with exactly these arguments: ' +
    '{"workflow": "./keyless-probe.js", "async": false}. ' +
    'IMPORTANT: `workflow` is the string "./keyless-probe.js" (a file path), `async` is the JSON boolean false. ' +
    'When the tool result arrives (whatever it is), reply with exactly: PROBE_DONE';
  runPi(prompt, { model: args.model, sessionRoot: root, timeoutSec: Math.min(args.timeout, 300) });

  let errorText = null;
  let callSeen = false;
  for (const f of walk(root)) {
    if (!f.endsWith('.jsonl') || f.split(path.sep).length !== root.split(path.sep).length + 1) continue;
    for (const rec of readJsonl(f)) {
      const m = rec.message;
      if (!m || m.role !== 'toolResult' || !/subagent/i.test(m.toolName || '')) continue;
      callSeen = true;
      const text = (m.content || []).map((c) => c.text || '').join('\n');
      if (m.isError) errorText = text;
    }
  }
  const rejected = callSeen && errorText != null;
  const mentionsKey = rejected && /\bkey\b/i.test(errorText);

  console.log('── 场景 keyless：无 key 的 runs.all 是否被拒绝（#6 缺陷 2 的契约事实）──');
  console.log(`  evidence root: ${root}`);
  if (!callSeen) {
    console.log('  INCONCLUSIVE：未观察到 subagent 工具调用（模型未按指令调用），请重跑或换 --model');
    return { name: 'keyless', ok: false, inconclusive: true, root };
  }
  console.log(`  调用被拒: ${rejected}；错误信息提及 key: ${mentionsKey}`);
  if (rejected) console.log(`  错误原文: ${(errorText || '').trim().slice(0, 300)}`);
  const ok = rejected && mentionsKey;
  console.log(ok
    ? '  ✅ 契约事实成立：runs.all 条目缺 key 会被平台拒绝 → 当前定义文本未规定 key 是真实缺陷\n'
    : '  ❌ 未复现「缺 key 被拒」（可能模型补了 key，或平台行为有变）——看上方原文再判断\n');
  return { name: 'keyless', ok, inconclusive: false, errorText, root };
}

// ---------------------------------------------------------------- 场景 2/3：guarantee 探针（红绿同源）

function scenarioGuarantee(args, defName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `repro-${defName}-`));
  const defText = readText(path.join(PKG_ROOT, DEF_FILES[defName])) || '';
  const contract = extractAxisContract(defText);

  console.log(`── 场景 guarantee：${defName} 的「收场不得抢在双轴之前」保证（红绿同源）──`);
  console.log(`  evidence root: ${root}`);
  console.log(`  契约抽取（G0）：async: ${contract.asyncMode}，定义规定的 key: [${contract.keys.join(', ') || '无'}]`);

  // 双轴 workflow 脚本：轴 key 固定用运行时常规名（key 缺陷由 keyless 场景专门复刻，
  // 对应 rev-362「缺 key 被拒 → 补 key 重试」路径的重试后状态）；本探针唯一实例化的
  // 契约变量是 `async`。轴任务 sleep 30 秒——完成时刻确定，时序差可测量。
  const axisItems =
    '  { key: "standards", agent: "delegate", task: "Run bash: sleep 12. Then reply exactly: S_DONE" },\n' +
    '  { key: "spec", agent: "delegate", task: "Run bash: sleep 12. Then reply exactly: P_DONE" },\n';
  fs.writeFileSync(
    path.join(root, 'axes.js'),
    'const results = await runs.all([\n' + axisItems + ']);\nreturn results;\n',
  );

  // 恒定对抗条件：调用一返回立刻纯文本收场（= 裁决点），不轮询、不等待。
  const prompt =
    'This is a TIMING EXPERIMENT with exactly two steps.\n' +
    'STEP 1: Make exactly one tool call to the `subagent` tool with these arguments: ' +
    `{"workflow": "./axes.js", "async": ${contract.asyncMode}} ` +
    '(`workflow` is the string "./axes.js", `async` is the JSON boolean ' + `${contract.asyncMode}). ` +
    'Call the tool EXACTLY ONCE — never a second call, even if something fails.\n' +
    'STEP 2: The INSTANT the tool result arrives, reply with exactly: VERDICT_EARLY — plain text, ' +
    'no further tool calls, no polling, no waiting.';
  runPi(prompt, { model: args.model, sessionRoot: root, timeoutSec: args.timeout });

  // ---- 证据汇集：顶层会话事件 + 双轴完成时刻 ----
  const timeline = [];
  const topSessions = walk(root).filter((f) => f.endsWith('.jsonl') && f.split(path.sep).length === root.split(path.sep).length + 1);
  let callTs = null;
  let callAsync = null;
  let returnTs = null;
  let returnError = null;
  let verdictTs = null;
  const axisRuns = [];
  for (const s of topSessions) {
    for (const rec of readJsonl(s)) {
      const m = rec.message;
      if (!m) continue;
      const ts = tsOfMessage(rec);
      if (m.role === 'assistant') {
        for (const c of m.content || []) {
          if (c.type === 'toolCall' && /subagent/i.test(c.name || '')) {
            callTs = ts;
            callAsync = (c.arguments || {}).async;
            timeline.push({ ts, text: `调用方: 双轴 workflow 调用（async: ${JSON.stringify(callAsync)}，契约来自 ${DEF_FILES[defName]}）` });
          }
          if (c.type === 'text' && /VERDICT_EARLY/.test(c.text || '')) {
            verdictTs = ts;
            timeline.push({ ts, text: '调用方: 收场（裁决点 VERDICT_EARLY）' });
          }
        }
      }
      if (m.role === 'toolResult' && /subagent/i.test(m.toolName || '')) {
        returnTs = ts;
        if (m.isError) returnError = (m.content || []).map((c) => c.text || '').join('\n');
        for (const x of harvestRuns(m.details)) axisRuns.push(x);
        timeline.push({ ts, text: `调用方: workflow 返回 isError=${m.isError}${m.isError ? ` ← ${(returnError || '').trim().slice(0, 200)}` : ''}` });
      }
    }
  }

  // 双轴发现：workflow toolResult 的运行元组（key 映射）；兜底扫 subagent-artifacts
  const axes = dedupeRuns(axisRuns);
  if (axes.length < 2) {
    const known = new Set(axes.map((a) => a.runId));
    for (const f of walk(root)) {
      const mm = f.match(/([0-9a-f-]{36})_[^/]+_transcript\.jsonl$/);
      if (!mm || known.has(mm[1])) continue;
      const recs = readJsonl(f);
      let firstTs = null;
      for (const rec of recs) { const t = tsOfMessage(rec); if (t != null) { firstTs = t; break; } }
      if (firstTs != null && callTs != null && firstTs >= callTs - 5000) {
        axes.push({ runId: mm[1], key: null, asyncDir: null, endedAt: null, startedTs: firstTs });
        known.add(mm[1]);
      }
    }
    const unnamed = axes.filter((a) => !a.key);
    unnamed.sort((a, b) => (a.startedTs || 0) - (b.startedTs || 0));
    unnamed.forEach((a, i) => { a.key = ['standards', 'spec'][i] || a.key; });
  }
  const axisList = axes.map((x) => {
    const done = runCompletionTs(root, x.runId, x.asyncDir);
    return { ...x, doneTs: done.ts, doneSource: done.source };
  });
  for (const ax of axisList) timeline.push({ ts: ax.doneTs, text: `axis[${ax.key || '?'}] 完成（${ax.doneSource}，run ${ax.runId.slice(0, 8)}）` });
  timeline.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const first = timeline.find((e) => e.ts != null);
  const t0 = first ? first.ts : 0;
  console.log('  时间线（平台事件日志）：');
  for (const ev of timeline) console.log(`    ${fmtRel(ev.ts, t0)}  ${ev.text}`);

  // ---- 断言 ----
  const results = [];
  results.push({ id: 'G0 contract-extracted', ok: contract.asyncMode != null, note: `async: ${contract.asyncMode}` });
  const accepted = callTs != null && returnError == null;
  results.push({ id: 'G1 workflow-accepted', ok: accepted, note: returnError ? `拒绝原文: ${returnError.trim().slice(0, 200)}` : '' });
  results.push({ id: 'G2 axes-keyed(standards,spec)', ok: contract.hasStableKeys, note: `定义须规定的 key: [${contract.keys.join(', ') || '无'}]（文本层；运行时 key 缺陷见 keyless 场景）` });

  let verdictAfter = false;
  let g3note = '';
  const anchor = verdictTs != null ? verdictTs : null;
  if (anchor == null) {
    g3note = '未观察到收场文本（VERDICT_EARLY）——证据不足，看时间线';
  } else if (axisList.length >= 2 && axisList.every((a) => a.doneTs != null)) {
    const latest = Math.max(...axisList.map((a) => a.doneTs));
    verdictAfter = anchor >= latest;
    g3note = verdictAfter
      ? `收场晚于全部轴完成 ${((anchor - latest) / 1000).toFixed(1)}s`
      : `收场早于轴完成 ${((latest - anchor) / 1000).toFixed(1)}s（= #6 失效签名：裁决抢在报告之前）`;
  } else {
    g3note = `轴完成时刻不可得（axes=${axisList.length}）——证据不足，看时间线`;
  }
  results.push({ id: 'G3 verdict-after-axes', ok: verdictAfter, note: g3note });

  if (args.dump) console.log('  dump:', JSON.stringify({ contract, callAsync, axisList, verdictTs }, null, 2));

  let okAll = true;
  console.log('  断言：');
  for (const r of results) {
    if (!r.ok) okAll = false;
    console.log(`    ${r.ok ? '✅' : '❌'} ${r.id}${r.note ? ` — ${r.note}` : ''}`);
  }
  console.log(okAll
    ? '  ✅ 保证成立：收场不早于两轴完成（修复后验收通过）\n'
    : '  ❌ 保证不成立 —— 上方 ❌ 断言与时间线即 issue #6 失效签名的真实复现证据\n');
  return { name: defName, ok: okAll, root };
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv);
  const want = (s) => args.only === 'all' || args.only === s;
  const out = [];
  if (want('keyless')) out.push(scenarioKeyless(args));
  if (want('reviewer')) out.push(scenarioGuarantee(args, 'reviewer'));
  if (want('final-reviewer')) out.push(scenarioGuarantee(args, 'final-reviewer'));

  console.log('══ 汇总 ══');
  let fail = false;
  for (const r of out) {
    console.log(`  ${r.inconclusive ? '⚠️' : r.ok ? '✅' : '❌'} ${r.name}`);
    if (!r.ok) fail = true;
    if (r.root) console.log(`      evidence: ${r.root}`);
  }
  process.exit(fail ? 1 : 0);
}

main();
