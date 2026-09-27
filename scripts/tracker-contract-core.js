'use strict';

// 契约解析核心（纯逻辑模块，无 IO）——票 01，接缝①（spec「Testing Decisions」唯一新缝）。
// 把上游 setup 产出的两份文档文本解析为机器契约对象（或显式错误）——本包从此的唯一
// tracker 配置源；通用引擎此后吃契约对象跑完整流程（spec：代码里零 per-tracker 分支）。
//
//   resolveContract({ issueTracker, triageLabels })
//     两份上游文档文本 → 契约对象（三预设之一 + 词表映射钉死）或 ok=false 显式错误：
//     缺 setup 产物 → 指引运行 /setup-matt-pocock-skills；范本认不出 → 显式
//     「仅支持 local / github / gitlab 三种」——两者都停下，不猜测不降级、不派生向导。
//   parseTriageLabels(mdText)
//     triage-labels.md 文本 → 词表映射：role→label（ADR-0006 决策层 ② 的拉取时钉死形态，
//     后续以参数传入 statusOf；映射判定方向是「哪个 label 担任哪个角色」，label→角色
//     由同一张表反查）。严格解析：按表头定位列、恰好五行、label 唯一；违约报错到
//     文件 + 行 + 列 + 期望。
//   validateContract(obj)
//     契约对象的 schema 校验档：三预设与合成契约（假想 tracker 形态，仅用于测试）都从
//     这里过同一扇门——契约是引擎唯一依赖，不经判型直接构造的对象同样合法。
//
// 范本判型（结构性判据）：H1 标题行 + 少量锚点短语——判据数据随预设发布
//（tracker-contracts 的 detection 字段，支持新 tracker = 新增预设 + 判据）；
// 正文可被用户编辑，锚点短语不可缺。大小写与空白归一后比对（容忍排版差异）。
//
// 词表映射的钉死语义（ADR-0006）：文件缺失是合法常态 → 落 canonical 默认并注记警告；
// 文件存在但违反契约 → 立即失败（错误文案指到文件 + 行 + 列 + 期望，解析错误文案即
// 契约教材），发生在任何 tracker 调用与落盘之前（零半成品）。映射优先序
//（wontfix → closed → 词表序）留在代码不开放配置；输出词表固定为 canonical 五角色。

const { CONTRACTS, CANONICAL_ROLES, CANONICAL_LABEL_MAP } = require('./tracker-contracts');

const DEFAULT_ISSUE_TRACKER_FILE = 'docs/agents/issue-tracker.md';
const DEFAULT_TRIAGE_FILE = 'docs/agents/triage-labels.md';

// 大小写 + 空白归一（判型比对口径：容忍排版与大小写差异，不容忍改词）
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const cellError = (file, line, col, header, problem, expectation) =>
  `词表违约：${file} 第 ${line} 行第 ${col} 列（表头「${header}」）：${problem}——期望 ${expectation}`;

// ------------------------------------------------------------------
// 契约对象校验档（schema 的机器表达；三预设与合成契约同门）
// ------------------------------------------------------------------

// 词表枚举是引擎协议词汇，不是 tracker 名分支：票集边来源 = tracker-set-core 的 source
// 值；阻塞边来源 = blockedByOf 的两来源；type 来源 = 转写的两来源。合成契约可以声明
// 这些词表内的任意组合（假想 tracker 形态），引擎逻辑一律按值执行。
const TICKET_SET_EDGES = ['sub-issues', 'parent-edges', 'init-list'];
const BLOCKING_EDGES = ['native', 'inline'];
const TYPE_SOURCES = ['wayfinder-label', 'type-line'];
const CLOSING_SURFACES = ['PR', 'MR', 'none'];
const CLAIM_STRENGTHS = ['advisory'];

function validateContract(c) {
  const errors = [];
  const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
  const isNullOrStrList = (v) => v === null || isStrList(v);
  if (!isObj(c)) return { ok: false, errors: ['契约对象必须是对象'] };

  const check = (cond, message) => {
    if (!cond) errors.push(message);
  };

  check(typeof c.tracker === 'string' && c.tracker.trim(), '契约缺 tracker 标识（字符串）');
  check(isObj(c.detection) && norm(c.detection.h1) === c.detection.h1 && Array.isArray(c.detection.anchors) && c.detection.anchors.length > 0,
    '契约缺 detection（H1 归一化形态 + 锚点短语数组）——范本判据随预设发布');

  const identity = c.identity;
  check(isObj(identity), '契约缺 identity（标识与引用）');
  if (isObj(identity)) {
    check(typeof identity.ticketNumber === 'string' && identity.ticketNumber.trim(), 'identity 缺 ticketNumber（票号语法）');
    check(
      isObj(identity.specRef) && ['number', 'path'].includes(identity.specRef.kind) &&
        Array.isArray(identity.specRef.accepts) && identity.specRef.accepts.length > 0,
      '契约 identity.specRef 缺合法形态（kind: number|path + accepts 形态清单）'
    );
    check(
      isObj(identity.sourceUrl) && ['url', 'path'].includes(identity.sourceUrl.kind) &&
        (identity.sourceUrl.host === null || typeof identity.sourceUrl.host === 'string') &&
        typeof identity.sourceUrl.path === 'string' && identity.sourceUrl.path.trim(),
      '契约 identity.sourceUrl 缺合法形态（kind: url|path + host（url 之外可 null）+ path 形态）'
    );
  }

  const mapping = c.mapping;
  check(isObj(mapping), '契约缺 mapping（表示映射）');
  if (isObj(mapping)) {
    check(
      isObj(mapping.labelMap) && Object.keys(mapping.labelMap).length === CANONICAL_ROLES.length &&
        CANONICAL_ROLES.every((r) => typeof mapping.labelMap[r] === 'string' && mapping.labelMap[r].trim()),
      '契约 mapping.labelMap 非法——期望 role→label 恰好五角色、label 非空（输出词表固定：canonical 五角色）'
    );
    check(typeof mapping.closedStatus === 'string' && mapping.closedStatus.trim(), '契约 mapping 缺 closedStatus（closed → 本地 Status 词）');
    check(TYPE_SOURCES.includes(mapping.typeSource), `契约 mapping.typeSource 必须是 ${TYPE_SOURCES.join(' | ')}，得到：${JSON.stringify(mapping.typeSource ?? null)}`);
    check(
      Array.isArray(mapping.blockingEdges) && mapping.blockingEdges.length > 0 && mapping.blockingEdges.every((e) => BLOCKING_EDGES.includes(e)),
      `契约 mapping.blockingEdges 必须是 ${BLOCKING_EDGES.join(' | ')} 的非空数组`
    );
  }

  check(
    isObj(c.ticketSet) && Array.isArray(c.ticketSet.edges) && c.ticketSet.edges.length > 0 &&
      c.ticketSet.edges.every((e) => TICKET_SET_EDGES.includes(e)),
    `契约 ticketSet.edges 必须是 ${TICKET_SET_EDGES.join(' | ')} 的非空数组（三层兜底链按序）`
  );

  const caps = c.capabilities;
  check(isObj(caps), '契约缺 capabilities（能力声明）');
  if (isObj(caps)) {
    check(CLAIM_STRENGTHS.includes(caps.claimStrength), `契约 capabilities.claimStrength 必须是 ${CLAIM_STRENGTHS.join(' | ')}（占坑强度如实声明），得到：${JSON.stringify(caps.claimStrength ?? null)}`);
    check(typeof caps.closeWithComment === 'boolean', '契约 capabilities.closeWithComment 必须是 boolean（false = note 先行）');
    check(CLOSING_SURFACES.includes(caps.closingSurface), `契约 capabilities.closingSurface 必须是 ${CLOSING_SURFACES.join(' | ')}，得到：${JSON.stringify(caps.closingSurface ?? null)}`);
  }

  const commands = c.commands;
  check(isObj(commands) && (commands.cli === null || typeof commands.cli === 'string'), '契约缺 commands（操作面；local 为全 null + cli null）');
  if (isObj(commands)) {
    for (const key of ['listIssues', 'subIssues', 'blockedBy', 'repoView', 'prProbe', 'viewIssue', 'claim', 'unclaim', 'comment', 'close']) {
      check(isNullOrStrList(commands[key]), `契约 commands.${key} 必须是 null 或 argv 模板（字符串数组，占位符 <num>/<body>/<login>/<repo>/<branch>）`);
    }
  }

  const idem = c.idempotency;
  check(isObj(idem) && typeof idem.marker === 'string' && idem.marker.includes('<runId>') && idem.marker.includes('<kind>'),
    '契约缺幂等键 marker（须含 <runId> 与 <kind> 占位）');
  check(isObj(idem) && typeof idem.carrier === 'string' && idem.carrier.trim(), '契约缺幂等载体 carrier');

  const lifecycle = c.lifecycle;
  check(
    isObj(lifecycle) && typeof lifecycle.specCloseTiming === 'string' && lifecycle.specCloseTiming.trim() &&
      isObj(lifecycle.abandon) && typeof lifecycle.abandon.unclaim === 'boolean' && typeof lifecycle.abandon.comment === 'boolean',
    '契约缺 lifecycle（spec 关票时点 + abandon 语义：unclaim/comment 布尔）'
  );

  return { ok: errors.length === 0, errors };
}

// ------------------------------------------------------------------
// triage-labels 严格解析（ADR-0006）
// ------------------------------------------------------------------

const ROLE_HEADER = 'label in mattpocock/skills';
const LABEL_HEADER = 'label in our tracker';
const PIPE_ROW = /^\s*\|/;
const isPipeRow = (line) => PIPE_ROW.test(String(line ?? ''));
// 分隔行：每个单元格都是破折号列（| --- | :---: | 形态）
const SEPARATOR_CELL = /^:?-{2,}:?$/;

// 表格行 → 单元格数组：外层管道剥掉，单元格去首尾空白与一层反引号
function cellsOf(line) {
  const parts = String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return parts.map((raw) => {
    const s = raw.trim();
    const m = /^`([^`]*)`$/.exec(s);
    return (m ? m[1] : s).trim();
  });
}
const isSeparatorRow = (line) => {
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c) || c === '');
};

// 词表文件缺失 → canonical 默认并注记一行（合法常态：setup 仅在装了 triage skill 时才写
// 该文件，且上游技能无映射表时贴的就是 canonical 字面名——落默认是如实而非降级，ADR-0006）。
// 文件存在但为空/无表格 → 违约（文件在而内容不合规是配置错误，显式暴露，不猜）。
function parseTriageLabels(mdText, options = {}) {
  const file = typeof options.file === 'string' && options.file.trim() ? options.file : DEFAULT_TRIAGE_FILE;
  if (mdText == null) {
    return {
      ok: true,
      labelMap: { ...CANONICAL_LABEL_MAP },
      warnings: [
        `${file} 不存在——按 ADR-0006 落 canonical 默认词表（setup 仅在装了 triage skill 时才写该文件）。` +
          '若目标仓库实际用自定义 label 名，请补齐该文件（或重跑 /setup-matt-pocock-skills）。',
      ],
    };
  }

  const text = String(mdText).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const errors = [];
  const warnings = [];

  // 表头行：第一条含「Label in mattpocock/skills」表头单元格的表格行（按表头名定位列）
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isPipeRow(lines[i]) && cellsOf(lines[i]).some((c) => norm(c) === ROLE_HEADER)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    const firstPipe = lines.findIndex((l) => isPipeRow(l));
    const at = firstPipe === -1 ? 1 : firstPipe + 1;
    return {
      ok: false,
      labelMap: null,
      warnings,
      errors: [
        `词表违约：${file} 第 ${at} 行：找不到表头行——期望表头行含「Label in mattpocock/skills」与「Label in our tracker」两列`,
      ],
    };
  }

  const headerLine = lines[headerIdx];
  const headerCells = cellsOf(headerLine);
  const roleCol = headerCells.findIndex((c) => norm(c) === ROLE_HEADER); // 0 基索引；报错时 +1
  const labelCol = headerCells.findIndex((c) => norm(c) === LABEL_HEADER);
  if (labelCol === -1) {
    return {
      ok: false,
      labelMap: null,
      warnings,
      errors: [
        `词表违约：${file} 第 ${headerIdx + 1} 行第 ${headerCells.length + 1} 列起：缺列「Label in our tracker」（现 ${headerCells.length} 列）——` +
          '期望表头含该列（按表头名定位列，防插列错位造成静默错映射）',
      ],
    };
  }

  // 数据行：表头之下连续的表格行（跳过分隔行），到第一个非表格行止。
  // 行集合闭合：恰好五行，不增不删（ADR-0006）——多出的行、缺的行都在行数档显式报错。
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length && isPipeRow(lines[i]); i++) {
    if (isSeparatorRow(lines[i])) continue;
    rows.push({ line: i + 1, text: lines[i] });
  }

  const seenRoles = new Map(); // role → 首现行号
  const seenLabels = new Map(); // labelKey → { label, lines: [] }
  const labelMap = {};

  for (const row of rows) {
    const cells = cellsOf(row.text);
    if (cells.length < Math.max(roleCol, labelCol) + 1) {
      errors.push(
        `词表违约：${file} 第 ${row.line} 行：仅 ${cells.length} 列——期望与表头同列数（按表头名定位列）`
      );
      continue;
    }
    const role = cells[roleCol];
    const label = cells[labelCol];
    if (!CANONICAL_ROLES.includes(role)) {
      errors.push(
        cellError(file, row.line, roleCol + 1, 'Label in mattpocock/skills',
          `角色名「${role}」不在 canonical 五角色`,
          `恰好五角色（${CANONICAL_ROLES.join(' / ')}）`)
      );
    } else if (seenRoles.has(role)) {
      // 重复角色在行内报（成组的重复/缺失在行数档后统一报）
      errors.push(
        cellError(file, row.line, roleCol + 1, 'Label in mattpocock/skills',
          `角色「${role}」重复（第 ${seenRoles.get(role)} 行已出现）`,
          '五角色恰好各出现一次')
      );
    } else {
      seenRoles.set(role, row.line);
      labelMap[role] = label;
    }
    if (!label) {
      errors.push(
        cellError(file, row.line, labelCol + 1, 'Label in our tracker',
          'label 为空', '每行一个非空 label')
      );
      continue;
    }
    const key = label.toLowerCase();
    if (!seenLabels.has(key)) seenLabels.set(key, { label, lines: [] });
    seenLabels.get(key).lines.push(row.line);
  }

  // label 全表唯一（GitHub label 名跨大小写唯一——大小写不敏感判重）
  for (const { label, lines: dupLines } of seenLabels.values()) {
    if (dupLines.length > 1) {
      errors.push(
        cellError(file, dupLines[0], labelCol + 1, 'Label in our tracker',
          `label 重复「${label}」（另见第 ${dupLines.slice(1).join('、')} 行）`,
          '全表唯一（label 名跨大小写唯一）')
      );
    }
  }

  // 行集合闭合：恰好五行
  if (rows.length !== CANONICAL_ROLES.length) {
    const offending = rows.length > CANONICAL_ROLES.length ? rows[CANONICAL_ROLES.length].line : rows[rows.length - 1]?.line ?? headerIdx + 1;
    errors.push(
      `词表违约：${file} 第 ${offending} 行：数据行 ${rows.length} 行——期望恰好五行（行集合闭合：不增不删）`
    );
  }

  // 角色列闭合：五角色恰好各出现一次（重复已在逐行档报，此处收缺失的尾）
  const missingRoles = CANONICAL_ROLES.filter((r) => !seenRoles.has(r));
  if (seenRoles.size > 0 && missingRoles.length) {
    const parts = [`缺失：${missingRoles.join('、')}`];
    errors.push(
      cellError(file, headerIdx + 1, roleCol + 1, 'Label in mattpocock/skills',
        `角色列非五角色恰各一次（${parts.join('；')}）`,
        '五角色恰好各出现一次')
    );
  }

  if (errors.length) return { ok: false, labelMap: null, warnings, errors };
  return { ok: true, labelMap, warnings, errors: [] };
}

// ------------------------------------------------------------------
// 范本判型 + 契约解析
// ------------------------------------------------------------------

// H1 标题行：首个一级标题（标题文本归一化后与预设 detection.h1 精确比对）。
function firstH1(text) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+)$/.exec(lines[i]);
    if (m) return { line: i + 1, title: norm(m[1]) };
  }
  return null;
}

// 缺 setup 产物 / 范本认不出 / 判型失败：三者都是显式停下（不猜测、不降级、不派生向导）。
function resolveContract({ issueTracker, triageLabels, issueTrackerFile, triageLabelsFile } = {}) {
  const file = typeof issueTrackerFile === 'string' && issueTrackerFile.trim() ? issueTrackerFile : DEFAULT_ISSUE_TRACKER_FILE;
  // CRLF 归一为 LF（与转写同一口径）：判型与解析不受 Windows 编辑器行尾影响
  const text = issueTracker == null ? '' : String(issueTracker).replace(/\r\n/g, '\n');
  if (!text.trim()) {
    return {
      ok: false,
      contract: null,
      errors: [
        `缺 issue tracker 范本文档：${file}——先运行 /setup-matt-pocock-skills 落盘 setup 产物，再重跑`,
      ],
      warnings: [],
    };
  }

  const h1 = firstH1(text);
  const preset = h1 ? Object.values(CONTRACTS).find((p) => p.detection.h1 === h1.title) : null;
  if (!preset) {
    return {
      ok: false,
      contract: null,
      errors: [
        `issue tracker 范本认不出（H1：${h1 ? `「${h1.title}」` : '（无 H1 标题行）'}）——` +
          '仅支持 local / github / gitlab 三种范本，不猜测不降级；重跑 /setup-matt-pocock-skills 或升级本包预设',
      ],
      warnings: [],
    };
  }

  // 锚点短语：正文可编辑，锚点不可缺——全部命中才判型成功（大小写与空白归一后比对）
  const haystack = norm(text);
  const missing = preset.detection.anchors.filter((a) => !haystack.includes(norm(a)));
  if (missing.length) {
    return {
      ok: false,
      contract: null,
      errors: [
        `issue tracker 范本判型失败：H1 命中 ${preset.tracker} 但缺少锚点短语：${missing.map((a) => `「${a}」`).join('、')}——` +
          '判据是 H1 + 锚点短语（正文可编辑，锚点不可缺）；重跑 /setup-matt-pocock-skills 或升级本包预设',
      ],
      warnings: [],
    };
  }

  // 词表映射：拉取时钉死（ADR-0006）——覆盖预设的 canonical 默认；违约在判型时一并拦下
  //（错误文案由 parseTriageLabels 给到文件+行+列+期望），不产生半成品契约。
  const tri = parseTriageLabels(triageLabels, { file: triageLabelsFile });
  if (!tri.ok) {
    return { ok: false, contract: null, errors: [...tri.errors], warnings: [...tri.warnings] };
  }

  const contract = JSON.parse(JSON.stringify(preset));
  contract.mapping.labelMap = tri.labelMap;
  const validity = validateContract(contract);
  if (!validity.ok) {
    // 预设数据漂移是包内缺陷，不是用户可修的配置——显式失败点名，不猜测。
    return { ok: false, contract: null, errors: [`契约预设「${preset.tracker}」未通过 schema 校验：${validity.errors.join('；')}`], warnings: [...tri.warnings] };
  }
  return { ok: true, contract, warnings: [...tri.warnings], errors: [] };
}

module.exports = {
  resolveContract,
  parseTriageLabels,
  validateContract,
};
