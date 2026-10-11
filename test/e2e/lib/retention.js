'use strict';
// ============================================================================
// 运行证据的保留与清理策略（纯逻辑，便于确定性测试）。
//
// 策略：
//   - 通过（passed）的运行：超过保留天数即可清理。
//   - 失败 / 未完成 / 取消 / 拒绝的运行：默认保留——失败时不立即删除唯一证据；
//     只有显式 --force 才删。删除不是自动发生的，也不会连带删除未过期的运行。
//   - 清理只作用于证据目录内部，不碰源码、不碰 tracker、不发起任何模型调用。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_KEEP_DAYS = 14;

function readRunStatus(dir) {
  for (const name of ['results.json', 'refusal.json']) {
    const file = path.join(dir, name);
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && typeof doc.status === 'string') return doc.status;
    } catch { /* 缺文件或坏 JSON：按未知处理（未知＝不删） */ }
  }
  return 'unknown';
}

function cleanRuns({ root, keepDays = DEFAULT_KEEP_DAYS, force = false, now = Date.now() }) {
  const report = { root, keepDays, force, removed: [], kept: [] };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return report; // 还没有证据目录：无事可做
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const status = readRunStatus(dir);
    const ageDays = (now - fs.statSync(dir).mtimeMs) / 86400000;
    const failureState = status !== 'passed';
    if (failureState && !force) {
      report.kept.push({ name: entry.name, status, reason: '失败/未完成/取消/拒绝的证据默认保留（--force 才删）' });
      continue;
    }
    if (ageDays < keepDays) {
      report.kept.push({ name: entry.name, status, reason: `未超过保留天数 ${keepDays}（已 ${ageDays.toFixed(1)} 天）` });
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    report.removed.push({ name: entry.name, status, ageDays: Number(ageDays.toFixed(1)) });
  }
  return report;
}

function renderCleanReport(report) {
  const lines = [];
  lines.push(`══ 真实模型验收证据清理（保留 ${report.keepDays} 天${report.force ? '，--force 含失败证据' : ''}）══`);
  lines.push(`目录   ${report.root}`);
  if (report.removed.length === 0) lines.push('删除   无');
  for (const r of report.removed) lines.push(`删除   ${r.name}  [${r.status}]  已 ${r.ageDays} 天`);
  if (report.kept.length === 0) lines.push('保留   无');
  for (const k of report.kept) lines.push(`保留   ${k.name}  [${k.status}] —— ${k.reason}`);
  lines.push('清理不发起任何模型调用；源码与 tracker 不在清理范围内。');
  return `${lines.join('\n')}\n`;
}

function defaultRunsRoot() {
  return path.join(path.resolve(__dirname, '..', '..', '..'), '.scratch', 'e2e-runs');
}

module.exports = { DEFAULT_KEEP_DAYS, readRunStatus, cleanRuns, renderCleanReport, defaultRunsRoot };
