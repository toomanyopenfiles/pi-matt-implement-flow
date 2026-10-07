'use strict';

// 负向验收探针（阶段 D）：故意失败，验证必需检查 ci-success 挡住合并。
// 本文件只存在于探针分支，永不合入 main。

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('negative probe: 可控失败以验证失败门', () => {
  assert.fail('可控失败：负向验收用（不入 main）');
});
