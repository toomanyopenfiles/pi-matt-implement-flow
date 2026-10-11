'use strict';
// 场景模块桩：把 PI_E2E_SCENARIOS 指到本文件，用 STUB_SCENARIOS（JSON 数组）
// 声明这次要用的场景。每条 { id, mode, calls?, timeoutMs?, ... }，探针一律指向
// test/fixtures/e2e-stub-probe.js（调用边界桩）。出口形态与 test/e2e/scenarios.js
// 相同：{ scenarios: [{ id, title, probe, args, callsPerRun, timeoutMs, level, claim, writes }] }。

const path = require('node:path');

const raw = JSON.parse(process.env.STUB_SCENARIOS || '[]');
const DEFAULT_WRITES = { files: '临时目录', network: '无', remote: '无' };

module.exports = {
  scenarios: raw.map((s) => ({
    id: s.id,
    title: s.title || `桩场景 ${s.id}`,
    probe: path.join(__dirname, 'e2e-stub-probe.js'),
    args: ['--stub-mode', s.mode || 'pass', '--stub-calls', String(s.reportCalls == null ? (s.calls || 1) : s.reportCalls)],
    callsPerRun: s.calls || 1,
    timeoutMs: s.timeoutMs || 30000,
    level: s.level || 'platform-contract-probe',
    claim: s.claim || '调用边界桩（测试装置，不是真实模型验收）',
    writes: s.writes || DEFAULT_WRITES,
  })),
};
