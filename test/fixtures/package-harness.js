'use strict';

// npm tarball 装置：真实 `npm pack` 打到仓库外的临时目录（工作区零脏文件），解包后
// 作为包级系统回归的被测面。进程内只 pack 一次（loadPackage 记忆化），调用方在文件级
// after 钩子注册 cleanupPackage() 清理。被测代码必须来自解包目录——不从仓库 scripts/
// 偷生产入口；fixture/helper 仍可来自 test/ 源码。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');

let cached = null;

function loadPackage() {
  if (cached) return cached;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matt-pkg-'));
  const pack = spawnSync('npm', ['pack', '--pack-destination', tmp, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (pack.status !== 0) throw new Error(`npm pack 失败（exit ${pack.status}）: ${pack.stderr}${pack.stdout}`);
  let meta;
  try {
    meta = JSON.parse(pack.stdout)[0];
  } catch (e) {
    throw new Error(`npm pack --json 输出不可解析: ${pack.stdout}`);
  }
  const tarball = path.join(tmp, meta.filename);
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', tmp], { encoding: 'utf8', timeout: 120000 });
  if (untar.status !== 0) throw new Error(`tar 解包失败（exit ${untar.status}）: ${untar.stderr}`);
  cached = {
    tmp,
    tarball,
    root: path.join(tmp, 'package'),
    name: meta.name,
    version: meta.version,
    files: meta.files.map((f) => f.path).sort(),
  };
  return cached;
}

function cleanupPackage() {
  if (!cached) return;
  fs.rmSync(cached.tmp, { recursive: true, force: true });
  cached = null;
}

module.exports = { loadPackage, cleanupPackage, REPO_ROOT };
