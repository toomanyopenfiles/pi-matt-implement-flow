'use strict';
// 渲染器：中间模型 → 静态 HTML（人类可读、面向审核者）。
// 原则：中文为主、术语括注原文并链接到首页名词表、事实与意见分区、全部证据可折叠展开。

const fs = require('fs');
const path = require('path');
const { TERMS, lookup } = require('./glossary');
const { ROLE_LABEL, findBriefFor } = require('./collect');

// ---------------------------------------------------------------- 基础

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 术语链接：term('评审裁决','verdict') → <a class="term" ...>评审裁决（verdict）</a>
function term(zh, en) {
  const t = lookup(en) || lookup(zh);
  if (!t) return `${esc(zh)}（${esc(en)}）`;
  return `<a class="term" href="index.html#g-${esc(t.id)}" title="${esc(t.def)}">${esc(zh)}（${esc(t.en)}）</a>`;
}

function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return esc(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtCost(n) {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function sha(s) {
  if (!s) return '—';
  const str = String(s);
  return `<code class="sha">${esc(str.length > 12 ? str.slice(0, 12) : str)}</code>`;
}

function details(summary, inner, open = false) {
  return `<details class="fold"${open ? ' open' : ''}><summary>${summary}</summary><div class="fold-body">${inner}</div></details>`;
}

function codeBlock(text, cls = '') {
  return `<pre class="code ${cls}">${esc(text)}</pre>`;
}

const DIFF_LINE = /^(diff |index |--- |\+\+\+|@@)/;
function diffBlock(text) {
  const lines = esc(text).split('\n').map((l) => {
    if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="d-add">${l}</span>`;
    if (l.startsWith('-') && !l.startsWith('---')) return `<span class="d-del">${l}</span>`;
    if (DIFF_LINE.test(l)) return `<span class="d-hunk">${l}</span>`;
    return l;
  });
  return `<pre class="code diff">${lines.join('\n')}</pre>`;
}

const SEV_LABEL = { high: '高危', medium: '注意', low: '背景' };
const VERDICT_LABEL = {
  approved: ['通过', 'ok'],
  changes_requested: ['需修改', 'warn'],
  ready: ['可交付', 'ok'],
  ready_with_fixes: ['可交付但需修', 'warn'],
  not_ready: ['不可交付', 'bad'],
};

// ---------------------------------------------------------------- 页面骨架

function layout(title, body, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="assets/style.css">
${extraHead}
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <span class="brand">流程审计报告</span>
    <nav class="nav">
      <a href="index.html">总览</a>
      <a href="final.html">终审与收尾</a>
      <a href="index.html#glossary">名词表</a>
    </nav>
  </div>
</header>
<main class="page">
${body}
</main>
<footer class="foot">由 pi-matt-implement-flow 审计工具生成 · 纯本地旁路取证 · 生成时间 ${esc(fmtTs(new Date().toISOString()))}</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------- 首页

function renderOverview(model) {
  const r = model.run;
  const init = r.init || {};
  const flags = init.reviewer != null || init.maxFixRounds != null || init.maxConcurrent != null
    ? `逐票评审${init.reviewer === 'off' ? '关' : '开'} · 每票修复预算 ${init.maxFixRounds ?? 2} · 并发 ${init.maxConcurrent ?? 3}`
    : '默认（评审开 · 修复预算 2 · 并发 3）';
  const pr = r.prs.length ? r.prs[r.prs.length - 1] : null;

  const cards = [
    { label: '运行目录', value: `<code>${esc(model.slug)}</code>` },
    { label: '仓库', value: `<code>${esc(model.repoPath)}</code>` },
    { label: '功能分支', value: init.branch ? `<code>${esc(init.branch)}</code>（基线 ${sha(init.baselineSha)}）` : '—' },
    { label: 'spec', value: init.spec ? `<code>${esc(init.spec)}</code>` : '—' },
    { label: '测试门禁', value: init.testCommand ? `<code>${esc(init.testCommand)}</code>` : '—' },
    { label: term('流程形态', 'flow shape'), value: flags },
    { label: '票务', value: esc(init.tracker || '—') },
    { label: '代码评审 PR', value: pr ? (pr.url ? `<a href="${esc(pr.url)}">${esc(pr.state)}（${esc(pr.url)}）</a>` : esc(pr.state)) : '无（本地分支）' },
    { label: term('封账', 'seal'), value: r.sealed ? `<span class="pill ok">已封账</span> <span class="muted">${esc(fmtTs(r.close.ts))}</span>` : '<span class="pill bad">未封账</span>' },
  ];

  const s = model.stats;
  const statCards = [
    { label: '票数', value: model.tickets.length },
    { label: '派发次数', value: model.runRefs.filter((x) => x.role === 'coder').length },
    { label: '评审轮次', value: model.runRefs.filter((x) => x.role === 'reviewer').length },
    { label: '修复轮次', value: model.runRefs.filter((x) => x.role === 'coder-resume').length },
    { label: '终审', value: s.finalReviews || 0 },
    { label: '子代理总成本', value: fmtCost(s.totalCost) },
    { label: '子代理总 token', value: fmtTokens(s.totalTokens) },
  ];

  return `
<section class="hero">
  <h1>流程运行总览 <span class="muted">· ${esc(model.slug)}</span></h1>
  <p class="lede">本报告由已完成的流程运行目录离线取证生成：全部内容来自${term('事件流', 'event stream')}、平台留存的子代理证据与 git 事实，收集过程零大模型调用。</p>
  <div class="card-grid">
    ${cards.map((c) => `<div class="card"><div class="card-label">${c.label}</div><div class="card-value">${c.value}</div></div>`).join('')}
  </div>
  <div class="stat-grid">
    ${statCards.map((c) => `<div class="stat"><div class="stat-num">${c.value}</div><div class="stat-label">${c.label}</div></div>`).join('')}
  </div>
</section>`;
}

function renderRisks(model, ai) {
  const sevCls = { high: 'high', medium: 'medium', low: 'low' };
  const items = model.risks.map((r, i) => `
    <li class="risk risk-${sevCls[r.severity]}">
      <div class="risk-head"><span class="pill ${sevCls[r.severity]}">${SEV_LABEL[r.severity]}</span> ${esc(r.title)}</div>
      <div class="risk-detail">${esc(r.detail)}</div>
      ${r.evidence.length ? `<div class="risk-refs">${r.evidence.map((e) => `<span class="ref">${esc(e.label)}：${e.ref.startsWith('ticket-') || e.ref.startsWith('index') ? `<a href="${esc(e.ref)}">${esc(e.ref)}</a>` : `<code>${esc(e.ref)}</code>`}</span>`).join(' ')}</div>` : ''}
    </li>`).join('');

  let aiHtml = '';
  if (ai) {
    const aiItems = (ai.findings || []).map((f) => {
      const sev = SEV_LABEL[f.severity];
      const pill = sev
        ? `<span class="pill ${esc(f.severity)}">意见 · ${esc(sev)}</span>`
        : '<span class="pill ai">意见</span>';
      return `
      <li class="risk risk-ai">
        <div class="risk-head">${pill} ${esc(f.title)}</div></div>
        <div class="risk-detail">${esc(f.detail || '')}</div>
        ${(f.evidenceRefs || []).length ? `<div class="risk-refs">引用证据：${f.evidenceRefs.map((e) => `<code>${esc(e)}</code>`).join('、')}</div>` : ''}
      </li>`;
    }).join('');
    aiHtml = `
<section class="section">
  <h2>AI 分析意见 <span class="muted">· 非事实记录</span></h2>
  <p class="muted">以下内容由大模型基于本报告的确定性证据生成（模型：${esc(ai.model || '未知')}，生成于 ${esc(fmtTs(ai.generatedAt))}）。
  这是<b>观点层</b>，用于提示可能的交叉矛盾与未建模风险；请对照证据核实，勿作为事实采信。</p>
  <ul class="risk-list">${aiItems || '<li class="muted">（无意见）</li>'}</ul>
</section>`;
  }

  return `
<section class="section" id="risks">
  <h2>异常与风险 <span class="muted">· 确定性检出</span></h2>
  <p class="muted">以下条目全部由脚本从事件流、平台证据与 git 事实中机械检出，每条可回溯到出处，不含任何模型推断。</p>
  <ul class="risk-list">${items || '<li class="muted">未检出确定性异常。</li>'}</ul>
</section>
${aiHtml}`;
}

function renderTicketTable(model) {
  const rows = model.tickets.map((t) => {
    const status = t.merges.length ? `<span class="pill ok">已合并</span>`
      : model.run.escalates.some((e) => e.ticket === t.id) ? '<span class="pill bad">已升级</span>'
      : '<span class="pill warn">未合并</span>';
    const rounds = t.verdicts.map((v) => {
      const [label, cls] = VERDICT_LABEL[v.verdict] || [v.verdict, ''];
      return `<span class="pill ${cls}">R${v.round} ${label}</span>`;
    }).join(' ') || '<span class="muted">未评审</span>';
    return `<tr>
      <td><a href="ticket-${esc(t.id)}.html">票 ${esc(t.id)}</a></td>
      <td>${esc(t.title || '（票面缺失）')}</td>
      <td>${status}</td>
      <td>${rounds}</td>
      <td>${t.fixes.length || '—'}</td>
      <td>${t.merges.length ? sha(t.merges[t.merges.length - 1].mergeSha) : '—'}</td>
    </tr>`;
  }).join('');
  return `
<section class="section" id="tickets">
  <h2>票目总表</h2>
  <table class="table">
    <thead><tr><th>票</th><th>标题</th><th>状态</th><th>${term('评审裁决', 'verdict')}</th><th>修复轮</th><th>合并提交</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function narrateEvent(e) {
  const p = e.payload || {};
  const t = (zh, en) => term(zh, en);
  switch (e.type) {
    case 'init': return `${t('记账', 'record')} <b>运行初始化</b>：分支 <code>${esc(p.branch)}</code>（基线 ${sha(p.baselineSha)}），测试门禁 <code>${esc(p.testCommand)}</code>，票务 ${esc(p.tracker)}。`;
    case 'pr': return `代码评审 PR：${esc(p.state)}${p.url ? `（<a href="${esc(p.url)}">${esc(p.url)}</a>）` : ''}。`;
    case 'dispatch': return `${t('派发', 'dispatch')} 票 ${esc(p.ticket)}（key <code>${esc(p.key)}</code>，运行 <code>${esc((p.runId || '').slice(0, 8))}</code>${p.worktree === 'true' ? '，独立工作树' : ''}）。`;
    case 'settled': return `票 ${esc(p.ticket)} ${t('实现结算', 'settled')}：提交 ${sha(p.headSha)}${p.gate ? `，门禁：${esc(p.gate)}` : ''}。`;
    case 'verdict': {
      const [label] = VERDICT_LABEL[p.verdict] || [p.verdict];
      return `票 ${esc(p.ticket)} ${t('评审裁决', 'verdict')}（第 ${esc(p.round)} 轮）：<b>${esc(label)}</b>${p.findings ? `，问题清单 <code>${esc(path.basename(p.findings))}</code>` : ''}。`;
    }
    case 'fix': return `票 ${esc(p.ticket)} ${t('修复轮', 'fix round')} ${esc(p.fixNo)}：${t('续跑', 'resume')}同一实现者（key <code>${esc(p.key)}</code>）${p.note ? `——${esc(p.note)}` : ''}。`;
    case 'merge': return `票 ${esc(p.ticket)} <b>合并</b>：merge ${sha(p.mergeSha)}${p.note ? `，${esc(p.note)}` : ''}。`;
    case 'final': {
      const [label] = VERDICT_LABEL[p.finalVerdict] || [p.finalVerdict];
      return `${t('终审', 'final review')}裁决：<b>${esc(label)}</b>（运行 <code>${esc((p.runId || '').slice(0, 8))}</code>）${p.findings ? `，问题清单 <code>${esc(path.basename(p.findings))}</code>` : ''}。`;
    }
    case 'escalate': return `票 ${esc(p.ticket)} <b class="bad-text">${t('升级', 'escalate')}</b>：${esc(p.note || '预算耗尽，移交维护者。')}`;
    case 'anomaly': return `<b class="bad-text">${t('异常记录', 'anomaly')}</b>：${esc(p.note)}`;
    case 'close': return `<b>${t('封账', 'close')}</b>：运行终结。${esc(p.note || '')}`;
    default: return `<b>${esc(e.type)}</b>：<code>${esc(JSON.stringify(p)).slice(0, 300)}</code>`;
  }
}

function renderTimeline(model) {
  const items = model.events.map((e) => `
    <li class="tl-item">
      <div class="tl-meta">#${esc(e.seq)} · ${esc(fmtTs(e.ts))}</div>
      <div class="tl-text">${narrateEvent(e)}</div>
    </li>`).join('');
  return `
<section class="section" id="timeline">
  <h2>事件时间线 <span class="muted">· 叙述化</span></h2>
  <p class="muted">由${term('事件流', 'event stream')}逐条渲染：每条${term('记账', 'record')}都带权威序号与时间戳，可回到运行目录 <code>events.jsonl</code> 对账。</p>
  <ol class="timeline">${items}</ol>
</section>`;
}

function renderCost(model) {
  const rows = Object.entries(model.stats.byRole).map(([role, v]) => `
    <tr><td>${esc(ROLE_LABEL[role] || role)}</td><td>${v.runs}</td><td>${fmtCost(v.cost)}</td><td>${fmtTokens(v.tokens)}</td></tr>`).join('');
  return `
<section class="section" id="cost">
  <h2>用量与成本</h2>
  <table class="table">
    <thead><tr><th>环节</th><th>运行次数</th><th>成本</th><th>token</th></tr></thead>
    <tbody>${rows}<tr class="total"><td>合计</td><td>—</td><td>${fmtCost(model.stats.totalCost)}</td><td>${fmtTokens(model.stats.totalTokens)}</td></tr></tbody>
  </table>
  <p class="muted">口径：事件流中有运行 ID 记录的子代理（含 run 级终审——其运行 ID 由 final 事件承载）；旧账无 final 事件时终审运行降级为平台证据目录扫描汇集，见 <a href="final.html">终审与收尾</a>。</p>
</section>`;
}

function renderGlossary() {
  const groups = [
    ['域词汇', TERMS.filter((t) => ['ledger', 'event-stream', 'notes', 'record', 'close', 'reconcile', 'flow-shape'].includes(t.id))],
    ['流程环节', TERMS.filter((t) => ['frontier', 'dispatch', 'settled', 'verdict', 'two-axis', 'fix-round', 'escalate', 'integration-gate', 'final-review', 'anomaly'].includes(t.id))],
    ['平台与证据', TERMS.filter((t) => ['acceptance-contract', 'structured-output', 'worktree', 'gate', 'run', 'resume'].includes(t.id))],
  ];
  return `
<section class="section" id="glossary">
  <h2>名词表</h2>
  <p class="muted">正文中的术语都链接到这里。域词汇与包内 <code>CONTEXT.md</code> 保持一致。</p>
  ${groups.map(([title, terms]) => `
    <h3>${esc(title)}</h3>
    <dl class="glossary">
      ${terms.map((t) => `<dt id="g-${esc(t.id)}">${esc(t.zh)}（${esc(t.en)}）</dt><dd>${esc(t.def)}</dd>`).join('')}
    </dl>`).join('')}
</section>`;
}

function renderIndex(model, ai) {
  const body = `
${renderOverview(model)}
${renderRisks(model, ai)}
${renderTicketTable(model)}
${renderTimeline(model)}
${renderCost(model)}
${renderGlossary()}`;
  return layout(`总览 · ${model.slug}`, body);
}

// ---------------------------------------------------------------- 票页

function runSummaryCard(model, ref) {
  const c = model.childRuns[ref.runId];
  if (!c || !c.found) {
    return `<div class="card"><div class="card-label">运行证据</div><div class="card-value muted">证据缺失（可能已被平台清理）· 运行 <code>${esc(ref.runId.slice(0, 8))}</code></div></div>`;
  }
  const u = c.usage || {};
  const checks = (c.acceptance && c.acceptance.runtimeChecks || []).map((k) => `<li class="${k.status === 'passed' ? 'ok-text' : 'bad-text'}">${esc(k.id)}：${esc(k.status)}</li>`).join('');
  const verify = (c.acceptance && c.acceptance.verifyRuns || []).map((v) => `
    <div class="verify"><b>${esc(v.id)}</b> <code>${esc(v.command)}</code> — <span class="${v.status === 'passed' ? 'ok-text' : 'bad-text'}">${esc(v.status)}</span>（${esc(String(v.durationMs || '—'))} ms）
    ${v.stdout ? details('查看门禁输出', codeBlock(v.stdout)) : ''}</div>`).join('');
  return `
<div class="card run-card">
  <div class="card-label">${esc(ROLE_LABEL[ref.role] || ref.role)}运行 <code>${esc(c.runId.slice(0, 8))}</code></div>
  <div class="card-value">
    模型 <code>${esc(c.model || '—')}</code> · 退出码 <span class="${c.exitCode === 0 ? 'ok-text' : 'bad-text'}">${esc(String(c.exitCode ?? '—'))}</span>
    · 成本 ${fmtCost(u.cost)} · token ${fmtTokens((u.input || 0) + (u.output || 0))}
    ${c.acceptance ? `· 验收状态 <span class="${/reject/i.test(String(c.acceptance.status)) ? 'bad-text' : 'ok-text'}">${esc(c.acceptance.status || '—')}</span>` : ''}
  </div>
  ${verify ? `<div class="sub">门禁：</div>${verify}` : ''}
  ${checks ? details('验收检查明细', `<ul class="plain">${checks}</ul>`) : ''}
  ${c.childReport ? details('实现者结构化报告（原始字段）', codeBlock(JSON.stringify(c.childReport, null, 2))) : ''}
  ${c.structuredValue ? details('结构化输出（原始字段）', codeBlock(JSON.stringify(c.structuredValue, null, 2))) : ''}
  ${c.outputMd ? details('最终输出全文', codeBlock(c.outputMd)) : ''}
  ${(c.nestedDispatches || []).length ? details(`内部派发（${c.nestedDispatches.length} 次，${term('双轴评审', 'two-axis')}轴代理等）`, c.nestedDispatches.map((n) => `<div class="nested"><div class="muted">${esc(fmtTs(n.ts))} → ${esc(n.agent)}</div>${codeBlock(n.excerpt)}</div>`).join('')) : ''}
  ${c.transcriptPath ? `<div class="muted small">完整过程记录：<code>${esc(c.transcriptPath)}</code></div>` : ''}
</div>`;
}

function renderTicket(model, t, idx, total) {
  const rounds = new Map(); // round -> html parts
  const push = (k, html) => { if (!rounds.has(k)) rounds.set(k, []); rounds.get(k).push(html); };

  for (const d of t.dispatches) {
    const brief = findBriefForSafe(model, d.key, d.ts);
    push(Number(d.round || 1), `
      <div class="step"><div class="step-title">${term('派发', 'dispatch')} <code>${esc(d.key)}</code> <span class="muted">· ${esc(fmtTs(d.ts))} · 序号 ${esc(d.seq)}</span></div>
      ${runSummaryCard(model, { runId: d.runId, role: 'coder', ticket: t.id, key: d.key })}
      ${brief
        ? details('派发任务书原文（从主会话恢复）', codeBlock(brief.text))
        : '<div class="muted">派发任务书原文未能从主会话恢复。</div>'}
      </div>`);
  }
  for (const s of t.settles) {
    push(Number(s.round || 1), `
      <div class="step"><div class="step-title">${term('实现结算', 'settled')} <span class="muted">· ${esc(fmtTs(s.ts))}</span></div>
      <div class="card">提交锚点 ${sha(s.headSha)}${s.gate ? ` · 门禁摘要：${esc(s.gate)}` : ''}${s.worktree ? ` · <span class="muted small">工作树 <code>${esc(s.worktree)}</code></span>` : ''}</div>
      </div>`);
  }
  for (const v of t.verdicts) {
    const [label, cls] = VERDICT_LABEL[v.verdict] || [v.verdict, ''];
    const findings = v.findings && model.findingsFiles[v.findings];
    const bundleKey = Object.keys(model.bundles).find((k) => k.includes(`/${String(t.id).padStart(2, '0')}-r${v.round || 1}.diff`));
    const bundle = bundleKey ? model.bundles[bundleKey] : null;
    push(Number(v.round || 1), `
      <div class="step"><div class="step-title">${term('评审裁决', 'verdict')}（第 ${esc(v.round)} 轮）<span class="muted">· ${esc(fmtTs(v.ts))}</span></div>
      ${runSummaryCard(model, { runId: v.revRunId, role: 'reviewer', ticket: t.id, key: `rev-${t.id}` })}
      <div class="card">结论 <span class="pill ${cls}">${esc(label)}</span>${v.note ? ` · ${esc(v.note)}` : ''}</div>
      ${v.findings
        ? findings
          ? details(`问题清单全文（${esc(path.basename(v.findings))}）`, codeBlock(findings.text))
          : `<div class="card muted">问题清单文件缺失或不可读：<code>${esc(v.findings)}</code>（可能已被清理）</div>`
        : ''}
      ${v.findings || bundle
        ? bundle
          ? details(`评审材料包 diff（${fmtSize(bundle)}）`, bundle.truncated ? `${diffBlock(bundle.text)}<div class="muted">（原文 ${fmtSize(bundle)}，已截断展示）</div>` : diffBlock(bundle.text))
          : `<div class="card muted">评审材料包缺失或不可读：<code>reviews/${esc(String(t.id).padStart(2, '0'))}-r${esc(v.round || 1)}.diff</code></div>`
        : ''}
      </div>`);
  }
  for (const f of t.fixes) {
    const brief = findBriefForSafe(model, f.key, f.ts);
    push(Number((f.fixNo || 1)) + 0.5, `
      <div class="step"><div class="step-title">${term('修复轮', 'fix round')} ${esc(f.fixNo)} <span class="muted">· ${esc(fmtTs(f.ts))}</span></div>
      ${f.note ? `<div class="card">问题摘要：${esc(f.note)}</div>` : ''}
      ${runSummaryCard(model, { runId: f.resumeRunId, role: 'coder-resume', ticket: t.id, key: f.key })}
      ${brief ? details('修复任务书原文（续跑指令，从主会话恢复）', codeBlock(brief.text)) : '<div class="muted">修复任务书原文未能恢复。</div>'}
      </div>`);
  }
  const mergeHtml = t.merges.map((m) => `
    <div class="step"><div class="step-title">合并 <span class="muted">· ${esc(fmtTs(m.ts))}</span></div>
    <div class="card">merge ${sha(m.mergeSha)} ← 票头 ${sha(m.headSha)}${m.note ? ` · ${esc(m.note)}` : ''}${model.git[m.mergeSha] ? `<div class="muted small">提交主题：${esc(model.git[m.mergeSha].subject)}</div>` : model.git[m.mergeSha] === undefined ? '' : '<div class="muted small">（合并提交已不在当前分支可达范围）</div>'}</div>
    </div>`).join('');

  const roundKeys = [...rounds.keys()].sort((a, b) => a - b);
  const roundsHtml = roundKeys.map((k) => {
    const label = Number.isInteger(k) ? `第 ${k} 轮` : `修复轮 ${Math.floor(k)}`;
    return `<div class="round"><h3>${esc(label)}</h3>${rounds.get(k).join('')}</div>`;
  }).join('');

  const nav = `
  <div class="pager">
    ${idx > 0 ? `<a href="ticket-${esc(model.tickets[idx - 1].id)}.html">← 票 ${esc(model.tickets[idx - 1].id)}</a>` : '<span></span>'}
    <a href="index.html">返回总览</a>
    ${idx < total - 1 ? `<a href="ticket-${esc(model.tickets[idx + 1].id)}.html">票 ${esc(model.tickets[idx + 1].id)} →</a>` : '<span></span>'}
  </div>`;

  const body = `
<div class="page-head">
  <h1>票 ${esc(t.id)}：${esc(t.title || '（票面缺失）')}</h1>
  <p class="muted">${t.file ? `票面文件 <code>${esc(t.file)}</code>` : '票面文件未找到'}</p>
</div>
${t.body ? details('票面原文', codeBlock(t.body)) : ''}
<div class="rounds">${roundsHtml || '<p class="muted">本票没有派发记录。</p>'}</div>
${mergeHtml ? `<div class="round"><h3>合并</h3>${mergeHtml}</div>` : ''}
${nav}`;
  return layout(`票 ${t.id} · ${model.slug}`, body);
}

function findBriefForSafe(model, key, ts) {
  const { findBriefFor } = require('./collect');
  return findBriefFor(model.briefs, key, ts);
}

function fmtSize(o) {
  if (!o) return '0 B';
  const kb = o.length / 1024;
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
}

// ---------------------------------------------------------------- 终审与收尾页

function renderFinal(model) {
  const fr = model.finalReviews;
  const parts = [];
  parts.push(`<div class="page-head"><h1>终审与收尾</h1><p class="muted">终审运行由${term('事件流', 'event stream')}的 <code>final</code> 事件驱动汇集（runId 与裁决均取自事件）；旧账无 final 事件时降级为平台证据目录扫描。</p></div>`);

  if (!fr.length) {
    parts.push('<p class="muted">未找到终审（final-reviewer）运行证据。</p>');
  } else {
    const bundleKey = Object.keys(model.bundles).find((k) => k.endsWith('/final.diff'));
    const bundle = bundleKey ? model.bundles[bundleKey] : null;
    for (const c of fr) {
      const u = c.usage || {};
      const verdict = c.verdict || (c.structuredValue && c.structuredValue.verdict) || null;
      const [label, cls] = verdict ? (VERDICT_LABEL[verdict] || [verdict, '']) : ['（结构化结论未提取，见全文）', ''];
      const findings = c.findings ? model.findingsFiles[c.findings] : null;
      parts.push(`
<div class="step">
  <div class="step-title">${term('终审', 'final review')} 运行 <code>${esc(c.runId.slice(0, 8))}</code> <span class="muted">· 模型 ${esc(c.model || '—')} · 成本 ${fmtCost(u.cost)}</span></div>
  <div class="card">结论 <span class="pill ${cls}">${esc(label)}</span>${c.seq != null ? ` <span class="muted small">· 记账序号 ${esc(c.seq)} · ${esc(fmtTs(c.ts))}</span>` : ''}</div>
  ${c.deadRunRef ? '<div class="card muted">该 final 事件的 runId 不是 UUID 形状——判定为记账污染的死数据：不探测平台证据；裁决仍以事件流为准（取证告警另见 run-ref-dead 留痕）。</div>' : ''}
  ${c.findings
    ? findings
      ? details(`问题清单全文（${esc(path.basename(c.findings))}）`, codeBlock(findings.text))
      : `<div class="card muted">问题清单文件缺失或不可读：<code>${esc(c.findings)}</code>（可能已被清理）</div>`
    : ''}
  ${c.structuredValue ? details('结构化结论（原始字段）', codeBlock(JSON.stringify(c.structuredValue, null, 2))) : ''}
  ${c.outputMd ? details('终审报告全文', codeBlock(c.outputMd)) : ''}
  ${bundle ? details(`整分支评审材料包（${fmtSize(bundle)}）`, bundle.truncated ? `${diffBlock(bundle.text)}<div class="muted">（已截断）</div>` : diffBlock(bundle.text)) : ''}
  ${c.transcriptPath ? `<div class="muted small">完整过程记录：<code>${esc(c.transcriptPath)}</code></div>` : ''}
</div>`);
    }
  }

  if (model.run.anomalies.length || model.run.escalates.length) {
    parts.push(`
<section class="section"><h2>${term('异常记录', 'anomaly')}与${term('升级', 'escalate')}</h2>
<ol class="timeline">
${[...model.run.anomalies.map((a) => ({ ...a, kind: 'anomaly' })), ...model.run.escalates.map((e) => ({ ...e, kind: 'escalate' }))]
  .sort((a, b) => a.seq - b.seq)
  .map((x) => `<li class="tl-item"><div class="tl-meta">#${esc(x.seq)} · ${esc(fmtTs(x.ts))}</div><div class="tl-text">${x.kind === 'anomaly' ? `<b class="bad-text">异常记录</b>：${esc(x.note)}` : `<b class="bad-text">升级</b> 票 ${esc(x.ticket)}：${esc(x.note || '')}`}</div></li>`).join('')}
</ol></section>`);
  }

  if (model.run.sealed) {
    parts.push(`
<section class="section"><h2>${term('封账', 'close')}</h2>
<div class="card">${esc(model.run.close.note || '运行终结。')} <span class="muted">· ${esc(fmtTs(model.run.close.ts))}</span></div>
</section>`);
  } else {
    parts.push('<section class="section"><div class="risk risk-medium"><div class="risk-head"><span class="pill medium">注意</span> 运行未封账</div><div class="risk-detail">事件流没有 close 记账，本报告可能不反映终局。</div></div></section>');
  }

  if (model.notes) {
    parts.push(`
<section class="section"><h2>${term('编排笔记', 'orchestration notes')}（全文）</h2>
${details('展开阅读 notes.md', codeBlock(model.notes))}
</section>`);
  }

  return layout(`终审与收尾 · ${model.slug}`, parts.join('\n'));
}

// ---------------------------------------------------------------- 输出

function renderAll(model, outDir, ai) {
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  const files = [
    ['index.html', renderIndex(model, ai)],
    ['final.html', renderFinal(model)],
    ...model.tickets.map((t, i) => [`ticket-${t.id}.html`, renderTicket(model, t, i, model.tickets.length)]),
    ['assets/style.css', CSS],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(outDir, name), content);
  }
  return files.map(([n]) => path.join(outDir, n));
}

const CSS = `
:root {
  --bg: #fafafa; --card: #ffffff; --line: #e3e3e0; --text: #1f2328; --muted: #6e7781;
  --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --accent: #0969da;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.7 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
.topbar { position: sticky; top: 0; z-index: 10; background: #ffffffee; backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); }
.topbar-inner { max-width: 980px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; }
.brand { font-weight: 700; }
.nav a { margin-left: 16px; color: var(--accent); text-decoration: none; }
.nav a:hover { text-decoration: underline; }
.page { max-width: 980px; margin: 0 auto; padding: 24px 20px 60px; }
h1 { font-size: 26px; margin: 8px 0 12px; } h2 { font-size: 20px; margin: 0 0 8px; } h3 { font-size: 16px; margin: 16px 0 8px; }
.muted { color: var(--muted); font-weight: 400; }
.small { font-size: 12px; }
.lede { color: var(--muted); max-width: 720px; }
.hero { margin-bottom: 28px; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; margin: 16px 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
.card-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.card-value { word-break: break-all; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin: 16px 0; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 8px; text-align: center; padding: 12px 8px; }
.stat-num { font-size: 22px; font-weight: 700; }
.stat-label { font-size: 12px; color: var(--muted); }
.section { margin: 32px 0; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); background: #f0f0ee; }
.pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, white); background: #f0faf3; }
.pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, white); background: #fdf7e8; }
.pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, white); background: #fdf0f0; }
.pill.high { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, white); background: #fdf0f0; }
.pill.medium { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, white); background: #fdf7e8; }
.pill.low { color: var(--muted); }
.pill.ai { color: #8250df; border-color: color-mix(in srgb, #8250df 35%, white); background: #f6f2fd; }
.risk-list { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 10px; }
.risk { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 8px; padding: 10px 14px; }
.risk-high { border-left-color: var(--bad); }
.risk-medium { border-left-color: var(--warn); }
.risk-low { border-left-color: var(--line); }
.risk-ai { border-left-color: #8250df; }
.risk-head { font-weight: 600; margin-bottom: 4px; }
.risk-detail { color: var(--text); margin: 4px 0; }
.risk-refs { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.ref code, .ref a { background: #f0f0ee; padding: 1px 6px; border-radius: 4px; }
.table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.table th, .table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
.table th { background: #f0f0ee; font-size: 13px; }
.table tr:last-child td { border-bottom: none; }
.table .total td { font-weight: 700; background: #fafaf8; }
.timeline { list-style: none; padding: 0; margin: 12px 0; border-left: 2px solid var(--line); }
.tl-item { padding: 6px 0 6px 16px; position: relative; }
.tl-item::before { content: ""; position: absolute; left: -6px; top: 14px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.tl-meta { font-size: 12px; color: var(--muted); }
.glossary dt { font-weight: 700; margin-top: 10px; }
.glossary dd { margin: 2px 0 0 0; color: var(--text); }
a.term { color: inherit; text-decoration: underline dotted var(--muted); text-underline-offset: 3px; }
a.term:hover { color: var(--accent); }
code, .sha { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: #f0f0ee; padding: 1px 5px; border-radius: 4px; }
pre.code { background: #f6f8fa; border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
pre.diff .d-add { background: #e6ffec; display: inline-block; width: 100%; }
pre.diff .d-del { background: #ffebe9; display: inline-block; width: 100%; }
pre.diff .d-hunk { color: var(--accent); font-weight: 600; }
details.fold { margin: 8px 0; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
details.fold > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; color: var(--accent); }
details.fold > .fold-body { padding: 0 12px 12px; }
.step { margin: 14px 0; padding: 12px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.step-title { font-weight: 700; margin-bottom: 8px; }
.round { margin: 24px 0; }
.run-card { margin: 8px 0; }
.sub { margin: 8px 0 4px; font-weight: 600; font-size: 13px; }
.verify { margin: 4px 0; }
.nested { margin: 6px 0; }
.plain { margin: 4px 0; padding-left: 18px; }
.plain li { margin: 2px 0; font-size: 13px; }
.ok-text { color: var(--ok); } .bad-text { color: var(--bad); }
.pager { display: flex; justify-content: space-between; margin: 28px 0 8px; }
.pager a { color: var(--accent); text-decoration: none; }
.page-head { margin-bottom: 16px; }
.foot { max-width: 980px; margin: 0 auto; padding: 16px 20px 40px; color: var(--muted); font-size: 12px; }
`;

module.exports = { renderAll, esc, term };
