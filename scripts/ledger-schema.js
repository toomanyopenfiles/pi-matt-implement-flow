'use strict';

// 事件分类学与 CLI 载荷 schema（纯函数，无 IO）。
// 可由 add 记账的事件（10 类）+ init 载荷档（票 04 起 init 移入子命令，载荷档保留：
// init 子命令与既往 add init 同一参数集，tracker 字段来自契约识别），枚举定死；
// 每类事件有固定的必选/可选参数集；自由文本统一 --note。
// 本模块不知道文件系统与 git——真相层查询由 ledger.js 注入。

// 信封格式版本：事件分类学演进时 +1，旧运行账本按此识别（v=2 起含 run 级 final 事件；
// v=3 起 anomaly 可带 optional 键 refSeq——补正链指针）。
// 现无代码消费该字段——升版是分类学自家教义的显式动作，不是迁移触发器（旧账不迁移）。
const EVENT_VERSION = 3;

// kebab-case CLI 旗标 → payload 字段（camelCase）
const FLAG_TO_KEY = {
  ticket: 'ticket',
  key: 'key',
  'run-id': 'runId',
  worktree: 'worktree',
  round: 'round',
  'head-sha': 'headSha',
  gate: 'gate',
  verdict: 'verdict',
  'final-verdict': 'finalVerdict',
  findings: 'findings',
  'rev-run-id': 'revRunId',
  'fix-no': 'fixNo',
  'resume-run-id': 'resumeRunId',
  'merge-sha': 'mergeSha',
  branch: 'branch',
  'branch-base': 'branchBase',
  'baseline-sha': 'baselineSha',
  spec: 'spec',
  'test-command': 'testCommand',
  tickets: 'tickets',
  reviewer: 'reviewer',
  'max-fix-rounds': 'maxFixRounds',
  'max-concurrent': 'maxConcurrent',
  state: 'state',
  url: 'url',
  note: 'note',
  'ref-seq': 'refSeq',
};
// --tracker 不是任何事件的旗标（票 04）：tracker 由 setup 产物自动识别（契约驱动 init），
// 旗标双轨废除——配置单源是 docs/agents/issue-tracker.md；schema 的未知旗标拒绝自动生效。
const KEY_TO_FLAG = Object.fromEntries(Object.entries(FLAG_TO_KEY).map(([f, k]) => [k, f]));

// 枚举字段：值必须落在集合内（校验档：拒绝）
const ENUMS = {
  verdict: ['approved', 'changes_requested'],
  // 终审的整分支三值裁决。不复用 verdict 键：枚举校验按 key 全局生效，复用会被票级二值拒绝
  // （ADR-0002 Decision 1）。
  finalVerdict: ['ready', 'ready_with_fixes', 'not_ready'],
  state: ['opened-draft', 'ready'],
  // tracker 字段值域（事件格式零迁移，票 04）：识别出的契约预设只有三预设（tracker-contracts），
  // 三者恒在此域——字段校验照旧有效，既有账本照常渲染与对账。
  tracker: ['local', 'github', 'gitlab'],
  reviewer: ['on', 'off'],
};

// 事件分类学（10 类可在 add 的事件 + init 载荷档，枚举定死）。reviewer 派发不单独记事件——
// 由 verdict 的 revRunId 承载；final-reviewer 的派发同理不记，runId 由 run 级 final 事件承载。
// init 载荷档保留（票 04）：它是 init 子命令的载荷口径（tracker 由契约识别填入，不再经 add）——
// 参数集、枚举校验、票号归一与既往零差异；schema 的枚举/SHA/票号档在此档照常生效。
// 历史账本的 init 事件照常渲染与对账（事件格式零迁移）。
const EVENT_TYPES = {
  init: {
    required: ['branch', 'branchBase', 'baselineSha', 'spec', 'testCommand', 'tracker'],
    // 可选流程形态快照：reviewer=on|off、maxFixRounds、maxConcurrent。
    // 省略 = 默认形态（on / 2 / 3）——旧账本自然兼容。
    // 可选票集边界（票 04）：init 票号清单——三层兜底的兜底层，init 时冻结 run 的票集边界
    // （此后边界外的票号记账被拒，中途偷加票被拒）。省略 = 无冻结边界（旧形态零变化）。
    optional: ['reviewer', 'maxFixRounds', 'maxConcurrent', 'tickets'],
  },
  dispatch: { required: ['ticket', 'key', 'runId'], optional: ['worktree', 'note'] },
  settled: { required: ['ticket', 'round', 'headSha'], optional: ['worktree', 'gate', 'note'] },
  verdict: {
    required: ['ticket', 'round', 'verdict'],
    optional: ['findings', 'revRunId', 'note'],
  },
  fix: { required: ['ticket', 'fixNo', 'key', 'resumeRunId'], optional: ['note'] },
  merge: { required: ['ticket', 'headSha', 'mergeSha'], optional: ['note'] },
  escalate: { required: ['ticket'], optional: ['note'] },
  // anomaly 是逃生通道（note 必选），refSeq 是 optional 补正链指针：指向本异常所针对/
  // 更正的既有事件序号（写点三重校验：正整数 / 小于当前序号 / 对应事件存在）。
  anomaly: { required: ['note'], optional: ['refSeq'] },
  // 整分支终审裁决（run 级状态转换，无 ticket）。runId 必选：事件驱动审计与平台证据
  // 核验的唯一锚点（票级还有 dispatch/fix 兜底，终审没有）。多轮终审 = 多条事件，不去重。
  final: { required: ['finalVerdict', 'runId'], optional: ['findings', 'note'] },
  pr: { required: ['state'], optional: ['url', 'note'] },
  close: { required: [], optional: ['note'] },
};

// 票号归一（单一转换点，ADR-0004）：票号一律采用 tracker 原生编号——local 是 feature 局部
// 两位序号（'1' → '01'，与票文件名、merge 令牌 ticket-01 对齐），github 是 issue number，
// 可达四位以上。1–9 号补零显示为 '01'–'09'；写入（parseFlags、Blocked by 行）与核验
// （merge 令牌提取）共用本函数，两侧得到同一表示。位数上限放宽到 6 位：覆盖现实的
// issue number 量级，再长按非法形态拒绝（也防超长数字串在 Number() 下失真）。
function normalizeTicket(v) {
  if (!/^\d{1,6}$/.test(String(v))) return null;
  return String(Number(v)).padStart(2, '0');
}

// 票号清单旗标（票集边界，票 04）的单一转换点：逗号分隔的票号列表 → 归一化、去重、
// 数值排序后的规范数组。任一 token 非法（非数字 / 小数 / 负数 / 超 6 位 / 空段）或整体
// 为空时返回 null——调用方按「旗标不可用」处理。写入（parseFlags 的形态档）与读取
//（gateAdd 冻结执法、reconcile 边界对账）共用本函数，两侧得到同一集合。
function ticketSetList(value) {
  if (value == null || !String(value).trim()) return null;
  const seen = new Set();
  for (const tok of String(value).split(',')) {
    const n = normalizeTicket(tok.trim());
    if (!n) return null;
    seen.add(n);
  }
  return [...seen].sort((a, b) => Number(a) - Number(b));
}

// refSeq（anomaly 的补正链指针，票 03）的数值形态：旗标值按原文入账（字符串，与 round 同惯例），
// 读取侧只在 refSeqNumber 这一处归一——写点校验、check 对账与审计 collect 三处共用同一实现，
// 避免各自 Number() 漂移。非正整数（含非数字、0、负数、小数）返回 null：调用方按「没有可用的
// 序号」处理（写点另有 schema 层的正整数档拒绝，此函数不承担校验职责）。
function refSeqNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// flags 式载荷解析（非裸 JSON——LLM 不会因 shell 引号写坏事件）。
// 返回 { payload, errors }：errors 非空即拒绝（校验档：拒绝）。
function parseFlags(tokens, typeName) {
  const spec = EVENT_TYPES[typeName];
  if (!spec) return { payload: {}, errors: [`未知事件类型：${typeName}`] };
  const allowed = new Set([...spec.required, ...spec.optional]);
  const payload = {};
  const errors = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('--')) {
      errors.push(`意外位置参数「${tok}」——参数一律用 --flag value 形式（flags 式，非裸 JSON）`);
      continue;
    }
    let flag = tok.slice(2);
    let value = null;
    const eq = flag.indexOf('=');
    if (eq !== -1) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
      value = tokens[++i];
    } else {
      errors.push(`旗标 --${flag} 缺少值`);
      continue;
    }
    const key = FLAG_TO_KEY[flag];
    if (!key) {
      errors.push(
        `未知旗标 --${flag}（事件 ${typeName} 的参数集见 --help）；本脚本无任何绕过校验的旗标`
      );
      continue;
    }
    if (!allowed.has(key)) {
      errors.push(`旗标 --${flag} 不属于事件 ${typeName} 的参数集`);
      continue;
    }
    if (key in payload) {
      errors.push(`旗标 --${flag} 重复给出`);
      continue;
    }
    if (!String(value).trim()) {
      errors.push(`旗标 --${flag} 的值为空`);
      continue;
    }
    payload[key] = value;
  }
  for (const key of spec.required) {
    if (!(key in payload)) errors.push(`缺少必选参数 --${KEY_TO_FLAG[key]}`);
  }
  if ('ticket' in payload) {
    const n = normalizeTicket(payload.ticket);
    if (!n) errors.push(`ticket 必须是票号数字（如 01 或 1042），得到：${payload.ticket}`);
    else payload.ticket = n;
  }
  for (const key of ['round', 'fixNo', 'maxFixRounds', 'maxConcurrent', 'refSeq']) {
    if (key in payload && !/^[1-9]\d*$/.test(String(payload[key]))) {
      errors.push(`${key} 必须是正整数（>=1），得到：${payload[key]}`);
    }
  }
  // 票号清单旗标（票 04）：形态档——逗号分隔的票号列表；非法形态 / 空集合拒绝。
  // 规范形态（归一 + 去重 + 数值排序的逗号串）经 ticketSetList 写入，读取侧同用它展开。
  if ('tickets' in payload) {
    const list = ticketSetList(payload.tickets);
    if (!list) {
      errors.push(
        `tickets 必须是逗号分隔的票号列表（如 01,02,1042），得到：${payload.tickets}`
      );
    } else {
      payload.tickets = list.join(',');
    }
  }
  for (const key of ['headSha', 'mergeSha', 'baselineSha']) {
    if (key in payload && !/^[0-9a-f]{7,40}$/i.test(String(payload[key]))) {
      errors.push(`${key} 必须是 git SHA（7-40 位十六进制），得到：${payload[key]}`);
    }
  }
  for (const [key, values] of Object.entries(ENUMS)) {
    if (key in payload && !values.includes(payload[key])) {
      errors.push(`${key} 必须是 ${values.join(' | ')}，得到：${payload[key]}`);
    }
  }
  return { payload, errors };
}

// 信封盖章：时间戳 / 单调序号 / 格式版本 / 写入时刻 git HEAD——全部由脚本生成，LLM 不提供时间。
function makeEnvelope({ type, payload, seq, now, head, warnings }) {
  const event = { v: EVENT_VERSION, seq, ts: now.toISOString(), head, type, payload };
  if (warnings && warnings.length) event.warn = warnings;
  return event;
}

// init 载荷档校验（票 04，纯函数）：init 子命令的 tracker 来自契约识别（非旗标），
// 旗标在 ledger.js 的 init 子命令收集成键值对象后传入，本函数按 init 的参数集校验——
// 与 parseFlags 同一套字段档（SHA 形态 / 枚举 / 正整数 / tickets 清单），载荷形态是
// 已组装的对象（tracker 由识别结果预先填入）；返回校验后的最终载荷与错误。
// 返回 { payload, errors }：errors 非空即拒绝；payload 为校验后的最终事件载荷（归一态）。
function validateInitPayload(rawPayload = {}) {
  const spec = EVENT_TYPES.init;
  const payload = { ...rawPayload };
  const errors = [];
  for (const key of spec.required) {
    if (!(key in payload) || !String(payload[key] ?? '').trim()) {
      errors.push(`缺少必选参数 --${KEY_TO_FLAG[key]}`);
    }
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) errors.push(`载荷键 ${key} 不属于事件 init 的参数集`);
  }
  for (const [key, values] of Object.entries(ENUMS)) {
    if (key in payload && !values.includes(payload[key])) {
      errors.push(`${key} 必须是 ${values.join(' | ')}，得到：${payload[key]}`);
    }
  }
  if ('ticket' in payload) {
    const n = normalizeTicket(payload.ticket);
    if (!n) errors.push(`ticket 必须是票号数字（如 01 或 1042），得到：${payload.ticket}`);
    else payload.ticket = n;
  }
  for (const key of ['round', 'fixNo', 'maxFixRounds', 'maxConcurrent', 'refSeq']) {
    if (key in payload && !/^[1-9]\d*$/.test(String(payload[key]))) {
      errors.push(`${key} 必须是正整数（>=1），得到：${payload[key]}`);
    }
  }
  if ('tickets' in payload) {
    const list = ticketSetList(payload.tickets);
    if (!list) {
      errors.push(`tickets 必须是逗号分隔的票号列表（如 01,02,1042），得到：${payload.tickets}`);
    } else {
      payload.tickets = list.join(',');
    }
  }
  for (const key of ['headSha', 'mergeSha', 'baselineSha']) {
    if (key in payload && !/^[0-9a-f]{7,40}$/i.test(String(payload[key]))) {
      errors.push(`${key} 必须是 git SHA（7-40 位十六进制），得到：${payload[key]}`);
    }
  }
  return { payload, errors };
}

module.exports = {
  EVENT_VERSION,
  EVENT_TYPES,
  ENUMS,
  FLAG_TO_KEY,
  KEY_TO_FLAG,
  normalizeTicket,
  validateInitPayload,
  refSeqNumber,
  ticketSetList,
  parseFlags,
  makeEnvelope,
};
