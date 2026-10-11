'use strict';
// ============================================================================
// 对照候选（基线 / 原样搬迁阶段 / 最终候选）与被测内容标识（票 35）。
//
// 「选哪个候选」和「实际测的是不是那个候选」是两件事。本模块只做无副作用的事实
// 读取，不 checkout、不建分支、不改工作区：
//
//   - 相关内容标识：按 scripts/registration-checks.js 的 CONTRACT_DOCUMENTS 取
//     指令文档清单（位置由登记表决定，不在此写死路径），把工作区内容与命名候选
//     ref 处的内容各算一份内容哈希。
//   - match：命名候选 ref 的内容是否与工作区内容一致。不一致时如实标注——本轮
//     证据不得据此宣称检验了该候选，受影响证据需重新评估。
//   - 未知 ref 是用法错误（调用方按用法错误处理），不猜、不静默降级。
//
// 一次对照 = 各自单独授权的批次：候选范围进计划、进授权哈希，换候选必须重新授权。
// ============================================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { contractDocPaths } = require('../../../scripts/registration-checks.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const REGISTRY_DOCS = contractDocPaths();

class CandidateError extends Error {}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 内容标识 = 相关指令文档清单上的稳定哈希（只取有内容的文档；缺失的文档不进哈希，
// 由 docs 列表里的 hash: null 单独如实呈现）。
function contentId(entries) {
  const stable = entries
    .filter((e) => e.hash != null)
    .map((e) => `${e.path}:${e.hash}`)
    .sort()
    .join('\n');
  return sha256(stable);
}

function defaultShowFile(root) {
  return (doc, rev) => {
    const r = spawnSync('git', ['show', `${rev}:${doc}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) return null;
    return r.stdout;
  };
}

function defaultReadWorking(root) {
  return (doc) => {
    try {
      return fs.readFileSync(path.join(root, doc), 'utf8');
    } catch {
      return null;
    }
  };
}

function resolveRef(ref, { root, run = defaultRun }) {
  const r = run(['rev-parse', '--verify', `${ref}^{commit}`], root);
  if (r.status !== 0) throw new CandidateError(`未知候选 / 基线 ref：${ref}（git rev-parse 失败）`);
  return r.stdout.trim();
}

function defaultRun(args, root) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// 解析候选：ref → sha + 工作区内容标识 + 命名 ref 处内容标识 + 一致性。
function resolveCandidate({ ref, root = REPO_ROOT, docs = REGISTRY_DOCS, showFile, readWorking, run } = {}) {
  if (!ref) throw new CandidateError('候选 ref 不能为空');
  const runner = run || ((args, cwd) => defaultRun(args, cwd));
  const sha = resolveRef(ref, { root, run: runner });
  const show = showFile || defaultShowFile(root);
  const read = readWorking || defaultReadWorking(root);

  const entries = docs.map((doc) => {
    const working = read(doc);
    const atRef = show(doc, sha);
    return {
      path: doc,
      hash: working == null ? null : sha256(working),
      refHash: atRef == null ? null : sha256(atRef),
      match: working != null && atRef != null && working === atRef,
    };
  });

  const mismatched = entries.filter((e) => !e.match).map((e) => e.path);
  const match = mismatched.length === 0;
  return {
    ref,
    sha,
    match,
    contentId: contentId(entries.map((e) => ({ path: e.path, hash: e.hash }))),
    refContentId: contentId(entries.map((e) => ({ path: e.path, hash: e.refHash }))),
    docs: entries.map((e) => ({ path: e.path, hash: e.hash, refHash: e.refHash, match: e.match })),
    mismatched,
    note: match
      ? `候选 ${ref} @ ${sha.slice(0, 12)} 的相关指令内容与工作区一致，本轮结果可绑定该候选。`
      : `候选 ${ref} @ ${sha.slice(0, 12)} 与工作区不一致（${mismatched.join('、') || '未知'}）：本轮结果不得据此宣称检验了该候选；相关文档已变化，受影响证据需重新评估。`,
  };
}

// 对照说明：行为对照，不是逐字输出或相同工具序列的对照。
function comparisonNote({ baseline, candidate }) {
  if (!baseline && !candidate) return '本轮无对照：只记录被测版本（本入口不做优化前后对照运行）';
  const parts = [];
  if (candidate) parts.push(`被测候选标识 ${candidate}`);
  if (baseline) parts.push(`对照基线标识 ${baseline}`);
  return `${parts.join('；')}：只记录标识与内容哈希供报告绑定（本入口不执行对照运行）。对照按场景行为与安全边界结果比较，不比较逐字输出、token 数或相同工具序列；每个候选各自单独授权。`;
}

module.exports = {
  REPO_ROOT,
  REGISTRY_DOCS,
  CandidateError,
  sha256,
  contentId,
  resolveCandidate,
  comparisonNote,
};
