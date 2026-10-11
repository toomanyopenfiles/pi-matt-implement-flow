'use strict';
// ============================================================================
// 内容哈希的唯一实现（票 35）：候选内容标识、任务书哈希与 fixture 清单都用它。
// ============================================================================

const crypto = require('node:crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = { sha256 };
