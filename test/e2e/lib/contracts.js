'use strict';
// ============================================================================
// 指令契约登记表的测试侧读取入口（票 35）。
//
// 权威清单只有一份：scripts/registration-checks.js 的 CONTRACT_DOCUMENTS。场景判定、
// 导航任务书的不指路检查、候选内容标识与合成轨迹都经这里取契约条目，不写死文档路径，
// 也不改生产脚本的导出面。
//
// 未知契约 id = 装置故障（调用方按 harness 处理），绝不静默降级成“没有这份文档”。
// ============================================================================

const { CONTRACT_DOCUMENTS } = require('../../../scripts/registration-checks.js');

function contractEntry(id, registry = CONTRACT_DOCUMENTS) {
  const entry = registry.find((e) => e.id === id);
  if (!entry) throw new Error(`unknown contract id: ${id} — 先在 CONTRACT_DOCUMENTS 登记契约与其权威位置`);
  return entry;
}

function contractDocs(id, registry = CONTRACT_DOCUMENTS) {
  return contractEntry(id, registry).docs;
}

function contractIds(registry = CONTRACT_DOCUMENTS) {
  return registry.map((e) => e.id);
}

module.exports = { CONTRACT_DOCUMENTS, contractEntry, contractDocs, contractIds };
