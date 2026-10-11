#!/usr/bin/env node
'use strict';
// 平台二进制桩：记录每次调用（argv + cwd）到 $STUB_PI_LOG；`--version` 返回固定版本号，
// 其余调用立刻退出 0 且不发生任何模型调用。
//
// 用途：断言"在模型调用边界之前拒绝"——若入口或探针真的启动过一次模型运行，
// 这个日志里就会出现一次非 `--version` 的调用。测试复制本文件到临时目录并加执行位
// （入口与探针按可执行文件路径启动它），所以仓库里本文件不需要执行位。

const fs = require('node:fs');

const argv = process.argv.slice(2);
if (process.env.STUB_PI_LOG) {
  fs.appendFileSync(
    process.env.STUB_PI_LOG,
    `${JSON.stringify({ argv, cwd: process.cwd(), ts: Date.now() })}\n`,
  );
}

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('9.9.9-stub\n');
  process.exit(0);
}

process.stdout.write('stub-pi: no model call performed\n');
process.exit(0);
