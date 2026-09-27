'use strict';

// 通用 driver（票 05，spec「模块改动」的命令执行收敛）：按契约命令模板执行 tracker 操作。
// 取数 / 占坑 / 留评 / 关票 / 撤认领不再有 per-tracker 调用点——调用方给契约对象 + 操作名 +
// 占位符值，本模块把契约 commands.<kind> 的 argv 模板翻译成一次真实进程调用。
//
//   buildArgv(contract, kind, values) → { cli, argv, scoped }
//     模板占位符（<num> <body> <login> <repo> <branch>）替换：<num> 前置归一
//     （'07' → '7'——tracker 的原生号，与 executeSyncAction 先例同一口径）；
//     <repo>/<num> 可嵌在元素内（REST 端点路径模板）；其余占位符整元素严格匹配。
//     残留占位符即契约缺陷，显式拒绝（不猜测放行半成品 argv）。
//   runCommand(contract, kind, values, { run }) → Stdout（exec 谓词注入，默认薄 IO 的 execFileSync）
//     仓库作用域：模板不携带 <repo> 占位时前置 ['-R', repo]（gh/glab CLI 家族的仓库旗标
//     约定；api 路径模板自带 repo，不再前置）。
//     closeWithComment 能力（同步动作集由能力生成的数据前提）：close 动作携带 body 时按
//     能力执行——true（github/local）在 close 模板后追加 ['--comment', body]；
//     false（gitlab）的先评后关等价序列由同步规划面生成（票 06 落地），本层显式拒绝。
//   listLimit(contract) → number|null
//     listIssues 模板的 --limit 上限（拉取截断警告的数值亦来自模板，零硬编码）。
//
// 本模块属「不设缝」的命令模板执行薄层（spec Testing Decisions：best-effort IO 先例）；
// 策略判定（动作集、幂等键、时序门）全在纯模块与黑盒面上，此处只做机械翻译。

// 仓库作用域旗标：gh/glab CLI 家族共享的仓库选择约定（模板未自带 <repo> 占位时前置）。
const REPO_FLAG = '-R';

// 模板占位符词表：整元素替换（值不嵌进其他元素——body/login 是自由文本，嵌入即注入面）。
const EXACT_PLACEHOLDERS = {
  '<body>': 'body',
  '<login>': 'login',
  '<branch>': 'branch',
};

const hasPlaceholder = (el) => /<[^<>]+>/.test(el);

function reject(message) {
  throw new Error(message);
}

// <num>：票号空间外的原生号引力——'07' → '7'、1042 → '1042'；非法形态在构造点拒绝
//（与 executeSyncAction 的 String(Number(num)) 先例同一口径）。
function nativeNum(raw) {
  const s = String(raw ?? '');
  if (!/^\d{1,6}$/.test(s.trim())) {
    reject(`driver <num> 占位符非法：${JSON.stringify(raw)}——必须是 1–6 位数字`);
  }
  return String(Number(s));
}

// 模板 → argv：整元素占位符严格替换 + <repo>/<num> 的元素内替换（REST 路径模板）。
function substitute(template, values) {
  const native = nativeNum(values.num);
  return template.map((el) => {
    if (el in EXACT_PLACEHOLDERS) {
      const v = values[EXACT_PLACEHOLDERS[el]];
      if (!v || typeof v !== 'string') reject(`driver 占位符 ${el} 缺值——契约模板 ${JSON.stringify(template)}`);
      return v;
    }
    let out = el;
    if (el === '<num>') {
      out = native;
    } else {
      out = out.replace(/<repo>/g, String(values.repo ?? ''))
        .replace(/<num>/g, native);
    }
    if (hasPlaceholder(out)) {
      reject(`模板占位符未赋值：${JSON.stringify(el)}——契约模板缺值（values=${JSON.stringify(values)}）`);
    }
    return out;
  });
}

// 契约命令模板 → { cli, argv }：
//   模板缺失（null / 键不存在）→ 拒绝（契约能力未声明，引擎不猜命令）。
//   close + body：能力 closeWithComment=false 显式拒绝（先评后关等价序列归同步规划面，票 06）。
//   仓库作用域：repo 给出且模板不自带 <repo> 占位 → argv 前置 ['-R', repo]。
function buildArgv(contract, kind, values = {}) {
  const commands = contract?.commands;
  const template = commands ? commands[kind] : null;
  if (!Array.isArray(template)) {
    reject(`契约缺 ${kind} 命令模板——该操作未被此契约的能力声明（tracker=${JSON.stringify(contract?.tracker ?? null)}）`);
  }
  if (kind === 'close' && values.body != null && contract.capabilities?.closeWithComment === false) {
    reject('契约 capabilities.closeWithComment=false——close 不接受收尾评论：先留评后关票的等价序列由同步规划按能力生成（票 06 落地）');
  }
  let argv = substitute(template, values);
  if (kind === 'close' && values.body != null && contract.capabilities?.closeWithComment !== false) {
    argv = [...argv, '--comment', String(values.body)];
  }
  const scoped = !!(values.repo && !template.some(hasPlaceholder));
  if (scoped) argv = [REPO_FLAG, values.repo, ...argv];
  return { cli: commands.cli, argv, scoped };
}

// 薄 IO 默认执行面：契约 cli 名 + argv → execFileSync（编码/超时/管量级由调用方注入可选覆盖）。
function defaultRun(argv, options = {}) {
  const { execFileSync } = require('node:child_process');
  return execFileSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

// runCommand：取契约模板 → 真实调用。返回 stdout 字符串；exec 谓词可注入（黑盒测试走
// PATH 桩，不走本参数——它是薄 IO 语义复用点，非测试钩子）。
function runCommand(contract, kind, values = {}, { run = defaultRun, runOptions } = {}) {
  const { cli, argv } = buildArgv(contract, kind, values);
  return run([cli, ...argv], runOptions);
}

// listIssues 模板的拉取上限：'--limit' 后随的数值（模板是数据，警告文案从模板取数不硬编码）。
function listLimit(contract) {
  const template = contract?.commands?.listIssues;
  if (!Array.isArray(template)) return null;
  const i = template.indexOf('--limit');
  if (i === -1 || i + 1 >= template.length) return null;
  const n = Number(template[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { buildArgv, runCommand, defaultRun, listLimit, substitute };
