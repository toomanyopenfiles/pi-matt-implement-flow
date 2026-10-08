#!/usr/bin/env node
'use strict';

// /matt-flow-config 的只读解析入口，给编排器在**每次派发新子代理前**调用：
//   node scripts/flow-config-cli.js run-timeout [--cwd <dir>]
// 打印一行 JSON：{"timeoutMs":14400000,"source":"default","invalid":[]}
// ——timeoutMs 就是派发项的 `timeoutMs` 参数（平台运行时限）。每次调用都重新读
// settings（镜像 pi-subagents 每次派发重读的语义），所以同一未封账 run 中改配置、
// 下一次派发即生效；这里不读、不写任何 init 旗标（运行时限不冻结进流程形态）。

const os = require('node:os');
const path = require('node:path');

const flowConfig = require('./flow-config-core.js');

// 镜像 pi SDK 的 CONFIG_DIR_NAME 常量（'.pi'）；CLI 不依赖 pi 运行时，故自带一份。
const CONFIG_DIR_NAME = '.pi';

function usage() {
  return 'usage: node scripts/flow-config-cli.js run-timeout [--cwd <dir>]\n';
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run-timeout') {
    process.stderr.write(usage());
    return 1;
  }
  let cwd = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--cwd' && rest[i + 1] !== undefined) {
      cwd = rest[++i];
    } else {
      process.stderr.write(`unknown argument: ${rest[i]}\n${usage()}`);
      return 1;
    }
  }
  try {
    const userPath = flowConfig.userSettingsPath(process.env, os.homedir(), CONFIG_DIR_NAME);
    const projectPath = flowConfig.projectSettingsPath(cwd, {
      configDirName: CONFIG_DIR_NAME,
      homeDir: os.homedir(),
    });
    const userSettings = flowConfig.readSettingsFile(userPath);
    const projectSettings = projectPath ? flowConfig.readSettingsFile(projectPath) : {};
    const { value, source, invalid } = flowConfig.resolveRunTimeoutDetailed(userSettings, projectSettings);
    process.stdout.write(`${JSON.stringify({ timeoutMs: value, source, invalid })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`run-timeout resolution failed: ${error?.message ?? String(error)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
