'use strict';

// 票 01：契约解析核心与三预设——接缝①（spec「Testing Decisions」唯一新缝：契约解析
// 纯函数面）。纯函数直喂、无 IO、无网络；测外部行为：
//   - 三份上游范本文本 → 契约对象（能力与映射逐项断言：票集边来源、占坑强度、
//     closeWithComment、收尾面、原址语法、阻塞边来源）
//   - 用户编辑过正文的范本变体仍判型成功（判据只依赖 H1 + 锚点短语）
//   - 缺 setup 产物 / 认不出的范本 → 显式错误文案（停下，不猜测不降级）
//   - triage-labels.md 的解析矩阵（合规、改名、重复 label、多行少行、缺列 → 文件+行+列+期望）
//   - 合成契约（假想 tracker 形态）不经判型直接构造——契约是引擎唯一依赖
// fixture 直喂（test/fixtures/ 三份上游范本 + 词表变体），中文用例命名，沿用既有
// 纯函数测试风格（node:test + assert/strict + 分节横幅注释）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../scripts/tracker-contract-core');
const contracts = require('../scripts/tracker-contracts');

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// --- 上游范本 fixture（直喂：判型输入就是上游 setup 产物的原文）---

const LOCAL = read('issue-tracker-local.md');
const GITHUB = read('issue-tracker-github.md');
const GITLAB = read('issue-tracker-gitlab.md');
// 用户编辑过正文的变体：本仓自身的 docs/agents/issue-tracker.md（上游 local 范本 +
// 「本 repo 的附加约定」追加节——判据（H1 + 锚点短语）原样保留，正文已非上游原文）
const LOCAL_EDITED = read('issue-tracker-local-edited.md');
const TRIAGE_CANONICAL = read('triage-labels-canonical.md');
const TRIAGE_CUSTOM = read('triage-labels-custom.md');

const resolve = (issueTracker, triageLabels) =>
  core.resolveContract({ issueTracker, triageLabels });

// ====================================================================
// 判型与契约对象：三份上游范本各判型成功
// ====================================================================

test('判型：local 范本 → local 契约——能力与映射逐项可断言', () => {
  const r = core.resolveContract({ issueTracker: LOCAL, triageLabels: TRIAGE_CANONICAL });
  assert.equal(r.ok, true, `判型应成功：${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.errors, []);
  const c = r.contract;
  assert.equal(c.tracker, 'local');
  // 票集边来源：local 无远端边——票文件即真相，边界只有清单一层
  assert.deepEqual(c.ticketSet.edges, ['init-list']);
  // 占坑强度：advisory 锁如实声明（spec User Story 18）
  assert.equal(c.capabilities.claimStrength, 'advisory');
  // closeWithComment 与收尾面：local 的关票即 Status 行改写，评论同文件（无远端关票）
  assert.equal(c.capabilities.closeWithComment, true);
  assert.equal(c.capabilities.closingSurface, 'none');
  // 原址语法：spec 引用即文件路径，不经 URL 解析
  assert.equal(c.identity.specRef.kind, 'path');
  assert.equal(c.identity.sourceUrl.kind, 'path');
  // 阻塞边来源：Blocked by: 正文行
  assert.deepEqual(c.mapping.blockingEdges, ['inline']);
  // type 来源：Type: 行（local 票文件头的 Type 行，非 label）
  assert.equal(c.mapping.typeSource, 'type-line');
  // 操作面：票文件即真相——命令模板全 null（快照/同步无操作，spec：local 零变化）
  assert.equal(c.commands.cli, null);
  assert.equal(c.commands.close, null);
  assert.equal(c.commands.claim, null);
});

test('判型：github 范本 → github 契约——sub-issues 边、PR 收尾面、github.com 原址语法', () => {
  const r = core.resolveContract({ issueTracker: GITHUB, triageLabels: TRIAGE_CANONICAL });
  assert.equal(r.ok, true, `判型应成功：${JSON.stringify(r.errors)}`);
  const c = r.contract;
  assert.equal(c.tracker, 'github');
  // 票集边来源：三层兜底链全量可用（原生 sub-issues 最高优先）
  assert.deepEqual(c.ticketSet.edges, ['sub-issues', 'parent-edges', 'init-list']);
  // 占坑强度如实声明；closeWithComment：gh issue close --comment 单步关票
  assert.equal(c.capabilities.claimStrength, 'advisory');
  assert.equal(c.capabilities.closeWithComment, true);
  // 收尾面：PR（GitHub 保持 PR 时序）
  assert.equal(c.capabilities.closingSurface, 'PR');
  // 原址语法：github.com/<owner>/<repo>/issues/<num>
  assert.equal(c.identity.sourceUrl.kind, 'url');
  assert.equal(c.identity.sourceUrl.host, 'github.com');
  assert.equal(c.identity.sourceUrl.path, '/<owner>/<repo>/issues/<num>');
  // 阻塞边来源：原生依赖边 + 正文 Blocked by 行兜底（两者并存）
  assert.deepEqual(c.mapping.blockingEdges, ['native', 'inline']);
  // type 来源：wayfinder:<type> label（上游范本约定，透传不校验）
  assert.equal(c.mapping.typeSource, 'wayfinder-label');
  // 操作面：gh 命令模板是数据——取数 / 占坑 / 撤占坑 / 留评 / 关票逐项可断言
  assert.equal(c.commands.cli, 'gh');
  assert.deepEqual(c.commands.claim, ['issue', 'edit', '<num>', '--add-assignee', '@me']);
  assert.deepEqual(c.commands.unclaim, ['issue', 'edit', '<num>', '--remove-assignee', '<login>']);
  assert.deepEqual(c.commands.comment, ['issue', 'comment', '<num>', '--body', '<body>']);
  assert.deepEqual(c.commands.close, ['issue', 'close', '<num>']);
  assert.deepEqual(
    c.commands.listIssues,
    ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,body,state,labels,url']
  );
  // 通用 driver 的辅助模板（票 05）：仓库标识探测与收尾面状态探测——格式驱动的最佳努力拉取
  assert.deepEqual(c.commands.repoView, ['repo', 'view', '--json', 'nameWithOwner']);
  assert.deepEqual(
    c.commands.prProbe,
    ['pr', 'list', '--head', '<branch>', '--json', 'state,isDraft', '--limit', '1']
  );
});

test('判型：gitlab 范本 → gitlab 契约——无 sub-issues、note 先行关票、MR 收尾面、路径形态原址', () => {
  const r = core.resolveContract({ issueTracker: GITLAB, triageLabels: TRIAGE_CANONICAL });
  assert.equal(r.ok, true, `判型应成功：${JSON.stringify(r.errors)}`);
  const c = r.contract;
  assert.equal(c.tracker, 'gitlab');
  // 票集边来源：无 sub-issues——Parent 反查 + 票号清单兜底（spec 能力差异声明）
  assert.deepEqual(c.ticketSet.edges, ['parent-edges', 'init-list']);
  // 占坑强度如实声明；closeWithComment=false：glab issue close 不接受收尾评论 → note 先行
  assert.equal(c.capabilities.claimStrength, 'advisory');
  assert.equal(c.capabilities.closeWithComment, false);
  // 收尾面：MR（先留评后关票的等价序列同步到 MR 上）
  assert.equal(c.capabilities.closingSurface, 'MR');
  // 原址语法：路径形态 /-/issues/<num>，host=null（自建实例不认域名）
  assert.equal(c.identity.sourceUrl.kind, 'url');
  assert.equal(c.identity.sourceUrl.host, null);
  assert.equal(c.identity.sourceUrl.path, '/<namespace>/<project>/-/issues/<num>');
  // 阻塞边来源：free tier 无原生链接——Blocked by: 正文行
  assert.deepEqual(c.mapping.blockingEdges, ['inline']);
  // 操作面：glab note/comment 的数据表达；close 模板不带评论参数（能力表声明先留评）
  assert.equal(c.commands.cli, 'glab');
  assert.deepEqual(c.commands.claim, ['issue', 'update', '<num>', '--assignee', '@me']);
  assert.deepEqual(c.commands.unclaim, ['issue', 'update', '<num>', '--unassign', '<login>']);
  assert.deepEqual(c.commands.comment, ['issue', 'note', '<num>', '--message', '<body>']);
  assert.deepEqual(c.commands.close, ['issue', 'close', '<num>']);
});

test('预设是数据不是代码：三份预设可 JSON 往返、判型产物与预设数据同源', () => {
  // 数据性证明 ①：JSON 序列化往返不变形（无函数、无 getter、无循环引用）
  for (const c of [contracts.LOCAL_CONTRACT, contracts.GITHUB_CONTRACT, contracts.GITLAB_CONTRACT]) {
    assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
  }
  // 数据性证明 ②：resolveContract 的产物就是预设对象本身（canonical 词表下逐字段同源）
  const local = core.resolveContract({ issueTracker: LOCAL, triageLabels: TRIAGE_CANONICAL });
  assert.deepEqual(local.contract, contracts.LOCAL_CONTRACT);
  const github = core.resolveContract({ issueTracker: GITHUB, triageLabels: TRIAGE_CANONICAL });
  assert.deepEqual(github.contract, contracts.GITHUB_CONTRACT);
  const gitlab = core.resolveContract({ issueTracker: GITLAB, triageLabels: TRIAGE_CANONICAL });
  assert.deepEqual(gitlab.contract, contracts.GITLAB_CONTRACT);
  // 三预设彼此不同（判型才有意义）
  assert.notDeepEqual(contracts.GITHUB_CONTRACT.ticketSet.edges, contracts.GITLAB_CONTRACT.ticketSet.edges);
});

// ====================================================================
// 判型容错：用户编辑过正文的范本变体仍判型成功
// ====================================================================

test('判型容错：用户编辑过正文的范本仍判型成功（本仓 docs/agents/issue-tracker.md 即活例）', () => {
  // 判据只依赖 H1 + 锚点短语——本仓自己的范本在上游 local 范本之上加了「本 repo 的
  // 附加约定」节，正文已非上游原文；判型必须照常命中。
  const r = core.resolveContract({ issueTracker: LOCAL_EDITED, triageLabels: TRIAGE_CANONICAL });
  assert.equal(r.ok, true, `判型应成功：${JSON.stringify(r.errors)}`);
  assert.equal(r.contract.tracker, 'local');
  assert.deepEqual(r.contract.ticketSet.edges, ['init-list']);
});

test('判型容错：追加节、改写散文、调整节序、CRLF 行尾都不改变判型', () => {
  // ① 追加仓库自有约定节（本地化改写最常见形态）
  const appended = GITHUB + '\n## 我们仓库的额外约定\n\n- issue 一律带 area 标签。\n- 同步评论用中文。\n';
  assert.equal(core.resolveContract({ issueTracker: appended, triageLabels: null }).ok, true);
  // ② 删改与重排正文段落（锚点短语所在行保留原文措辞）
  const reordered = [
    '# Issue tracker: GitHub',
    '',
    'Issues and specs for this repo live as GitHub issues.',
    '',
    '## When a skill says "fetch the relevant ticket"',
    '',
    'Run `gh issue view <number> --comments`.',
    '',
    '## Conventions',
    '',
    '- **Create an issue**: `gh issue create --title "..." --body "..."`.',
    '- **Close**: `gh issue close <number> --comment "..."`.',
  ].join('\n');
  const rr = core.resolveContract({ issueTracker: reordered, triageLabels: null });
  assert.equal(rr.ok, true, `重排正文后仍应判型成功：${JSON.stringify(rr.errors)}`);
  assert.equal(rr.contract.tracker, 'github');
  // ③ CRLF 行尾（Windows 编辑器落盘）
  assert.equal(core.resolveContract({ issueTracker: LOCAL.replace(/\n/g, '\r\n'), triageLabels: null }).ok, true);
  // ④ H1 排版差异（多空格）与锚点大小写差异都归一后命中
  const messy = [
    '#  Issue   tracker:  GitHub',
    '',
    '- **Create an issue**: `GH Issue Create --title "..."`',
    '- **Close**: `GH Issue Close <number>`',
  ].join('\n');
  const messyR = core.resolveContract({ issueTracker: messy, triageLabels: null });
  assert.equal(messyR.ok, true, `排版/大小写差异应归一容忍：${JSON.stringify(messyR.errors)}`);
  assert.equal(messyR.contract.tracker, 'github');
});

// ====================================================================
// 显式失败面：缺产物 / 认不出 / 判型失败——停下，不猜测不降级
// ====================================================================

test('缺 setup 产物：显式指引运行 /setup-matt-pocock-skills，停下不猜测', () => {
  for (const missing of [null, undefined, '', '   \n  ']) {
    const r = core.resolveContract({ issueTracker: missing, triageLabels: TRIAGE_CANONICAL });
    assert.equal(r.ok, false);
    assert.equal(r.contract, null, '缺产物不得产出契约对象（不猜测不降级）');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /缺 issue tracker 范本文档/);
    assert.match(r.errors[0], /docs\/agents\/issue-tracker\.md/);
    assert.match(r.errors[0], /\/setup-matt-pocock-skills/);
  }
});

test('范本认不出：报仅支持 local/github/gitlab 三种——Jira 等其他形态不猜测不降级', () => {
  const jira = [
    '# Issue tracker: Jira',
    '',
    'Issues and specs live in Jira. Use the Jira CLI for all operations.',
    '',
    '- **Create an issue**: `jira issue create --project PROJ`',
    '- **Close**: `jira issue close PROJ-42`',
  ].join('\n');
  const r = core.resolveContract({ issueTracker: jira, triageLabels: TRIAGE_CANONICAL });
  assert.equal(r.ok, false);
  assert.equal(r.contract, null);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /范本认不出/);
  assert.match(r.errors[0], /仅支持 local \/ github \/ gitlab 三种范本/);
  assert.match(r.errors[0], /H1：/);
});

test('范本认不出：正文无 H1 标题行同样显式失败', () => {
  const noH1 = '## Issue tracker: GitHub\n\n正文只有二级标题。\n';
  const r = core.resolveContract({ issueTracker: noH1, triageLabels: null });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /范本认不出/);
  assert.match(r.errors[0], /仅支持 local \/ github \/ gitlab 三种范本/);
});

test('范本判型失败：H1 命中但锚点短语缺失 → 显式失败（正文被掏空到失格）', () => {
  const gutted = [
    '# Issue tracker: GitHub',
    '',
    '本仓的工单都在 GitHub 上，我们用自家封装的 REST 客户端直接调 API，不走 gh CLI。',
  ].join('\n');
  const r = core.resolveContract({ issueTracker: gutted, triageLabels: null });
  assert.equal(r.ok, false);
  assert.equal(r.contract, null);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /判型失败/);
  assert.match(r.errors[0], /缺少锚点短语/);
  assert.match(r.errors[0], /「gh issue create」/);
});

// ====================================================================
// triage-labels 严格解析（ADR-0006）：词表映射矩阵
// ====================================================================

test('词表解析：canonical 表 → 五角色恰好各映射一次，零警告', () => {
  const r = core.parseTriageLabels(TRIAGE_CANONICAL);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.labelMap, {
    'needs-triage': 'needs-triage',
    'needs-info': 'needs-info',
    'ready-for-agent': 'ready-for-agent',
    'ready-for-human': 'ready-for-human',
    wontfix: 'wontfix',
  });
});

test('词表解析：自定义 label 串照常解析（改名词表，Role→label 钉死）', () => {
  const r = core.parseTriageLabels(TRIAGE_CUSTOM);
  assert.equal(r.ok, true);
  assert.deepEqual(r.labelMap, {
    'needs-triage': 'to-triage',
    'needs-info': 'awaiting-reporter',
    'ready-for-agent': 'afk-ready',
    'ready-for-human': 'human-only',
    wontfix: 'closed-wontfix',
  });
  // 解析进契约：词表映射钉在 mapping.labelMap（拉取时钉死，ADR-0006）
  const c = core.resolveContract({ issueTracker: GITHUB, triageLabels: TRIAGE_CUSTOM });
  assert.equal(c.ok, true);
  assert.equal(c.contract.mapping.labelMap.wontfix, 'closed-wontfix');
  assert.equal(c.contract.mapping.labelMap['ready-for-agent'], 'afk-ready');
});

test('词表解析：按表头定位列——两列表头调换后仍正确映射（防插列错位）', () => {
  // 同一批数据、表头列序对调：解析结果必须一致（列位置由表头名定位，不由列序决定）
  const swapped = [
    '| Label in our tracker | Label in mattpocock/skills | Meaning |',
    '| -------------------- | --------------------------- | ------- |',
    '| `to-triage`         | `needs-triage`              | 待评估  |',
    '| `awaiting-reporter` | `needs-info`                | 等情报  |',
    '| `afk-ready`         | `ready-for-agent`           | 可派发  |',
    '| `human-only`        | `ready-for-human`           | 人写    |',
    '| `closed-wontfix`    | `wontfix`                   | 不修    |',
  ].join('\n');
  const r = core.parseTriageLabels(swapped);
  assert.equal(r.ok, true, `调列后应照常解析：${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.labelMap, {
    'needs-triage': 'to-triage',
    'needs-info': 'awaiting-reporter',
    'ready-for-agent': 'afk-ready',
    'ready-for-human': 'human-only',
    wontfix: 'closed-wontfix',
  });
});

test('词表解析：行序无关（打乱数据行 → 同一映射）', () => {
  const lines = TRIAGE_CANONICAL.split('\n');
  const dataRows = lines.slice(6, 11); // 行 7–11
  const shuffled = [...lines.slice(0, 6), ...[dataRows[4], dataRows[2], dataRows[0], dataRows[3], dataRows[1]], ...lines.slice(11)];
  const r = core.parseTriageLabels(shuffled.join('\n'));
  assert.equal(r.ok, true, `行序无关应成立：${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.labelMap, core.parseTriageLabels(TRIAGE_CANONICAL).labelMap);
});

test('词表解析：文件缺失 → canonical 默认 + 注记警告（合法常态，非降级）', () => {
  const r = core.parseTriageLabels(null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.labelMap, core.parseTriageLabels(TRIAGE_CANONICAL).labelMap, 'canonical 默认与合规表同映射');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /docs\/agents\/triage-labels\.md 不存在/);
  // 经 resolveContract 时警告随契约携带
  const c = core.resolveContract({ issueTracker: GITHUB, triageLabels: null });
  assert.equal(c.ok, true);
  assert.equal(c.warnings.length, 1);
  assert.deepEqual(c.contract.mapping.labelMap, core.parseTriageLabels(TRIAGE_CANONICAL).labelMap);
});

test('词表违约：多一行 → 报错含文件 + 行 + 期望恰五行（数据行闭包）', () => {
  const lines = TRIAGE_CANONICAL.split('\n');
  const extra = [...lines.slice(0, 11), '| `needs-triage` | `to-triage-2` | 多出的一行 |', ...lines.slice(11)];
  const r = core.parseTriageLabels(extra.join('\n'));
  assert.equal(r.ok, false);
  assert.equal(r.labelMap, null, '违约不得产出映射（零半成品）');
  assert.ok(r.errors.some((e) => /triage-labels\.md 第 12 行/.test(e) && /数据行 6 行/.test(e) && /恰好五行/.test(e)), r.errors.join('\n'));
});

test('词表违约：少一行 → 报错含文件 + 行 + 期望恰五行', () => {
  const lines = TRIAGE_CANONICAL.split('\n');
  const fewer = [...lines.slice(0, 10), ...lines.slice(11)]; // 删掉 ready-for-human 行（剩 4 行）
  const r = core.parseTriageLabels(fewer.join('\n'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /第 10 行/.test(e) && /数据行 4 行/.test(e) && /恰好五行/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /缺失：wontfix/.test(e)), '角色列闭合同步点名缺失');
});

test('词表违约：label 重复（跨大小写）→ 报错点名两行 + 全表唯一期望', () => {
  const five = [
    '| Label in mattpocock/skills | Label in our tracker | Meaning |',
    '| --- | --- | --- |',
    '| `needs-triage` | `to-triage` | a |',
    '| `needs-info` | `awaiting` | b |',
    '| `ready-for-agent` | `AFK` | c |',
    '| `ready-for-human` | `afk` | d |',
    '| `wontfix` | `no-fix` | e |',
  ].join('\n');
  const r = core.parseTriageLabels(five);
  assert.equal(r.ok, false);
  const dup = r.errors.find((e) => /label 重复/.test(e));
  assert.ok(dup, r.errors.join('\n'));
  assert.match(dup, /第 5 行第 2 列/);
  assert.match(dup, /另见第 6 行/);
  assert.match(dup, /重复「AFK」/);
  assert.match(dup, /全表唯一/);
});

test('词表违约：缺列 → 表头行报错含文件 + 行 + 期望（按表头名定位）', () => {
  const noLabelCol = [
    '# Triage Labels',
    '',
    '| Label in mattpocock/skills | Meaning |',
    '| --- | --- |',
    '| `needs-triage` | a |',
    '| `needs-info` | b |',
    '| `ready-for-agent` | c |',
    '| `ready-for-human` | d |',
    '| `wontfix` | e |',
  ].join('\n');
  const r = core.parseTriageLabels(noLabelCol);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /triage-labels\.md 第 3 行第 3 列起/);
  assert.match(r.errors[0], /缺列「Label in our tracker」/);
});

test('词表违约：角色名错 → 报错该行列 + 期望 canonical 五角色', () => {
  const five = [
    '| Label in mattpocock/skills | Label in our tracker | Meaning |',
    '| --- | --- | --- |',
    '| `needs-triage` | `a` | 1 |',
    '| `needs-info` | `b` | 2 |',
    '| `banana` | `c` | 3 |',
    '| `ready-for-human` | `d` | 4 |',
    '| `wontfix` | `e` | 5 |',
  ].join('\n');
  const r = core.parseTriageLabels(five);
  assert.equal(r.ok, false);
  const bad = r.errors.find((e) => /banana/.test(e));
  assert.ok(bad, r.errors.join('\n'));
  assert.match(bad, /第 5 行第 1 列/);
  assert.match(bad, /不在 canonical 五角色/);
  assert.match(bad, /needs-triage \/ needs-info \/ ready-for-agent \/ ready-for-human \/ wontfix/);
});

test('词表违约：label 空 → 报错该行列 + 期望非空', () => {
  const five = [
    '| Label in mattpocock/skills | Label in our tracker | Meaning |',
    '| --- | --- | --- |',
    '| `needs-triage` | `to-triage` | 1 |',
    '| `needs-info` | `` | 2 |',
    '| `ready-for-agent` | `afk` | 3 |',
    '| `ready-for-human` | `human` | 4 |',
    '| `wontfix` | `no-fix` | 5 |',
  ].join('\n');
  const r = core.parseTriageLabels(five);
  assert.equal(r.ok, false);
  const empty = r.errors.find((e) => /label 为空/.test(e));
  assert.ok(empty, r.errors.join('\n'));
  assert.match(empty, /第 4 行第 2 列/);
});

test('词表违约：角色重复 → 报错点名重复行 + 缺失角色', () => {
  const five = [
    '| Label in mattpocock/skills | Label in our tracker | Meaning |',
    '| --- | --- | --- |',
    '| `needs-triage` | `a` | 1 |',
    '| `needs-triage` | `b` | 2 |',
    '| `ready-for-agent` | `c` | 3 |',
    '| `ready-for-human` | `d` | 4 |',
    '| `wontfix` | `e` | 5 |',
  ].join('\n');
  const r = core.parseTriageLabels(five);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /角色「needs-triage」重复（第 3 行已出现）/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /缺失：needs-info/.test(e)), r.errors.join('\n'));
});

test('词表违约：文件存在但无表格 → 显式报错（空文件不是缺失，不静默落默认）', () => {
  for (const text of ['', '   ', '# Triage Labels\n\n说明散文，无表格。\n']) {
    const r = core.parseTriageLabels(text);
    assert.equal(r.ok, false);
    assert.equal(r.labelMap, null);
    assert.ok(r.errors.some((e) => /找不到表头行/.test(e)), r.errors.join('\n'));
    assert.ok(r.errors.some((e) => /Label in mattpocock\/skills/.test(e)), r.errors.join('\n'));
  }
});

test('词表违约在判型时一并拦下：resolveContract 整体 ok=false，零半成品契约', () => {
  const lines = TRIAGE_CANONICAL.split('\n');
  const extra = [...lines.slice(0, 11), '| `needs-triage` | `to-triage-2` | 多出的一行 |', ...lines.slice(11)];
  const r = core.resolveContract({ issueTracker: GITHUB, triageLabels: extra.join('\n') });
  assert.equal(r.ok, false);
  assert.equal(r.contract, null);
  assert.ok(r.errors.some((e) => /数据行 6 行/.test(e)), r.errors.join('\n'));
});

// ====================================================================
// 合成契约：假想 tracker 形态不经判型直接构造
// ====================================================================

test('合成契约：假想 tracker 形态不经判型直接构造并通过 schema 校验', () => {
  // 假想形态：看板式 tracker——有关票无评论、无原生边、无 sub-issues、收尾面 none、
  // 词表全改名。引擎若吃 tracker 名，这个对象无处可去；只吃契约则合法。
  const synthetic = {
    tracker: 'board',
    detection: { h1: 'issue tracker: board', anchors: ['board create'] },
    identity: {
      ticketNumber: '1–6 位数字（卡片号）',
      specRef: { kind: 'number', accepts: ['<card>', '#<card>'] },
      sourceUrl: { kind: 'url', host: null, path: '/<space>/<board>/card/<num>' },
    },
    mapping: {
      labelMap: { 'needs-triage': 'new', 'needs-info': 'stalled', 'ready-for-agent': 'go', 'ready-for-human': 'stop', wontfix: 'archive' },
      closedStatus: 'resolved',
      typeSource: 'wayfinder-label',
      blockingEdges: ['inline'],
      // view/list JSON 形状（票 06 适配面）：假想形态自报 canonical 字面。
      viewShape: {
        number: 'number', title: 'name', body: 'note', state: 'status',
        stateOpen: ['active'], stateClosed: ['done'],
        assignees: 'owners', assigneeLogin: 'id',
        comments: 'activity', commentBody: 'text',
        urlKeys: ['cardUrl'],
      },
    },
    ticketSet: { edges: ['parent-edges', 'init-list'] },
    capabilities: { claimStrength: 'advisory', closeWithComment: false, closingSurface: 'none' },
    commands: {
      cli: 'board',
      listIssues: ['card', 'list', '--json'],
      subIssues: null,
      blockedBy: null,
      repoView: null,
      prProbe: null,
      viewIssue: ['card', 'view', '<num>', '--json'],
      claim: ['card', 'assign', '<num>', '@me'],
      unclaim: ['card', 'assign', '<num>', '--remove', '<login>'],
      comment: ['card', 'note', '<num>', '<body>'],
      close: ['card', 'close', '<num>'],
    },
    idempotency: { marker: '<!-- matt-implement:<runId>:<kind> -->', carrier: 'comment-body' },
    lifecycle: { specCloseTiming: 'pre-seal', abandon: { unclaim: true, comment: true } },
  };
  const v = core.validateContract(synthetic);
  assert.equal(v.ok, true, `合成契约应合法：${JSON.stringify(v.errors)}`);
  // 同一扇门：三预设与合成契约同 schema（引擎唯一依赖是契约对象，不是 tracker 名）
  for (const c of [contracts.LOCAL_CONTRACT, contracts.GITHUB_CONTRACT, contracts.GITLAB_CONTRACT, synthetic]) {
    assert.equal(core.validateContract(c).ok, true);
  }
  // 词表可完全自定义（输出词表固定五角色，输入串任意）——映射进同一 schema
  assert.deepEqual(Object.keys(synthetic.mapping.labelMap).sort(), [...contracts.CANONICAL_ROLES].sort());
});

test('schema 校验档：残缺 / 枚举外的契约对象显式拒绝', () => {
  // 缺整个能力维
  const missing = { ...contracts.GITHUB_CONTRACT };
  delete missing.capabilities;
  assert.equal(core.validateContract(missing).ok, false);
  assert.ok(core.validateContract(missing).errors.some((e) => /capabilities/.test(e)));
  // 收尾面枚举外
  const badSurface = { ...contracts.GITHUB_CONTRACT, capabilities: { ...contracts.GITHUB_CONTRACT.capabilities, closingSurface: 'PRX' } };
  assert.equal(core.validateContract(badSurface).ok, false);
  assert.ok(core.validateContract(badSurface).errors.some((e) => /closingSurface/.test(e)));
  // 词表角色不全（输出词表固定五角色）
  const badMap = { ...contracts.GITHUB_CONTRACT, mapping: { ...contracts.GITHUB_CONTRACT.mapping, labelMap: { wontfix: 'wontfix' } } };
  assert.equal(core.validateContract(badMap).ok, false);
  assert.ok(core.validateContract(badMap).errors.some((e) => /labelMap/.test(e)));
  // 票集边词表外
  const badEdges = { ...contracts.GITHUB_CONTRACT, ticketSet: { edges: ['jql'] } };
  assert.equal(core.validateContract(badEdges).ok, false);
  // 非对象 / 数组
  assert.equal(core.validateContract(null).ok, false);
  assert.equal(core.validateContract([]).ok, false);
});

test('schema 枚举与既有引擎词表同源：票集边 / 阻塞边 / type 来源引用现存纯函数语义', () => {
  // 三预设的边来源值恰好落在既有纯模块的语义面内（票 04 的 source 值、票 02 的两来源）
  assert.deepEqual(contracts.GITHUB_CONTRACT.ticketSet.edges, ['sub-issues', 'parent-edges', 'init-list']);
  assert.deepEqual(contracts.GITHUB_CONTRACT.mapping.blockingEdges, ['native', 'inline']);
  assert.deepEqual(contracts.LOCAL_CONTRACT.mapping.blockingEdges, ['inline']);
  // canonical 词表常量即 ADR-0006 的输出词表（与 tracker-sync-core 的五角色同字面）
  assert.deepEqual(contracts.CANONICAL_ROLES, ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']);
});
