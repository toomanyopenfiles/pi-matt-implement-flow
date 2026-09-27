'use strict';

// 票 03 测试夹具：合成改名词表契约（spec 接缝②的「合成契约——假想 tracker 形态」）。
// 五个 triage 角色的 label 全部改名，供状态词表参数化的映射矩阵使用：同一套用例喂
// 三预设 + 本合成契约，断言全部落在同一套 canonical 输出词表——证明引擎只吃契约
// 词表、不吃硬编码五名（statusOf / normalizeStatus / transcribe / planSnapshot）。
// 构造后立即过 01 的同一扇 schema 校验门（validateContract），保证夹具本身合法。

const assert = require('node:assert/strict');
const { validateContract } = require('../tracker-contract-core');

const RENAMED_CONTRACT = {
  tracker: 'synthetic-renamed',
  detection: { h1: 'issue tracker: synthetic', anchors: ['anchor-phrase'] },
  identity: {
    ticketNumber: '1–6 位数字',
    specRef: {
      kind: 'number',
      accepts: ['<num>', '#<num>', '<owner>/<repo>#<num>', 'https://example.test/<owner>/<repo>/issues/<num>'],
    },
    sourceUrl: { kind: 'url', host: 'example.test', path: '/<owner>/<repo>/issues/<num>' },
  },
  mapping: {
    labelMap: {
      'needs-triage': 'to-triage',
      'needs-info': 'more-info-please',
      'ready-for-agent': 'afk-ok',
      'ready-for-human': 'human-own-it',
      wontfix: 'archived',
    },
    closedStatus: 'resolved',
    typeSource: 'wayfinder-label',
    blockingEdges: ['inline'],
  },
  ticketSet: { edges: ['sub-issues', 'parent-edges', 'init-list'] },
  capabilities: { claimStrength: 'advisory', closeWithComment: true, closingSurface: 'none' },
  commands: {
    cli: 'fake', listIssues: null, subIssues: null, blockedBy: null, repoView: null, prProbe: null, viewIssue: null,
    claim: null, unclaim: null, comment: null, close: null,
  },
  idempotency: { marker: '<!-- matt-implement:<runId>:<kind> -->', carrier: 'comment-body' },
  lifecycle: { specCloseTiming: 'pre-seal', abandon: { unclaim: true, comment: true } },
};

assert.equal(
  validateContract(RENAMED_CONTRACT).ok,
  true,
  '合成改名词表契约必须通过 01 的 schema 校验门（夹具完整性）'
);

module.exports = { RENAMED_CONTRACT };
