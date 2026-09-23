'use strict';
// 渲染器：中间模型 → 静态 HTML（人类可读、面向审核者）。
// 原则：术语括注对照语言并链接到首页名词表、事实与意见分区、全部证据可折叠展开。
// 全部面向人类的文案走 i18n.js：语言由 model.lang 决定（collect 写入，默认中文）。

const fs = require('fs');
const path = require('path');
const { TERMS, lookup } = require('./glossary');
const { findBriefFor } = require('./collect');
const { makeT, roleLabel, hasKey } = require('./i18n');

// ---------------------------------------------------------------- 基础

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 术语链接：term(T, '评审裁决', 'verdict') → 中文界面「评审裁决（verdict）」/ 英文界面「verdict（评审裁决）」
function term(T, zh, en) {
  const t = lookup(en) || lookup(zh);
  const label = T.lang === 'zh' ? `${esc(zh)}（${esc(en)}）` : `${esc(en)}（${esc(zh)}）`;
  if (!t) return label;
  const def = t.def[T.lang] || t.def.zh;
  return `<a class="term" href="index.html#g-${esc(t.id)}" title="${esc(def)}">${label}</a>`;
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

// 裁决标签（文案）+ 样式类（语言无关）
const VERDICT_CLS = {
  approved: 'ok',
  changes_requested: 'warn',
  ready: 'ok',
  ready_with_fixes: 'warn',
  not_ready: 'bad',
};
function verdictLabel(T, code) {
  const key = `verdict.${code}`;
  // 裁决码未入表时原样展示码值（不假装认识）；cls 是呈现样式，与文案分开维护
  return [hasKey(T.lang, key) ? T(key) : code, VERDICT_CLS[code] || ''];
}

// ---------------------------------------------------------------- 页面骨架

function layout(T, title, body, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="${esc(T('layout.htmlLang'))}">
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
    <span class="brand">${T('layout.brand')}</span>
    <nav class="nav">
      <a href="index.html">${T('layout.nav.overview')}</a>
      <a href="final.html">${T('layout.nav.final')}</a>
      <a href="index.html#glossary">${T('layout.nav.glossary')}</a>
    </nav>
  </div>
</header>
<main class="page">
${body}
</main>
<footer class="foot">${T('layout.footer', { ts: esc(fmtTs(new Date().toISOString())) })}</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------- 首页

function renderOverview(model, T) {
  const r = model.run;
  const init = r.init || {};
  const flags = init.reviewer != null || init.maxFixRounds != null || init.maxConcurrent != null
    ? T('ov.flowFlags', {
      state: init.reviewer === 'off' ? T('ov.off') : T('ov.on'),
      fix: init.maxFixRounds ?? 2,
      conc: init.maxConcurrent ?? 3,
    })
    : T('ov.flowFlagsDefault');
  const pr = r.prs.length ? r.prs[r.prs.length - 1] : null;

  const cards = [
    { label: T('ov.dir'), value: `<code>${esc(model.slug)}</code>` },
    { label: T('ov.repo'), value: `<code>${esc(model.repoPath)}</code>` },
    { label: T('ov.branch'), value: init.branch ? `<code>${esc(init.branch)}</code>${T('ov.baseline', { sha: sha(init.baselineSha) })}` : '—' },
    { label: 'spec', value: init.spec ? `<code>${esc(init.spec)}</code>` : '—' },
    { label: T('ov.gate'), value: init.testCommand ? `<code>${esc(init.testCommand)}</code>` : '—' },
    { label: term(T, '流程形态', 'flow shape'), value: flags },
    { label: T('ov.tracker'), value: esc(init.tracker || '—') },
    { label: T('ov.pr'), value: pr ? (pr.url ? `<a href="${esc(pr.url)}">${esc(pr.state)}${T('ev.prUrl', { url: esc(pr.url) })}</a>` : esc(pr.state)) : T('ov.prNone') },
    { label: term(T, '封账', 'seal'), value: r.sealed ? `<span class="pill ok">${T('ov.sealed')}</span> <span class="muted">${esc(fmtTs(r.close.ts))}</span>` : `<span class="pill bad">${T('ov.unsealed')}</span>` },
  ];

  const s = model.stats;
  const statCards = [
    { label: T('ov.stat.tickets'), value: model.tickets.length },
    { label: T('ov.stat.dispatches'), value: model.runRefs.filter((x) => x.role === 'coder').length },
    { label: T('ov.stat.reviews'), value: model.runRefs.filter((x) => x.role === 'reviewer').length },
    { label: T('ov.stat.fixes'), value: model.runRefs.filter((x) => x.role === 'coder-resume').length },
    { label: T('ov.stat.finals'), value: s.finalReviews || 0 },
    { label: T('ov.stat.cost'), value: fmtCost(s.totalCost) },
    { label: T('ov.stat.tokens'), value: fmtTokens(s.totalTokens) },
  ];

  return `
<section class="hero">
  <h1>${T('overview.title')} <span class="muted">· ${esc(model.slug)}</span></h1>
  <p class="lede">${T('overview.lede', { eventStream: term(T, '事件流', 'event stream') })}</p>
  <div class="card-grid">
    ${cards.map((c) => `<div class="card"><div class="card-label">${c.label}</div><div class="card-value">${c.value}</div></div>`).join('')}
  </div>
  <div class="stat-grid">
    ${statCards.map((c) => `<div class="stat"><div class="stat-num">${c.value}</div><div class="stat-label">${c.label}</div></div>`).join('')}
  </div>
</section>`;
}

function renderRisks(model, ai, T) {
  const sevCls = { high: 'high', medium: 'medium', low: 'low' };
  const items = model.risks.map((r, i) => `
    <li class="risk risk-${sevCls[r.severity]}">
      <div class="risk-head"><span class="pill ${sevCls[r.severity]}">${T(`sev.${r.severity}`)}</span> ${esc(r.title)}</div>
      <div class="risk-detail">${esc(r.detail)}</div>
      ${r.evidence.length ? `<div class="risk-refs">${r.evidence.map((e) => `<span class="ref">${esc(e.label)}：${e.ref.startsWith('ticket-') || e.ref.startsWith('index') ? `<a href="${esc(e.ref)}">${esc(e.ref)}</a>` : `<code>${esc(e.ref)}</code>`}</span>`).join(' ')}</div>` : ''}
    </li>`).join('');

  let aiHtml = '';
  if (ai) {
    const aiItems = (ai.findings || []).map((f) => {
      const sevKey = `sev.${f.severity}`;
      const sev = hasKey(T.lang, sevKey) ? T(sevKey) : null;
      const pill = sev
        ? `<span class="pill ${esc(f.severity)}">${T('ai.pill', { sev: esc(sev) })}</span>`
        : `<span class="pill ai">${T('ai.pillPlain')}</span>`;
      return `
      <li class="risk risk-ai">
        <div class="risk-head">${pill} ${esc(f.title)}</div></div>
        <div class="risk-detail">${esc(f.detail || '')}</div>
        ${(f.evidenceRefs || []).length ? `<div class="risk-refs">${T('ai.refs')}${f.evidenceRefs.map((e) => `<code>${esc(e)}</code>`).join(T('risk.listSep'))}</div>` : ''}
      </li>`;
    }).join('');
    aiHtml = `
<section class="section">
  <h2>${T('ai.title')} <span class="muted">· ${T('ai.subtitle')}</span></h2>
  <p class="muted">${T('ai.intro', { model: esc(ai.model || '—'), ts: esc(fmtTs(ai.generatedAt)) })}</p>
  <ul class="risk-list">${aiItems || `<li class="muted">${T('ai.empty')}</li>`}</ul>
</section>`;
  }

  return `
<section class="section" id="risks">
  <h2>${T('risk.title')} <span class="muted">· ${T('risk.subtitle')}</span></h2>
  <p class="muted">${T('risk.intro')}</p>
  <ul class="risk-list">${items || `<li class="muted">${T('risk.empty')}</li>`}</ul>
</section>
${aiHtml}`;
}

function renderTicketTable(model, T) {
  const rows = model.tickets.map((t) => {
    const status = t.merges.length ? `<span class="pill ok">${T('table.merged')}</span>`
      : model.run.escalates.some((e) => e.ticket === t.id) ? `<span class="pill bad">${T('table.escalated')}</span>`
        : `<span class="pill warn">${T('table.unmerged')}</span>`;
    const rounds = t.verdicts.map((v) => {
      const [label, cls] = verdictLabel(T, v.verdict);
      return `<span class="pill ${cls}">R${v.round} ${label}</span>`;
    }).join(' ') || `<span class="muted">${T('table.noReviews')}</span>`;
    return `<tr>
      <td><a href="ticket-${esc(t.id)}.html">${T('ev.ticket')} ${esc(t.id)}</a></td>
      <td>${esc(t.title || T('table.noTitle'))}</td>
      <td>${status}</td>
      <td>${rounds}</td>
      <td>${t.fixes.length || '—'}</td>
      <td>${t.merges.length ? sha(t.merges[t.merges.length - 1].mergeSha) : '—'}</td>
    </tr>`;
  }).join('');
  return `
<section class="section" id="tickets">
  <h2>${T('table.title')}</h2>
  <table class="table">
    <thead><tr><th>${T('table.ticket')}</th><th>${T('table.heading')}</th><th>${T('table.status')}</th><th>${term(T, '评审裁决', 'verdict')}</th><th>${T('table.fixes')}</th><th>${T('table.mergeSha')}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function narrateEvent(e, T) {
  const p = e.payload || {};
  const t = (zh, en) => term(T, zh, en);
  switch (e.type) {
    case 'init': return T('ev.init', {
      record: t('记账', 'record'), branch: esc(p.branch), base: sha(p.baselineSha),
      gate: esc(p.testCommand), tracker: esc(p.tracker),
    });
    case 'pr': return T('ev.pr', {
      state: esc(p.state),
      urlPart: p.url ? T('ev.prUrl', { url: `<a href="${esc(p.url)}">${esc(p.url)}</a>` }) : '',
    });
    case 'dispatch': return T('ev.dispatch', {
      dispatch: t('派发', 'dispatch'), ticket: esc(p.ticket), key: esc(p.key),
      run: esc((p.runId || '').slice(0, 8)), wt: p.worktree === 'true' ? T('ev.ownWorktree') : '',
    });
    case 'settled': return T('ev.settled', {
      ticket: esc(p.ticket), settled: t('实现结算', 'settled'), sha: sha(p.headSha),
      gate: p.gate ? T('ev.gateSuffix', { gate: esc(p.gate) }) : '',
    });
    case 'verdict': {
      const [label] = verdictLabel(T, p.verdict);
      return T('ev.verdict', {
        ticket: esc(p.ticket), verdict: t('评审裁决', 'verdict'), round: esc(p.round), label: esc(label),
        findings: p.findings ? T('ev.findingsSuffix', { file: esc(path.basename(p.findings)) }) : '',
      });
    }
    case 'fix': return T('ev.fix', {
      ticket: esc(p.ticket), fix: t('修复轮', 'fix round'), fixNo: esc(p.fixNo),
      resume: t('续跑', 'resume'), key: esc(p.key),
      note: p.note ? T('ev.noteSuffix', { note: esc(p.note) }) : '',
    });
    case 'merge': return T('ev.merge', {
      ticket: esc(p.ticket), sha: sha(p.mergeSha),
      note: p.note ? T('ev.noteComma', { note: esc(p.note) }) : '',
    });
    case 'final': {
      const [label] = verdictLabel(T, p.finalVerdict);
      return T('ev.final', {
        final: t('终审', 'final review'), label: esc(label), run: esc((p.runId || '').slice(0, 8)),
        findings: p.findings ? T('ev.findingsSuffix', { file: esc(path.basename(p.findings)) }) : '',
      });
    }
    case 'escalate': return T('ev.escalate', {
      ticket: esc(p.ticket), escalate: t('升级', 'escalate'),
      note: esc(p.note || T('ev.escalateDefault')),
    });
    case 'anomaly': return T('ev.anomaly', { anomaly: t('异常记录', 'anomaly'), note: esc(p.note) });
    case 'close': return T('ev.close', { close: t('封账', 'close'), note: esc(p.note || '') });
    default: return T('ev.unknown', { type: esc(e.type), payload: esc(JSON.stringify(p)).slice(0, 300) });
  }
}

function renderTimeline(model, T) {
  const items = model.events.map((e) => `
    <li class="tl-item">
      <div class="tl-meta">#${esc(e.seq)} · ${esc(fmtTs(e.ts))}</div>
      <div class="tl-text">${narrateEvent(e, T)}</div>
    </li>`).join('');
  return `
<section class="section" id="timeline">
  <h2>${T('tl.title')} <span class="muted">· ${T('tl.subtitle')}</span></h2>
  <p class="muted">${T('tl.intro', { eventStream: term(T, '事件流', 'event stream'), record: term(T, '记账', 'record') })}</p>
  <ol class="timeline">${items}</ol>
</section>`;
}

function renderCost(model, T) {
  const rows = Object.entries(model.stats.byRole).map(([role, v]) => `
    <tr><td>${esc(roleLabel(model.lang, role))}</td><td>${v.runs}</td><td>${fmtCost(v.cost)}</td><td>${fmtTokens(v.tokens)}</td></tr>`).join('');
  return `
<section class="section" id="cost">
  <h2>${T('cost.title')}</h2>
  <table class="table">
    <thead><tr><th>${T('cost.role')}</th><th>${T('cost.runs')}</th><th>${T('cost.cost')}</th><th>${T('cost.tokens')}</th></tr></thead>
    <tbody>${rows}<tr class="total"><td>${T('cost.total')}</td><td>—</td><td>${fmtCost(model.stats.totalCost)}</td><td>${fmtTokens(model.stats.totalTokens)}</td></tr></tbody>
  </table>
  <p class="muted">${T('cost.note', { link: `<a href="final.html">${T('layout.nav.final')}</a>` })}</p>
</section>`;
}

function renderGlossary(model, T) {
  const groups = [
    [T('gl.group.domain'), TERMS.filter((t) => ['ledger', 'event-stream', 'notes', 'record', 'close', 'reconcile', 'flow-shape'].includes(t.id))],
    [T('gl.group.flow'), TERMS.filter((t) => ['frontier', 'dispatch', 'settled', 'verdict', 'two-axis', 'fix-round', 'escalate', 'integration-gate', 'final-review', 'anomaly'].includes(t.id))],
    [T('gl.group.platform'), TERMS.filter((t) => ['acceptance-contract', 'structured-output', 'worktree', 'gate', 'run', 'resume'].includes(t.id))],
  ];
  return `
<section class="section" id="glossary">
  <h2>${T('gl.title')}</h2>
  <p class="muted">${T('gl.intro')}</p>
  ${groups.map(([title, terms]) => `
    <h3>${esc(title)}</h3>
    <dl class="glossary">
      ${terms.map((t) => `<dt id="g-${esc(t.id)}">${esc(t.zh)}（${esc(t.en)}）</dt><dd>${esc(t.def[T.lang] || t.def.zh)}</dd>`).join('')}
    </dl>`).join('')}
</section>`;
}

function renderIndex(model, ai, T) {
  const body = `
${renderOverview(model, T)}
${renderRisks(model, ai, T)}
${renderTicketTable(model, T)}
${renderTimeline(model, T)}
${renderCost(model, T)}
${renderGlossary(model, T)}`;
  return layout(T, `${T('layout.nav.overview')} · ${model.slug}`, body);
}

// ---------------------------------------------------------------- 票页

function runSummaryCard(model, ref, T) {
  const c = model.childRuns[ref.runId];
  if (!c || !c.found) {
    return `<div class="card"><div class="card-label">${T('run.evidence')}</div><div class="card-value muted">${T('run.missing', { run: esc(ref.runId.slice(0, 8)) })}</div></div>`;
  }
  const u = c.usage || {};
  const checks = (c.acceptance && c.acceptance.runtimeChecks || []).map((k) => `<li class="${k.status === 'passed' ? 'ok-text' : 'bad-text'}">${T('run.checkLine', { id: esc(k.id), status: esc(k.status) })}</li>`).join('');
  const verify = (c.acceptance && c.acceptance.verifyRuns || []).map((v) => `
    <div class="verify">${T('run.verifyLine', { id: esc(v.id), command: esc(v.command), statusPart: `<span class="${v.status === 'passed' ? 'ok-text' : 'bad-text'}">${esc(v.status)}</span>${T('run.verifyMs', { ms: esc(String(v.durationMs || '—')) })}` })}
    ${v.stdout ? details(T('run.verifyDetails'), codeBlock(v.stdout)) : ''}</div>`).join('');
  return `
<div class="card run-card">
  <div class="card-label">${T('run.title', { role: esc(roleLabel(model.lang, ref.role)), run: esc(c.runId.slice(0, 8)) })}</div>
  <div class="card-value">
    ${T('run.modelWord')} <code>${esc(c.model || '—')}</code> · ${T('run.exitWord')} <span class="${c.exitCode === 0 ? 'ok-text' : 'bad-text'}">${esc(String(c.exitCode ?? '—'))}</span>
    · ${T('run.costWord')} ${fmtCost(u.cost)} · ${T('run.tokenWord')} ${fmtTokens((u.input || 0) + (u.output || 0))}
    ${c.acceptance ? `· ${T('run.acceptanceWord')} <span class="${/reject/i.test(String(c.acceptance.status)) ? 'bad-text' : 'ok-text'}">${esc(c.acceptance.status || '—')}</span>` : ''}
  </div>
  ${verify ? `<div class="sub">${T('run.gateHead')}</div>${verify}` : ''}
  ${checks ? details(T('run.checksDetails'), `<ul class="plain">${checks}</ul>`) : ''}
  ${c.childReport ? details(T('run.childReport'), codeBlock(JSON.stringify(c.childReport, null, 2))) : ''}
  ${c.structuredValue ? details(T('run.structuredValue'), codeBlock(JSON.stringify(c.structuredValue, null, 2))) : ''}
  ${c.outputMd ? details(T('run.outputMd'), codeBlock(c.outputMd)) : ''}
  ${(c.nestedDispatches || []).length ? details(T('run.nested', { count: c.nestedDispatches.length, twoAxis: term(T, '双轴评审', 'two-axis') }), c.nestedDispatches.map((n) => `<div class="nested"><div class="muted">${esc(fmtTs(n.ts))} → ${esc(n.agent)}</div>${codeBlock(n.excerpt)}</div>`).join('')) : ''}
  ${c.transcriptPath ? `<div class="muted small">${T('run.transcript', { path: esc(c.transcriptPath) })}</div>` : ''}
</div>`;
}

function renderTicket(model, t, idx, total, T) {
  const rounds = new Map(); // round -> html parts
  const push = (k, html) => { if (!rounds.has(k)) rounds.set(k, []); rounds.get(k).push(html); };

  for (const d of t.dispatches) {
    const brief = findBriefForSafe(model, d.key, d.ts);
    push(Number(d.round || 1), `
      <div class="step"><div class="step-title">${term(T, '派发', 'dispatch')} <code>${esc(d.key)}</code> <span class="muted">${T('tp.seqMeta', { ts: esc(fmtTs(d.ts)), seq: esc(d.seq) })}</span></div>
      ${runSummaryCard(model, { runId: d.runId, role: 'coder', ticket: t.id, key: d.key }, T)}
      ${brief
        ? details(T('tp.brief'), codeBlock(brief.text))
        : `<div class="muted">${T('tp.briefMissing')}</div>`}
      </div>`);
  }
  for (const s of t.settles) {
    push(Number(s.round || 1), `
      <div class="step"><div class="step-title">${term(T, '实现结算', 'settled')} <span class="muted">· ${esc(fmtTs(s.ts))}</span></div>
      <div class="card">${T('tp.commitAnchor', { sha: sha(s.headSha) })}${s.gate ? T('tp.gateSummary', { gate: esc(s.gate) }) : ''}${s.worktree ? T('tp.worktreePart', { path: esc(s.worktree) }) : ''}</div>
      </div>`);
  }
  for (const v of t.verdicts) {
    const [label, cls] = verdictLabel(T, v.verdict);
    const findings = v.findings && model.findingsFiles[v.findings];
    const bundleKey = Object.keys(model.bundles).find((k) => k.includes(`/${String(t.id).padStart(2, '0')}-r${v.round || 1}.diff`));
    const bundle = bundleKey ? model.bundles[bundleKey] : null;
    push(Number(v.round || 1), `
      <div class="step"><div class="step-title">${T('tp.verdictStep', { verdict: term(T, '评审裁决', 'verdict'), round: esc(v.round) })} <span class="muted">· ${esc(fmtTs(v.ts))}</span></div>
      ${runSummaryCard(model, { runId: v.revRunId, role: 'reviewer', ticket: t.id, key: `rev-${t.id}` }, T)}
      <div class="card">${T('tp.verdictResult', { pill: `<span class="pill ${cls}">${esc(label)}</span>`, note: v.note ? ` · ${esc(v.note)}` : '' })}</div>
      ${v.findings
        ? findings
          ? details(T('tp.findingsFull', { file: esc(path.basename(v.findings)) }), codeBlock(findings.text))
          : `<div class="card muted">${T('tp.findingsMissing', { path: esc(v.findings) })}</div>`
        : ''}
      ${v.findings || bundle
        ? bundle
          ? details(T('tp.bundleDiff', { size: fmtSize(bundle) }), bundle.truncated ? `${diffBlock(bundle.text)}<div class="muted">${T('tp.truncatedFull', { size: fmtSize(bundle) })}</div>` : diffBlock(bundle.text))
          : `<div class="card muted">${T('tp.bundleMissing', { id: esc(String(t.id).padStart(2, '0')), round: esc(v.round || 1) })}</div>`
        : ''}
      </div>`);
  }
  for (const f of t.fixes) {
    const brief = findBriefForSafe(model, f.key, f.ts);
    push(Number((f.fixNo || 1)) + 0.5, `
      <div class="step"><div class="step-title">${T('tp.fixRoundLabel', { n: esc(f.fixNo) })} <span class="muted">· ${esc(fmtTs(f.ts))}</span></div>
      ${f.note ? `<div class="card">${T('tp.fixNote', { note: esc(f.note) })}</div>` : ''}
      ${runSummaryCard(model, { runId: f.resumeRunId, role: 'coder-resume', ticket: t.id, key: f.key }, T)}
      ${brief ? details(T('tp.fixBrief'), codeBlock(brief.text)) : `<div class="muted">${T('tp.fixBriefMissing')}</div>`}
      </div>`);
  }
  const mergeHtml = t.merges.map((m) => `
    <div class="step"><div class="step-title">${T('tp.mergeStep')} <span class="muted">· ${esc(fmtTs(m.ts))}</span></div>
    <div class="card">${T('tp.mergeCard', { mergeSha: sha(m.mergeSha), headSha: sha(m.headSha), note: m.note ? ` · ${esc(m.note)}` : '' })}${model.git[m.mergeSha] ? `<div class="muted small">${T('tp.mergeSubject', { subject: esc(model.git[m.mergeSha].subject) })}</div>` : model.git[m.mergeSha] === undefined ? '' : `<div class="muted small">${T('tp.mergeUnreachable')}</div>`}</div>
    </div>`).join('');

  const roundKeys = [...rounds.keys()].sort((a, b) => a - b);
  const roundsHtml = roundKeys.map((k) => {
    const label = Number.isInteger(k) ? T('tp.roundLabel', { n: k }) : T('tp.fixRoundLabel', { n: Math.floor(k) });
    return `<div class="round"><h3>${esc(label)}</h3>${rounds.get(k).join('')}</div>`;
  }).join('');

  const nav = `
  <div class="pager">
    ${idx > 0 ? `<a href="ticket-${esc(model.tickets[idx - 1].id)}.html">${T('tp.pagerPrev', { id: esc(model.tickets[idx - 1].id) })}</a>` : '<span></span>'}
    <a href="index.html">${T('tp.pagerHome')}</a>
    ${idx < total - 1 ? `<a href="ticket-${esc(model.tickets[idx + 1].id)}.html">${T('tp.pagerNext', { id: esc(model.tickets[idx + 1].id) })}</a>` : '<span></span>'}
  </div>`;

  const body = `
<div class="page-head">
  <h1>${T('tp.title', { id: esc(t.id), title: esc(t.title || T('table.noTitle')) })}</h1>
  <p class="muted">${t.file ? T('tp.ticketFile', { path: esc(t.file) }) : T('tp.ticketFileMissing')}</p>
</div>
${t.body ? details(T('tp.ticketBody'), codeBlock(t.body)) : ''}
<div class="rounds">${roundsHtml || `<p class="muted">${T('tp.noDispatch')}</p>`}</div>
${mergeHtml ? `<div class="round"><h3>${T('tp.mergeStep')}</h3>${mergeHtml}</div>` : ''}
${nav}`;
  return layout(T, `${T('ev.ticket')} ${t.id} · ${model.slug}`, body);
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

function renderFinal(model, T) {
  const fr = model.finalReviews;
  const parts = [];
  parts.push(`<div class="page-head"><h1>${T('fp.title')}</h1><p class="muted">${T('fp.intro', { eventStream: term(T, '事件流', 'event stream') })}</p></div>`);

  if (!fr.length) {
    parts.push(`<p class="muted">${T('fp.none')}</p>`);
  } else {
    const bundleKey = Object.keys(model.bundles).find((k) => k.endsWith('/final.diff'));
    const bundle = bundleKey ? model.bundles[bundleKey] : null;
    for (const c of fr) {
      const u = c.usage || {};
      const verdict = c.verdict || (c.structuredValue && c.structuredValue.verdict) || null;
      const [label, cls] = verdict ? verdictLabel(T, verdict) : [T('fp.noVerdict'), ''];
      const findings = c.findings ? model.findingsFiles[c.findings] : null;
      parts.push(`
<div class="step">
  <div class="step-title">${T('fp.stepTitle', { final: term(T, '终审', 'final review'), run: esc(c.runId.slice(0, 8)), model: esc(c.model || '—'), cost: fmtCost(u.cost) })}</div>
  <div class="card">${T('tp.verdictResult', { pill: `<span class="pill ${cls}">${esc(label)}</span>`, note: c.seq != null ? T('fp.seqMeta', { seq: esc(c.seq), ts: esc(fmtTs(c.ts)) }) : '' })}</div>
  ${c.deadRunRef ? `<div class="card muted">${T('fp.deadRef')}</div>` : ''}
  ${c.findings
    ? findings
      ? details(T('tp.findingsFull', { file: esc(path.basename(c.findings)) }), codeBlock(findings.text))
      : `<div class="card muted">${T('tp.findingsMissing', { path: esc(c.findings) })}</div>`
    : ''}
  ${c.structuredValue ? details(T('fp.structured'), codeBlock(JSON.stringify(c.structuredValue, null, 2))) : ''}
  ${c.outputMd ? details(T('fp.reportFull'), codeBlock(c.outputMd)) : ''}
  ${bundle ? details(T('fp.finalBundle', { size: fmtSize(bundle) }), bundle.truncated ? `${diffBlock(bundle.text)}<div class="muted">${T('tp.truncatedShort')}</div>` : diffBlock(bundle.text)) : ''}
  ${c.transcriptPath ? `<div class="muted small">${T('run.transcript', { path: esc(c.transcriptPath) })}</div>` : ''}
</div>`);
    }
  }

  if (model.run.anomalies.length || model.run.escalates.length) {
    parts.push(`
<section class="section"><h2>${T('fp.anomaliesTitle', { anomaly: term(T, '异常记录', 'anomaly'), escalate: term(T, '升级', 'escalate') })}</h2>
<ol class="timeline">
${[...model.run.anomalies.map((a) => ({ ...a, kind: 'anomaly' })), ...model.run.escalates.map((e) => ({ ...e, kind: 'escalate' }))]
      .sort((a, b) => a.seq - b.seq)
      .map((x) => `<li class="tl-item"><div class="tl-meta">#${esc(x.seq)} · ${esc(fmtTs(x.ts))}</div><div class="tl-text">${x.kind === 'anomaly' ? T('fp.anomalyEntry', { note: esc(x.note) }) : T('fp.escalateEntry', { ticket: esc(x.ticket), note: esc(x.note || '') })}</div></li>`).join('')}
</ol></section>`);
  }

  if (model.run.sealed) {
    parts.push(`
<section class="section"><h2>${term(T, '封账', 'close')}</h2>
<div class="card">${esc(model.run.close.note || T('fp.sealNote'))} <span class="muted">· ${esc(fmtTs(model.run.close.ts))}</span></div>
</section>`);
  } else {
    parts.push(`<section class="section"><div class="risk risk-medium"><div class="risk-head"><span class="pill medium">${T('sev.medium')}</span> ${T('fp.unsealedTitle')}</div><div class="risk-detail">${T('fp.unsealedDetail')}</div></div></section>`);
  }

  if (model.notes) {
    parts.push(`
<section class="section"><h2>${T('fp.notesTitle', { notes: term(T, '编排笔记', 'orchestration notes') })}</h2>
${details(T('fp.notesFold'), codeBlock(model.notes))}
</section>`);
  }

  return layout(T, `${T('fp.title')} · ${model.slug}`, parts.join('\n'));
}

// ---------------------------------------------------------------- 输出

function renderAll(model, outDir, ai) {
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  const T = makeT(model.lang); // 全站点文案取用入口：只派生一次，向下传递
  const files = [
    ['index.html', renderIndex(model, ai, T)],
    ['final.html', renderFinal(model, T)],
    ...model.tickets.map((t, i) => [`ticket-${t.id}.html`, renderTicket(model, t, i, model.tickets.length, T)]),
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
