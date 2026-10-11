'use strict';

// 包注册不变量的纯校验逻辑。
// 所有 checker 都接收注入的数据/存在性谓词，不直接碰文件系统——
// 因此「模拟破坏」只需喂假想的 fixture，绝不改动真实文件。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PKG_ROOT = path.resolve(__dirname, '..');

// 常量单一来源：agent 角色表与超时契约值来自 flow-config-core，避免两处漂移。
const { ROLES, AGENT_TIMEOUT_MS, GATE_VERIFY_TIMEOUT_MS } = require('./flow-config-core.js');

// 三个 agent 的名字（不含包前缀）。包全名 = `${packageName}.${agentName}`。
const AGENT_NAMES = ROLES;

// --- 读取（只读原语，供测试装配真实包树） ---

function readPackageJson(root = PKG_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function isFileAt(root, relPath) {
  try {
    return fs.statSync(path.resolve(root, relPath)).isFile();
  } catch {
    return false;
  }
}

function isDirAt(root, relPath) {
  try {
    return fs.statSync(path.resolve(root, relPath)).isDirectory();
  } catch {
    return false;
  }
}

// --- frontmatter 最小解析（无 YAML 依赖；只需顶层 key: value 行） ---

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const frontmatter = {};
  for (const line of text.slice(3, end).split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return frontmatter;
}

// ====================================================================
// 承重契约 → 权威文档位置登记表（ticket 33 建立，ticket 36 跟随指令拆分）
//
// 静态合同的检查器只吃文本、不认文件名；测试经 resolveContractText / resolveContractCorpus
// 按契约 id 取文本。指令搬迁 = 改本表的 docs（原位置记进 previous）：检查器、断言与派发
// 边界测试原样跟随，测试里不再写死指令文档路径（注册事实如 agent frontmatter、
// 可执行派发脚本按各自的注册面/包布局读，不属本表）。
//
// 当前布局（ticket 36）：主干 `SKILL.md` 常驻（角色、核心安全约束、流程地图、披露入口），
// 阶段操作文档在 `run/` 下按需加载；检查器问题串里的 `SKILL.md` 沿用为「被检查的指令文本」
// 的稳定标签，位置一律以本表为准（拆分不改逐条消息的措辞）。
//
// 字段：
// - id       契约名（检查器与测试按它取值）
// - contract 契约一句话（对照/复核用；规则权威仍在文档，这里不是规则副本）
// - docs     当前权威位置（包内相对路径；跨文档的契约按阅读顺序列出，文本按序拼接）
// - previous 搬迁前的原位置（对照列；已搬走却仍留在主干的旧路径 = 悬空指针，检查即红）
// - entry    触发入口：carriers 是动作前加载的文档（主干 / agent 定义等加载面），
//            trigger 是触发条件——当 docs 里有 carriers 之外的文档时，trigger 必须是
//            披露段里的触发锚点；全部文档都在 carriers 内时（主干常驻 / 平台按注册名
//            加载），trigger 只是入口何时生效的对照说明。
// - tests    对应测试（对照列；首段是测试文件路径，存在性由自检钉住）
//
// 披露入口纪律：docs 里不在 carriers 内的文档必须由 carriers 某段以「触发条件 + 动作前
// 读取」披露 —— 该段要含路径、带 read/before 语义、并含登记表里的 trigger 锚点；入口缺失、
// 只提名不要求动作前读取、缺触发条件、入口文档没落地、目标过期、登记文档没落地，各自报红。
// 只钉承重的路径、触发条件与动作前读取语义，不锁标题措辞、行数或目录数量，也不以
// 「拼接全部文档搜关键词」代替入口检查。
// 边界：散文解释与「继续条件」措辞不定型，不做逐字断言；跨文档的小节断言随实际拆分
// 调整检查对象与入口，但不删断言、不删破坏模拟。
// ====================================================================
const TRUNK_DOC = 'SKILL.md';

// 主干常驻：入口就是主干本身，每次加载，无独立披露段。
const TRUNK_ENTRY = Object.freeze({ carriers: ['SKILL.md'], trigger: '主干常驻（每次加载）' });

// 阶段操作文档（ticket 36 原样拆分自主干）的触发锚点：主干「The loop」的入口段逐条携带，
// 登记行按文档取对应锚点；同一文档的多个契约行共用本锚点。
const STAGE_ENTRY = Object.freeze({
  'run/dispatch-reference.md': 'before writing a brief or a dispatch script',
  'run/new-run.md': 'before Round 0',
  'run/ticket-loop.md': 'before dispatching a wave',
  'run/recovery.md': 'before resuming an unfinished run',
  'run/closing.md': 'before the Final gate',
});
const stageEntry = (doc) => ({ carriers: ['SKILL.md'], trigger: STAGE_ENTRY[doc] });

const CONTRACT_DOCUMENTS = [
  // —— 派发参考（run/dispatch-reference.md）：五套简报模板与路径规则。
  {
    id: 'coder-brief-worktree-reality',
    contract: 'coder 简报的 Worktree reality 块、退役编排笔记指针、用户裁定的软围栏原句',
    docs: ['run/dispatch-reference.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/dispatch-reference.md'),
    tests: ['test/self-check.test.js · coder brief carries the worktree-reality contract'],
  },
  {
    id: 'briefs',
    contract: '五套简报模板、零报告职责、承重收尾句（SHA 报告与提交纪律）',
    docs: ['run/dispatch-reference.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/dispatch-reference.md'),
    tests: ['test/self-check.test.js · anchor-4、anchor-8'],
  },
  // —— 新运行（run/new-run.md）：前置条件、流程形态、运行时限、Round 0。
  {
    id: 'preconditions-flow-config',
    contract: '前置条件与流程形态冻结（reviewer/concurrency，无修复配额）',
    docs: ['run/new-run.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/new-run.md'),
    tests: ['test/self-check.test.js · run/new-run.md flow configuration and new init expose reviewer/concurrency'],
  },
  {
    id: 'round0',
    contract: 'Round 0：图、分支、基线、环境勘测（勘测结论归编排笔记环境事实节）',
    docs: ['run/new-run.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/new-run.md'),
    tests: ['test/self-check.test.js · Round 0 carries the environment-survey step'],
  },
  // —— ticket 循环（run/ticket-loop.md）：派发、结算、评审、修复轮、合并收尾。
  {
    id: 'ticket-round',
    contract: '认领、派发、结算、正式评审轮次独立与批准门看当前候选',
    docs: ['run/ticket-loop.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/self-check.test.js · run/ticket-loop.md formal review rounds are independent / ticket repairs'],
  },
  {
    id: 'coder-dispatch-typed-gate',
    contract: '票据 coder 派发 = typed gate（gate 在场、无 acceptance 对象 / outputSchema）',
    docs: ['run/ticket-loop.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/self-check.test.js · anchor-1'],
  },
  {
    id: 'dispatch-schema-copy',
    contract: '派发 schema 副本与 mechanical-report 真源逐字一致',
    docs: ['run/ticket-loop.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/self-check.test.js · anchor-2'],
  },
  {
    id: 'gate-commands',
    contract: '每条机械报告门禁命令带 --base 与 --test-command',
    docs: ['run/ticket-loop.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/self-check.test.js · anchor-5'],
  },
  {
    id: 'fix-loop',
    contract: '修复轮 resume（acceptance: false、无 gate）与编排者手跑同一门禁命令',
    docs: ['run/ticket-loop.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/self-check.test.js · anchor-3、anchor-9'],
  },
  // —— 恢复（run/recovery.md）：续跑与升级历史；round0 的续段入口在 new-run 文档。
  {
    id: 'cold-resume',
    contract: '续跑：跳过 init 与拉取、再生对账、核验条件、恢复中断阶段（续段回到 Round 0）',
    docs: ['run/recovery.md', 'run/new-run.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/recovery.md'),
    tests: ['test/self-check.test.js · run/recovery.md cold resume 合同'],
  },
  {
    id: 'human-handoff',
    contract: '票级升级历史与异常处置证据归编排笔记，升级不是完成',
    docs: ['run/recovery.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/recovery.md'),
    tests: ['test/self-check.test.js · run/recovery.md human handoff / anomaly history 合同'],
  },
  // —— 收尾（run/closing.md）：终审、阶段性交付、用户放弃。
  {
    id: 'final-gate',
    contract: '终审裁决、修复与重审、not_ready 拒正常封账、pre-seal sync',
    docs: ['run/closing.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/closing.md'),
    tests: ['test/self-check.test.js · run/closing.md final repairs / pre-seal sync 合同'],
  },
  {
    id: 'partial-delivery',
    contract: '阶段性交付：保持未封账与续跑证据，只续剩余范围',
    docs: ['run/closing.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/closing.md'),
    tests: ['test/self-check.test.js · run/closing.md partial delivery 合同'],
  },
  {
    id: 'user-abandonment',
    contract: '用户放弃：停子代理、保存成果、abandon 同步成功后封账',
    docs: ['run/closing.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/closing.md'),
    tests: ['test/self-check.test.js · run/closing.md user abandonment 合同'],
  },
  // —— 跨文档契约：一节在循环、一节在收尾（按阅读顺序拼接）。
  {
    id: 'merge-close',
    contract: '串行合并、集成修复纯判定 gate、验证通过后才合并记账与票完成',
    docs: ['run/ticket-loop.md', 'run/closing.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/self-check.test.js · anchor-7、reconciliation before merge accounting'],
  },
  {
    id: 'run-deadlines',
    contract: '每次新派发携带新解析的运行时限、retained resume 零时限、门禁超时独立',
    docs: ['run/new-run.md', 'run/ticket-loop.md', 'run/closing.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/new-run.md'),
    tests: [
      'test/self-check.test.js · every new dispatch carries the freshly resolved run deadline',
      'test/run-timeout-dispatch.test.js · all fresh top-level workflow templates send the latest A → B value',
    ],
  },
  {
    id: 'dispatch-templates',
    contract: '六种派发形态的模板围栏与散文形态（派发边界执行检查的被测面）',
    docs: ['run/ticket-loop.md', 'run/closing.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/run-timeout-dispatch.test.js · fresh templates / retained-resume template'],
  },
  {
    id: 'dispatch-delivery',
    contract: '派发交付形态：脚本先落盘新文件、再以文件路径调用',
    docs: ['run/ticket-loop.md', 'run/closing.md'],
    previous: ['SKILL.md'],
    entry: stageEntry('run/ticket-loop.md'),
    tests: ['test/self-check.test.js · dispatch delivery（issue #9）'],
  },
  // —— 主干常驻契约（角色、记忆层写权、共享修复决策、硬规则）。
  {
    id: 'ledger-discipline',
    contract: '台账/事件流/编排笔记三层写权、对账纪律、封账前同步',
    docs: ['SKILL.md'],
    previous: ['SKILL.md'],
    entry: TRUNK_ENTRY,
    tests: ['test/self-check.test.js · ledger / reconciliation / pre-seal sync 合同'],
  },
  {
    id: 'repair-decisions',
    contract: '修复决策原则：证据与批准范围决定继续或请求用户，无次数停线',
    docs: ['SKILL.md'],
    previous: ['SKILL.md'],
    entry: TRUNK_ENTRY,
    tests: ['test/self-check.test.js · SKILL.md repair decisions use evidence and approved scope'],
  },
  {
    id: 'hard-rules',
    contract: '硬规则：不写 feature code、合并 token、裁决值、单写者、封账不可逆',
    docs: ['SKILL.md'],
    previous: ['SKILL.md'],
    entry: TRUNK_ENTRY,
    tests: ['test/self-check.test.js · anchor-6'],
  },
  // —— agent 定义与只读参考（平台按注册名加载 / 主干在动作前披露）。
  {
    id: 'coder-agent-definition',
    contract: 'coder 定义的 workspace/批准范围/事实报告边界与零报告禁令面',
    docs: ['agents/coder.md'],
    previous: ['agents/coder.md'],
    entry: {
      carriers: ['agents/coder.md'],
      trigger: '每次派发 pi-matt-implement-flow.coder（平台按注册名加载该定义）',
    },
    tests: ['test/self-check.test.js · agents/coder.md follows the brief workspace'],
  },
  {
    id: 'reviewer-agent-definition',
    contract: 'reviewer 定义的角色范围（票据 + spec、只读面、批准/要求修改裁决）与共享协议加载入口',
    docs: ['agents/reviewer.md'],
    previous: ['agents/reviewer.md'],
    entry: {
      carriers: ['agents/reviewer.md'],
      trigger: '每次派发 pi-matt-implement-flow.reviewer（平台按注册名加载该定义）',
    },
    tests: [
      'test/self-check.test.js · reviewer 输入对齐 brief 与机械 gate 证据',
      'test/self-check.test.js · both reviewer definitions load the shared review protocol',
    ],
  },
  {
    id: 'final-reviewer-agent-definition',
    contract: 'final-reviewer 定义的整支范围（跨票检查、延期 findings 处置、三值裁决）与 reviewer=off 前提',
    docs: ['agents/final-reviewer.md'],
    previous: ['agents/final-reviewer.md'],
    entry: {
      carriers: ['agents/final-reviewer.md'],
      trigger: '每次派发 pi-matt-implement-flow.final-reviewer（平台按注册名加载该定义）',
    },
    tests: [
      'test/self-check.test.js · final-reviewer 保留跨票检查与延期 findings 处置',
      'test/self-check.test.js · both reviewer definitions load the shared review protocol',
    ],
  },
  {
    id: 'review-protocol',
    contract:
      '两类 reviewer 的共同只读双轴协议：路径形态、阻塞双轴派发与稳定轴标识、两轴后裁决、最新时限与主仓库配置指针、证据过滤、不跨轴合并排名、升级边界',
    docs: ['scripts/review-protocol.md'],
    previous: ['agents/reviewer.md', 'agents/final-reviewer.md'],
    entry: {
      carriers: ['SKILL.md', 'agents/reviewer.md', 'agents/final-reviewer.md'],
      trigger: 'before dispatching the axes',
    },
    tests: [
      'test/self-check.test.js · shared review protocol is the single axis-spawn contract',
      'test/package-manifest.test.js · tarball 清单闭包',
    ],
  },
  {
    id: 'axis-run-timeout-settings',
    contract: '双轴派发前的运行时限解析规则（reviewer 只读面，主干披露入口）',
    docs: ['scripts/run-timeout-settings.md'],
    previous: ['scripts/run-timeout-settings.md'],
    entry: {
      carriers: ['SKILL.md'],
      trigger: 'before dispatching the axes',
    },
    tests: [
      'test/self-check.test.js · shared review protocol is the single axis-spawn contract',
      'test/package-manifest.test.js · tarball 清单闭包',
    ],
  },
];

function contractEntry(id, registry = CONTRACT_DOCUMENTS) {
  const entry = registry.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`unknown contract id: ${id} — 先在 CONTRACT_DOCUMENTS 登记契约与其权威位置`);
  }
  return entry;
}

// 登记表里的全部权威文档路径（按登记顺序去重）：语料拼接与打包面共用同一份清单。
function contractDocPaths(registry = CONTRACT_DOCUMENTS) {
  const paths = [];
  for (const entry of registry) {
    for (const doc of entry.docs) {
      if (!paths.includes(doc)) paths.push(doc);
    }
  }
  return paths;
}

// 按契约 id 取权威文本：位置由登记表决定，检查器与测试都不认文件名。
function resolveContractText(root, id, { registry = CONTRACT_DOCUMENTS, readText: read = readText } = {}) {
  return contractEntry(id, registry)
    .docs.map((doc) => read(root, doc))
    .join('\n');
}

// 全部登记文档按登记顺序拼接的语料：供全局散文/禁用词扫描使用。
// 导航不靠它裁定——位置与入口另有 checkContractDocLocations。
function resolveContractCorpus(root, { registry = CONTRACT_DOCUMENTS, readText: read = readText } = {}) {
  return contractDocPaths(registry)
    .map((doc) => read(root, doc))
    .join('\n');
}

// 入口语义（启发式，只钉承重点）：同一段里出现路径，且带「读」与「动作前」两个词。
// 释义与「继续条件」的措辞不定型，不做逐字断言；标题、行数、目录数量一概不锁。
// ticket 37：扫描某文档名的**每一段**而不只是第一段——入口之前对同一路径的随口提名
// （例如列出输入指针的清单项）不得誤杀后面那段合格的披露（33-r2 P2 的假红面）。
const ENTRY_READ_CUE = /\b(read|reads|re-reads|rereads|load|loads|consult|consults|follow|follows)\b/i;
const ENTRY_BEFORE_CUE = /\bbefore\b/i;

function paragraphsNaming(text, doc) {
  return text.split(/\n\s*\n/).filter((block) => block.includes(doc));
}

function isDisclosureBlock(block, trigger) {
  return ENTRY_READ_CUE.test(block) && ENTRY_BEFORE_CUE.test(block) && Boolean(trigger) && block.includes(trigger);
}

// 契约位置与披露入口：登记文档与入口文档必须存在；不在 carriers 内的文档必须由 carriers
// 某段以「触发条件 + 动作前读取」披露（含登记表里的 trigger 锚点）；入口文档不得仍指向已搬迁的旧路径。
function checkContractDocLocations(root, {
  registry = CONTRACT_DOCUMENTS,
  isFile = isFileAt,
  readText: read = readText,
} = {}) {
  const problems = [];
  const readOrNull = (doc) => {
    try {
      return read(root, doc);
    } catch {
      return null;
    }
  };
  for (const entry of registry) {
    const carriers = entry.entry?.carriers ?? [TRUNK_DOC];
    for (const doc of [...new Set([...entry.docs, ...carriers])]) {
      if (isFile(root, doc)) continue;
      const kind = entry.docs.includes(doc) ? 'registered contract doc' : 'entry carrier doc';
      problems.push(
        `${kind} is missing: ${doc} (contract ${entry.id}) — 权威位置不存在，搬迁没落地`
      );
    }
  }
  const trunk = readOrNull(TRUNK_DOC);
  if (trunk === null) {
    return [...problems, `trunk doc is unreadable: ${TRUNK_DOC} — 披露入口的入口缺失`];
  }
  const disclosed = new Set();
  for (const entry of registry) {
    const carriers = entry.entry?.carriers ?? [TRUNK_DOC];
    const trigger = entry.entry?.trigger ?? '';
    const where = carriers.join(', ');
    for (const doc of entry.docs) {
      if (carriers.includes(doc) || disclosed.has(doc)) continue;
      const carrierText = carriers.map(readOrNull).filter((text) => text !== null).join('\n');
      const blocks = paragraphsNaming(carrierText, doc);
      if (blocks.length === 0) {
        problems.push(
          `${where} does not disclose ${doc} before the action (contract ${entry.id}) — 非主干权威文档必须由入口文档在动作前披露：触发条件 + 读取入口`
        );
        continue;
      }
      if (blocks.some((block) => isDisclosureBlock(block, trigger))) {
        disclosed.add(doc);
        continue;
      }
      if (!blocks.some((block) => ENTRY_READ_CUE.test(block) && ENTRY_BEFORE_CUE.test(block))) {
        problems.push(
          `${where} entry for ${doc} names the path but not the pre-action read (contract ${entry.id}) — 入口要说明何时读、动作前读，提名不等于披露`
        );
        continue;
      }
      problems.push(
        `${where} entry for ${doc} is missing the trigger condition (contract ${entry.id}): ${trigger || '(未登记)'} — 入口要说明何时读（触发锚点见 CONTRACT_DOCUMENTS.entry.trigger）`
      );
    }
    // 入口目标错误：登记行的每份入口文档（主干 / agent 定义 / 运行参考）都不得仍指向
    // 已搬迁的旧路径。ticket 37 起共同评审协议住在共享运行文档里、入口在 agent 定义内——
    // 只扫主干会漏掉 agent 侧的回流指针，故按 carriers 逐份扫（搬迁后的文档正文不在此列，
    // 它本来就可以正常点名主干）。
    for (const old of entry.previous ?? []) {
      if (entry.docs.includes(old)) continue;
      for (const carrier of carriers) {
        const carrierText = readOrNull(carrier);
        if (carrierText === null || !carrierText.includes(old)) continue;
        problems.push(
          `${carrier} still points at the superseded location ${old} (contract ${entry.id}) — 入口目标错误：权威位置是 ${entry.docs.join(', ')}`
        );
      }
    }
  }
  return problems;
}

// pi.skills 声明面的共用读取：非数组时返回 null（由调用方按各自措辞报错）。
function declaredSkillEntries(manifest) {
  const declared = manifest?.pi?.skills;
  return Array.isArray(declared) ? declared : null;
}

function normalizeDeclaredPath(entry) {
  return String(entry).replace(/^\.\//, '');
}

// 主干就是 pi.skills 注册的技能文件：披露入口自身必须有注册面，否则整套指令不可达。
function checkTrunkSkillRegistration(manifest, { trunk = TRUNK_DOC } = {}) {
  const registered = (declaredSkillEntries(manifest) ?? []).map(normalizeDeclaredPath);
  return registered.includes(trunk)
    ? []
    : [
        `package.json: pi.skills does not register the trunk instruction doc (${trunk}) — 主干是披露入口的入口，未注册即整套指令不可达`,
      ];
}

// 打包面：登记表的每份权威文档都必须在真实 tarball 清单里（安装后可达），
// 不只存在于源码 checkout。
function checkContractDocsPackaged(packedFiles, { registry = CONTRACT_DOCUMENTS } = {}) {
  const problems = [];
  for (const doc of contractDocPaths(registry)) {
    if (packedFiles.includes(doc)) continue;
    const owners = registry.filter((e) => e.docs.includes(doc)).map((e) => e.id).join(', ');
    problems.push(
      `contract doc is not in the tarball: ${doc} (contract ${owners}) — 安装后不可达：files 白名单或目录需覆盖它`
    );
  }
  return problems;
}

// 指令指针闭包（ticket 36）：主干、运行参考与 agent 定义里以 `<this-package>/` 指名的文件
// 必须随包发货 —— 源码树里可达不算，判定只看真实 tarball 的文件清单。
// 只认这套显式前缀：散文里的运行期路径（`.pi/…`）与仓库文档不是包内指针，
// 不按「看起来像路径」扫描，避免把非指针误判成悬空指针。
const PACKAGE_POINTER_RE = /<this-package>\/[A-Za-z0-9._/-]+/g;
const PACKAGE_POINTER_PREFIX = '<this-package>/';

function checkInstructionPointersPackaged(packedFiles, {
  registry = CONTRACT_DOCUMENTS,
  root = PKG_ROOT,
  readText: read = readText,
} = {}) {
  const packed = new Set(packedFiles);
  const problems = [];
  for (const doc of contractDocPaths(registry)) {
    let text;
    try {
      text = read(root, doc);
    } catch {
      continue; // 文档缺位由位置检查报出，不在本检查里重复报
    }
    for (const pointer of text.match(PACKAGE_POINTER_RE) ?? []) {
      const relPath = pointer.slice(PACKAGE_POINTER_PREFIX.length);
      if (packed.has(relPath)) continue;
      problems.push(
        `${doc} points at ${pointer}, which is not in the tarball — 指令指针必须在安装包内可达，不能依赖源码独有文件`
      );
    }
  }
  return problems;
}

// --- 注册不变量：每条返回问题数组，空数组 = 通过 ---
// 不变量 1：pi.skills 声明的每个字面路径都指向真实存在的文件。
function checkSkillFileRegistration(manifest, { isFile = isFileAt } = {}) {
  const problems = [];
  const declared = declaredSkillEntries(manifest);
  if (!declared || declared.length === 0) {
    problems.push('package.json: pi.skills must declare at least one skill path');
    return problems;
  }
  for (const entry of declared) {
    if (typeof entry !== 'string') {
      problems.push(`pi.skills entry is not a string path: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!isFile(entry)) {
      problems.push(`pi.skills entry points at a missing file: ${entry}`);
    }
  }
  return problems;
}

// 不变量 2：pi.subagents.agents 声明的每个路径都指向真实存在的目录。
function checkAgentDirRegistration(manifest, { isDir = isDirAt } = {}) {
  const problems = [];
  const agents = manifest?.pi?.subagents?.agents;
  if (!Array.isArray(agents)) {
    problems.push('package.json: pi.subagents.agents must be an array of paths');
    return problems;
  }
  if (agents.length === 0) {
    problems.push('package.json: pi.subagents.agents is empty');
  }
  for (const entry of agents) {
    if (typeof entry !== 'string') {
      problems.push(`pi.subagents.agents entry is not a string path: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!isDir(entry)) {
      problems.push(`pi.subagents.agents entry points at a missing directory: ${entry}`);
    }
  }
  return problems;
}

// 不变量 3：SKILL.md frontmatter 合法——name 与包名一致、description 存在、模型自动调用禁用。
function checkSkillFrontmatter(frontmatter, packageName) {
  const problems = [];
  if (!frontmatter) {
    return ['SKILL.md has no parseable frontmatter block'];
  }
  if (frontmatter.name !== packageName) {
    problems.push(
      `SKILL.md name "${frontmatter.name ?? '(missing)'}" does not match package name "${packageName}"`
    );
  }
  if (!frontmatter.description) {
    problems.push('SKILL.md frontmatter is missing a description');
  }
  if (frontmatter['disable-model-invocation'] !== 'true') {
    problems.push(
      'SKILL.md frontmatter must set disable-model-invocation: true (skill is orchestrator-only, not for model auto-invocation)'
    );
  }
  return problems;
}

// 不变量 4：三个 agent 文件齐备，且各自以包全名形式声明（name + package，注册名为 `package.name`）。
// 单个 agent 的 frontmatter 校验是纯函数——破坏模拟只喂假想 fixture。
function checkAgentFrontmatter(frontmatter, agentName, packageName) {
  const problems = [];
  if (!frontmatter) {
    return [`missing agent file for "${agentName}"`];
  }
  if (!frontmatter.name) {
    problems.push(`agent "${agentName}" frontmatter is missing its name field`);
  } else if (frontmatter.name !== agentName) {
    problems.push(
      `agent "${agentName}" declares name "${frontmatter.name}", which does not match its file`
    );
  }
  if (!frontmatter.package) {
    problems.push(
      `agent "${agentName}" frontmatter is missing the package field — without it the agent registers under its bare name, colliding with builtin reviewer and user aliases`
    );
  } else if (frontmatter.package !== packageName) {
    problems.push(
      `agent "${agentName}" declares package "${frontmatter.package}", which does not match package name "${packageName}"`
    );
  }
  return problems;
}

function checkAgentRegistration(agentFrontmatter, packageName) {
  const problems = [];
  for (const agentName of AGENT_NAMES) {
    problems.push(...checkAgentFrontmatter(agentFrontmatter[agentName], agentName, packageName));
  }
  return problems;
}

// 不变量 5：test 脚本存在且调用 node 内建测试跑器。
function checkTestScript(manifest) {
  const problems = [];
  const testScript = manifest?.scripts?.test;
  if (!testScript) {
    problems.push('package.json: no "test" script defined');
    return problems;
  }
  if (!/\bnode\b.*--test|--test.*\bnode\b/.test(testScript)) {
    problems.push(
      `package.json: test script "${testScript}" does not invoke node's built-in test runner (--test)`
    );
  }
  return problems;
}

// —— 不变量 6：coder 简报契约的 worktree 现实块（P1-1）。
// 提示词契约没有机械执法点，唯一可自动测的外部行为面是 SKILL.md 的内容不变量：
// Worktree reality 块存在、编排笔记指针退役、软围栏句按用户裁定原句存在。
const WORKTREE_REALITY_HEADING = '## Worktree reality';
const RETIRED_NOTES_POINTER = 'Notes (read if present)';
const SOFT_FENCE_SENTENCE =
  'Other tickets under .scratch/ and anything else in the main repo are context, not scope — never implement them.';

// 内容不变量的共用预处与：按空白归一化后匹配，锁定措辞原句、容忍模板内折行。
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ');
}

function checkCoderBriefWorktreeReality(skillText) {
  const problems = [];
  const normalized = normalizeWhitespace(skillText);
  if (!skillText.includes(WORKTREE_REALITY_HEADING)) {
    problems.push('SKILL.md is missing the "## Worktree reality" block in the coder brief');
  }
  if (skillText.includes(RETIRED_NOTES_POINTER)) {
    problems.push(
      'SKILL.md still points coders at the orchestration notes ("Notes (read if present)") — the pointer is retired: coders never read the orchestration notes'
    );
  }
  if (!normalized.includes(SOFT_FENCE_SENTENCE)) {
    problems.push(
      'SKILL.md is missing the user-adjudicated soft-fence sentence ("…are context, not scope — never implement them") — do not reword or drop it'
    );
  }
  return problems;
}

// —— 不变量 7：Round 0 的环境勘测步骤（P1-1 票 02）——勘测结论属散文，归宿是编排
// 笔记「环境事实」节，永不进事件流。锚点限定在 Round 0 小节内：步骤漂出 Round 0
// 或小节被删时检查照样红；锚点字符串是步骤名与节的定名。
function checkRound0EnvSurvey(skillText) {
  const start = skillText.indexOf('### Round 0');
  if (start === -1) {
    return ['SKILL.md is missing the "### Round 0" section'];
  }
  const end = skillText.indexOf('\n### ', start + 1);
  const normalized = normalizeWhitespace(end === -1 ? skillText.slice(start) : skillText.slice(start, end));
  const missing = ['Environment survey', '环境事实'].filter((s) => !normalized.includes(s));
  return missing.length === 0
    ? []
    : [
        `SKILL.md Round 0 is missing the environment-survey step (read .gitignore, write the 环境事实 section of the orchestration notes; missing anchors: ${missing.join(', ')})`,
      ];
}

// —— 不变量 8：ledger 脚本存在——机械台账协议的唯一写面必须随包交付（ADR-0001）。
const LEDGER_SCRIPT = 'scripts/ledger.js';
function checkLedgerScript({ isFile = isFileAt } = {}) {
  return isFile(LEDGER_SCRIPT)
    ? []
    : [`ledger script missing: ${LEDGER_SCRIPT} — the mechanical-ledger protocol's only write surface`];
}

// —— 不变量 9：pi.extensions 声明与 /matt-flow-config 扩展文件。
// 谓词为 path-only（与兄弟 checker 同形），默认绑定包根。
function checkExtensionRegistration(manifest, {
  isFile = (p) => isFileAt(PKG_ROOT, p),
  isDir = (p) => isDirAt(PKG_ROOT, p),
} = {}) {
  const problems = [];
  const declared = manifest?.pi?.extensions ?? [];
  if (!Array.isArray(declared) || declared.length === 0) {
    problems.push('package.json: pi.extensions must declare at least one extension path');
    return problems;
  }
  for (const entry of declared) {
    if (typeof entry !== 'string') {
      problems.push(`pi.extensions entry is not a string path: ${JSON.stringify(entry)}`);
      continue;
    }
    // 条目可以是文件或目录（pi manifest 两者都合法）；相对路径以包根为基准。
    if (!isFile(entry) && !isDir(entry)) {
      problems.push(`pi.extensions entry points at a missing path: ${entry}`);
    }
  }
  return problems;
}

const EXTENSION_SCRIPT = 'extensions/matt-flow-config.js';
function checkFlowConfigExtension({ isFile = (p) => isFileAt(PKG_ROOT, p) } = {}) {
  return isFile(EXTENSION_SCRIPT)
    ? []
    : [`flow-config extension missing: ${EXTENSION_SCRIPT} — /matt-flow-config is its registration surface`];
}

// —— 不变量 10：超时契约：三个 agent 各自声明 4h run 死线（issue #26）；
// SKILL.md 派发模板的 gate 对象显式 10 分钟（平台常量 120s 不可配，只能 per-entry 覆盖；断锚 1/7 钉死）。
function checkAgentTimeoutFrontmatter(frontmatter, agentName) {
  if (!frontmatter) return [`missing agent file for "${agentName}"`];
  return frontmatter.timeoutMs === String(AGENT_TIMEOUT_MS)
    ? []
    : [
        `agent "${agentName}" frontmatter must declare timeoutMs: ${AGENT_TIMEOUT_MS} (4h run deadline; platform default without it is 30 min), got: ${frontmatter.timeoutMs ?? '(missing)'}`,
      ];
}

function checkAgentTimeouts(agentFrontmatter) {
  const problems = [];
  for (const agentName of AGENT_NAMES) {
    problems.push(...checkAgentTimeoutFrontmatter(agentFrontmatter[agentName], agentName));
  }
  return problems;
}

module.exports = {
  PKG_ROOT,
  AGENT_NAMES,
  TRUNK_DOC,
  CONTRACT_DOCUMENTS,
  contractDocPaths,
  resolveContractText,
  resolveContractCorpus,
  checkContractDocLocations,
  checkTrunkSkillRegistration,
  checkContractDocsPackaged,
  checkInstructionPointersPackaged,
  readPackageJson,
  readText,
  isFileAt,
  isDirAt,
  parseFrontmatter,
  checkSkillFileRegistration,
  checkAgentDirRegistration,
  checkSkillFrontmatter,
  checkAgentFrontmatter,
  checkAgentRegistration,
  checkTestScript,
  checkCoderBriefWorktreeReality,
  checkRound0EnvSurvey,
  LEDGER_SCRIPT,
  checkLedgerScript,
  EXTENSION_SCRIPT,
  checkExtensionRegistration,
  checkFlowConfigExtension,
  AGENT_TIMEOUT_MS,
  GATE_VERIFY_TIMEOUT_MS,
  checkAgentTimeouts,
  checkDispatchRunDeadlines,
  checkCoderDispatchTypedGate,
  checkDispatchSchemaMatchesSource,
  checkFixLoopHandRun,
  checkFixLoopAcceptanceDisabled,
  checkNoReportBans,
  checkGateCommandFlags,
  checkHardRulesRetained,
  checkPureVerdictGateAndRepair,
  checkNoIsolationBriefs,
  checkAxisSpawnContract,
  checkWorkflowScriptDelivery,
  checkDispatchScriptFiles,
  checkPartialDeliveryContinuation,
};

// —— 票 02 断锚：typed gate 派发形态（8 条）。检查器吃 SKILL.md / agents/coder.md
// 文本；schema 副本比对吃票 01 模块导出的真源（调用方 require 后传入），文档副本漂移即红。

function sectionBetween(text, startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  if (s === -1) return null;
  if (!endMarker) return text.slice(s);
  const e = text.indexOf(endMarker, s + startMarker.length);
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

// 断锚共用形状：缺失锚点 / 残留禁用词各自收拢为一处循环，措辞由调用方闭包给定。
function missingAnchors(normalized, anchors, describe) {
  const problems = [];
  for (const anchor of anchors) {
    if (!normalized.includes(anchor)) problems.push(describe(anchor));
  }
  return problems;
}

function presentForbidden(normalized, forbidden, describe) {
  const problems = [];
  for (const token of forbidden) {
    if (normalized.includes(token)) problems.push(describe(token));
  }
  return problems;
}

// —— 运行时限派发合同（issue #26）：每次新派发都携带从配置新读的死线；
// retained resume 保持平台既有的保留合同，永不携带运行时限（接续不是新派发）。
// 五条新派发路径（逐票 coder、逐票评审、修复兑底 fresh coder、集成 fixer、终审 +
// 终审 fixer）逐节钉 `timeoutMs: RUN_TIMEOUT_MS`；模板围栏钉替换指针（指向解析 CLI），
// 防「只改显示值 / 只改 frontmatter 不改派发参数」的漂移。
const RUN_DEADLINE_SYMBOL = 'RUN_TIMEOUT_MS';
const RUN_DEADLINE_CLI = 'flow-config-cli.js run-timeout';
const RUN_DEADLINE_SECTION_ANCHORS = [
  RUN_DEADLINE_CLI,
  RUN_DEADLINE_SYMBOL,
  String(AGENT_TIMEOUT_MS),
  '2147483647',
  'not frozen',
  'retained-child contract',
  '--settings-paths',
  'run-timeout-settings.md',
  'args.timeoutMs',
];
// [name, section start, section end] —— 每节都必须携带新派发死线。
const RUN_DEADLINE_DISPATCH_SECTIONS = [
  ['ticket coder dispatch', '### Each round', '### Verify'],
  ['per-ticket review dispatch', '### Verify each finished ticket', '### Fix loop'],
  ['fix-loop fallback dispatch', '### Fix loop', '### Merge'],
  ['integration fixer dispatch', '### Merge', '### Final gate'],
  ['final gate dispatches', '### Final gate', '## Briefs'],
];

function checkDispatchRunDeadlines(skillText) {
  const problems = [];
  const section = sectionBetween(skillText, '### Run deadline', '## Ledger');
  if (section === null) {
    return ['SKILL.md is missing the "### Run deadline" section (per-dispatch run deadline contract, issue #26)'];
  }
  const normalized = normalizeWhitespace(section);
  problems.push(
    ...missingAnchors(
      normalized,
      RUN_DEADLINE_SECTION_ANCHORS,
      (anchor) => `SKILL.md run-deadline section is missing the anchor: ${anchor}`
    )
  );
  for (const [name, start, end] of RUN_DEADLINE_DISPATCH_SECTIONS) {
    const sub = sectionBetween(skillText, start, end);
    if (sub === null) {
      problems.push(`SKILL.md is missing the "${start}" section`);
      continue;
    }
    if (!normalizeWhitespace(sub).includes(`timeoutMs: ${RUN_DEADLINE_SYMBOL}`)) {
      problems.push(
        `SKILL.md ${name} is missing the run deadline (timeoutMs: ${RUN_DEADLINE_SYMBOL}) — every new dispatch must pass the freshly resolved value (issue #26)`
      );
    }
  }
  // 终审派发是散文面（无围栏），单独钉它的字段清单：只靠节级存在性会被同节的
  // 终审 fixer 围栏拖绿，漏掉终审本身。修复兑底 fresh coder 同理（散文面）。
  const finalSection = sectionBetween(skillText, '### Final gate', '## Briefs');
  if (finalSection !== null && !normalizeWhitespace(finalSection).includes('acceptance: false`, `timeoutMs: RUN_TIMEOUT_MS')) {
    problems.push(
      'SKILL.md final-reviewer dispatch must carry the run deadline in its field list (`acceptance: false`, `timeoutMs: RUN_TIMEOUT_MS`) — issue #26'
    );
  }
  const fixLoopSection = sectionBetween(skillText, '### Fix loop', '### Merge');
  if (fixLoopSection !== null && !normalizeWhitespace(fixLoopSection).includes('acceptance: false, timeoutMs: RUN_TIMEOUT_MS')) {
    problems.push(
      'SKILL.md fix-loop integrity fallback must carry the run deadline in its dispatch shape (acceptance: false, timeoutMs: RUN_TIMEOUT_MS) — issue #26'
    );
  }
  // 逐围栏：新派发块携带死线与替换指针；retained resume 块零运行时限。
  for (const fence of skillText.matchAll(/```js\n([\s\S]*?)\n```/g)) {
    const block = fence[1];
    if (/resume:\s*["'`]/.test(block)) {
      if (/timeoutMs/.test(block)) {
        problems.push(
          'SKILL.md retained-resume snippet must not carry a run deadline — a resume keeps the platform\'s retained-child contract and is never a new dispatch (issue #26)'
        );
      }
      continue;
    }
    if (!/agent:\s*["'`]pi-matt-implement-flow\./.test(block)) continue;
    if (!block.includes(`timeoutMs: ${RUN_DEADLINE_SYMBOL}`)) {
      problems.push(
        `SKILL.md fresh-dispatch template is missing \`timeoutMs: ${RUN_DEADLINE_SYMBOL}\` on its dispatch entry (issue #26)`
      );
    }
    if (!block.includes(RUN_DEADLINE_CLI)) {
      problems.push(
        `SKILL.md fresh-dispatch template lost the substitution pointer (${RUN_DEADLINE_CLI}) — the entry value must be the freshly resolved deadline, not a copy of the default (issue #26)`
      );
    }
  }
  return problems;
}

// —— 断锚 1：票据 coder 派发块为 typed gate JSON 形态；acceptance 对象（非 false）
// 与 outputSchema 不再出现于派发面（平台互斥铁律：结构化输出源唯一）。
function checkCoderDispatchTypedGate(skillText) {
  const section = sectionBetween(skillText, '### Each round', '### Verify');
  if (section === null) return ['SKILL.md is missing the "### Each round" section'];
  const normalized = normalizeWhitespace(section);
  const problems = missingAnchors(
    normalized,
    [
      'gate: {',
      'output: "json"',
      `timeoutMs: ${GATE_VERIFY_TIMEOUT_MS}`,
      'mechanical-report.js',
      'required: ["headSha", "testResult", "changedFiles", "validationOutput"]',
    ],
    (anchor) => `SKILL.md coder dispatch is missing the typed-gate anchor: ${anchor}`
  );
  // 旧形状只在派发代码块内禁用——解释散文仍可点名互斥铁律。
  const fence = section.match(/```js\n([\s\S]*?)\n```/);
  if (!fence) {
    problems.push('SKILL.md coder dispatch carries no fenced ```js dispatch block');
  } else {
    const block = normalizeWhitespace(fence[1]);
    for (const pattern of [/acceptance\s*:\s*\{/, /outputSchema/, /report\s*:\s*"on"/, /verify\s*:\s*\[/]) {
      if (pattern.test(block)) {
        problems.push(
          `SKILL.md coder dispatch still carries the old dispatch shape (${pattern}) — acceptance objects and outputSchema are retired from the dispatch face`
        );
      }
    }
    // 派发块是待复制执行的 JS：包在 async 函数里必须可解析，大括号失衡即红。
    try {
      new vm.Script(`async function __dispatch__() {\n${fence[1]}\n}`);
    } catch (e) {
      problems.push(`SKILL.md coder dispatch \`\`\`js block is not parseable JS (${e.message}) — the dispatch copy must stay executable`);
    }
  }
  return problems;
}

// —— 断锚 2：schema 副本与票 01 真源逐字一致（调用方 require 机械报告模块导出后传入）。
function extractFencedJsonCopy(text) {
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return { error: 'no fenced ```json schema copy' };
  try {
    return { doc: JSON.parse(m[1]) };
  } catch (e) {
    return { error: `fenced \`\`\`json schema copy is not valid JSON: ${e.message}` };
  }
}

function checkDispatchSchemaMatchesSource(skillText, source) {
  const { doc, error } = extractFencedJsonCopy(skillText);
  if (error) {
    return [
      `SKILL.md carries ${error} — the dispatch schema copy must stay verbatim-identical to scripts/mechanical-report.js`,
    ];
  }
  const problems = [];
  if (JSON.stringify(doc) !== JSON.stringify(source.schema)) {
    problems.push(
      'SKILL.md dispatch schema copy drifted from the ticket-01 source (scripts/mechanical-report.js REPORT_SCHEMA) — the copy must stay verbatim-identical'
    );
  }
  const names = (source.fields ?? []).map((f) => f.name);
  if (JSON.stringify(doc.required ?? null) !== JSON.stringify(names)) {
    problems.push(
      `SKILL.md dispatch schema required list does not match the source field table [${names.join(', ')}]`
    );
  }
  return problems;
}

// —— 断锚 3：修复轮 = 编排者在 coder 保留 worktree 手跑同一条脚本命令
//（stdout 即该轮报告、退出码即该轮 gate；--base 恒为票基点；零报告职责）。
function checkFixLoopHandRun(skillText) {
  const section = sectionBetween(skillText, '### Fix loop', '### Merge');
  if (section === null) return ['SKILL.md is missing the "### Fix loop" section'];
  const normalized = normalizeWhitespace(section);
  const problems = missingAnchors(
    normalized,
    [
      'mechanical-report.js',
      '--base',
      'retained worktree',
      "stdout is that round's report",
      "exit code is that round's gate",
    ],
    (anchor) => `SKILL.md fix loop is missing the hand-run anchor: ${anchor}`
  );
  problems.push(
    ...presentForbidden(
      normalized,
      [
        'acceptanceReport',
        'structured_output',
        'outputSchema',
        'stored acceptance contract',
        'treat the result as the gate',
      ],
      (token) => `SKILL.md fix loop still carries the old fix-loop wording: ${token}`
    )
  );
  return problems;
}

// —— 断锚 4（issue #7 后的负空间裁定，ADR-0008 补记二）：简报与 coder 定义**不得**携带
// 报告禁令（No work reports / No handwritten reports / No report duties，任意大小写），
// 也不得复述平台表单义务（识别句 "that duty comes first"）——报告/表单职责单源归平台
// system prompt。理由：本流程承重输出全走结构化通道（git 真相、手跑门禁、context
// pointer、评审结构化 verdict），散文报告无机械消费者；禁令与平台 fenced
// `acceptance-report` 要求构成双指令冲突（#7 的死因），且首轮门禁证据链经过该表单
// （缺失则门禁在执行前被跳过，见 ADR-0008 补记一事实①），复述禁令直接威胁首轮门禁。
// 同时钉死砍禁令的边界：修复简报的裁决来源事实句与两句承重收尾语——它们一丢，砍禁令
// 就失守（模型自封门禁 / 编排者取不到 SHA / 门禁卡不住漏提交）。旧合同通道词
// （acceptanceReport / structured_output / outputSchema / SIBLING /
// ## Acceptance Contract）两侧同表禁用。
const BAN_PHRASES = ['no work reports', 'no handwritten reports', 'no report duties'];
const FORM_DUTY_RESTATED = 'that duty comes first';
const FIX_VERDICT_SOURCE = 'hand-runs the gate for this round';
const LOAD_BEARING_SENTENCES = [
  'by context pointer',
  'a dirty tree or an empty diff fails the gate',
];
// 报 SHA 的四套简报逐个钉 "by context pointer"（评审简报不报 SHA，不在其列）。
const SHA_REPORTING_BRIEFS = [
  '### Coder brief',
  '### Fix follow-up',
  '### Integration fixer',
  '### Final fixer',
];
const OLD_CONTRACT_TOKENS = [
  'acceptanceReport',
  'structured_output',
  'outputSchema',
  'SIBLING',
  '## Acceptance Contract',
];
// 五套简报的小节标题（前缀匹配带后缀的实际标题）；措辞不再钉死，只保证模板在位。
const BRIEF_HEADINGS = [
  '### Coder brief',
  '### Reviewer brief',
  '### Fix follow-up',
  '### Integration fixer',
  '### Final fixer',
];

function checkNoReportBans(skillText, coderAgentText) {
  const section = sectionBetween(skillText, '## Briefs', '## Hard rules');
  if (section === null) return ['SKILL.md is missing the "## Briefs" section'];
  const problems = [];
  const normalized = normalizeWhitespace(section);
  problems.push(
    ...presentForbidden(
      normalized,
      OLD_CONTRACT_TOKENS,
      (token) => `SKILL.md briefs still carry a report duty: ${token} — the round's report comes from the mechanical gate, never from the model`
    )
  );
  if (!normalized.includes('commit everything')) {
    problems.push('SKILL.md briefs lost the "commit everything" close-out duty');
  }
  for (const heading of BRIEF_HEADINGS) {
    if (!section.includes(heading)) {
      problems.push(`SKILL.md is missing the "${heading}" brief`);
    }
  }
  // 逐简报钉 "by context pointer"：只查整文件会漏掉单套简报丢失（其服务对象是每次派发）。
  for (let i = 0; i < BRIEF_HEADINGS.length; i++) {
    const heading = BRIEF_HEADINGS[i];
    if (!SHA_REPORTING_BRIEFS.includes(heading)) continue;
    const sub = sectionBetween(section, heading, BRIEF_HEADINGS[i + 1]);
    if (sub === null) continue; // 缺模板已由上面的存在性检查报出
    if (!sub.includes('by context pointer')) {
      problems.push(
        `SKILL.md ${heading.slice(4)} brief lost the load-bearing SHA report ("by context pointer") — 编排者靠它取 worktree/branch/SHA（issue #7）`
      );
    }
  }
  const fixBrief = sectionBetween(section, '### Fix follow-up', '### Integration fixer');
  if (fixBrief !== null && !fixBrief.includes(FIX_VERDICT_SOURCE)) {
    problems.push(
      `SKILL.md Fix follow-up brief lost the verdict-source sentence ("${FIX_VERDICT_SOURCE}") — 砍禁令后这是防模型自封门禁的唯一事实句（issue #7）`
    );
  }
  const targets = [['SKILL.md', skillText]];
  if (coderAgentText !== undefined) {
    targets.push(['agents/coder.md', coderAgentText]);
    problems.push(
      ...presentForbidden(
        normalizeWhitespace(coderAgentText),
        OLD_CONTRACT_TOKENS,
        (token) => `agents/coder.md still carries the old contract wording: ${token}`
      )
    );
  }
  for (const [who, text] of targets) {
    for (const phrase of BAN_PHRASES) {
      if (new RegExp(phrase, 'i').test(text)) {
        problems.push(
          `${who} must not carry a report ban ("${phrase}") — issue #7 负空间裁定：报告职责单源归平台 system prompt，禁令与其构成双指令冲突`
        );
      }
    }
    if (text.includes(FORM_DUTY_RESTATED)) {
      problems.push(
        `${who} must not restate the platform form duty ("${FORM_DUTY_RESTATED} …") — 表单/报告职责单源归平台 system prompt，复述即漂移源（issue #7）`
      );
    }
    for (const anchor of LOAD_BEARING_SENTENCES) {
      if (!text.includes(anchor)) {
        problems.push(
          `${who} lost a load-bearing close-out sentence: "${anchor}" — 报告禁令可砍，这句是编排者取 SHA / 门禁卡提交的通道（issue #7）`
        );
      }
    }
  }
  return problems;
}

// —— issue #7 断锚：修复轮 resume 与完整性兜底 fresh coder 一律 `acceptance: false`。
// 平台事实：retained resume 继承首轮验收契约（verified + attestation 报告义务），报告
// 缺失时平台在任何核查执行前就把 run 判为「Structured acceptance report not found」——gate 在
// resume 上被平台拒收，兜底 fresh coder 也**不**挂 gate（gate 归一化出 verified 并恢复
// 报告义务，正是本 bug 的死因）。两处判定都只剩编排者手跑的机械报告门禁（断锚 3）。
const FIX_ACCEPTANCE_REASON_ANCHOR = "this round's verdict is the hand-run gate";
const FIX_FALLBACK_SHAPE = 'worktree: true, baseRef: "refs/heads/ticket-<NN>", acceptance: false';

function checkFixLoopAcceptanceDisabled(skillText) {
  const section = sectionBetween(skillText, '### Fix loop', '### Merge');
  if (section === null) return ['SKILL.md is missing the "### Fix loop" section'];
  const problems = [];
  const fence = section.match(/```js\n([\s\S]*?)\n```/);
  const block = fence ? fence[1] : '';
  if (!block) {
    problems.push('SKILL.md fix loop carries no fenced ```js resume snippet');
  } else {
    if (!/resume:/.test(block)) {
      problems.push('SKILL.md fix-loop resume snippet lost the `resume` dispatch');
    }
    if (!/acceptance:\s*false/.test(block)) {
      problems.push(
        'SKILL.md fix-loop resume snippet must carry `acceptance: false` (issue #7) — a retained resume inherits the first round\'s acceptance contract and rejects a committed fix for a report the model never writes'
      );
    }
    if (/\bgate\s*:/.test(block)) {
      problems.push(
        'SKILL.md fix-loop resume snippet must not carry a gate — the platform rejects a gate on a retained resume'
      );
    }
  }
  const normalized = normalizeWhitespace(section);
  if (!normalized.includes(FIX_ACCEPTANCE_REASON_ANCHOR)) {
    problems.push(
      `SKILL.md fix loop must say why the resume carries \`acceptance: false\` (issue #7 anchor: "${FIX_ACCEPTANCE_REASON_ANCHOR}")`
    );
  }
  if (!normalized.includes(FIX_FALLBACK_SHAPE)) {
    problems.push(
      `SKILL.md integrity fallback must dispatch the fresh coder as \`${FIX_FALLBACK_SHAPE}\` (issue #7) — acceptance off, verdict from the hand-run gate`
    );
  }
  if (!/\bno gate\b/i.test(normalized)) {
    problems.push(
      'SKILL.md integrity fallback must state it carries no gate (a gate restores the report duty that falsely rejects a finished fix)'
    );
  }
  if (/\bgate\s*:\s*\{/.test(normalized)) {
    problems.push(
      'SKILL.md fix loop must not dispatch any gate object — fix rounds are judged by the hand-run gate only'
    );
  }
  return problems;
}

// —— 断锚 5：每条机械报告 gate 命令都带 --base 与 --test-command。
// 只收以 node <this-package>/scripts/mechanical-report.js 起手的命令行——散文提及不算命令；
// shell 续行（行尾反斜杠）先拼成逻辑行再判定，跨行命令不误报。
function checkGateCommandFlags(skillText) {
  const logicalLines = skillText.replace(/\\\r?\n[ \t]*/g, ' ').split('\n');
  const commands = [];
  for (const line of logicalLines) {
    commands.push(...(line.match(/node <this-package>\/scripts\/mechanical-report\.js[^\n]*/g) ?? []));
  }
  if (commands.length === 0) {
    return [
      'SKILL.md carries no mechanical-report gate command (`node <this-package>/scripts/mechanical-report.js …`)',
    ];
  }
  const problems = [];
  for (const cmd of commands) {
    problems.push(
      ...missingAnchors(cmd, ['--base', '--test-command'], (flag) => `SKILL.md gate command is missing ${flag}: ${cmd.trim()}`)
    );
  }
  return problems;
}

// —— 断锚 6：既有硬规则断言保留（改写不得顺手删硬规则）。
function checkHardRulesRetained(skillText) {
  const section = sectionBetween(skillText, '## Hard rules', null);
  if (section === null) return ['SKILL.md is missing the "## Hard rules" section'];
  const normalized = normalizeWhitespace(section);
  return missingAnchors(
    normalized,
    [
      'ticket-NN',
      'blocked',
      'approved',
      'Never hand-write or edit the ledger or the event stream',
    ],
    (anchor) => `SKILL.md hard rules lost an existing clause: ${anchor}`
  );
}

// —— 断锚 7：无隔离修复者（集成修复者 / 终审修复者）挂纯判定 gate
//（command + timeoutMs，无 output/schema）；继续/暂停归共享修复原则，不守护旧次数停线。
function checkPureVerdictGateAndRepair(skillText) {
  const problems = [];
  const pureGateAnchor = `gate: { command: "<testCommand>", timeoutMs: ${GATE_VERIFY_TIMEOUT_MS} }`;
  for (const [name, start, end] of [
    ['merge/integration', '### Merge', '### Final gate'],
    ['final gate', '### Final gate', '## Briefs'],
  ]) {
    const section = sectionBetween(skillText, start, end);
    if (section === null) {
      problems.push(`SKILL.md is missing the "${start}" section`);
      continue;
    }
    const normalized = normalizeWhitespace(section);
    if (!normalized.includes(pureGateAnchor)) {
      problems.push(`SKILL.md ${name} section is missing the pure-verdict gate: ${pureGateAnchor}`);
    }
    for (const body of [...normalized.matchAll(/gate:\s*\{([^}]*)\}/g)].map((m) => m[1])) {
      if (/output|schema/.test(body)) {
        problems.push(`SKILL.md ${name} pure-verdict gate must not carry output/schema: gate: {${body}}`);
      }
    }
    if (!normalized.includes('Repair decisions')) {
      problems.push(`SKILL.md ${name} section is missing the Repair decisions pointer`);
    }
    if (/two consecutive reds/i.test(normalized)) {
      problems.push(`SKILL.md ${name} section still carries the retired two-red stop rule`);
    }
  }
  return problems;
}

// 阶段性交付的最小文本自检：只检查续跑约定在场，不裁定模型是否遵守。
function checkPartialDeliveryContinuation(skillText) {
  const section = sectionBetween(skillText, '### Partial delivery', '### User abandonment');
  if (section === null) return ['SKILL.md is missing the "### Partial delivery" section'];
  return missingAnchors(
    normalizeWhitespace(section),
    ['unsealed', 'tracker snapshot', 'findings', 'final sync', 'Cold resume'],
    (anchor) => `SKILL.md partial delivery is missing the continuation anchor: ${anchor}`
  );
}

// —— 断锚 8：第五套无隔离修复简报存在且零报告职责；无隔离简报只剩修复收尾职责。
function checkNoIsolationBriefs(skillText) {
  const briefs = sectionBetween(skillText, '## Briefs', '## Hard rules');
  if (briefs === null) return ['SKILL.md is missing the "## Briefs" section'];
  const problems = [];
  const normalized = normalizeWhitespace(briefs);
  if (!normalized.includes('five brief templates')) {
    problems.push(
      'SKILL.md path rule still counts four brief templates — the no-isolation final-fixer brief is the fifth'
    );
  }
  if (!briefs.includes('### Final fixer (no isolation)')) {
    problems.push('SKILL.md is missing the fifth brief: "### Final fixer (no isolation)"');
  }
  for (const [name, start, end] of [
    ['integration fixer', '### Integration fixer', '### Final fixer'],
    ['final fixer', '### Final fixer', '## Hard rules'],
  ]) {
    const sub = sectionBetween(briefs, start, end);
    if (sub === null) {
      problems.push(`SKILL.md is missing the "${start}" brief`);
      continue;
    }
    const subNorm = normalizeWhitespace(sub);
    for (const token of ['acceptanceReport', 'structured_output', 'outputSchema', 'Acceptance Contract']) {
      if (subNorm.includes(token)) {
        problems.push(`SKILL.md ${name} brief still carries a report duty: ${token}`);
      }
    }
    if (!subNorm.includes('commit on the feature branch')) {
      problems.push(`SKILL.md ${name} brief lost the close-out duty: commit on the feature branch`);
    }
  }
  return problems;
}

// issue #6：双轴派发契约必须是「阻塞调用 + 稳定 key + 不得提前收尾」。
// async: true 会让调用立即返回，reviewer 可在轴未完时收尾并无 structured_output
// 收场；key 是 runs.all 的硬契约（缺 key 整个调用被拒）。三者缺一即回归。
function checkAxisSpawnContract(agentText) {
  const problems = [];
  if (!agentText.includes('timeoutMs: RUN_TIMEOUT_MS')) {
    problems.push('axis-spawn args must carry `timeoutMs: RUN_TIMEOUT_MS` resolved immediately before axis dispatch');
  }
  if (!agentText.includes('Run timeout settings')) {
    problems.push('axis-spawn must use the brief\'s main-repo settings paths');
  }
  if (!agentText.includes('run-timeout-settings.md')) {
    problems.push('axis-spawn must point to the fresh timeout resolution rules');
  }
  if (!/async:\s*false/.test(agentText)) {
    problems.push('axis-spawn must pin `async: false` (a blocking call); `async: true` can outlive the reviewer');
  }
  if (/async:\s*true/.test(agentText)) {
    problems.push('axis-spawn must not instruct `async: true`');
  }
  if (!/\bkey\b/i.test(agentText) || !agentText.includes('standards') || !agentText.includes('spec')) {
    problems.push('axis items must carry the stable keys `standards` and `spec` (runs.all rejects keyless items)');
  }
  if (!/never end (your|the) turn/i.test(agentText)) {
    problems.push('must state the never-end-your-turn-while-an-axis-runs rule');
  }
  return problems;
}

// —— 派发交付形态（issue #9）：workflow 脚本一律「写入文件 → 文件路径调用」。
// 围栏形态（同一回复的 ```js workflow 块 + 布尔 workflow: true）对模型调用不可靠：
// `workflow` 走 === true 严格判别（模型系统性传字符串 "true"），围栏块又必须与工具
// 调用同回复（模型常拆到不同消息 → found 0 fenced blocks）；旧 API workflowScript /
// workflowScriptPath 已对模型关闭。唯一可靠交付是脚本文件路径（值含 / 即按文件加载）。
const SCRIPT_FILE_FORM = /workflow:\s*["'`][^"'`]*[\\/][^"'`]*["'`]/;
const RETIRED_DISPATCH_TOKENS = [
  { re: /\bworkflow:\s*true\b/, name: 'the reply-fenced form (`workflow: true`)' },
  { re: /```js workflow/, name: 'the reply-fenced form (a same-reply ```js workflow block)' },
  { re: /\bworkflowScript\b/, name: 'the removed `workflowScript` API' },
  { re: /\bworkflowScriptPath\b/, name: 'the removed `workflowScriptPath` API' },
];

function checkWorkflowScriptDelivery(text) {
  const problems = [];
  for (const { re, name } of RETIRED_DISPATCH_TOKENS) {
    if (re.test(text)) {
      problems.push(`dispatch wording still carries ${name} — deliver workflow scripts as files (workflow: "<path>.js")`);
    }
  }
  if (!SCRIPT_FILE_FORM.test(text)) {
    problems.push('no script-file dispatch form found (workflow: "<path>.js") — every workflow dispatch must call a script file');
  }
  return problems;
}

// —— SKILL.md 派发脚本的落盘纪律：脚本先写进运行期目录的新文件（审计报告按文件恢复
// 任务书；一次调用一个新文件，不复用不覆盖），再以文件路径调用。
function checkDispatchScriptFiles(skillText) {
  const normalized = normalizeWhitespace(skillText);
  return missingAnchors(
    normalized,
    ['a new file', '/wf/'],
    (anchor) => `SKILL.md is missing the dispatch-script file discipline anchor: ${anchor} (write each dispatch script to a new file under .pi/matt-implement/<slug>/wf/, then call it by path)`,
  );
}
