'use strict';

// npm tarball 装置：真实 `npm pack` 打到仓库外的临时目录（工作区零脏文件），解包后
// 作为包级系统回归的被测面。进程内只 pack 一次（loadPackage 记忆化），调用方在文件级
// after 钩子注册 cleanupPackage() 清理。被测代码必须来自解包目录——不从仓库 scripts/
// 偷生产入口；fixture/helper 仍可来自 test/ 源码。
//
// 发布流水线传入 MATT_IMPLEMENT_TARBALL=<已生成的 .tgz> 时跳过 npm pack，直接解包
// 该产物——包级回归与 npm 发布消费同一个 tarball（测试专用开关，非生产钩子）。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');

let cached = null;

function walkFiles(root, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(path.join(root, r)).isDirectory()) out.push(...walkFiles(root, r));
    else out.push(r);
  }
  return out.sort();
}

function loadPackage() {
  if (cached) return cached;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matt-pkg-'));
  const provided = process.env.MATT_IMPLEMENT_TARBALL;
  let tarball;
  if (provided) {
    tarball = path.resolve(provided);
    if (!fs.existsSync(tarball)) throw new Error(`MATT_IMPLEMENT_TARBALL 指向的文件不存在: ${tarball}`);
  } else {
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
    tarball = path.join(tmp, meta.filename);
  }
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', tmp], { encoding: 'utf8', timeout: 120000 });
  if (untar.status !== 0) throw new Error(`tar 解包失败（exit ${untar.status}）: ${untar.stderr}`);
  const root = path.join(tmp, 'package');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  cached = {
    tmp,
    tarball,
    root,
    name: pkgJson.name,
    version: pkgJson.version,
    files: walkFiles(root),
  };
  return cached;
}

function cleanupPackage() {
  if (!cached) return;
  fs.rmSync(cached.tmp, { recursive: true, force: true });
  cached = null;
}

module.exports = { loadPackage, cleanupPackage, REPO_ROOT };
