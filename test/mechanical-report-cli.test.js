'use strict';

// 票 01：机械报告脚本黑盒测试——真 git 仓库临时夹具 + 进程边界。
// 断言 stdout 的 4 字段 JSON 与退出码；中文用例名；node --test。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '../scripts/mechanical-report.js');

// --- 夹具：真 git 仓库（init → 改文件 → commit，可控历史）---

function makeGitRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  git(['init']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  git(['add', 'a.txt']);
  git(['commit', '-m', 'base']);
  return { dir, git, base: git(['rev-parse', 'HEAD']) };
}

// 第二个已提交改动（相对 base 有内容，供成功路径用）
function commitChange(repo, name, content) {
  fs.writeFileSync(path.join(repo.dir, name), content);
  repo.git(['add', name]);
  repo.git(['commit', '-m', `change ${name}`]);
  return repo.git(['rev-parse', 'HEAD']);
}

function runReport(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// ====================================================================
// 自描述：--print-schema（字段表/schema 真源，供文档副本交叉比对）
// ====================================================================

test('--print-schema 打印字段表与 schema：恰 4 字段、全 required、camelCase', () => {
  const r = runReport(['--print-schema'], { cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(r.stdout);
  const names = doc.fields.map((f) => f.name);
  assert.deepEqual(names, ['headSha', 'testResult', 'changedFiles', 'validationOutput']);
  assert.deepEqual(doc.schema.required, ['headSha', 'testResult', 'changedFiles', 'validationOutput']);
  assert.equal(doc.schema.additionalProperties, false);
});

// ====================================================================
// 用法拒绝：缺参/未知旗标（exit 2，先于一切 git/测试动作）
// ====================================================================

test('缺 --base 或 --test-command 或未知旗标：用法拒绝（非零退出，无独立判死码）', (t) => {
  const repo = makeGitRepo(t);
  const missingBase = runReport(['--test-command', 'printf ok\n'], { cwd: repo.dir });
  assert.equal(missingBase.status, 1);
  assert.match(missingBase.stdout, /--base/);

  const missingCmd = runReport(['--base', repo.base], { cwd: repo.dir });
  assert.equal(missingCmd.status, 1);
  assert.match(missingCmd.stdout, /--test-command/);

  const bogus = runReport(['--base', repo.base, '--test-command', 'printf ok\n', '--bogus', 'x'], { cwd: repo.dir });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stdout, /未知旗标 --bogus/);

  const help = runReport(['--base', repo.base, '--test-command', 'printf ok\n', '--help'], { cwd: repo.dir });
  assert.equal(help.status, 1);
  assert.match(help.stdout, /未知旗标 --help/);
});

// ====================================================================
// 成功路径：实跑测试命令 + git 事实 → 单个 4 字段 JSON，exit 0
// ====================================================================

test('成功路径：stdout 为单个 4 字段 JSON，字段值来自 git 事实与测试输出', (t) => {
  const repo = makeGitRepo(t);
  const head = commitChange(repo, 'b.txt', 'work\n');
  const cmd = "printf 'line1\\nok 3 pass\\n'";
  const r = runReport(['--base', repo.base, '--test-command', cmd], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['changedFiles', 'headSha', 'testResult', 'validationOutput']);
  assert.equal(report.headSha, head);
  assert.deepEqual(report.changedFiles, ['b.txt']);
  assert.equal(report.testResult, `${cmd} — exit 0, ok 3 pass`);
  assert.deepEqual(report.validationOutput, ['line1', 'ok 3 pass']);
});

test('无测试文件变更不判死：只改非测试文件照常通过', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'src.txt', 'work\n');
  const r = runReport(['--base', repo.base, '--test-command', "printf 'ok\\n'"], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).changedFiles, ['src.txt']);
});

// ====================================================================
// 五条非零退出条件，各自可复现
// ====================================================================

test('条件①-非零：测试命令退出码非零 → exit 1 并点名退出码', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  const r = runReport(['--base', repo.base, '--test-command', 'exit 3'], { cwd: repo.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /非零/);
  assert.match(r.stdout, /exit 3/);
});

test('MECHANICAL_REPORT_TIMEOUT_MS 环境旋钮不存在：同名变量被忽略，固定超时生效', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  // 旧旋钮语义下 1ms 超时会把 sleep 0.2 判死；旋钮删除后命令正常跑完 exit 0。
  const r = runReport(['--base', repo.base, '--test-command', 'sleep 0.2 && printf ok\n'], {
    cwd: repo.dir,
    env: { MECHANICAL_REPORT_TIMEOUT_MS: '1' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).validationOutput, ['ok']);
});

test('条件②：测试输出为空 → exit 1', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  const r = runReport(['--base', repo.base, '--test-command', 'true'], { cwd: repo.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /测试输出为空/);
});

test('条件③：staged 或未提交改动 → exit 1（两种形态各自可复现）', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  // staged 未提交
  fs.writeFileSync(path.join(repo.dir, 'staged.txt'), 'x\n');
  repo.git(['add', 'staged.txt']);
  const staged = runReport(['--base', repo.base, '--test-command', "printf 'ok\\n'"], { cwd: repo.dir });
  assert.equal(staged.status, 1);
  assert.match(staged.stdout, /未提交改动/);
  // 回滚后换 unstaged 形态
  repo.git(['reset', 'HEAD', 'staged.txt']);
  fs.rmSync(path.join(repo.dir, 'staged.txt'));
  fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'dirty\n');
  const unstaged = runReport(['--base', repo.base, '--test-command', "printf 'ok\\n'"], { cwd: repo.dir });
  assert.equal(unstaged.status, 1);
  assert.match(unstaged.stdout, /未提交改动/);
});

test('条件④：相对 base 无任何改动 → exit 1', (t) => {
  const repo = makeGitRepo(t);
  const r = runReport(['--base', repo.base, '--test-command', "printf 'ok\\n'"], { cwd: repo.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /无任何改动/);
});

test('条件⑤：git 事实提取失败 → exit 1（坏基点 / 非 git 目录）', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  const badBase = runReport(['--base', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '--test-command', "printf 'ok\\n'"], {
    cwd: repo.dir,
  });
  assert.equal(badBase.status, 1);
  assert.match(badBase.stdout, /git 事实提取失败/);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-report-nogit-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const noRepo = runReport(['--base', repo.base, '--test-command', "printf 'ok\\n'"], { cwd: plain });
  assert.equal(noRepo.status, 1);
  assert.match(noRepo.stdout, /git 事实提取失败/);
});

// ====================================================================
// 输出形态：尾 10 行、管道透传、stderr 合并、超长截断
// ====================================================================

test('validationOutput 取尾部 ≤10 行非空，testResult 取输出末行', (t) => {
  const repo = makeGitRepo(t);
  const head = commitChange(repo, 'b.txt', 'work\n');
  const cmd = `${process.execPath} -e "for(let i=1;i<=15;i++)console.log('L'+i)"`;
  const r = runReport(['--base', repo.base, '--test-command', cmd], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.headSha, head);
  assert.deepEqual(report.validationOutput, ['L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13', 'L14', 'L15']);
  assert.equal(report.testResult, `${cmd} — exit 0, L15`);
});

test('--test-command 不透明透传：管道与多词命令原样进 shell', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  const cmd = "printf 'a\\nb\\n' | grep b";
  const r = runReport(['--base', repo.base, '--test-command', cmd], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.testResult, `${cmd} — exit 0, b`);
  assert.deepEqual(report.validationOutput, ['b']);
});

test('stdout 无结尾换行时不与 stderr 首行黏合（verbatim 行边界保持）', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  const cmd = `${process.execPath} -e "process.stdout.write('out-last'); console.error('err-first')"`;
  const r = runReport(['--base', repo.base, '--test-command', cmd], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.validationOutput, ['out-last', 'err-first']);
  assert.equal(report.testResult, `${cmd} — exit 0, err-first`);
});

test('stderr 输出同样进入测试证据（合并采集）', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  const cmd = `${process.execPath} -e "console.error('err-line')"`;
  const r = runReport(['--base', repo.base, '--test-command', cmd], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.validationOutput, ['err-line']);
  assert.equal(report.testResult, `${cmd} — exit 0, err-line`);
});

test('报告超 12k 字符时截断并带截断标记，退出码保持 0', (t) => {
  const repo = makeGitRepo(t);
  const head = commitChange(repo, 'b.txt', 'work\n');
  const cmd = `${process.execPath} -e "for(let i=0;i<12;i++)console.log('X'.repeat(2000)+i)"`;
  const r = runReport(['--base', repo.base, '--test-command', cmd], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.length <= 12000, `stdout ${r.stdout.length} 字符必须 ≤12000`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.headSha, head);
  assert.deepEqual(report.changedFiles, ['b.txt']);
  assert.match(report.validationOutput[0], /truncated/);
  assert.match(JSON.stringify(report), /truncated/);
});

test('截断兜底：变更文件清单超长时截断 changedFiles 并打标记', (t) => {
  const repo = makeGitRepo(t);
  for (let i = 0; i < 600; i++) {
    fs.writeFileSync(path.join(repo.dir, `file-${String(i).padStart(4, '0')}-with-a-long-name-to-fill-space.txt`), 'x\n');
  }
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'many files']);
  const r = runReport(['--base', repo.base, '--test-command', "printf 'ok\\n'"], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.length <= 12000, `stdout ${r.stdout.length} 字符必须 ≤12000`);
  const report = JSON.parse(r.stdout);
  assert.ok(report.changedFiles.length < 600, '清单被截断');
  assert.equal(report.changedFiles[report.changedFiles.length - 1], require('../scripts/mechanical-report').TRUNCATION_NOTE);
});

test('截断兜底：单行超长输出时硬截 testResult 并打标记', (t) => {
  const repo = makeGitRepo(t);
  commitChange(repo, 'b.txt', 'work\n');
  const cmd = `${process.execPath} -e "console.log('Y'.repeat(20000))"`;
  const r = runReport(['--base', repo.base, '--test-command', cmd], { cwd: repo.dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.length <= 12000, `stdout ${r.stdout.length} 字符必须 ≤12000`);
  const report = JSON.parse(r.stdout);
  assert.match(report.testResult, /truncated/);
  assert.match(report.testResult, /^.* — exit 0, Y+/, '摘要形状保持（命令 + 退出码 + 末行残部）');
});
