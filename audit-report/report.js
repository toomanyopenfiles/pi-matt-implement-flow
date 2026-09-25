#!/usr/bin/env node
'use strict';
// 流程审计报告 · CLI 入口
//
// 用法：
//   node audit-report/report.js --runtime-dir <流程运行目录>
//       [--lang <zh|en>]                  输出语言（默认 zh）
//       [--out <报告输出目录>]            默认 <runtimeDir>/report
//       [--ai-analysis <ai-analysis.json>] 读取已回填的 AI 分析意见并渲染进报告
//       [--ai-brief]                       导出 AI 分析简报（供大模型分析后回填）
//
// 全程零大模型调用：AI 意见层是显式的「分析—回填—重渲染」两步，见 README。

const fs = require('fs');
const path = require('path');
const { collect } = require('./collect');
const { renderAll } = require('./render');
const { DEFAULT_LANG, makeT, normLang } = require('./i18n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--ai-analysis') args.aiAnalysis = argv[++i];
    else if (a === '--ai-brief') args.aiBrief = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

// AI 分析简报：把确定性证据整理成一份自包含的 markdown，供大模型（或人）离线分析。
function buildAiBrief(model) {
  const T = makeT(model.lang);
  const lines = [];
  lines.push(T('brief.title', { slug: model.slug }));
  lines.push('');
  lines.push(T('brief.provenance', { events: model.events.length, runs: model.runRefs.length }));
  lines.push(T('brief.instruction'));
  lines.push('');
  lines.push(T('brief.s1'));
  if (model.risks.length) {
    model.risks.forEach((r, i) => lines.push(`${i + 1}. [${r.severity}] ${r.title} — ${r.detail}`));
  } else {
    lines.push(T('brief.none'));
  }
  lines.push('');
  lines.push(T('brief.s2'));
  for (const t of model.tickets) {
    const v = t.verdicts.map((x) => `R${x.round}:${x.verdict}`).join(' ') || T('brief.noVerdicts');
    const m = t.merges.length ? `merge ${t.merges[t.merges.length - 1].mergeSha}` : T('brief.notMerged');
    lines.push(T('brief.ticketLine', { id: t.id, title: t.title || '—', verdicts: v, fixes: t.fixes.length, merge: m }));
  }
  lines.push('');
  lines.push(T('brief.s3'));
  for (const [role, v] of Object.entries(model.stats.byRole)) {
    lines.push(T('brief.roleLine', { role, runs: v.runs, cost: (v.cost || 0).toFixed(4), tokens: v.tokens }));
  }
  lines.push('');
  lines.push(T('brief.s4'));
  for (const a of model.run.anomalies) lines.push(T('brief.anomalyLine', { seq: a.seq, note: a.note }));
  for (const e of model.run.escalates) lines.push(T('brief.escalateLine', { seq: e.seq, ticket: e.ticket, note: e.note }));
  if (!model.run.anomalies.length && !model.run.escalates.length) lines.push(T('brief.none'));
  lines.push('');
  lines.push(T('brief.s5'));
  lines.push(model.run.sealed ? T('brief.sealed', { note: model.run.close.note }) : T('brief.unsealed'));
  const pr = model.run.prs[model.run.prs.length - 1];
  lines.push(T('brief.prLine', { value: pr ? `${pr.state} ${pr.url || ''}` : T('brief.noPr') }));
  lines.push('');
  lines.push(T('brief.s6'));
  for (const r of model.runRefs) {
    const c = model.childRuns[r.runId];
    const ref = r.ticket === 'final' ? T('ref.final') : T('ref.ticket', { ticket: r.ticket });
    const status = c && c.found
      ? T('brief.runStatus', { exit: c.exitCode, acceptance: c.acceptance ? c.acceptance.status : '—', model: c.model })
      : T('brief.evidenceMissing');
    lines.push(T('brief.runLine', { runId: r.runId, role: r.role, ref, key: r.key, status }));
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // 语言先解析（usage / 报错文案也要跟语言走）；不认识的语言按默认语言报错退出
  const lang = normLang(args.lang);
  if (!lang) {
    console.error(makeT(DEFAULT_LANG)('cli.badLang', { lang: args.lang }));
    process.exit(1);
  }
  const T = makeT(lang);

  if (args.help || !args.runtimeDir) {
    console.log(T('cli.usage'));
    process.exit(args.help ? 0 : 1);
  }

  const t0 = Date.now();
  const model = collect({ runtimeDir: args.runtimeDir, lang: T.lang });
  const outDir = path.resolve(args.out || path.join(model.runtimeDir, 'report'));

  let ai = null;
  const aiPath = args.aiAnalysis || path.join(outDir, 'ai-analysis.json');
  if (args.aiAnalysis && !fs.existsSync(args.aiAnalysis)) {
    console.error(T('cli.aiMissing', { path: args.aiAnalysis }));
  } else if (args.aiAnalysis && fs.existsSync(args.aiAnalysis)) {
    try { ai = JSON.parse(fs.readFileSync(args.aiAnalysis, 'utf8')); } catch (e) { console.error(T('cli.aiParseError', { msg: e.message })); }
  } else if (fs.existsSync(aiPath)) {
    try { ai = JSON.parse(fs.readFileSync(aiPath, 'utf8')); } catch { /* 忽略坏文件 */ }
  }

  const files = renderAll(model, outDir, ai);

  // 中间模型存档（调试与二次分析用）
  fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model, null, 2));

  if (args.aiBrief) {
    fs.writeFileSync(path.join(outDir, 'analysis-brief.md'), buildAiBrief(model) + T('brief.aiInstructions'));
  }

  console.log(T('cli.done', { ms: Date.now() - t0 }));
  console.log(T('cli.runtimeDir', { v: model.runtimeDir }));
  console.log(T('cli.outDir', { v: outDir }));
  console.log(T('cli.pages', { n: files.filter((f) => f.endsWith('.html')).length }));
  console.log(T('cli.risks', { n: model.risks.length, high: model.risks.filter((r) => r.severity === 'high').length }));
  if (model.warnings.length) console.log(T('cli.warnings', { n: model.warnings.length }));
  if (ai) console.log(T('cli.aiOpinion', { n: (ai.findings || []).length }));
  else if (args.aiBrief) console.log(T('cli.aiBrief', { path: path.join(outDir, 'analysis-brief.md') }));
}

main();
