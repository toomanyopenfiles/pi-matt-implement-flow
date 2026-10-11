'use strict';

// 契约搬迁 fixture（ticket 33）：临时根 + 假想登记表行，供静态合同与派发边界测试共用。
// 只写临时目录，绝不改动真实文件；登记表行的形状与 scripts/registration-checks.js 的
// CONTRACT_DOCUMENTS 一致（含触发入口字段）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TRUNK_DOC } = require('../../scripts/registration-checks.js');

// 临时根：files 是 { 包内相对路径: 文本 }。
function relocationRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

// 假想登记表行：默认入口是主干（carriers）且不钉触发锚点（trigger 为空即只查路径与
// 动作前读取语义）；要验触发条件时显式传 trigger。slimming 字段与真实登记行同形
// （ticket 38），默认「本轮未动」，验证精简影响的构造显式传入。
function contractRow(id, docs, {
  previous = [TRUNK_DOC],
  carriers = [TRUNK_DOC],
  trigger = '',
  slimming = { kind: 'unchanged', note: 'fixture row' },
} = {}) {
  return { id, contract: 'fixture row', docs, previous, entry: { carriers, trigger }, tests: [], slimming };
}

module.exports = { relocationRoot, contractRow };
