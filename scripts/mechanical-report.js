#!/usr/bin/env node
'use strict';

// 机械报告脚本（票 01）：git 事实 + 实跑测试输出 → 4 字段 JSON 报告，stdout 即结构化
// 输出，退出码即验收判定。模型全程不参与。多语言无关：--test-command 不透明透传
// （shell 执行，多词/管道皆可）。
//
// 用法：
//   node mechanical-report.js --base <票基点> --test-command "<命令>"
//   node mechanical-report.js --print-schema
//
// 退出码：0 = gate 通过（stdout 为单个 4 字段 JSON）；1 = gate 拒绝（五条件见下，
// stdout 为拒绝原因）；2 = 用法错误。
// 非零退出五条件：① 测试命令非零或超时 ② 测试输出为空 ③ 存在 staged 或未提交改动
// ④ 相对 base 无任何改动 ⑤ git 事实提取失败。不判死：无测试文件变更；超 12k 截断打标记。
//
// 报告合同真源 = 本模块导出（FIELD_TABLE + REPORT_SCHEMA），附 --print-schema 自描述。

const { spawnSync } = require('node:child_process');

const FIELD_TABLE = [
  { name: 'headSha', type: 'string', source: 'git rev-parse HEAD', description: 'git 机械提取的 HEAD SHA' },
  { name: 'testResult', type: 'string', source: 'testCommand + 测试输出末行', description: '单行摘要 "<testCommand> — exit <code>, <输出末行 verbatim>"' },
  { name: 'changedFiles', type: 'string[]', source: 'git diff --name-only <base>...HEAD', description: '相对票基点的 name-only 变更清单原样' },
  { name: 'validationOutput', type: 'string[]', source: '测试输出尾部', description: '测试输出尾部 ≤10 行非空 verbatim 关键行' },
];

const REPORT_SCHEMA = {
  type: 'object',
  required: ['headSha', 'testResult', 'changedFiles', 'validationOutput'],
  properties: {
    headSha: { type: 'string' },
    testResult: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    validationOutput: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

// 平台 stdout 契约：单个 JSON 文档 ≤12000 字符。超长截断打标记，不判死。
const MAX_REPORT_CHARS = 12000;
const TRUNCATION_NOTE = '[truncated: 超 12000 字符上限]';
// stdout 经 console.log 落盘，恒多一个换行：JSON 本体按 11999 预算。
const STDOUT_BUDGET = MAX_REPORT_CHARS - 1;

// 测试命令超时（与派发 timeoutMs: 600000 同口径；运维旋钮，供长/短套件调参）。
const DEFAULT_TEST_TIMEOUT_MS = 600000;
const TEST_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;

const USAGE = `mechanical-report.js — typed gate 机械产报告（stdout 即报告，退出码即判定）

用法:
  node mechanical-report.js --base <票基点> --test-command "<命令>"
  node mechanical-report.js --print-schema`;

const out = (...lines) => console.log(lines.join('\n'));

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) return { ok: false, detail: `git ${args.join(' ')} 执行失败：${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, detail: `git ${args.join(' ')} 退出 ${r.status}：${(r.stderr ?? '').trim().split('\n')[0] ?? ''}` };
  }
  return { ok: true, stdout: r.stdout ?? '' };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '--test-command') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        return { error: `缺少必选参数 ${a} 的值（用法：mechanical-report.js --base <票基点> --test-command "<命令>"）` };
      }
      opts[a === '--base' ? 'base' : 'testCommand'] = v;
    } else if (a === '--print-schema') {
      opts.printSchema = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a.startsWith('--')) {
      return { error: `未知旗标 ${a}（用法：mechanical-report.js --base <票基点> --test-command "<命令>"）` };
    } else {
      return { error: `未知参数 ${a}（用法：mechanical-report.js --base <票基点> --test-command "<命令>"）` };
    }
  }
  return { opts };
}

// 单行化（testResult 恒单行）：换行折为空格。
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');

// stdout 预算适配：validationOutput（标记 + 尾）→ changedFiles（头 + 标记）→
// testResult 硬截 + 标记。恒返回 ≤STDOUT_BUDGET 字符的 JSON（+ 换行 = stdout ≤12000）。
function fitBudget(report) {
  const vOrig = report.validationOutput;
  const cOrig = report.changedFiles;
  let s = JSON.stringify(report);
  if (s.length <= STDOUT_BUDGET) return s;
  for (let keep = vOrig.length - 1; keep >= 0; keep--) {
    report.validationOutput = keep === 0 ? [TRUNCATION_NOTE] : [TRUNCATION_NOTE, ...vOrig.slice(-keep)];
    s = JSON.stringify(report);
    if (s.length <= STDOUT_BUDGET) return s;
  }
  for (let keep = cOrig.length - 1; keep >= 0; keep--) {
    report.changedFiles = keep === 0 ? [TRUNCATION_NOTE] : [...cOrig.slice(0, keep), TRUNCATION_NOTE];
    s = JSON.stringify(report);
    if (s.length <= STDOUT_BUDGET) return s;
  }
  let room = STDOUT_BUDGET - JSON.stringify({ ...report, testResult: '' }).length - JSON.stringify(TRUNCATION_NOTE).length;
  report.testResult = `${report.testResult.slice(0, Math.max(0, room))}${TRUNCATION_NOTE}`;
  s = JSON.stringify(report);
  while (s.length > STDOUT_BUDGET && report.testResult.length > TRUNCATION_NOTE.length) {
    room = Math.max(0, room - (s.length - STDOUT_BUDGET) - 8);
    report.testResult = `${report.testResult.slice(0, room)}${TRUNCATION_NOTE}`;
    s = JSON.stringify(report);
  }
  return s;
}

function testTimeoutMs() {
  const raw = process.env.MECHANICAL_REPORT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TEST_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TEST_TIMEOUT_MS;
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    out(parsed.error);
    return 2;
  }
  const opts = parsed.opts;
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.printSchema) {
    out(JSON.stringify({ fields: FIELD_TABLE, schema: REPORT_SCHEMA }, null, 2));
    return 0;
  }
  if (!opts.base) {
    out('缺少必选参数 --base（用法：mechanical-report.js --base <票基点> --test-command "<命令>"）');
    return 2;
  }
  if (!opts.testCommand) {
    out('缺少必选参数 --test-command（用法：mechanical-report.js --base <票基点> --test-command "<命令>"）');
    return 2;
  }

  // ⑤ git 事实提取失败 → 非零（先取事实：HEAD / 脏检查 / 变更清单）。
  const head = git(['rev-parse', 'HEAD']);
  if (!head.ok) {
    out(`gate 拒绝：git 事实提取失败（${head.detail}）`);
    return 1;
  }
  const headSha = head.stdout.trim();

  const status = git(['status', '--porcelain']);
  if (!status.ok) {
    out(`gate 拒绝：git 事实提取失败（${status.detail}）`);
    return 1;
  }
  // ③ 存在 staged 或未提交改动 → 非零。
  if (status.stdout.trim() !== '') {
    out('gate 拒绝：存在 staged 或未提交改动（工作区不干净），先提交再跑 gate');
    return 1;
  }

  const diff = git(['diff', '--name-only', `${opts.base}...HEAD`]);
  if (!diff.ok) {
    out(`gate 拒绝：git 事实提取失败（${diff.detail}）`);
    return 1;
  }
  const changedFiles = diff.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
  // ④ 相对 base 无任何改动 → 非零。
  if (changedFiles.length === 0) {
    out(`gate 拒绝：相对基点 ${opts.base} 无任何改动`);
    return 1;
  }

  // 实跑测试命令（不透明透传，shell 执行）。
  const timeout = testTimeoutMs();
  const t = spawnSync(opts.testCommand, {
    shell: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: TEST_OUTPUT_MAX_BUFFER,
  });
  // ① 测试命令超时 → 非零。
  if (t.error && t.error.code === 'ETIMEDOUT') {
    out(`gate 拒绝：测试命令超时（${timeout}ms）：${opts.testCommand}`);
    return 1;
  }
  if (t.error) {
    out(`gate 拒绝：测试命令执行失败（${t.error.message}）：${opts.testCommand}`);
    return 1;
  }
  // ① 测试命令非零 → 非零。
  if (t.status !== 0) {
    out(`gate 拒绝：测试命令退出码非零（${oneLine(opts.testCommand)} — exit ${t.status}）`);
    return 1;
  }

  // stdout + stderr 合并为测试输出（行本身 verbatim，仅统一换行）。
  const combined = `${t.stdout ?? ''}${t.stderr ?? ''}`;
  const lines = combined.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  // ② 测试输出为空 → 非零。
  if (lines.length === 0) {
    out('gate 拒绝：测试输出为空（无非空输出行）');
    return 1;
  }

  const lastLine = lines[lines.length - 1];
  const report = {
    headSha,
    testResult: `${oneLine(opts.testCommand)} — exit ${t.status}, ${lastLine}`,
    changedFiles,
    validationOutput: lines.slice(-10),
  };
  out(fitBudget(report));
  return 0;
}

module.exports = {
  FIELD_TABLE,
  REPORT_SCHEMA,
  REPORT_CONTRACT: { fields: FIELD_TABLE, schema: REPORT_SCHEMA },
  MAX_REPORT_CHARS,
  TRUNCATION_NOTE,
  DEFAULT_TEST_TIMEOUT_MS,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
