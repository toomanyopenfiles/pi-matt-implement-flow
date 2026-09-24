'use strict';

// tracker 同步核心（纯逻辑模块，无 IO）——spec 约定的两组纯函数，分居两个模块：
//   转写（本文件，票 02）：tracker issue 表示 → local 同构票文件文本
//   同步规划（sync-planning-core.js，票 03）：（快照状态, tracker 状态）→ 幂等动作列表
//
// 转写由三部分构成：
//   - statusOf      状态映射表：wontfix label → wontfix（spec 明文唯一的 closed 豁免）；
//                   closed → resolved；其余按 triage label 词表（docs/agents/triage-labels.md）
//                   映射 Status: 行
//   - typeOf        类型映射表：wayfinder:<type> label → Type: 行；spec 母票 → Type: spec
//                   （封账门豁免的识别标记，ledger-core 的 closeBlockers 读它）
//   - blockedByOf   阻塞映射表：native dependencies 或正文 Blocked by 行 → Blocked by: 行，
//                   编号一律过 ledger-schema.normalizeTicket（票号空间的单一转换点，ADR-0004）
//   - transcribeTicket / transcribeSpec
//                   票文件文本编排：H1 首题 + Status/Type/Blocked by 行（与 ledger.js 的
//                   parseTicketFile 宽容格式同构）+ 正文逐字保留；spec 母票头部含 Source: 行
//
// 确定性契约：给定同一批 issue 数据，任何时刻转写产物逐字节一致——
// 无时间、无 locale、无随机；多值字段按固定优先序收敛；CRLF 归一为 LF。
//
// 本模块不做任何 IO。输入的 issue 形状（gh issue JSON 或其手工等价物，IO 薄层负责适配）：
//   {
//     number: '<数字|数字串>',       // 必须落票号空间（normalizeTicket 可归一）
//     title: 'string',
//     body: 'string|null',
//     state: 'OPEN|open|CLOSED|closed',   // 大小写不敏感
//     labels: ['string' | { name: 'string' }],   // gh 返回对象数组，两者都收
//     blockedBy: ['<数字>'],         // native dependencies（可选，IO 层解析后注入）
//     url / html_url: 'string|null', // 仅 spec 转写的 Source 行回退用
//   }
// stateReason（COMPLETED / NOT_PLANNED）不进状态映射表：票面只认 closed 与 label 词表；
// not_planned 是否折算为 wontfix 属 IO 薄层的适配决策，不在纯函数面发明第四行。

const schema = require('./ledger-schema');

// triage label 词表（docs/agents/triage-labels.md 的五个 canonical 角色）。
// statusOf 的映射优先序（spec 只豁免 wontfix）：wontfix → closed → 其余 label 按本表序
// 取最先命中——映射因此与 labels 数组序无关。
const TRIAGE_LABELS = ['wontfix', 'needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human'];

// 开放票且无任何 triage label 时的兜底：tracker 上未被评估的票，其如实的本地状态就是
// needs-triage（维护者待评估）。不落空串——parseTicketFile 会把空值读成 ''，让下游
// （前沿扫描、封账门）面对一个非词表状态。
const UNTRIAGED_FALLBACK = 'needs-triage';

// wayfinder 类型词表（docs/agents/issue-tracker.md 的 Type 值）。仅用于文档；
// 未知后缀逐字透传（转写是忠实拷贝层，词表校验是读取侧/账本侧的职责）。

const labelNames = (issue) =>
  (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : String(l?.name ?? '')))
    .map((s) => s.trim())
    .filter(Boolean);

const isClosed = (issue) => String(issue.state ?? '').trim().toLowerCase() === 'closed';

// ------------------------------------------------------------------
// 状态映射表
// ------------------------------------------------------------------

// 优先序即 spec 状态映射的明文面：wontfix 是唯一获得 closed 豁免的 label（关成
// not_planned 的票仍显 wontfix）；closed 压过其余一切 label——closed + 陈旧可派发
// label（如 ready-for-agent）不得转写成开放态，否则会污染前沿；其后的 triage label
// 按词表序保守取先，兜底见 UNTRIAGED_FALLBACK。
function statusOf(issue) {
  const labels = labelNames(issue);
  if (labels.includes('wontfix')) return 'wontfix';
  if (isClosed(issue)) return 'resolved';
  for (const role of TRIAGE_LABELS) {
    if (role !== 'wontfix' && labels.includes(role)) return role;
  }
  return UNTRIAGED_FALLBACK;
}

// ------------------------------------------------------------------
// 类型映射表
// ------------------------------------------------------------------

function typeOf(issue, { isSpec = false } = {}) {
  if (isSpec) return 'spec'; // 母票标记优先于任何 label（spec 识别靠引用与母票边，不靠 label——ADR-0005）
  const wayfinder = labelNames(issue).find((l) => l.startsWith('wayfinder:'));
  return wayfinder ? wayfinder.slice('wayfinder:'.length).trim() : null;
}

// ------------------------------------------------------------------
// 阻塞映射表
// ------------------------------------------------------------------

// 正文里的 Blocked by 行：与 ledger.js parseTicketFile 的 grab 同一宽容形态
// （**Blocked by:** x 与 Blocked by: x 皆读，首个命中行生效），提取全部数字。
const BLOCKED_BY_LINE = /^\**\s*Blocked by\s*:\**\s*(.*)$/im;

function blockedByOf(issue) {
  const native = issue.blockedBy ?? [];
  const lineMatch = BLOCKED_BY_LINE.exec(String(issue.body ?? ''));
  const inline = lineMatch ? (lineMatch[1].match(/\d+/g) ?? []) : [];
  // 两来源合并 → 单一转换点归一 → 去重 → 数值排序。超位数字（票号空间不可表示）
  // 经 normalizeTicket 得 null，照令牌扫描的先例丢弃，不拖累其余边。
  const normalized = [...native, ...inline].map((v) => schema.normalizeTicket(String(v))).filter(Boolean);
  return [...new Set(normalized)].sort((a, b) => Number(a) - Number(b));
}

// ------------------------------------------------------------------
// 票文件文本编排
// ------------------------------------------------------------------

// 票号：读写同过一个转换点——H1 首题与 Blocked by 引用得到同一表示（1–9 号补零为 01–09）。
function ticketNum(issue) {
  const num = schema.normalizeTicket(String(issue?.number ?? ''));
  if (!num) {
    throw new Error(
      `票号非法：${issue?.number ?? '(缺失)'}——issue number 必须是 1–6 位数字（ledger-schema.normalizeTicket 的票号空间）`
    );
  }
  return num;
}

const transcribeBody = (issue) => String(issue.body ?? '').replace(/\r\n/g, '\n').trim();

// 工单票文件文本：与 local tracker 票文件同构（parseTicketFile 三个标签行 + H1 首题）。
// 任务票无 Type 行（isTaskFile：缺 Type 即 task）；无正文时文件止于头部块，不落空节。
function transcribeTicket(issue) {
  if (!issue) throw new Error('缺少 issue——转写需要 tracker 的 issue 表示');
  const num = ticketNum(issue);
  const status = statusOf(issue);
  const type = typeOf(issue);
  const blockedBy = blockedByOf(issue);
  const lines = [`# ${num}: ${String(issue.title ?? '').trim()}`, '', `**Status:** ${status}`];
  if (type) lines.push('', `**Type:** ${type}`);
  lines.push('', `**Blocked by:** ${blockedBy.length ? blockedBy.join(', ') : '—'}`);
  const body = transcribeBody(issue);
  if (body) lines.push('', body);
  return lines.join('\n') + '\n';
}

// spec 母票票文件文本：Source 行在文件头部（供同步收尾解析 tracker 原址——ADR-0005），
// Type: spec 是封账门豁免的识别标记，状态与正文走同一张转写口径。
// 与 local spec.md 的形态同构：H1 为 `# Spec: <题>`（integration-05 对齐项）——issue 标题
// 按 to-spec 发布惯例自带 "Spec: " 前缀，剥一次避免双前缀；票号合法性仍过 ticketNum
//（票号空间单一转换点），但 spec.md 文件名固定、H1 不再携带号前缀。
// 正文里的 Status 行剔除（integration-05 缺陷 2）：to-spec 发布惯例把 Status 行带进 issue
// 正文（local 文件头在 GitHub 上没有对应物，正文首行即其落点），原样保留会同文件两行
// Status，parseTicketFile 取首行造成语义漂移——Status 的唯一来源是状态映射表，正文行
// 不透传（行形态与 parseTicketFile 的 grab 同一宽容口径；剔行残留的空行不重排）。
const SPEC_TITLE_PREFIX = /^Spec\s*[:：]\s*/i;
const STATUS_META_LINE = /^\**\s*Status\s*:\**/;

function transcribeSpec({ issue, source }) {
  if (!issue) throw new Error('缺少 spec 母票——转写需要 tracker 的 spec issue 表示');
  const src = source ?? issue.url ?? issue.html_url ?? null;
  if (!src) {
    throw new Error('spec 转写缺少 Source（tracker 原址）——同步收尾依赖该行解析收尾对象，未提供不得落盘');
  }
  ticketNum(issue); // 票号合法性（单一转换点）；号本身不再进 spec.md 的 H1
  const title = String(issue.title ?? '').trim().replace(SPEC_TITLE_PREFIX, '');
  const lines = [
    `# Spec: ${title}`,
    '',
    `Source: ${src}`,
    '',
    `**Status:** ${statusOf(issue)}`,
    '',
    '**Type:** spec',
  ];
  const body = transcribeBody(issue)
    .split('\n')
    .filter((line) => !STATUS_META_LINE.test(line))
    .join('\n')
    .trim();
  if (body) lines.push('', body);
  return lines.join('\n') + '\n';
}

// 快照布局层（snapshot-core.planSnapshot）直接编排 transcribeSpec + transcribeTicket：
// 票集解析与批内去重（重号取首个）归票集边界口径，不在转写面另立一套契约。

module.exports = {
  statusOf,
  typeOf,
  blockedByOf,
  transcribeTicket,
  transcribeSpec,
};
