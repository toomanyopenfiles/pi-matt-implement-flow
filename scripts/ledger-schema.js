'use strict';

// 事件分类学与 CLI 载荷 schema（纯函数，无 IO）。
// 十一类事件枚举定死（spec：事件分类学）；每类事件有固定的必选/可选参数集；
// 自由文本统一 --note。本模块不知道文件系统与 git——真相层查询由 ledger.js 注入。

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
  tracker: 'tracker',
  reviewer: 'reviewer',
  'max-fix-rounds': 'maxFixRounds',
  'max-concurrent': 'maxConcurrent',
  state: 'state',
  url: 'url',
  note: 'note',
  'ref-seq': 'refSeq',
};
const KEY_TO_FLAG = Object.fromEntries(Object.entries(FLAG_TO_KEY).map(([f, k]) => [k, f]));

// 枚举字段：值必须落在集合内（校验档：拒绝）
const ENUMS = {
  verdict: ['approved', 'changes_requested'],
  // 终审的整分支三值裁决。不复用 verdict 键：枚举校验按 key 全局生效，复用会被票级二值拒绝
  // （ADR-0002 Decision 1）。
  finalVerdict: ['ready', 'ready_with_fixes', 'not_ready'],
  state: ['opened-draft', 'ready'],
  tracker: ['local', 'github', 'gitlab'],
  reviewer: ['on', 'off'],
};

// 事件分类学（11 类，枚举定死）。reviewer 派发不单独记事件——由 verdict 的 revRunId 承载；
// final-reviewer 的派发同理不记，runId 由 run 级 final 事件承载。
const EVENT_TYPES = {
  init: {
    required: ['branch', 'branchBase', 'baselineSha', 'spec', 'testCommand', 'tracker'],
    // 可选流程形态快照：reviewer=on|off、maxFixRounds、maxConcurrent。
    // 省略 = 默认形态（on / 2 / 3）——旧账本自然兼容。
    optional: ['reviewer', 'maxFixRounds', 'maxConcurrent'],
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

// 票号归一：'1' → '01'（与票文件名、merge 令牌 ticket-NN 对齐）
function normalizeTicket(v) {
  if (!/^\d{1,3}$/.test(String(v))) return null;
  return String(Number(v)).padStart(2, '0');
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
    if (!n) errors.push(`ticket 必须是票号数字（如 01），得到：${payload.ticket}`);
    else payload.ticket = n;
  }
  for (const key of ['round', 'fixNo', 'maxFixRounds', 'maxConcurrent', 'refSeq']) {
    if (key in payload && !/^[1-9]\d*$/.test(String(payload[key]))) {
      errors.push(`${key} 必须是正整数（>=1），得到：${payload[key]}`);
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

module.exports = {
  EVENT_VERSION,
  EVENT_TYPES,
  ENUMS,
  FLAG_TO_KEY,
  KEY_TO_FLAG,
  normalizeTicket,
  refSeqNumber,
  parseFlags,
  makeEnvelope,
};
