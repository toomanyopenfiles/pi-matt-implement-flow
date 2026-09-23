#!/usr/bin/env node
'use strict';

// ledger CLI — 机械台账的三个子命令（唯一写面）。
// 分层：薄 IO 壳（git/gh/票文件读取 + 原子写）+ 纯判定核心（ledger-schema / ledger-core）。
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
const snapshot = require('./snapshot-core');
const tset = require('./tracker-set-core');

const EVENTS_FILE = 'events.jsonl';
const LEDGER_FILE = 'ledger.md';
// tracker 快照（票 05，ADR-0003）：snapshot-init 的落盘根——与 local tracker 的
// spec 同目录 issues/ 枚举约定同构（dirname(spec)/issues/），账本枚举零形态分叉。
const SNAPSHOT_DIR = 'tracker';

const USAGE = `pi-matt-implement-flow ledger — 机械台账（真相层 / 事件流 / 派生台账三层，LLM 永不手写台账）

用法:
  node ledger.js add <type> --runtime-dir <dir> [--flag value ...]
  node ledger.js build --runtime-dir <dir>
  node ledger.js check --runtime-dir <dir>

事件类型与参数集 (add):
  init        --branch --branch-base --baseline-sha --spec --test-command --tracker(local|github|gitlab)
              [--reviewer on|off] [--max-fix-rounds N] [--max-concurrent N] [--tickets 01,02,1042]
              # 流程形态快照（flow shape）：本 run 是否逐票评审 / 每票修复预算 / 并发 coder 数；
              # 省略 = 默认形态 on / 2 / 3。快照冻结后，verdict/fix/merge 校验均按它执行。
              # --tickets（票集边界，票 04）：本 run 的票号清单（票集解析三层兜底的兜底层）；
              # init 时冻结——此后边界外的票号记账被拒（中途偷加票被拒）。省略 = 无冻结边界。
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

快照初始化 (snapshot-init，tracker=github):
  snapshot-init --spec <issue号|#号|owner/repo#号|issueURL> [--tickets 01,02,1042]
              # init 阶段一条命令：拉取 spec 与全部工单，转写为 tracker 快照
              # （<runtime-dir>/tracker/spec.md 带 Source: 行 + tracker/issues/<号>-<slug>.md，
              # 与 local 票文件同构，账本零形态分叉）。票集来自票 04 的三层解析；
              # spec 母票带 Type: spec 豁免标记。快照已存在时拒绝执行（续跑保护：既有内容
              # 零覆盖，续跑绝不重拉）；gh 收发为 best-effort 薄 IO——失败报错清晰、
              # 不产生半成品（临时目录整体改名，全部成功才落盘）。

说明:
  add      记账：脚本盖权威时间戳/单调序号/版本/git HEAD 锚点，append 后自动再生台账
  build    台账再生：四段 markdown（头部/表格/时间线/对账结论），确定性重建
  check    对账：账实差异核验，非零退出码 = 有差异；派发与合并前、compaction 后必跑；
           并对 final 事件的 runId 做 best-effort 平台证据核验（不可核验仅警告，不影响退出码）
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

function collectTruth({ runtimeDir, events }) {
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

  // gh PR 状态：best-effort，不可用 → null（台账标 unknown，不编造）
  truth.probeGh = (branch) => {
    try {
      const raw = execFileSync('gh', ['pr', 'list', '--head', branch, '--json', 'state,isDraft', '--limit', '1'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const arr = JSON.parse(raw);
      if (!arr.length) return 'none';
      if (arr[0].isDraft) return 'opened-draft';
      return arr[0].state === 'OPEN' ? 'ready' : null;
    } catch {
      return null;
    }
  };

  // 本地 tracker 票集枚举（spec 同目录 issues/；GitHub/GitLab tracker 优雅降级）
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
      const parsed = parseTicketFile(fs.readFileSync(path.join(issuesDir, name), 'utf8'));
      truth.tickets.push({ num, file: name, ...parsed });
    }
    // 票号数值排序（ADR-0004）：混位数下文件名字典序会乱（'1042-…' 排在 '02-…' 前面），
    // 真相层枚举统一按数值序供给下游（票表、对账差异、封账阻塞清单）。
    truth.tickets.sort((a, b) => Number(a.num) - Number(b.num));
  };

  if (!init) {
    // 事件流丢失的降级再生：按 tracker 约定从运行时目录 slug 反查 .scratch/<slug>/spec.md
    const slug = path.basename(runtimeDir);
    const fallbackSpec = repoRoot ? path.join(repoRoot, '.scratch', slug, 'spec.md') : null;
    if (fallbackSpec && fs.existsSync(fallbackSpec)) {
      enumerateIssues(fallbackSpec);
    } else {
      truth.ticketsWarning = '无 init 事件且按约定找不到 .scratch/<slug>/spec.md——票集降级为空';
    }
  } else if (init.payload.tracker !== 'local') {
    truth.ticketsWarning = `tracker=${init.payload.tracker}——v1 仅支持本地 markdown tracker 枚举，票集降级为事件流票集`;
  } else if (!truth.fileExists(init.payload.spec)) {
    truth.ticketsWarning = `spec 文件不存在：${init.payload.spec}——票集枚举降级`;
  } else {
    enumerateIssues(path.resolve(repoRoot, init.payload.spec));
  }
  return truth;
}

// 票文件解析：Status / Type / Blocked by 行 + 首题（兼容 **Status:** x 与 Status: x 两种写法）
function parseTicketFile(text) {
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
    status: grab('Status'),
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

function cmdAdd({ runtimeDir, rest }) {
  const type = rest[0];
  if (!type || !schema.EVENT_TYPES[type]) {
    out(
      `✗ 拒绝：未知事件类型 ${type ?? '(缺失)'}——可选：${Object.keys(schema.EVENT_TYPES).join(', ')}`
    );
    return 1;
  }
  const { payload, errors } = schema.parseFlags(rest.slice(1), type);
  if (errors.length) {
    out(`✗ 拒绝（未入账）：`, ...errors.map((e) => `  - ${e}`));
    return 1;
  }

  const eventsPath = path.join(runtimeDir, EVENTS_FILE);
  const { events, loadError } = loadEvents(eventsPath);
  if (loadError) {
    out(`✗ 拒绝（未入账）：${loadError}`);
    return 1;
  }

  const truth = collectTruth({ runtimeDir, events });
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

  const what = payload.ticket ? `ticket=${payload.ticket}` : type;
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
  const truth = collectTruth({ runtimeDir, events });
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

// --- 快照初始化（票 05）：gh 收发 best-effort 薄 IO + 布局纯函数（snapshot-core）---

// spec 引用 → owner/repo（供 gh -R 与 sub_issues REST 路径）：与 parseSpecRef 同源的两种
// 带前缀形态；纯 issue 号 / #号不携带 repo（gh 按 cwd 的 git remote 解析，不猜）。
function repoFromSpecRef(specRef) {
  const s = String(specRef ?? '').trim();
  let m = /^([\w.-]+)\/([\w.-]+)#\d{1,6}$/.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  m = /github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/\d{1,6}/.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

const ghDetail = (e) =>
  (String(e?.stderr ?? '').trim() || String(e?.message ?? '').trim()).split('\n')[0] ||
  `退出码 ${e?.status ?? '未知'}`;

function runGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: 120000,
    // 大仓的 issue list（--limit 1000 含正文）远超默认 1MB buffer——ENOBUFS 是真实
    // 失败面（手工验证 golang/go 时撞过），按薄 IO 的量级给足。
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// cwd 仓库的 owner/repo（best-effort）：仅用于 sub_issues 拉取；失败不拦快照——
// 票集边界还有 ## Parent 反查与 --tickets 两层兜底。
function ghRepoView(warnings) {
  try {
    const name = JSON.parse(runGh(['repo', 'view', '--json', 'nameWithOwner']) || '{}')?.nameWithOwner;
    return name ? String(name) : null;
  } catch (e) {
    warnings.push(`gh repo view 失败（best-effort 跳过）：${ghDetail(e)}——sub-issues 拉取跳过，票集边界走 ## Parent 反查或 --tickets`);
    return null;
  }
}

// spec issue 的原生 sub-issues（票 04 层 ① 的数据源，best-effort）：REST 端点一次拉取，
// 失败仅警告不拦快照——三层兜底链的设计初衷就是层 ① 可缺席。
function ghSubIssues(repo, specNum, issues, warnings) {
  try {
    const raw = runGh(['api', `repos/${repo}/issues/${Number(specNum)}/sub_issues`]);
    const subs = (JSON.parse(raw || '[]') ?? [])
      .map((it) => schema.normalizeTicket(it?.number))
      .filter(Boolean);
    const specIssue = issues.find((it) => schema.normalizeTicket(it?.number) === specNum);
    if (specIssue) specIssue.subIssues = subs;
  } catch (e) {
    warnings.push(`spec ${specNum} 的 sub-issues 拉取失败（best-effort 跳过）：${ghDetail(e)}`);
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
  const specNum = tset.parseSpecRef(flags.spec);
  let issues = [];
  if (specNum) {
    const repo = repoFromSpecRef(flags.spec) ?? ghRepoView(warnings);
    try {
      const args = ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,body,state,labels,url'];
      if (repo) args.push('-R', repo);
      issues = JSON.parse(runGh(args) || '[]') ?? [];
    } catch (e) {
      out(
        `✗ 快照初始化失败：gh issue list 拉取失败——${ghDetail(e)}`,
        '  快照未落盘（tracker/ 未创建）——gh 收发为 best-effort 薄 IO：失败不产生半成品，',
        '  排查 gh 登录/网络/引用后重跑（幂等：快照不存在时重跑即全新拉取）。'
      );
      return 1;
    }
    if (repo) ghSubIssues(repo, specNum, issues, warnings);
  }

  const plan = snapshot.planSnapshot({
    issues,
    specRef: flags.spec,
    initTickets: 'tickets' in flags ? flags.tickets.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
  if (!plan.ok) {
    out(`✗ 快照初始化失败：`, ...plan.errors.map((e) => `  - ${e}`));
    // 提示只在「引用本身解析不出」（local 路径 / 散文）且形态像文件路径时给——
    // 引用可解析但不在集合（拉取不全）的场景贴 tracker=local 提示会误导。
    if (!specNum && /[\\/]|\.md$/.test(String(flags.spec).trim())) {
      out('  提示：tracker=local 无需快照——本地票文件即真相层，不经此命令');
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
  if (!['add', 'build', 'check', 'snapshot-init'].includes(command)) {
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
  if (command === 'add') return cmdAdd({ runtimeDir, rest });
  if (command === 'build') return cmdBuild({ runtimeDir });
  if (command === 'snapshot-init') return cmdSnapshotInit({ runtimeDir, rest });
  return cmdCheck({ runtimeDir });
}

process.exit(main(process.argv.slice(2)));
