'use strict';
// ============================================================================
// 费用护栏测试的「调用边界桩」：代替真实探针子进程。
//
// 它不调用任何模型，只按 --stub-mode 产出与真实探针同形的结果文件
// （PI_E2E_RESULT_PATH），并把每次启动追加到 $STUB_LOG。授权、限定范围、
// 额度耗尽、重试与取消这些护栏，全部在这个边界上黑盒验证，零花费。
//
// 由 test/fixtures/e2e-stub-scenarios.js 声明成场景；测试通过 STUB_SCENARIOS
// 选择每条场景的模式。入口以 `node <probe> ...` 启动它（显式解释器，无需执行位）。
// ============================================================================

const fs = require('node:fs');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const mode = argOf('--stub-mode') || 'pass';
const scenario = process.env.PI_E2E_SCENARIO || 'unknown';
const attempt = Number(process.env.PI_E2E_ATTEMPT || 1);

if (process.env.STUB_LOG) {
  fs.appendFileSync(
    process.env.STUB_LOG,
    `${JSON.stringify({ scenario, attempt, mode, pid: process.pid })}\n`,
  );
}

function writeResult(status, kind, calls, extra = {}) {
  const target = process.env.PI_E2E_RESULT_PATH;
  if (!target) return;
  fs.writeFileSync(target, JSON.stringify({
    schema: 'e2e-scenario-result-1',
    scenario,
    status,
    kind,
    calls,
    assertions: [],
    notes: `stub:${mode}`,
    ...extra,
  }));
}

// 桩自报的实际调用数：默认等于场景声明的 callsPerRun（fixture 注入 --stub-calls），
// reportCalls 用于故意偏离声明（额度护栏路径）。
const reportedCalls = Number(argOf('--stub-calls') || 1);

switch (mode) {
  case 'pass':
    writeResult('pass', 'none', reportedCalls);
    process.exit(0);
    break;
  case 'fail':
    writeResult('fail', 'product-regression', reportedCalls);
    process.exit(1);
    break;
  case 'inconclusive':
    writeResult('inconclusive', 'undetermined', reportedCalls);
    process.exit(2);
    break;
  case 'flaky':
    // 第一次无法判定，第二次通过：重试计入额度的验证路径。
    if (attempt <= 1) {
      writeResult('inconclusive', 'infrastructure', reportedCalls);
      process.exit(2);
    }
    writeResult('pass', 'none', reportedCalls);
    process.exit(0);
    break;
  case 'crash':
    process.stderr.write('stub crash: no result file\n');
    process.exit(7);
    break;
  case 'bad-result':
    if (process.env.PI_E2E_RESULT_PATH) fs.writeFileSync(process.env.PI_E2E_RESULT_PATH, '{ not json');
    process.exit(0);
    break;
  case 'mismatch':
    // 报告说通过但退出码说失败：矛盾报告不得判通过。
    writeResult('pass', 'none', reportedCalls);
    process.exit(1);
    break;
  case 'no-result':
    process.stdout.write('stub: exited without writing a result\n');
    process.exit(0);
    break;
  case 'cancel':
    // 请求入口取消：向父进程发 SIGINT，然后保持存活，等待入口终止本进程。
    writeResult('pass', 'none', reportedCalls);
    process.kill(process.ppid, 'SIGINT');
    setTimeout(() => {}, 30000);
    break;
  case 'secret-leak': {
    const secret = process.env.STUB_SECRET || '';
    process.stdout.write(`stub stdout echoes ${secret}\n`);
    writeResult('pass', 'none', reportedCalls, { notes: `stub leaked ${secret}`, evidence: { dir: `/tmp/${secret}` } });
    process.exit(0);
    break;
  }
  case 'overrun':
    // 实际调用数多于计划声明的调用数：额度是护栏，超了不得判通过。
    writeResult('pass', 'none', Number(argOf('--stub-calls') || 3));
    process.exit(0);
    break;
  default:
    process.stderr.write(`unknown stub mode: ${mode}\n`);
    process.exit(9);
}
