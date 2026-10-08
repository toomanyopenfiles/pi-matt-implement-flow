'use strict';

// 包清单检查（阶段 B2）：对真实 `npm pack` 产物断言打包面——必需运行文件在场、
// 私有区/测试/开发草稿不入包、包内模块引用可达、无需平台实例的 CLI 入口可启动。
// 被测面 = tarball 解包目录（test/fixtures/package-harness.js），不是源码 checkout。
// 验证层级：包级系统。边界：这里只证打包与加载事实，不证明模型行为或平台派发。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { loadPackage, cleanupPackage, REPO_ROOT } = require('./fixtures/package-harness');

after(cleanupPackage);

// 递归列出目录下的文件（相对路径，POSIX 分隔符），供闭包对照。
function walk(root, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(path.join(root, r));
    if (st.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out.sort();
}

// 运行时目录：随包发布的生产代码与文档面。测试/文档草稿不在其中。
const RUNTIME_DIRS = ['agents', 'extensions', 'scripts', 'audit-report'];
const RUNTIME_FILES = ['SKILL.md'];
// npm 恒随包附带的文件 + files 白名单根文件。
const ALWAYS_INCLUDED = ['package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md'];

test('tarball 清单闭包：运行时目录逐文件在场，无多无少——必需运行文件不只存在于源码 checkout', () => {
  const pkg = loadPackage();
  const expected = [
    ...ALWAYS_INCLUDED,
    ...RUNTIME_FILES,
    ...RUNTIME_DIRS.flatMap((d) => walk(REPO_ROOT, d)),
  ].sort();
  assert.deepEqual(pkg.files, expected, 'tarball 文件集 = 恒附带文件 + 运行时目录闭包');
});

test('tarball 清单：私有区与开发草稿不入包（.pi/.scratch/test/docs/CI 配置/归档/凭证）', () => {
  const pkg = loadPackage();
  for (const f of pkg.files) {
    assert.doesNotMatch(f, /(^|\/)\.(pi|scratch|github|git)\//, f);
    assert.doesNotMatch(f, /^test\//, f);
    assert.doesNotMatch(f, /^docs\//, f);
    assert.doesNotMatch(f, /\.test\.js$/, f);
    assert.doesNotMatch(f, /spec12-acceptance|acceptance-archive/i, f);
    assert.doesNotMatch(f, /\.(log|pem|key|env)$/i, f);
    assert.doesNotMatch(f, /(^|\/)node_modules\//, f);
  }
});

test('package.json 与 pi 注册面在包内自洽：name/version 同源，skills/agents/extensions 条目在包内可解析', () => {
  const pkg = loadPackage();
  const packed = JSON.parse(fs.readFileSync(path.join(pkg.root, 'package.json'), 'utf8'));
  const repo = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(packed.name, repo.name);
  assert.equal(packed.version, repo.version);
  assert.equal(packed.name, pkg.name, '被测 tarball 的包名与仓库一致（防错拿别家产物）');
  assert.equal(packed.version, pkg.version);
  for (const entry of packed.pi.skills) {
    assert.ok(fs.existsSync(path.join(pkg.root, entry)), `pi.skills 条目在包内存在: ${entry}`);
  }
  for (const dir of packed.pi.subagents.agents) {
    assert.ok(fs.existsSync(path.join(pkg.root, dir)), `pi.subagents 条目在包内存在: ${dir}`);
    for (const name of ['coder.md', 'reviewer.md', 'final-reviewer.md']) {
      assert.ok(fs.existsSync(path.join(pkg.root, dir, name)), `${dir}/${name} 在包内存在`);
    }
  }
  for (const entry of packed.pi.extensions) {
    assert.ok(fs.existsSync(path.join(pkg.root, entry)), `pi.extensions 条目在包内存在: ${entry}`);
  }
});

test('包内 CJS 模块图可达：纯模块可加载、无缺失内部引用（入口脚本除外——加载边界见下）', () => {
  const pkg = loadPackage();
  // require 安全的纯模块（不含执行即入账的 CLI 入口 ledger.js 与 ESM 派发脚本 axis-axes.js）。
  const requireSafe = [
    ...['flow-config-core', 'ledger-core', 'ledger-schema', 'mechanical-report', 'registration-checks',
      'snapshot-core', 'sync-planning-core', 'sync-read-core', 'tracker-contract-core', 'tracker-contracts',
      'tracker-driver', 'tracker-set-core', 'tracker-sync-core'].map((m) => `./scripts/${m}.js`),
    ...['collect', 'render', 'glossary', 'i18n'].map((m) => `./audit-report/${m}.js`),
  ];
  const script = `for (const f of ${JSON.stringify(requireSafe)}) { require(f); } console.log('all-ok');`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: pkg.root, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all-ok/);
});

test('入口烟测：CLI 帮助/只读入口可启动；CJS 与 ESM 脚本各过各的语法边界（不粗暴 require）', () => {
  const pkg = loadPackage();
  const run = (args) => spawnSync(process.execPath, args, { cwd: pkg.root, encoding: 'utf8', timeout: 60000 });

  const help = run(['scripts/ledger.js', '--help']);
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /用法/);
  assert.match(help.stdout, /add/);

  const schema = run(['scripts/mechanical-report.js', '--print-schema']);
  assert.equal(schema.status, 0, schema.stdout + schema.stderr);
  const doc = JSON.parse(schema.stdout);
  assert.deepEqual(
    doc.fields.map((f) => f.name),
    ['headSha', 'testResult', 'changedFiles', 'validationOutput'],
  );
  assert.deepEqual(doc.schema.required, ['headSha', 'testResult', 'changedFiles', 'validationOutput']);

  const reportHelp = run(['audit-report/report.js', '--help']);
  assert.equal(reportHelp.status, 0, reportHelp.stdout + reportHelp.stderr);
  assert.match(reportHelp.stdout, /--runtime-dir/);

  // ESM 面分两种加载边界：
  // 1) pi 扩展是真 ES 模块（import）——以 .mjs 复本过 ESM 语法检查（无平台实例时不 import）；
  // 2) axis 派发脚本是 async 函数体脚本（顶层 await + return，平台按函数体装载）——
  //    以 AsyncFunction 构造验语法（普通 --check 在 CJS/ESM 两种模式下都不适用）。
  const extMjs = path.join(pkg.tmp, 'matt-flow-config.mjs');
  fs.copyFileSync(path.join(pkg.root, 'extensions/matt-flow-config.js'), extMjs);
  const extCheck = spawnSync(process.execPath, ['--check', extMjs], { encoding: 'utf8', timeout: 60000 });
  assert.equal(extCheck.status, 0, `extensions/matt-flow-config.js ESM 语法: ${extCheck.stderr}`);
  const axisCheck = spawnSync(process.execPath, ['-e',
    'const fs = require("node:fs"); new (async function () {}).constructor(fs.readFileSync(process.argv[1], "utf8")); console.log("axis-ok");',
    path.join(pkg.root, 'scripts/axis-axes.js')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(axisCheck.status, 0, `scripts/axis-axes.js 函数体语法: ${axisCheck.stderr}`);
  assert.match(axisCheck.stdout, /axis-ok/);
  // CJS 入口走原生 --check（require 即执行 CLI，不能用加载来验语法）。
  for (const rel of ['scripts/ledger.js', 'scripts/mechanical-report.js', 'scripts/flow-config-cli.js', 'audit-report/report.js']) {
    const check = spawnSync(process.execPath, ['--check', path.join(pkg.root, rel)], { encoding: 'utf8', timeout: 60000 });
    assert.equal(check.status, 0, `${rel} CJS 语法: ${check.stderr}`);
  }
});
