#!/usr/bin/env node
'use strict';

// ledger CLI — 机械台账的子命令（唯一写面）。
// 分层：薄 IO 壳（git/tracker CLI/票文件读取 + 原子写）+ 纯判定核心（ledger-schema / ledger-core /
// tracker-set-core / snapshot-core / sync-read-core / sync-planning-core）；
// tracker 收发一律按契约命令模板执行的通用 driver（tracker-driver，票 05）——
// 本层零 per-tracker 分支与零硬编码 argv。
//
//   add <type>   校验 → 盖时间戳/序号/HEAD 锚点 → append 事件流 → 自动再生台账
//   build        由事件流 + 真相层全量再生台账（全文打到 stdout，供 compaction 恢复读取）
//   check        账实差异核验；非零退出码 = 有差异，逐条列出
//
// 事件流（events.jsonl）与台账（ledger.md）同置 --runtime-dir（被 gitignore 的编排运行时状态目录）。
// 台账写入一律临时文件 + 原子替换——中断不留撕裂文件。无任何绕过校验的旗标；
// 与校验器分歧时的唯一逃生通道：add anomaly --note "..." 并停下上报。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schema = require('./ledger-schema');
const core = require('./ledger-core');
const contractCore = require('./tracker-contract-core');
const driver = require('./tracker-driver');
const snapshot = require('./snapshot-core');
const tset = require('./tracker-set-core');
const syncCore = require('./tracker-sync-core');
const syncread = require('./sync-read-core');
const syncplan = require('./sync-planning-core');

const EVENTS_FILE = 'events.jsonl';
const LEDGER_FILE = 'ledger.md';
// tracker 快照（票 05，ADR-0003）：snapshot-init 的落盘根——与 local tracker 的
// spec 同目录 issues/ 枚举约定同构（dirname(spec)/issues/），账本枚举零形态分叉。
const SNAPSHOT_DIR = 'tracker';

const USAGE = `pi-matt-implement-flow ledger — 机械台账（真相层 / 事件流 / 派生台账三层，LLM 永不手写台账）

用法:
  node ledger.js init --runtime-dir <dir> --branch <branch> --branch-base <base> --baseline-sha <sha>
               --spec <spec 文件路径> --test-command <cmd> [--reviewer on|off] [--max-fix-rounds N]
               [--max-concurrent N] [--tickets 01,02,1042]
  node ledger.js add <type> --runtime-dir <dir> [--flag value ...]
  node ledger.js build --runtime-dir <dir>
  node ledger.js check --runtime-dir <dir>

init（run 初始化，票 04——契约驱动）:
  # Round 0 的第一条（也是唯一一条可以入账的 init）:tracker 不再手工声明——按目标仓库
  # 的 setup 产物（docs/agents/issue-tracker.md + triage-labels.md）自动识别 tracker 并
  # 选中契约预设；识别结果（tracker 字段）照旧入账，事件格式零迁移。
  # 缺 setup 产物 → 指引运行 /setup-matt-pocock-skills；范本认不出 → 贴出「仅支持
  # local / github / gitlab 三种」并列出支持面——两者都是显式停下，不猜测不降级。
  # --tracker 旗标已废除（配置单源是 setup 产物，不再重复声明）。票集边界 --tickets、
  # 流程形态快照 --reviewer/--max-fix-rounds/--max-concurrent 与既往 init 同参同对：
  # 流程形态冻结后校验按其执行；票集边界冻结后，边界外的票号记账被拒。

事件类型与参数集 (add):
  dispatch    --ticket --key --run-id [--worktree] [--note]
  settled     --ticket --round --head-sha [--worktree] [--gate] [--note]
  verdict     --ticket --round --verdict(approved|changes_requested) [--findings] [--rev-run-id] [--note]
  fix         --ticket --fix-no --key --resume-run-id [--note]
  merge       --ticket --head-sha --merge-sha [--note]
  escalate    --ticket [--note]
  final       --final-verdict(ready|ready_with_fixes|not_ready) --run-id <runId> [--findings] [--note]
              # 整分支终审裁决（run 级，无 ticket）；runId 必选——事件驱动审计与平台证据核验的锚点。
              # 多轮终审 = 多条事件（无去重，一律以最新裁决为准）；无 merge 事件时警告入账。
  anomaly     --note [--ref-seq N]
              # refSeq 指向本异常所针对/更正的既有事件序号：须为正整数、小于当前序号，
              # 且该序号的事件已入账；违规拒绝（无绕过旗标）。指不到对应事件时去掉 --ref-seq 重记。
  pr          --state(opened-draft|ready) [--url] [--note]
  close       [--note]

快照初始化 (snapshot-init，契约驱动——tracker 由 setup 产物自动识别):
  snapshot-init --spec <契约声明的 spec 引用形态> [--tickets 01,02,1042]
              # init 阶段一条命令：拉取 spec 与全部工单（含原生 sub-issues 与 blocked_by
              # 依赖边，能力由契约声明），转写为 tracker 快照
              # （<runtime-dir>/tracker/spec.md 带 Source: 行 + tracker/issues/<号>-<slug>.md，
              # 与 local 票文件同构，账本零形态分叉）。票集边界此后由契约兜底链驱动；
              # spec 母票带 Type: spec 豁免标记。快照已存在时拒绝执行（续跑保护：既有内容
              # 零覆盖，续跑绝不重拉）；取数（issue 集合/sub-issues/依赖边/仓库标识探测）全都
              # 走契约命令模板（票 05 通用 driver）——失败报错清晰、
              # 不产生半成品（临时目录整体改名，全部成功才落盘）。local 契约无需快照。
              # 缺 setup 产物 → 指引运行 /setup-matt-pocock-skills，停下不降级。

同步 (sync，封账前、pr --state ready 之前):
  sync [--mode seal|abandon] [--claimant <login>] [--reason <放弃说明>]
              # 把 tracker/ 快照的待推送状态幂等推送到 tracker 本体（票 06；执行 03 的
              # 同步规划）。seal（缺省）：合并票关票附 merge SHA、escalate 票留评保持开放、
              # spec 母票收尾关闭；abandon：撤占坑（--claimant）+ 留评说明（--reason）。
              # 幂等键（票 02）：每条同步评论携带隐藏机器 marker
              # \`<!-- matt-implement:<runId>:<kind> -->\`（runId = 本 run 的运行目录名，
              # kind = merge|escalate|closing|abandon；HTML 注释，tracker 上人类不可见）。
              # 重入判定只认 marker：人改写/翻译/追加评论正文后重跑不重复推送；
              # 无 marker 的历史评论（旧形态）视为未同步、照常推送一次。
              # 快照事实来自票文件 ## Comments 节：merge SHA: <sha>、escalate: <原因>；
              # spec.md 的 Comments 节里 closing: <交付指引>（票 07 对齐措辞）。
              # 同步收发为 best-effort 薄 IO（契约命令模板执行）：先拉状态再规划、规划通过后才写入——
              # 拉取失败即整体中止（无半成品推送）；部分失败逐动作报告已完成/未完成，
              # 重跑安全（幂等规划只补未完成的动作）。同步成功后输出清理指引。
              # run 已封账或 PR 已标 ready 时拒绝执行（同步须在两时点之前）。

占坑 (claim，run 的第一个 tracker 写动作，先于快照拉取——ADR-0003 锁实时):
  claim --spec <契约声明的 spec 引用形态>
              # 把 spec 母票认领到 @me（契约 claim 模板执行；tracker 侧的 feature 级并发锁）。
              # 先读状态再写入：他人已在位 → 拒绝并点名在位者（不猜测覆盖他人占坑；
              # 同一占坑者续跑该步幂等可跳过）。进度与合并同步归 sync；封账/放弃时释放。
              # local 契约无 tracker 写面——占坑不存在（票文件即真相层）。

说明:
  init     run 初始化（Round 0 唯一一次）：契约驱动——tracker 从 setup 产物自动识别；
           识别结果（tracker 字段）照旧入账，事件格式零迁移；缺/认不出 setup 产物
           分别指引运行 /setup-matt-pocock-skills / 贴出仅支持三种，停下不降级
  add      记账：脚本盖权威时间戳/单调序号/版本/git HEAD 锚点，append 后自动再生台账
  build    台账再生：四段 markdown（头部/表格/时间线/对账结论），确定性重建
  check    对账：账实差异核验，非零退出码 = 有差异；派发与合并前、compaction 后必跑；
           并对 final 事件的 runId 做 best-effort 平台证据核验（不可核验仅警告，不影响退出码）
  sync     封账前单点同步：快照事实 → 03 规划 → 契约模板幂等执行（同步动作集由能力生成）；
           成功后打印清理指引（快照与 review bundle 清理、findings 与账本三件套留存）
  claim    占坑：spec 母票认领到 @me（契约 claim 模板；先读状态再写入，冲突拒绝）
  时间不由 LLM 提供；自由文本统一 --note；校验拒绝时给出原因，修正后重试；
  与校验器分歧 → add anomaly --note "..." 并停下上报（无任何绕过旗标）。
`;

// --- 输出与退出码 ---

const out = (...lines) => console.log(lines.join('\n'));

// --- 事件流读取 ---

function loadEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return { events: [], degraded: true, loadError: null };
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim());
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      return {
        events: null,
        degraded: false,
        loadError: `事件流第 ${i + 1} 行不是合法 JSON——事件流疑似被手改或损坏；先修复事件流（或向用户上报），再操作`,
      };
    }
  }
  return { events, degraded: false, loadError: null };
}

// 平台会话目录名：--<仓库路径各段以 '-' 连接>--
// （与 audit-report/collect.js 的 sessionDirName 同约定——探测口径同源，避免两处漂移）
function sessionDirName(repoPath) {
  return `--${repoPath.split(path.sep).filter(Boolean).join('-')}--`;
}

// --- 真相层采集（只读）---

function collectTruth({ runtimeDir, events, contract }) {
  fs.mkdirSync(runtimeDir, { recursive: true }); // 首次记账时目录尚不存在；git -C 需要它已存在
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', runtimeDir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], // stderr 一并入管，不污染 stdout 协议面
      }).trim();
    } catch {
      return null;
    }
  };
  const gitOk = (args) => {
    try {
      execFileSync('git', ['-C', runtimeDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  };
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const head = repoRoot ? git(['rev-parse', 'HEAD']) : null;

  const worktrees = [];
  const wtOut = git(['worktree', 'list', '--porcelain']);
  const wtPaths = new Set();
  if (wtOut) {
    for (const line of wtOut.split('\n')) {
      if (line.startsWith('worktree ')) {
        const wt = line.slice('worktree '.length).trim();
        worktrees.push(wt);
        wtPaths.add(wt);
        try {
          wtPaths.add(fs.realpathSync(wt));
        } catch {
          /* 已消失的 worktree 无 realpath */
        }
      }
    }
  }

  const truth = {
    repoRoot,
    head,
    worktrees,
    // worktree 可见性：raw 与 realpath 双向归一（macOS /var ↔ /private/var 等符号链接前缀差异）
    hasWorktree: (p) => {
      if (!p) return false;
      if (wtPaths.has(p)) return true;
      try {
        return wtPaths.has(fs.realpathSync(p));
      } catch {
        return false;
      }
    },
    branchExists: (name) => gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]),
    shaExists: (sha) => !!sha && gitOk(['cat-file', '-e', `${sha}^{commit}`]),
    isAncestor: (a, b) => !!a && !!b && gitOk(['merge-base', '--is-ancestor', a, b]),
    commitMessage: (sha) => (sha ? git(['log', '-1', '--format=%B', sha]) : null),
    fileExists: (p) => !!repoRoot && fs.existsSync(path.resolve(repoRoot, p)),
    mergesWithTokens: null,
    remoteUrl: git(['remote', 'get-url', 'origin']),
    tickets: [],
    ticketsWarning: null,
  };

  // 未入账合并扫描：依赖硬规则「merge 提交信息必须含 ticket-NN 令牌」（NN 位数不限，ADR-0004：
  // tracker 原生编号）；提取后经 normalizeTicket 归一，与事件侧票号同过单一转换点。
  // 无 init 基线 → null（降级）
  const init = events.find((e) => e.type === 'init');
  if (init?.payload?.baselineSha && head) {
    const out = git(['log', `${init.payload.baselineSha}..HEAD`, '--merges', '--format=%H%x09%s']) ?? '';
    truth.mergesWithTokens = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split('\t');
        const tokens = [...String(subject).matchAll(/ticket-(\d+)/g)].map((m) =>
          schema.normalizeTicket(m[1])
        );
        return { sha, subject, tokens };
      });
  }

  // 终审平台证据探测（check 的 best-effort 核验；尊重 HOME，便于黑盒测试指向伪造 fixture）。
  // 约定与审计工具同源：<HOME>/.pi/agent/sessions/--<仓库路径各段以 '-' 连接>--/subagent-artifacts/
  // 下以 runId 开头的产物文件组（_meta.json / _output.md / _transcript.jsonl）。
  // 主路径按仓库路径推导；推导不中时与审计工具同规则做全局兜底扫描。全程只读。
  truth.finalEvidence = (runId) => {
    const root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
    const dirs = [];
    if (repoRoot) {
      const primary = path.join(root, sessionDirName(repoRoot), 'subagent-artifacts');
      if (fs.existsSync(primary)) dirs.push(primary);
    }
    if (!dirs.length) {
      try {
        for (const d of fs.readdirSync(root)) {
          const cand = path.join(root, d, 'subagent-artifacts');
          if (fs.existsSync(cand)) dirs.push(cand);
        }
      } catch {
        /* 会话根不可读 → 不可核验（调用方按警告处理，不失败） */
      }
    }
    for (const dir of dirs) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.startsWith(runId));
        if (files.length) return { found: true, dir, files };
      } catch {
        /* 目录不可读，试下一个 */
      }
    }
    return { found: false, dir: dirs[0] ?? null };
  };

  // 收尾面 PR 状态：best-effort，不可用 → null（台账标 unknown，不编造）。
  // 票 05 契约化：探测命令用契约 prProbe 模板（通用 driver 执行）；契约由 setup 产物
  // 解析在调用点传入（不重复判型，判型失败不护道——台账标 unknown，不编造）。
  truth.prProbe = (branch) => {
    if (!contract || !contract.commands?.prProbe) return null;
    try {
      const raw = driver.runCommand(contract, 'prProbe', { branch }, { runOptions: { timeout: 10000 } });
      const arr = JSON.parse(raw);
      if (!arr.length) return 'none';
      if (arr[0].isDraft) return 'opened-draft';
      return arr[0].state === 'OPEN' ? 'ready' : null;
    } catch {
      return null;
    }
  };

  // 票文件枚举（spec 同目录 issues/）：local 票文件与 tracker 快照（tracker=github 的
  // snapshot-init 产物）同一约定——dirname(spec)/issues/，账本零形态分叉；快照票文件
  // 即"票文件"（spec 明文，ADR-0003），对账与封账门吃同一真相层。
  const enumerateIssues = (specAbsPath) => {
    const issuesDir = path.join(path.dirname(specAbsPath), 'issues');
    if (!fs.existsSync(issuesDir)) {
      truth.ticketsWarning = `issues 目录不存在：${issuesDir}——票集枚举降级`;
      return;
    }
    for (const name of fs.readdirSync(issuesDir).filter((n) => n.endsWith('.md')).sort()) {
      const m = /^(\d+)/.exec(name);
      if (!m) continue;
      const num = schema.normalizeTicket(m[1]);
      const parsed = parseTicketFile(fs.readFileSync(path.join(issuesDir, name), 'utf8'), { contract });
      truth.tickets.push({ num, file: name, ...parsed });
    }
    // 票号数值排序（ADR-0004）：混位数下文件名字典序会乱（'1042-…' 排在 '02-…' 前面），
    // 真相层枚举统一按数值序供给下游（票表、对账差异、封账阻塞清单）。
    truth.tickets.sort((a, b) => Number(a.num) - Number(b.num));
  };

  // 无 init 事件的降级再生与有 init 的枚举共用同一约定：spec 引用定位到
  // dirname(spec)/issues/（local 与快照同构，tracker 形态不改变枚举——零形态分叉）。
  if (!init) {
    // 事件流丢失的降级再生：按 tracker 约定从运行时目录 slug 反查 .scratch/<slug>/spec.md
    const slug = path.basename(runtimeDir);
    const fallbackSpec = repoRoot ? path.join(repoRoot, '.scratch', slug, 'spec.md') : null;
    if (fallbackSpec && fs.existsSync(fallbackSpec)) {
      enumerateIssues(fallbackSpec);
    } else {
      truth.ticketsWarning = '无 init 事件且按约定找不到 .scratch/<slug>/spec.md——票集降级为空';
    }
  } else if (!truth.fileExists(init.payload.spec)) {
    truth.ticketsWarning = `spec 文件不存在：${init.payload.spec}——票集枚举降级`;
  } else {
    enumerateIssues(path.resolve(repoRoot, init.payload.spec));
  }
  return truth;
}

// 票文件解析：Status / Type / Blocked by 行 + 首题（兼容 **Status:** x 与 Status: x 两种写法）。
// Status 读取过状态词表（票 03，与转写同一张契约词表）：canonical 五名恒可读、自定义
// label 串映射进角色；contract 由调用方注入（票 04 接线），缺省 = canonical 默认——
// local 模式现状行为零变化。
function parseTicketFile(text, { contract } = {}) {
  const grab = (label) => {
    const m = new RegExp(`^\\**\\s*${label}\\s*:\\**\\s*(.*)$`, 'mi').exec(text);
    return m ? m[1].replace(/\*+/g, '').trim() : null;
  };
  const h1 = /^#\s+(.+)$/m.exec(text);
  const title = h1 ? h1[1].trim().replace(/^\d+\s*[:：]\s*/, '') : null;
  const blockedRaw = grab('Blocked by');
  const blockedBy =
    blockedRaw && blockedRaw !== '—' ? (blockedRaw.match(/\d+/g) ?? []).map(schema.normalizeTicket) : [];
  const type = grab('Type');
  return {
    title,
    status: syncCore.normalizeStatus(grab('Status'), { contract }),
    type: type ? type.trim().toLowerCase() : null,
    blockedBy,
  };
}

// --- 台账原子写 ---

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// --- 子命令 ---

// init 子命令（票 04）：契约驱动的 run 初始化——Round 0 的首条（也是唯一一条）init。
// 与 add 的唯一区分：tracker 不是旗标而是识别结果——setup 产物判型选契约预设；
// 事件里 tracker 字段照旧（零迁移），载荷参数集与既往 init 事件完全一致。
// 识别先于一切写入（零半成品）：缺 setup 产物 → 指引运行 /setup-matt-pocock-skills；
// 范本认不出 → 「仅支持三种」，都停下不猜测不降级；词表违约指到文件+行+列+期望。
const INIT_REQUIRED = ['branch', 'branchBase', 'baselineSha', 'spec', 'testCommand'];
const INIT_OPTIONAL = ['reviewer', 'maxFixRounds', 'maxConcurrent', 'tickets'];


// setup 产物 → tracker（契约驱动）：判型输入是 repo 内的两份上游文档。
// 读取是纯 IO；解析/判型/词表全部在 tracker-contract-core（票 01，接缝①），
// 本层只做「读文件 → 调解析 → 贴错误」的转接，不重复任何判型逻辑。
const TRACKER_DOC = 'docs/agents/issue-tracker.md';
const TRIAGE_DOC = 'docs/agents/triage-labels.md';

function resolveTrackerFromRepo(repoRoot) {
  const trackerPath = path.resolve(repoRoot, TRACKER_DOC);
  const triagePath = path.resolve(repoRoot, TRIAGE_DOC);
  if (!fs.existsSync(trackerPath)) {
    return {
      ok: false,
      tracker: null,
      errors: [
        `缺少 issue tracker setup 产物：${TRACKER_DOC}——先运行 /setup-matt-pocock-skills 落盘 setup 产物，再重跑`,
      ],
      warnings: [],
    };
  }
  const issueTracker = fs.readFileSync(trackerPath, 'utf8');
  const triageLabels = fs.existsSync(triagePath) ? fs.readFileSync(triagePath, 'utf8') : null;
  const resolved = contractCore.resolveContract({
    issueTracker,
    triageLabels,
    issueTrackerFile: TRACKER_DOC,
    triageLabelsFile: TRIAGE_DOC,
  });
  if (!resolved.ok) {
    return { ok: false, tracker: null, contract: null, errors: [...resolved.errors], warnings: [...resolved.warnings] };
  }
  // 票 05：契约对象随识别结果一并回传（快照/同步的命令模板、兜底链、形态、拉取上限
  // 的唯一来源）——init 只用 tracker 字段，其余消费方不再重复判型。
  return { ok: true, tracker: resolved.contract.tracker, contract: resolved.contract, warnings: [...resolved.warnings] };
}

function cmdInit({ runtimeDir, rest }) {
  const errors = [];
  const collected = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
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
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
      value = rest[++i];
    } else {
      errors.push(`旗标 --${flag} 缺少值`);
      continue;
    }
    const key = schema.FLAG_TO_KEY[flag];
    if (!key) {
      if (flag === 'tracker') {
        // 硬枚举分支删除的显式拒面（票 04）：--tracker 双轨废除，识别是唯一来源，
        // 文案点名替代面（setup 产物）助一轮内修正。
        errors.push(
          '未知旗标 --tracker：tracker 由 setup 产物自动识别，不再手工声明——' +
            '配置单源是 docs/agents/issue-tracker.md（/setup-matt-pocock-skills 落盘）'
        );
      } else {
        errors.push(`未知旗标 --${flag}（init 的参数集见 --help）；本脚本无任何绕过校验的旗标`);
      }
      continue;
    }
    if (!INIT_REQUIRED.includes(key) && !INIT_OPTIONAL.includes(key)) {
      errors.push(`旗标 --${flag} 不属于 init 的参数集`);
      continue;
    }
    if (key in collected) {
      errors.push(`旗标 --${flag} 重复给出`);
      continue;
    }
    if (!String(value).trim()) {
      errors.push(`旗标 --${flag} 的值为空`);
      continue;
    }
    collected[key] = value;
  }
  const missing = INIT_REQUIRED.filter((key) => !(key in collected));
  if (missing.length) {
    errors.push(
      `缺少必选参数 ${missing.map((key) => `--${schema.KEY_TO_FLAG[key]}`).join(' ')}` +
        '——tracker 不在此列：由 setup 产物自动识别'
    );
  }
  if (errors.length) {
    out(`✗ 拒绝（未入账）：`, ...errors.map((e) => `  - ${e}`));
    return 1;
  }

  // 识别先于一切写入（零半成品，与 snapshot-init 的续跑保护同哲学）：缺 setup 产物 →
  // 指引运行 /setup-matt-pocock-skills；范本认不出 → 「仅支持三种」；词表违约指到
  // 文件+行+列+期望——都停下不猜测不降级。
  const resolution = resolveTrackerFromRepo(process.cwd());
  if (!resolution.ok) {
    out(`✗ 拒绝（未入账）：`, ...resolution.errors.map((e) => `  - ${e}`));
    return 1;
  }
  for (const w of resolution.warnings) out(`⚠ ${w}`);

  // tracker 字段来自识别结果——载荷与其他字段同一扇 schema 门过 init 载荷档
  //（枚举 / SHA / 正整数 / tickets 清单档与既往零差异，事件格式零迁移）。
  const { payload: validated, errors: schemaErrors } = schema.validateInitPayload({
    ...collected,
    tracker: resolution.tracker,
  });
  if (schemaErrors.length) {
    out(`✗ 拒绝（未入账）：`, ...schemaErrors.map((e) => `  - ${e}`));
    return 1;
  }

  return recordEvent({ runtimeDir, type: 'init', payload: validated });
}

function cmdAdd({ runtimeDir, rest }) {
  const type = rest[0];
  if (type === 'init') {
    out(
      '✗ 拒绝：add init 已废除（票 04）——run 初始化移入 init 子命令（契约驱动：' +
        'tracker 由 setup 产物自动识别，不再以旗标手工声明）；用法见 --help'
    );
    return 1;
  }
  if (!type || !schema.EVENT_TYPES[type]) {
    out(
      `✗ 拒绝：未知事件类型 ${type ?? '(缺失)'}——可选：${Object.keys(schema.EVENT_TYPES).filter((k) => k !== 'init').join(', ')}（add 不再收 init：run 初始化用 init 子命令）`
    );
    return 1;
  }
  const { payload, errors } = schema.parseFlags(rest.slice(1), type);
  if (errors.length) {
    out(`✗ 拒绝（未入账）：`, ...errors.map((e) => `  - ${e}`));
    return 1;
  }
  return recordEvent({ runtimeDir, type, payload });
}

// 共享入账路径（add 与 init 子命令的唯一写点）：loadEvents → collectTruth → gateAdd →
// 盖信封 append → 自动再生台账。init 事件也走 gateAdd（init-only 状态机执法面不变：
// 只能是第一条事件、baselineSha 需在 git 中存在、spec 文件需存在）。
function recordEvent({ runtimeDir, type, payload }) {
  const eventsPath = path.join(runtimeDir, EVENTS_FILE);
  const { events, loadError } = loadEvents(eventsPath);
  if (loadError) {
    out(`✗ 拒绝（未入账）：${loadError}`);
    return 1;
  }

  const truth = collectTruth({ runtimeDir, events, contract: resolveTrackerFromRepo(process.cwd()).contract ?? null });
  if (!truth.head) {
    out('✗ 拒绝（未入账）：无法锚定写入时刻的 git HEAD——运行时目录不在含提交的 git 仓库内');
    return 1;
  }

  const gate = core.gateAdd({ events, type, payload, truth });
  if (!gate.ok) {
    out(
      `✗ 拒绝（未入账）：`,
      ...gate.reasons.map((r) => `  - ${r}`),
      `  校验器与你的分歧没有旗标可绕——确有依据时：add anomaly --note "..." 并停下上报`
    );
    return 1;
  }

  const warnings = [...gate.warnings];
  const last = events.at(-1);
  if (last && new Date().toISOString() < last.ts) {
    warnings.push('时钟回拨：新事件时间戳早于上一条（序号仍单调，以 seq 为序）');
  }

  const seq = (last?.seq ?? 0) + 1;
  const event = schema.makeEnvelope({ type, payload, seq, now: new Date(), head: truth.head, warnings });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);

  // 记账成功 → 自动再生台账（「更新台账」不是一个可能被遗忘的独立步骤）
  const all = [...events, event];
  const recon = core.reconcile({ events: all, truth });
  const md = core.renderLedger({
    slug: path.basename(runtimeDir),
    events: all,
    truth,
    recon,
    degraded: false,
  });
  const ledgerPath = path.join(runtimeDir, LEDGER_FILE);
  atomicWrite(ledgerPath, md);

  const what = payload.ticket ? `ticket=${payload.ticket}` : type === 'init' ? `tracker=${payload.tracker}` : type;
  out(
    `✓ recorded seq=${seq} ${type} ${what}`,
    ...warnings.map((w) => `⚠ ${w}`),
    `ledger rebuilt: ${ledgerPath}`
  );
  return 0;
}

function collectOrReject({ runtimeDir, command }) {
  const { events, degraded, loadError } = loadEvents(path.join(runtimeDir, EVENTS_FILE));
  if (loadError) {
    out(`✗ ${command} 失败：${loadError}`);
    return null;
  }
  const truth = collectTruth({ runtimeDir, events, contract: resolveTrackerFromRepo(process.cwd()).contract ?? null });
  const recon = core.reconcile({ events, truth });
  if (degraded) {
    recon.warnings.unshift('事件流缺失/为空——台账由真相层降级再生：平台态列标 unknown，不编造');
  }
  return { events, truth, recon, degraded };
}

function cmdBuild({ runtimeDir }) {
  const collected = collectOrReject({ runtimeDir, command: 'build' });
  if (!collected) return 1;
  const md = core.renderLedger({
    slug: path.basename(runtimeDir),
    events: collected.events,
    truth: collected.truth,
    recon: collected.recon,
    degraded: collected.degraded,
  });
  atomicWrite(path.join(runtimeDir, LEDGER_FILE), md);
  out(md);
  return 0;
}

function cmdCheck({ runtimeDir }) {
  const collected = collectOrReject({ runtimeDir, command: 'check' });
  if (!collected) return 1;
  const { events, truth, recon } = collected;
  // 终审平台证据核验：警告级、不影响退出码（best-effort 不误杀不可核验的账）
  const evidenceWarnings = core.finalEvidenceWarnings({ events, truth });
  if (recon.diffs.length) {
    out(
      `✗ ${recon.diffs.length} 处账实差异（退出码 1）：`,
      ...recon.diffs.map((d, i) => `  ${i + 1}. ${d}`),
      ...recon.warnings.map((w) => `⚠ ${w}`),
      ...evidenceWarnings.map((w) => `⚠ ${w}`)
    );
    return 1;
  }
  const ticketCount = core.countTickets(events);
  out(`✓ 账实一致（票 ${ticketCount} 张，事件 ${events.length} 条）`);
  for (const w of recon.warnings) out(`⚠ ${w}`);
  for (const w of evidenceWarnings) out(`⚠ ${w}`);
  return 0;
}

// --- 快照初始化（票 05 契约化）：按契约命令模板执行的通用 driver 取数 + 布局纯函数
//（snapshot-core）。取数面（issue 集合 / sub-issues / 原生依赖边 / 仓库标识探测）全部走
// contract.commands 的模板（tracker-driver），本层零 per-tracker 分支与零硬编码 argv——
// 失败语义（best-effort 警告不拦快照 / 硬失败零落盘）与迁移前等价，命令形态由契约声明。

const cliDetail = (e) =>
  (String(e?.stderr ?? '').trim() || String(e?.message ?? '').trim()).split('\n')[0] ||
  `退出码 ${e?.status ?? '未知'}`;

// cwd 仓库的 owner/repo（best-effort，契约 repoView 模板）：仅供 REST 路径模板的 <repo>
// 占位；失败不拦快照——票集边界还有 ## Parent 反查与 --tickets 两层兜底。contract
// 未声明 repoView（能力缺席）→ 探测不执行（调用方由 spec 引用自带 repo 或走兜底）。
function cliRepoView(contract, warnings) {
  if (!contract?.commands?.repoView) return null;
  try {
    const name = JSON.parse(driver.runCommand(contract, 'repoView') || '{}')?.nameWithOwner;
    return name ? String(name) : null;
  } catch (e) {
    warnings.push(`仓库标识探测失败（best-effort 跳过）：${cliDetail(e)}——sub-issues 拉取跳过，票集边界走 ## Parent 反查或 --tickets`);
    return null;
  }
}

// spec issue 的原生 sub-issues（票 04 层 ① 的数据源，best-effort）：REST 端点一次拉取，
// 失败仅警告不拦快照——兜底链的设计初衷就是层 ① 可缺席。
function cliSubIssues(contract, repo, specNum, issues, warnings) {
  try {
    const raw = driver.runCommand(contract, 'subIssues', { repo, num: specNum });
    const subs = (JSON.parse(raw || '[]') ?? [])
      .map((it) => schema.normalizeTicket(it?.number))
      .filter(Boolean);
    const specIssue = issues.find((it) => schema.normalizeTicket(it?.number) === specNum);
    if (specIssue) specIssue.subIssues = subs;
  } catch (e) {
    warnings.push(`spec ${specNum} 的 sub-issues 拉取失败（best-effort 跳过）：${cliDetail(e)}`);
  }
}

// 票的原生依赖边（integration-05 缺陷 1）：转写纯函数 blockedByOf 早已支持 issue.blockedBy
// 注入，但快照的收发此前没有拉取 dependencies——纯 IO 接线缺失，转写产物 Blocked by
// 落占位 —。接线：票集边界先解析（纯函数，确定拉取对象、不给全仓发请求），逐票 REST 拉
// blocked_by 解析为票号注入；best-effort：单票失败仅警告，该票退回正文 Blocked by 行/占位 —
//（与 sub-issues 同一待遇，失败不产生半成品快照）。
function cliBlockedBy(contract, repo, nums, issues, warnings) {
  for (const num of nums) {
    try {
      const raw = driver.runCommand(contract, 'blockedBy', { repo, num });
      const blockers = (JSON.parse(raw || '[]') ?? [])
        .map((it) => schema.normalizeTicket(it?.number))
        .filter(Boolean);
      const tk = issues.find((it) => schema.normalizeTicket(it?.number) === num);
      if (tk) tk.blockedBy = blockers;
    } catch (e) {
      warnings.push(`票 ${num} 的原生依赖边拉取失败（best-effort 跳过）：${cliDetail(e)}`);
    }
  }
}

// 落盘：先写 <tracker>.incoming 草稿目录，再整体改名——中断/失败不留半成品快照，
// tracker/ 要么不存在、要么是完整快照（票 05：全部成功才落盘）。
function writeSnapshot(snapshotRoot, plan) {
  const incoming = `${snapshotRoot}.incoming`;
  fs.rmSync(incoming, { recursive: true, force: true }); // 上次中断残留的自家草稿，清掉重写
  fs.mkdirSync(incoming, { recursive: true });
  fs.writeFileSync(path.join(incoming, plan.spec.rel), plan.spec.text);
  for (const tk of plan.tickets) {
    fs.mkdirSync(path.dirname(path.join(incoming, tk.rel)), { recursive: true });
    fs.writeFileSync(path.join(incoming, tk.rel), tk.text);
  }
  try {
    fs.renameSync(incoming, snapshotRoot);
  } catch (e) {
    fs.rmSync(incoming, { recursive: true, force: true });
    if (fs.existsSync(snapshotRoot)) {
      throw new Error(`快照已存在：${snapshotRoot}——写入窗口内被并发创建，拒绝覆盖`);
    }
    throw e;
  }
}

function cmdSnapshotInit({ runtimeDir, rest }) {
  const errors = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) {
      errors.push(`意外位置参数「${tok}」——参数一律用 --flag value 形式`);
      continue;
    }
    let flag = tok.slice(2);
    let value = null;
    const eq = flag.indexOf('=');
    if (eq !== -1) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
      value = rest[++i];
    } else {
      errors.push(`旗标 --${flag} 缺少值`);
      continue;
    }
    if (!['spec', 'tickets'].includes(flag)) {
      errors.push(`未知旗标 --${flag}（snapshot-init 的参数集见 --help）；本脚本无任何绕过校验的旗标`);
      continue;
    }
    if (flag in flags) {
      errors.push(`旗标 --${flag} 重复给出`);
      continue;
    }
    if (!String(value).trim()) {
      errors.push(`旗标 --${flag} 的值为空`);
      continue;
    }
    flags[flag] = value;
  }
  if (!('spec' in flags)) {
    errors.push('缺少必选参数 --spec <spec 引用>（GitHub：issue 号 / #号 / owner/repo#号 / issue URL）');
  }
  // --tickets 与 init 子命令同名旗标共用 schema.ticketSetList 单一转换点：归一 + 去重 +
  // 数值排序，非法形态（空段/非数字/越界）在旗标层拒绝——不与 init 子命令双轨校验。
  let initTickets;
  if ('tickets' in flags) {
    initTickets = schema.ticketSetList(flags.tickets);
    if (initTickets === null) {
      errors.push(`tickets 必须是逗号分隔的票号列表（如 01,02,1042），得到：${flags.tickets}`);
    }
  }
  if (errors.length) {
    out(`✗ 拒绝：`, ...errors.map((e) => `  - ${e}`));
    return 2;
  }

  // 续跑保护先于一切网络动作：快照已存在即拒绝，既有内容零覆盖（票 05）。
  const snapshotRoot = path.join(runtimeDir, SNAPSHOT_DIR);
  const overwrite = snapshot.checkOverwrite({
    snapshotDir: snapshotRoot,
    fileExists: (p) => fs.existsSync(p),
  });
  if (!overwrite.ok) {
    out(
      `✗ 拒绝：快照已存在——${overwrite.conflicts[0]}`,
      '  续跑保护：快照是拉取一次的整体，已存在时拒绝重新拉取（既有内容零覆盖）；',
      '  续跑经 ledger build + check 由事件流与快照重建状态，绝不重新拉取（ADR-0003）。'
    );
    return 1;
  }

  const warnings = [];
  // 契约先于一切网络动作（零半成品）：配置单源是 setup 产物——快照取数/占位/引擎参数
  // （命令模板、兜底链、引用形态、拉取上限）全部由它派生；无法识别 → 显式停下不猜测，
  // 与 init 子命令同一转接（resolveTrackerFromRepo）。
  const resolution = resolveTrackerFromRepo(process.cwd());
  if (!resolution.ok) {
    out(`✗ 拒绝：`, ...resolution.errors.map((e) => `  - ${e}`));
    return 1;
  }
  for (const w of resolution.warnings) out(`⚠ ${w}`);
  const contract = resolution.contract;
  if (!contract.commands.cli) {
    // local 契约无 tracker 写面：票文件即真相，快照/同步为无操作（spec：local 零变化）。
    out(
      '✗ 拒绝：tracker=local 无需快照——本地票文件即真相层，不经此命令（快照/同步为无操作）。'
    );
    return 1;
  }

  const specNum = tset.parseSpecRef(flags.spec, { contract });
  let issues = [];
  if (specNum) {
    const repo = tset.repoOfSpecRef(flags.spec, { contract }) ?? cliRepoView(contract, warnings);
    try {
      const raw = driver.runCommand(contract, 'listIssues', { repo });
      issues = JSON.parse(raw || '[]') ?? [];
      // 单拉无分页（真分页 defer 到 hardening 票）：行数恰达契约模板声明的上限即如实
      // 警告——已达上限，拉取可能不全；不在拉取处硬拒，缺口由票集解析的缺票诊断点名后重跑。
      const limit = driver.listLimit(contract);
      if (limit != null && issues.length >= limit) {
        warnings.push(`拉取行数恰达 --limit ${limit} 上限——已达上限，拉取可能不全；票集若缺票，核对 tracker 状态后重跑`);
      }
    } catch (e) {
      out(
        `✗ 快照初始化失败：issue 集合拉取失败——${cliDetail(e)}`,
        '  快照未落盘（tracker/ 未创建）——取数为 best-effort 薄 IO：失败不产生半成品，',
        '  排查登录/网络/引用后重跑（幂等：快照不存在时重跑即全新拉取）。'
      );
      return 1;
    }
    if (repo) {
      cliSubIssues(contract, repo, specNum, issues, warnings);
      // 原生依赖边（integration-05 缺陷 1）：边界先解析（纯函数），仅对边界内的票拉
      // blocked_by 注入——planSnapshot 的转写才吃得到 native 来源。
      const boundary = tset.resolveTicketSet({ issues, specRef: flags.spec, initTickets, contract });
      if (boundary.ok) cliBlockedBy(contract, repo, boundary.tickets, issues, warnings);
    }
  }

  const plan = snapshot.planSnapshot({
    issues,
    specRef: flags.spec,
    initTickets,
    contract,
  });
  if (!plan.ok) {
    out(`✗ 快照初始化失败：`, ...plan.errors.map((e) => `  - ${e}`));
    // 提示只在「引用本身解析不出」且形态像 spec 引用时给——引用可解析但不在集合
    //（拉取不全）的场景无提示会误导；形态清单贴出契约声明面，帮一轮内修正。
    if (!specNum) {
      out(
        '  提示：spec 引用必须落在契约声明票形态内（GitHub：issue 号 / #号 / owner/repo#号 / issue URL）——',
        '  local 契约无需快照（本地票文件即真相层）。'
      );
    }
    return 1;
  }

  try {
    writeSnapshot(snapshotRoot, plan);
  } catch (e) {
    out(
      `✗ 快照初始化失败：快照落盘失败——${e.message}`,
      '  快照未落盘或仅存草稿（tracker/ 整体改名前不可见）——排除磁盘问题后重跑。'
    );
    return 1;
  }

  const display = (p) => {
    const rel = path.relative(process.cwd(), p);
    return rel && !rel.startsWith('..') ? rel : p;
  };
  out(
    `✓ 快照落盘：${display(snapshotRoot)}（spec 1 + 票 ${plan.tickets.length}，票集边界=${plan.source}）`,
    `  spec.md（Source: ${plan.spec.source}）`,
    ...plan.tickets.map((tk) => `  ${tk.rel}`),
    ...[...warnings, ...plan.warnings].map((w) => `⚠ ${w}`)
  );
  return 0;
}

// --- 同步（票 06）：快照事实读取（sync-read-core）+ 同步规划（票 03）+ 契约模板执行（票 05 driver）---
//
// 时序即幂等保障：先拉 tracker 状态（拉取失败即整体中止）→ 纯规划（拒绝面全拦在此，
// 零写入）→ 逐动作顺序执行。执行按同步动作集与契约命令模板一一对应（票 05：
// 取数/留评/关票/撤认领全走 driver，零硬编码 argv）：
//   close    → contract.commands.close（body != null 时按 closeWithComment 能力追加收尾评论）
//   comment  → contract.commands.comment
//   unassign → contract.commands.unclaim
// 幂等键（票 02）：每条同步评论携带隐藏机器 marker `<!-- matt-implement:<runId>:<kind> -->`
//（runId = 本 run 的 --runtime-dir 目录名 feature slug；kind = 动作种类），重入判定只认
// marker——人改写/翻译评论正文不影响重入；无 marker 的历史评论（旧形态）视为未同步、
// 照常推送一次。部分失败即停：报告已完成/未完成逐动作清单；重跑从拉取重新开始，
// 规划器按 tracker 已有 marker 痕迹只补未完成的动作——已关不重关、已评论不重复。

function describeSyncAction(action) {
  if (action.kind === 'close') return `close ${action.num}${action.body ? '（附评论）' : ''}`;
  if (action.kind === 'comment') return `comment ${action.num}`;
  return `unassign ${action.num}（${action.login}）`;
}

// 同步动作 → 契约命令模板执行（票 05 driver；repo 作用旗由 driver 按模板形态前置）。
function executeSyncAction(action, contract, repo) {
  if (action.kind === 'close') {
    driver.runCommand(contract, 'close', { num: action.num, body: action.body ?? null, repo });
  } else if (action.kind === 'comment') {
    driver.runCommand(contract, 'comment', { num: action.num, body: action.body, repo });
  } else if (action.kind === 'unassign') {
    driver.runCommand(contract, 'unclaim', { num: action.num, login: action.login, repo });
  } else {
    throw new Error(`未知同步动作 kind：${JSON.stringify(action.kind)}`);
  }
}

// 同步成功后的清理指引（CONTEXT.md 运行时三分：tracker 快照是第三类而非传输件，同步成功
// 后清理；review bundle 用后即弃；findings 留存因事件流引用其路径；账本三件套长存）。
// 只指引不代删——清理动作属编排流程（票 07 的清理清单）。
function syncCleanupLines(mode, runtimeDir) {
  const display = (p) => {
    const rel = path.relative(process.cwd(), p);
    return rel && !rel.startsWith('..') ? rel : p;
  };
  const runtime = display(runtimeDir);
  return [
    '清理指引（同步成功后执行；tracker 快照是第三类而非传输件，与用后即弃的 review bundle 同步成功后清理；findings 与账本三件套长存）：',
    `  - 清理 tracker 快照：rm -rf ${runtime}/tracker`,
    `  - 清理 review bundle：${runtime}/reviews/（若存在）`,
    `  - 留存 findings：${runtime}/findings/（事件流引用其路径，不可删）`,
    `  - 留存账本三件套：${runtime}/events.jsonl、ledger.md、notes.md（长存）`,
    mode === 'abandon'
      ? '  随后：封账（add close）——放弃路径已撤占坑留评，tracker 不留假占坑。'
      : '  随后：PR 标 ready（add pr --state ready）→ 封账（add close）——同步已先行，PR closing keywords 不会抢关已关的票。',
  ];
}

function parseSyncFlags(rest) {
  const errors = [];
  const flags = {};
  const allowed = ['mode', 'claimant', 'reason'];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) {
      errors.push(`意外位置参数「${tok}」——参数一律用 --flag value 形式`);
      continue;
    }
    let flag = tok.slice(2);
    let value = null;
    const eq = flag.indexOf('=');
    if (eq !== -1) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
      value = rest[++i];
    } else {
      errors.push(`旗标 --${flag} 缺少值`);
      continue;
    }
    if (!allowed.includes(flag)) {
      errors.push(`未知旗标 --${flag}（sync 的参数集见 --help）；本脚本无任何绕过校验的旗标`);
      continue;
    }
    if (flag in flags) {
      errors.push(`旗标 --${flag} 重复给出`);
      continue;
    }
    flags[flag] = value;
  }
  return { flags, errors };
}

function cmdSync({ runtimeDir, rest }) {
  const { flags, errors } = parseSyncFlags(rest);
  const mode = flags.mode ?? 'seal';
  // 同步幂等 marker 的 run 标识（票 02）：一次 run 的稳定身份标识 = feature slug
  //（--runtime-dir 的目录名，即事件流与快照所在的运行目录）。同名同分支重跑
  // 同一 slug 会命中旧 marker、不重复推送；目录名不含 < > 换行等界定性字符。
  const runId = path.basename(runtimeDir).trim();
  if (mode !== 'seal' && mode !== 'abandon') {
    errors.push(`--mode 非法：${JSON.stringify(flags.mode ?? '')}——应为 seal | abandon（缺省 seal）`);
  }
  if (mode === 'abandon') {
    if (!String(flags.claimant ?? '').trim()) errors.push('abandon 需要 --claimant <占坑的 tracker 用户名>');
    if (!String(flags.reason ?? '').trim()) errors.push('abandon 需要 --reason <放弃说明，用于留评>');
  }
  if (errors.length) {
    out(`✗ 拒绝：`, ...errors.map((e) => `  - ${e}`));
    return 2;
  }

  // 时点约束先于一切网络动作：同步须发生在封账之前、pr --state ready 之前
  //（ADR-0003——封账后事件流拒写，同步失败将无从记账；PR ready 后 closing keywords
  // 与同步抢关票，spec 接口契约的时点约束只剩未落实的前半时无效）。
  const { events, loadError } = loadEvents(path.join(runtimeDir, EVENTS_FILE));
  if (loadError) {
    out(`✗ 拒绝：${loadError}`);
    return 1;
  }
  const tooLate = events.some((e) => e?.type === 'close')
    ? 'run 已封账'
    : events.some((e) => e?.type === 'pr' && e?.payload?.state === 'ready')
      ? 'PR 已标 ready（pr --state ready 已入账）'
      : null;
  if (tooLate) {
    out(
      `✗ 拒绝：${tooLate}——同步须发生在封账之前、pr --state ready 之前；`,
      '  封账后事件流拒写、PR ready 后 closing keywords 与同步抢关票——此时同步失败将无从记账；',
      '  确有未推送状态：向用户上报后人工处理。',
    );
    return 1;
  }

  // 契约先于一切网络动作（零半成品，与 snapshot-init 同一转接）：同步的命令模板与
  // Source 行原址形态都由契约驱动；无法识别 → 显式停下不猜测不降级。
  const resolution = resolveTrackerFromRepo(process.cwd());
  if (!resolution.ok) {
    out(`✗ 拒绝：`, ...resolution.errors.map((e) => `  - ${e}`));
    return 1;
  }
  const contract = resolution.contract;
  if (!contract.commands.cli) {
    // local 契约无 tracker 写面：票文件即真相，快照/同步为无操作（spec：local 零变化）。
    out('✗ 拒绝：tracker=local 无需同步——本地票文件即真相层（快照/同步为无操作）。');
    return 1;
  }

  // 快照读取（纯函数，fs 谓词注入；Source 行按契约原址形态判定）：快照缺失 →
  // local 无需同步 / remote 契约先拉取。
  const snapshotRoot = path.join(runtimeDir, SNAPSHOT_DIR);
  const read = syncread.readSnapshot({
    trackerDir: snapshotRoot,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    listDir: (p) => fs.readdirSync(p),
    exists: (p) => fs.existsSync(p),
    contract,
  });
  if (!read.ok) {
    if (read.errors[0]?.startsWith('快照不存在')) {
      out(
        `✗ 拒绝：tracker/ 快照不存在——${snapshotRoot}`,
        '  tracker=local 无需同步（本地票文件即真相层，不经此命令）；',
        '  tracker=github 的 run 先跑 snapshot-init 拉取快照。',
      );
    } else {
      out(`✗ 拒绝：快照形态不合格——`, ...read.errors.map((e) => `  - ${e}`));
    }
    return 1;
  }
  for (const w of read.warnings) out(`⚠ ${w}`);

  // 拉取规划所需 tracker 状态：只拉同步对象（合并/升级事实票 + spec 母票；abandon 仅母票）。
  // 在途票（claimed/ready）不是同步对象，不发请求。
  const nums =
    mode === 'abandon'
      ? [read.spec.num]
      : [
          ...new Set([
            ...read.tickets.filter((t) => t.mergeSha || t.escalateReason).map((t) => t.num),
            read.spec.num,
          ]),
        ].sort((a, b) => Number(a) - Number(b));
  const views = [];
  for (const num of nums) {
    try {
      const raw = driver.runCommand(contract, 'viewIssue', { num, repo: read.source.repo });
      views.push(JSON.parse(raw || 'null'));
    } catch (e) {
      out(
        `✗ 同步未执行任何动作：issue view ${num} 拉取失败——${cliDetail(e)}`,
        '  同步先拉状态再规划、规划通过后才写入：拉取失败即整体中止，零写入（无半成品推送）；',
        '  排查登录/网络（或确认该票未被删除）后重跑。',
      );
      return 1;
    }
  }

  // 纯规划（拒绝面在此拦截，零写入）：非法事实/缺失状态都在这里拒绝，不猜。
  let actions;
  try {
    actions = syncplan.planTrackerSync(
      { tickets: read.tickets, spec: read.spec },
      { issues: syncread.toTrackerIssues(views) },
      mode === 'abandon'
        ? { mode, claimant: flags.claimant, reason: flags.reason, runId }
        : { mode, runId },
    );
  } catch (e) {
    out(`✗ ${e.message}`, '  同步规划拒绝即零推送——修正快照事实后重跑。');
    return 1;
  }

  if (!actions.length) {
    out('✓ 已同步：无待推送动作（幂等重入，零副作用）——close 0 / comment 0 / unassign 0');
    out(...syncCleanupLines(mode, runtimeDir));
    return 0;
  }

  // 逐动作顺序执行：部分失败即停，逐动作报告已完成/未完成（重跑只补未完成的动作）。
  const done = [];
  for (const action of actions) {
    try {
      executeSyncAction(action, contract, read.source.repo);
      out(`  ✓ ${describeSyncAction(action)}`);
      done.push(action);
    } catch (e) {
      out(
        `✗ 同步失败：${describeSyncAction(action)} 失败——${cliDetail(e)}`,
        `  已完成（${done.length}/${actions.length}）：`,
        ...done.map((a) => `    ✓ ${describeSyncAction(a)}`),
        `  未完成（${actions.length - done.length}）：`,
        ...actions.slice(done.length).map((a) => `    - ${describeSyncAction(a)}`),
        '  重跑安全：幂等规划只补未完成的动作（已推送的痕迹——已关票/已有评论——不再产生动作）。',
      );
      return 1;
    }
  }
  const tally = ['close', 'comment', 'unassign']
    .map((k) => `${k} ${actions.filter((a) => a.kind === k).length}`)
    .join(' / ');
  out(`✓ 同步完成：${actions.length} 个动作全部推送（${tally}）`);
  out(...syncCleanupLines(mode, runtimeDir));
  return 0;
}

// --- 占坑（票 05）：契约 claim 模板的 run 第一写动作（tracker 侧的 feature 级并发锁）---
//
// 占坑是 run 在 tracker 上的第一个写动作（先于快照拉取，ADR-0003：锁实时、进度延迟）；
// 进度与合并同步归 sync，封账/放弃时释放。本子命令只做契约模板执行的写面：
// 先读 spec 母票状态（冲突不猜测覆盖）→ 无人占坑才执行 claim 模板；占坑约定的协商语义
//（接管/改目标/协调）属 SKILL 叙事（票 07），不在脚本面。幂等：已在位 → 拒绝而非重复写。
function cmdClaim({ runtimeDir, rest }) {
  const errors = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) {
      errors.push(`意外位置参数「${tok}」——参数一律用 --flag value 形式`);
      continue;
    }
    let flag = tok.slice(2);
    let value = null;
    const eq = flag.indexOf('=');
    if (eq !== -1) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
      value = rest[++i];
    } else {
      errors.push(`旗标 --${flag} 缺少值`);
      continue;
    }
    if (flag !== 'spec') {
      errors.push(`未知旗标 --${flag}（claim 的参数集见 --help）；本脚本无任何绕过校验的旗标`);
      continue;
    }
    if ('spec' in flags) {
      errors.push('旗标 --spec 重复给出');
      continue;
    }
    if (!String(value).trim()) {
      errors.push('旗标 --spec 的值为空');
      continue;
    }
    flags.spec = value;
  }
  if (!('spec' in flags)) {
    errors.push('缺少必选参数 --spec <spec 引用>（契约声明的形态：GitHub：issue 号 / #号 / owner/repo#号 / issue URL）');
  }
  if (errors.length) {
    out(`✗ 拒绝：`, ...errors.map((e) => `  - ${e}`));
    return 2;
  }

  // 契约先于一切写动作（零半成品）：占坑写面由契约 claim 模板声明；local 契约无
  // tracker 写面——占坑不存在（票文件即真相层）。
  const resolution = resolveTrackerFromRepo(process.cwd());
  if (!resolution.ok) {
    out(`✗ 拒绝：`, ...resolution.errors.map((e) => `  - ${e}`));
    return 1;
  }
  const contract = resolution.contract;
  if (!contract.commands.claim || !contract.commands.cli) {
    out(
      '✗ 拒绝：tracker=local 无 tracker 写面——占坑不存在（本地票文件即真相层，不经此命令）。'
    );
    return 1;
  }
  const specNum = tset.parseSpecRef(flags.spec, { contract });
  if (!specNum) {
    out(
      `✗ 拒绝：spec 引用无法解析出票号：${JSON.stringify(flags.spec)}`,
      '  spec 引用必须落在契约声明票形态内（GitHub：issue 号 / #号 / owner/repo#号 / issue URL）。'
    );
    return 1;
  }
  // 仓库解析与 snapshot-init 同口径：引用自带 repo 优先，否则按契约 repoView 模板探测
  //（best-effort；跨仓引用必须打到契约仓，不能落在 cwd）。
  const repo = tset.repoOfSpecRef(flags.spec, { contract }) ?? cliRepoView(contract, []);

  // 先读状态再写入（冲突检查不可用时不盲写）：占坑是并发锁的占有面，他人已在位即停下。
  try {
    const view = JSON.parse(driver.runCommand(contract, 'viewIssue', { num: specNum, repo }) || '{}');
    const assignees = (view?.assignees ?? []).map((a) => a?.login).filter((l) => typeof l === 'string' && l);
    if (assignees.length) {
      out(
        `✗ 占坑冲突：spec ${specNum} 已在 tracker 上被认领（${assignees.join('、')}）——`,
        '  占坑是 feature 级并发锁的占有面：不猜测覆盖他人占坑；',
        '  若确为本 run 续跑（同一占坑者），该步幂等可直接跳过；',
        '  若要接管或换目标：按占坑约定与在位者（或用户）确认后处理。'
      );
      return 1;
    }
  } catch (e) {
    out(
      `✗ 占坑失败：spec ${specNum} 状态读取失败——${cliDetail(e)}`,
      '  先读状态再写入（冲突检查不可用时不盲写）：排查登录/网络/引用后重跑。'
    );
    return 1;
  }
  try {
    driver.runCommand(contract, 'claim', { num: specNum, repo });
  } catch (e) {
    out(`✗ 占坑失败：claim 执行失败——${cliDetail(e)}`, '  占坑未落（可安全重跑）。');
    return 1;
  }
  out(
    `✓ 占坑：spec ${specNum} 已认领到 @me（契约 claim 模板；tracker 侧的 feature 级并发锁，ADR-0003）。`
  );
  return 0;
}

// --- 入口 ---

function main(argv) {
  if (argv.length === 0) {
    out('缺少子命令。', USAGE);
    return 2;
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    out(USAGE);
    return 0;
  }
  const command = argv[0];
  if (!['add', 'build', 'check', 'claim', 'snapshot-init', 'sync', 'init'].includes(command)) {
    out(`未知子命令：${command}`, USAGE);
    return 2;
  }
  let runtimeDir = null;
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--runtime-dir') {
      runtimeDir = argv[++i] ?? null;
    } else if (tok.startsWith('--runtime-dir=')) {
      runtimeDir = tok.slice('--runtime-dir='.length);
    } else {
      rest.push(tok);
    }
  }
  if (!runtimeDir) {
    out('缺少 --runtime-dir <dir>（事件流与台账所在的编排运行时状态目录）', USAGE);
    return 2;
  }
  runtimeDir = path.resolve(runtimeDir);
  if (command === 'init') return cmdInit({ runtimeDir, rest });
  if (command === 'add') return cmdAdd({ runtimeDir, rest });
  if (command === 'claim') return cmdClaim({ runtimeDir, rest });
  if (command === 'build') return cmdBuild({ runtimeDir });
  if (command === 'snapshot-init') return cmdSnapshotInit({ runtimeDir, rest });
  if (command === 'sync') return cmdSync({ runtimeDir, rest });
  return cmdCheck({ runtimeDir });
}

process.exit(main(process.argv.slice(2)));
