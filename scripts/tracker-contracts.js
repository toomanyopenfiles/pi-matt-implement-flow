'use strict';

// tracker 契约预设——三份声明式数据（票 01，spec「契约预设」）。随包发布的机器契约：
// 能力表 + 映射表 + 命令模板，外加范本判据（detection，判型输入）。预设是数据不是代码
// 分支：引擎（票 04-07 接线）只读契约对象取能力、映射与命令，代码里零 per-tracker 分支；
// 支持一个新 tracker = 新增一份预设数据 + 范本判据（spec User Story 23），不碰引擎代码。
//
// schema 六维（字段语义详见 tracker-contract-core.validateContract——契约对象的唯一校验点）：
//   detection    —— 范本判据：H1 标题行（小写、空白归一后的形态）+ 少量锚点短语（全部
//                   命中才判型成功）。判据只依赖 H1 + 锚点，正文可被用户编辑（票 01）。
//   identity     —— 标识与引用：票号语法、spec 引用语法、原址语法（Source 行 / 收尾定位）。
//   mapping      —— 表示映射：closed→resolved、type 来源、阻塞边来源；labelMap 是
//                   label→词表映射的 canonical 默认（角色→label），resolveContract 按
//                   目标仓库 triage-labels.md 的解析结果覆盖钉死——拉取时钉死（ADR-0006）。
//   ticketSet    —— 票集边来源（三层兜底链；源名词表 = tracker-set-core.resolveTicketSet
//                   的 source 值：'sub-issues' | 'parent-edges' | 'init-list'）。
//   capabilities —— 能力声明：占坑强度（advisory 锁如实声明，spec User Story 18）、
//                   closeWithComment、收尾面（'PR' | 'MR' | 'none'）。
//   commands     —— 操作面：cli 名 + argv 命令模板（占位符 <num> / <body> / <login> /
//                   <repo> / <branch>）。closeWithComment=true 表示允许在 close 模板后追加
//                   ['--comment', '<body>']；=false（gitlab）表示 close 不接受收尾评论，
//                   需 note 先行（同步动作集由能力生成的数据前提，票 05/06）。
//                   repoView：仓库标识探测（best-effort；模板自带 owner/repo 形态的 spec 引用
//                   时不探测。票 05 落地自关闭脚本的硬码调用点）。
//                   prProbe：收尾面状态探测（best-effort 台账展示；非同步与对账的判定面）。
//                   local 全 null——票文件即真相，快照/同步无操作（spec：local 行为零变化）。
//   idempotency  —— 幂等键：marker 模板（票 02 落地）与载体（tracker 评论正文 / 票文件
//                   Comments 节）。
//   lifecycle    —— 生命周期策略：spec 关票时点（封账之前、pr ready 之前，ADR-0003）、
//                   abandon 语义（撤占坑 + 留评说明）。
//
// gitlab 能力差异声明（spec 接口契约）：无 sub-issues（票集走 Parent 反查 + 票号清单
// 兜底）；closeWithComment=false（note 先行）；阻塞边走 `Blocked by:` 正文行（free tier
// 无原生链接）；收尾面为 MR；自建实例按路径形态（/-/issues/N）识别原址，不认域名。

const CANONICAL_ROLES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];
const CANONICAL_LABEL_MAP = Object.fromEntries(CANONICAL_ROLES.map((r) => [r, r]));

// 幂等 marker 模板（票 02 的写入格式，先以数据钉进契约——引擎只读它，无 per-tracker 分支）
const SYNC_MARKER_TEMPLATE = '<!-- matt-implement:<runId>:<kind> -->';

const LOCAL_CONTRACT = {
  tracker: 'local',
  detection: {
    h1: 'issue tracker: local markdown',
    anchors: ['.scratch/<feature-slug>/', 'status:'],
  },
  identity: {
    ticketNumber: '1–6 位数字（feature 局部序号，1–9 补零显示）',
    specRef: {
      kind: 'path',
      accepts: ['<spec.md 文件路径>'],
    },
    sourceUrl: {
      kind: 'path',
      host: null,
      path: '<spec.md 文件路径>',
    },
  },
  mapping: {
    labelMap: { ...CANONICAL_LABEL_MAP },
    closedStatus: 'resolved',
    typeSource: 'type-line',
    blockingEdges: ['inline'],
    // local 无 tracker JSON——形状声明 canonical 形态自身（契约校验档要求字段在位；
    // local 的快照/同步为无操作，不会真的肥到这上面）。
    viewShape: {
      number: 'number',
      title: 'title',
      body: 'body',
      state: 'state',
      stateOpen: ['open'],
      stateClosed: ['closed'],
      assignees: 'assignees',
      assigneeLogin: 'login',
      comments: 'comments',
      commentBody: 'body',
      urlKeys: ['url', 'html_url'],
    },
  },
  ticketSet: {
    edges: ['init-list'],
  },
  capabilities: {
    claimStrength: 'advisory',
    closeWithComment: true,
    closingSurface: 'none',
  },
  commands: {
    cli: null,
    listIssues: null,
    subIssues: null,
    blockedBy: null,
    repoView: null,
    prProbe: null,
    viewIssue: null,
    claim: null,
    unclaim: null,
    comment: null,
    close: null,
  },
  idempotency: {
    marker: SYNC_MARKER_TEMPLATE,
    carrier: 'ticket-file-comments',
  },
  lifecycle: {
    specCloseTiming: 'pre-seal',
    abandon: { unclaim: true, comment: true },
  },
};

const GITHUB_CONTRACT = {
  tracker: 'github',
  detection: {
    h1: 'issue tracker: github',
    anchors: ['gh issue create', 'gh issue close'],
  },
  identity: {
    ticketNumber: '1–6 位数字（issue number，1–9 补零显示）',
    specRef: {
      kind: 'number',
      accepts: ['<num>', '#<num>', '<owner>/<repo>#<num>', 'https://github.com/<owner>/<repo>/issues/<num>'],
    },
    sourceUrl: {
      kind: 'url',
      host: 'github.com',
      path: '/<owner>/<repo>/issues/<num>',
    },
  },
  mapping: {
    labelMap: { ...CANONICAL_LABEL_MAP },
    closedStatus: 'resolved',
    typeSource: 'wayfinder-label',
    blockingEdges: ['native', 'inline'],
    // view/list JSON 形状（适配面）：跟踪器 issue JSON 产物 → 引擎 canonical 输入形态的
    // 字段映射（票 06 起声明式契约化——字段名差异为数据，不是 if-tracker 分支）。
    viewShape: {
      number: 'number',
      title: 'title',
      body: 'body',
      state: 'state',
      stateOpen: ['open'],
      stateClosed: ['closed'],
      assignees: 'assignees',
      assigneeLogin: 'login',
      comments: 'comments',
      commentBody: 'body',
      urlKeys: ['url', 'html_url'],
    },
  },
  ticketSet: {
    edges: ['sub-issues', 'parent-edges', 'init-list'],
  },
  capabilities: {
    claimStrength: 'advisory',
    closeWithComment: true,
    closingSurface: 'PR',
  },
  commands: {
    cli: 'gh',
    listIssues: ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,body,state,labels,url'],
    subIssues: ['api', 'repos/<repo>/issues/<num>/sub_issues'],
    blockedBy: ['api', 'repos/<repo>/issues/<num>/dependencies/blocked_by'],
    repoView: ['repo', 'view', '--json', 'nameWithOwner'],
    prProbe: ['pr', 'list', '--head', '<branch>', '--json', 'state,isDraft', '--limit', '1'],
    viewIssue: ['issue', 'view', '<num>', '--json', 'number,state,assignees,comments'],
    claim: ['issue', 'edit', '<num>', '--add-assignee', '@me'],
    unclaim: ['issue', 'edit', '<num>', '--remove-assignee', '<login>'],
    comment: ['issue', 'comment', '<num>', '--body', '<body>'],
    close: ['issue', 'close', '<num>'],
  },
  idempotency: {
    marker: SYNC_MARKER_TEMPLATE,
    carrier: 'comment-body',
  },
  lifecycle: {
    specCloseTiming: 'pre-seal',
    abandon: { unclaim: true, comment: true },
  },
};

const GITLAB_CONTRACT = {
  tracker: 'gitlab',
  detection: {
    h1: 'issue tracker: gitlab',
    anchors: ['glab issue create', 'glab issue close'],
  },
  identity: {
    ticketNumber: '1–6 位数字（IID，1–9 补零显示）',
    specRef: {
      kind: 'number',
      accepts: ['<iid>', '#<iid>', '<group>/<project>#<iid>', 'https://<host>/<namespace>/<project>/-/issues/<iid>'],
    },
    sourceUrl: {
      kind: 'url',
      host: null, // 域名无关：自建实例按路径形态识别，不认域名（spec User Story 9）
      path: '/<namespace>/<project>/-/issues/<num>',
    },
  },
  mapping: {
    labelMap: { ...CANONICAL_LABEL_MAP },
    closedStatus: 'resolved',
    typeSource: 'wayfinder-label',
    blockingEdges: ['inline'], // free tier 无原生链接——Blocked by: 正文行
    // view/list JSON 形状（适配面）：glab 语义的 field 映射——iid ≠ number、description ≠
    // body、state 'opened' ≠ 'open'、notes ≠ comments、assignees[].username ≠ login、
    // 引用原址是 web_url（票 06：GitLab 形态差异契约化，引擎据此适配零 if-tracker 分支）。
    viewShape: {
      number: 'iid',
      title: 'title',
      body: 'description',
      state: 'state',
      stateOpen: ['opened', 'open'],
      stateClosed: ['closed'],
      assignees: 'assignees',
      assigneeLogin: 'username',
      comments: 'notes',
      commentBody: 'body',
      urlKeys: ['web_url', 'url', 'html_url'],
    },
  },
  ticketSet: {
    edges: ['parent-edges', 'init-list'], // 无 sub-issues：Parent 反查 + 票号清单兜底
  },
  capabilities: {
    claimStrength: 'advisory',
    closeWithComment: false, // glab issue close 不接受收尾评论——note 先行（先留评后关票）
    closingSurface: 'MR',
  },
  commands: {
    cli: 'glab',
    listIssues: ['issue', 'list', '--state', 'all', '-F', 'json'],
    subIssues: null,
    blockedBy: null,
    repoView: null,
    prProbe: null,
    viewIssue: ['issue', 'view', '<num>', '-F', 'json'],
    claim: ['issue', 'update', '<num>', '--assignee', '@me'],
    unclaim: ['issue', 'update', '<num>', '--unassign', '<login>'],
    comment: ['issue', 'note', '<num>', '--message', '<body>'],
    close: ['issue', 'close', '<num>'],
  },
  idempotency: {
    marker: SYNC_MARKER_TEMPLATE,
    carrier: 'comment-body',
  },
  lifecycle: {
    specCloseTiming: 'pre-seal',
    abandon: { unclaim: true, comment: true },
  },
};

const CONTRACTS = {
  local: LOCAL_CONTRACT,
  github: GITHUB_CONTRACT,
  gitlab: GITLAB_CONTRACT,
};

module.exports = {
  CANONICAL_ROLES,
  CANONICAL_LABEL_MAP,
  SYNC_MARKER_TEMPLATE,
  LOCAL_CONTRACT,
  GITHUB_CONTRACT,
  GITLAB_CONTRACT,
  CONTRACTS,
};
