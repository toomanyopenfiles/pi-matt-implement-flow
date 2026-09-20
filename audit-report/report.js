#!/usr/bin/env node
'use strict';
// 流程审计报告 · CLI 入口
//
// 用法：
//   node audit-report/report.js --runtime-dir <流程运行目录>
//       [--out <报告输出目录>]            默认 <runtimeDir>/report
//       [--ai-analysis <ai-analysis.json>] 读取已回填的 AI 分析意见并渲染进报告
//       [--ai-brief]                       导出 AI 分析简报（供大模型分析后回填）
//
// 全程零大模型调用：AI 意见层是显式的「分析—回填—重渲染」两步，见 README。

const fs = require('fs');
const path = require('path');
const { collect } = require('./collect');
const { renderAll } = require('./render');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--ai-analysis') args.aiAnalysis = argv[++i];
    else if (a === '--ai-brief') args.aiBrief = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(`用法: node audit-report/report.js --runtime-dir <流程运行目录> [选项]

选项:
  --out <dir>              报告输出目录（默认 <runtimeDir>/report）
  --ai-analysis <file>     读取 AI 分析意见 JSON 并渲染为「分析意见」区块
  --ai-brief               额外导出 AI 分析简报 analysis-brief.md（零成本人工/模型分析入口）

说明:
  对一次已完成（或进行中）的流程运行做纯本地旁路取证，生成可浏览的静态报告网站。
  不调用任何大模型；主流程代码零改动，对目标仓库只读。`);
}

// AI 分析简报：把确定性证据整理成一份自包含的 markdown，供大模型（或人）离线分析。
function buildAiBrief(model) {
  const lines = [];
  lines.push(`# 审计分析简报 · ${model.slug}`);
  lines.push('');
  lines.push(`> 本简报由审计工具从下列确定性来源机械整理：事件流（${model.events.length} 条）、平台子代理证据（${model.runRefs.length} 次运行）、git 事实。`);
  lines.push('> 请基于本简报做交叉一致性检查与未建模风险识别；每条结论必须引用本简报中的条目编号或运行 ID 作为证据。');
  lines.push('');
  lines.push('## 一、确定性异常（脚本检出）');
  if (model.risks.length) {
    model.risks.forEach((r, i) => lines.push(`${i + 1}. [${r.severity}] ${r.title} — ${r.detail}`));
  } else {
    lines.push('（无）');
  }
  lines.push('');
  lines.push('## 二、票目与裁决汇总');
  for (const t of model.tickets) {
    const v = t.verdicts.map((x) => `R${x.round}:${x.verdict}`).join(' ') || '未评审';
    const m = t.merges.length ? `merge ${t.merges[t.merges.length - 1].mergeSha}` : '未合并';
    lines.push(`- 票 ${t.id}「${t.title || '—'}」 评审 ${v}，修复 ${t.fixes.length} 轮，${m}`);
  }
  lines.push('');
  lines.push('## 三、成本与用量');
  for (const [role, v] of Object.entries(model.stats.byRole)) {
    lines.push(`- ${role}: ${v.runs} 次运行, $${(v.cost || 0).toFixed(4)}, ${v.tokens} tokens`);
  }
  lines.push('');
  lines.push('## 四、异常记录与升级（事件原文）');
  for (const a of model.run.anomalies) lines.push(`- anomaly #${a.seq}: ${a.note}`);
  for (const e of model.run.escalates) lines.push(`- escalate #${e.seq} 票 ${e.ticket}: ${e.note}`);
  if (!model.run.anomalies.length && !model.run.escalates.length) lines.push('（无）');
  lines.push('');
  lines.push('## 五、收尾状态');
  lines.push(`- 封账: ${model.run.sealed ? `是（${model.run.close.note}）` : '否 —— 运行未终结'}`);
  const pr = model.run.prs[model.run.prs.length - 1];
  lines.push(`- PR: ${pr ? `${pr.state} ${pr.url || ''}` : '无'}`);
  lines.push('');
  lines.push('## 六、运行清单（runId × 角色 × 状态）');
  for (const r of model.runRefs) {
    const c = model.childRuns[r.runId];
    lines.push(`- ${r.runId} [${r.role}] 票 ${r.ticket} key=${r.key} ${c && c.found ? `exit=${c.exitCode} 验收=${c.acceptance ? c.acceptance.status : '—'} 模型=${c.model}` : '证据缺失'}`);
  }
  lines.push('');
  return lines.join('\n');
}

// 期望的回填格式说明，附在简报尾部
const AI_INSTRUCTIONS = `
---

## 给分析者的回填说明（大模型或人类）

分析完成后，把结论写入 <报告输出目录>/ai-analysis.json，格式：

{
  "model": "<分析所用模型或 human>",
  "generatedAt": "<ISO 时间>",
  "findings": [
    { "severity": "high|medium|low",
      "title": "一句话风险标题",
      "detail": "推理与依据",
      "evidenceRefs": ["简报中的条目编号 / runId / 票号"] }
  ]
}

然后重跑本工具（带 --ai-analysis <该文件>），意见会渲染进报告的独立「AI 分析意见」区块，
与确定性事实明确分层。
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.runtimeDir) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const t0 = Date.now();
  const model = collect({ runtimeDir: args.runtimeDir });
  const outDir = path.resolve(args.out || path.join(model.runtimeDir, 'report'));

  let ai = null;
  const aiPath = args.aiAnalysis || path.join(outDir, 'ai-analysis.json');
  if (args.aiAnalysis && !fs.existsSync(args.aiAnalysis)) {
    console.error(`指定的 AI 意见文件不存在：${args.aiAnalysis}（将只渲染确定性事实区）`);
  } else if (args.aiAnalysis && fs.existsSync(args.aiAnalysis)) {
    try { ai = JSON.parse(fs.readFileSync(args.aiAnalysis, 'utf8')); } catch (e) { console.error(`AI 意见文件解析失败：${e.message}`); }
  } else if (fs.existsSync(aiPath)) {
    try { ai = JSON.parse(fs.readFileSync(aiPath, 'utf8')); } catch { /* 忽略坏文件 */ }
  }

  const files = renderAll(model, outDir, ai);

  // 中间模型存档（调试与二次分析用）
  fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model, null, 2));

  if (args.aiBrief) {
    fs.writeFileSync(path.join(outDir, 'analysis-brief.md'), buildAiBrief(model) + AI_INSTRUCTIONS);
  }

  console.log(`✓ 审计报告已生成（${Date.now() - t0} ms，零 LLM 调用）`);
  console.log(`  运行目录: ${model.runtimeDir}`);
  console.log(`  报告输出: ${outDir}`);
  console.log(`  页面: ${files.filter((f) => f.endsWith('.html')).length} 个（首页 index.html）`);
  console.log(`  确定性风险: ${model.risks.length} 条（高 ${model.risks.filter((r) => r.severity === 'high').length}）`);
  if (model.warnings.length) console.log(`  取证降级警告: ${model.warnings.length} 条（详见报告内标注与 model.json）`);
  if (ai) console.log(`  AI 分析意见: ${(ai.findings || []).length} 条（已标注为观点层）`);
  else if (args.aiBrief) console.log(`  AI 分析简报: ${path.join(outDir, 'analysis-brief.md')}（分析后回填 ai-analysis.json 再重跑即可）`);
}

main();
