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
const path = require('node:path');
const schema = require('./ledger-schema');
const core = require('./ledger-core');

const EVENTS_FILE = 'events.jsonl';
const LEDGER_FILE = 'ledger.md';

const USAGE = `pi-matt-implement-flow ledger — 机械台账（真相层 / 事件流 / 派生台账三层，LLM 永不手写台账）

用法:
  node ledger.js add <type> --runtime-dir <dir> [--flag value ...]
  node ledger.js build --runtime-dir <dir>
  node ledger.js check --runtime-dir <dir>

事件类型与参数集 (add):
  init        --branch --branch-base --baseline-sha --spec --test-command --tracker(local|github|gitlab)
              [--reviewer on|off] [--max-fix-rounds N] [--max-concurrent N]
              # 流程形态快照（flow shape）：本 run 是否逐票评审 / 每票修复预算 / 并发 coder 数；
              # 省略 = 默认形态 on / 2 / 3。快照冻结后，verdict/fix/merge 校验均按它执行。
  dispatch    --ticket --key --run-id [--worktree] [--note]
  settled     --ticket --round --head-sha [--worktree] [--gate] [--note]
  verdict     --ticket --round --verdict(approved|changes_requested) [--findings] [--rev-run-id] [--note]
  fix         --ticket --fix-no --key --resume-run-id [--note]
  merge       --ticket --head-sha --merge-sha [--note]
  escalate    --ticket [--note]
  final       --final-verdict(ready|ready_with_fixes|not_ready) --run-id <runId> [--findings] [--note]
              # 整分支终审裁决（run 级，无 ticket）；runId 必选——事件驱动审计与平台证据核验的锚点。
              # 多轮终审 = 多条事件（无去重，一律以最新裁决为准）；无 merge 事件时警告入账。
  anomaly     --note
  pr          --state(opened-draft|ready) [--url] [--note]
  close       [--note]

说明:
  add      记账：脚本盖权威时间戳/单调序号/版本/git HEAD 锚点，append 后自动再生台账
  build    台账再生：四段 markdown（头部/表格/时间线/对账结论），确定性重建
  check    对账：账实差异核验，非零退出码 = 有差异；派发与合并前、compaction 后必跑
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

  // 未入账合并扫描：依赖硬规则「merge 提交信息必须含 ticket-NN 令牌」；无 init 基线 → null（降级）
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
  const { events, recon } = collected;
  if (recon.diffs.length) {
    out(
      `✗ ${recon.diffs.length} 处账实差异（退出码 1）：`,
      ...recon.diffs.map((d, i) => `  ${i + 1}. ${d}`),
      ...recon.warnings.map((w) => `⚠ ${w}`)
    );
    return 1;
  }
  const ticketCount = core.countTickets(events);
  out(`✓ 账实一致（票 ${ticketCount} 张，事件 ${events.length} 条）`);
  for (const w of recon.warnings) out(`⚠ ${w}`);
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
  if (!['add', 'build', 'check'].includes(command)) {
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
  return cmdCheck({ runtimeDir });
}

process.exit(main(process.argv.slice(2)));
