'use strict';

// 票 05：snapshot-init 子命令黑盒测试——真实调用 ledger CLI，断言退出码、stdout、落盘产物。
// gh 收发是 best-effort 薄 IO（spec 测试决策：不设缝、不碰网络）——测试通过 PATH 注入 gh 桩
// 二进制供给合成 issue 数据，生产代码不含任何测试钩子。快照已存在的拒绝与零覆盖、
// gh 失败的清晰报错与无半成品，都在这个外部行为面上验证。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER = path.resolve(__dirname, 'ledger.js');

// --- gh 桩：按首个参数分派（issue list / api sub_issues / api dependencies/blocked_by / repo view）---
// api 分支按路径二次分派：sub_issues 与 dependencies/blocked_by 两个 REST 端点（票 05 薄 IO 的全部收口）。
// deps 桩默认返回空数组（无 native 边，既有用例行为不变）；GH_STUB_DEPS 给目录时按 issue 号读
// <目录>/<号>.json，缺文件回退 []；GH_STUB_DEPS_FAIL 模拟端点失败。
const GH_STUB = `#!/usr/bin/env bash
if [[ -n "$GH_STUB_FAIL" ]]; then echo "gh: simulated failure (network down)" >&2; exit 1; fi
case "$1" in
  issue) cat "$GH_STUB_ISSUES" ;;
  api)
    case "$2" in
      */sub_issues)
        if [[ -n "$GH_STUB_SUBS" ]]; then cat "$GH_STUB_SUBS"; else echo "gh: sub_issues fixture missing" >&2; exit 1; fi ;;
      */dependencies/blocked_by)
        if [[ -n "$GH_STUB_DEPS_FAIL" ]]; then echo "gh: simulated deps failure" >&2; exit 1; fi
        if [[ -z "$GH_STUB_DEPS" ]]; then echo "[]"; exit 0; fi
        n=$(printf '%s' "$2" | sed -E 's|.*/issues/([0-9]+)/dependencies.*|\\1|')
        if [[ -f "$GH_STUB_DEPS/$n.json" ]]; then cat "$GH_STUB_DEPS/$n.json"; else echo "[]"; fi ;;
      *) echo "gh stub: unhandled api path: $2" >&2; exit 64 ;;
    esac ;;
  repo) if [[ -n "$GH_STUB_REPO" ]]; then printf '{"nameWithOwner":"%s"}\\n' "$GH_STUB_REPO"; else echo "gh: repo fixture missing" >&2; exit 1; fi ;;
  *) echo "gh stub: unhandled invocation: $*" >&2; exit 64 ;;
esac
`;

// --- 合成 issue 集合（gh issue list --json 的产物形态）---
const ISSUES = JSON.stringify([
  {
    number: 1042,
    title: 'GitHub tracker 一等公民支持',
    body: '## Solution\n\n快照 + 同步。',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
    url: 'https://github.com/o/r/issues/1042',
  },
  {
    number: 1043,
    title: 'Issue transcription pure fns',
    body: '## Parent\n\n#1042\n\n**Blocked by:** —',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
    url: 'https://github.com/o/r/issues/1043',
  },
  {
    number: 1044,
    title: 'Sync command',
    body: '## Parent\n\n#1042\n\nBlocked by: 1043',
    state: 'CLOSED',
    labels: [],
    url: 'https://github.com/o/r/issues/1044',
  },
  {
    number: 9000,
    title: 'Unrelated feature issue',
    body: '别的 spec 的票，不在本 run 票集',
    state: 'OPEN',
    labels: [],
    url: 'https://github.com/o/r/issues/9000',
  },
]);
const SUBS_1042 = JSON.stringify([{ number: 1043 }, { number: 1044 }]);
// 无 Parent 边的变体（走 init 票号清单兜底）
const ISSUES_NO_EDGES = JSON.stringify([
  {
    number: 1042,
    title: 'GitHub tracker 一等公民支持',
    body: 'spec 正文',
    state: 'OPEN',
    labels: [],
    url: 'https://github.com/o/r/issues/1042',
  },
  {
    number: 1043,
    title: 'Issue transcription pure fns',
    body: '无边票据',
    state: 'OPEN',
    labels: [],
    url: 'https://github.com/o/r/issues/1043',
  },
  {
    number: 1044,
    title: 'Sync command',
    body: '无边票据',
    state: 'CLOSED',
    labels: [],
    url: 'https://github.com/o/r/issues/1044',
  },
]);

// --- fixture ---

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, GH_STUB);
  fs.chmodSync(gh, 0o755);
  return { dir, bin, runtime: path.join(dir, '.pi/matt-implement/demo'), tracker: path.join(dir, '.pi/matt-implement/demo/tracker') };
}

function snapshot(f, args, env = {}) {
  const r = spawnSync(process.execPath, [LEDGER, 'snapshot-init', ...args], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const withGh = (f, extra = {}) => ({
  GH_STUB_ISSUES: path.join(f.dir, 'issues.json'),
  GH_STUB_REPO: 'o/r',
  GH_STUB_SUBS: path.join(f.dir, 'subs.json'),
  ...extra,
});

function writeStubData(f, { issues = ISSUES, subs = SUBS_1042 } = {}) {
  fs.writeFileSync(path.join(f.dir, 'issues.json'), issues);
  if (subs) fs.writeFileSync(path.join(f.dir, 'subs.json'), subs);
}

function lsIssues(f) {
  return fs.existsSync(path.join(f.tracker, 'issues'))
    ? fs.readdirSync(path.join(f.tracker, 'issues')).sort()
    : [];
}

// ====================================================================
// 成功路径：拉取 → 解析 → 转写 → 落盘
// ====================================================================

test('snapshot-init 成功：spec.md 带 Source 行与 Type: spec 豁免标记，票文件名带原生票号', (t) => {
  const f = makeFixture(t);
  writeStubData(f);
  const r = snapshot(f, ['--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/1042'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const specText = fs.readFileSync(path.join(f.tracker, 'spec.md'), 'utf8');
  assert.match(specText, /^Source: https:\/\/github\.com\/o\/r\/issues\/1042$/m, 'Source 行记录 tracker 原址');
  assert.match(specText, /^\*\*Type:\*\* spec$/m, 'spec 母票豁免标记');
  assert.deepEqual(lsIssues(f), [
    '1043-issue-transcription-pure-fns.md',
    '1044-sync-command.md',
  ], '每票一文件，文件名带原生票号（转写 slug）');
  const closed = fs.readFileSync(path.join(f.tracker, 'issues', '1044-sync-command.md'), 'utf8');
  assert.match(closed, /^\*\*Status:\*\* resolved$/m, 'closed → resolved（02 的状态映射表）');
  assert.match(closed, /^\*\*Blocked by:\*\* 1043$/m, '正文阻塞边过 02 的阻塞映射表');
  assert.match(r.stdout, /快照落盘/);
  assert.match(r.stdout, /票集边界=sub-issues/, 'sub-issues 桩命中层 ①');
  assert.equal(fs.existsSync(`${f.tracker}.incoming`), false, '无落盘草稿残留');
});

test('sub-issues 拉取失败 best-effort：走 ## Parent 反查定界并给出警告，快照照常落盘', (t) => {
  const f = makeFixture(t);
  writeStubData(f, { subs: null });
  const r = snapshot(f, ['--runtime-dir', f.runtime, '--spec', '#1042'], withGh(f, { GH_STUB_SUBS: '' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /票集边界=parent-edges/, '兜底层 ② 定界');
  assert.match(r.stdout, /sub-issues/, '警告点名 sub-issues 拉取失败');
  assert.deepEqual(lsIssues(f), ['1043-issue-transcription-pure-fns.md', '1044-sync-command.md']);
});

test('--tickets 兜底：三层走到 init 票号清单——按清单落盘', (t) => {
  const f = makeFixture(t);
  writeStubData(f, { issues: ISSUES_NO_EDGES, subs: null });
  const r = snapshot(
    f,
    ['--runtime-dir', f.runtime, '--spec', '#1042', '--tickets', '1043,1044'],
    withGh(f, { GH_STUB_SUBS: '' })
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /票集边界=init-list/);
  assert.deepEqual(lsIssues(f), ['1043-issue-transcription-pure-fns.md', '1044-sync-command.md']);
});

// ====================================================================
// native 依赖边：dependencies/blocked_by 拉取 → issue.blockedBy 注入（integration-05 缺陷 1）
// ====================================================================

test('native 依赖边进快照：REST blocked_by 注入 → 票文件 Blocked by 行带原生边（正文无行也照落）', (t) => {
  const f = makeFixture(t);
  // 正文不含 Blocked by 行——Blocked by 只能来自 native 边，证明不是正文行的功劳
  fs.writeFileSync(
    path.join(f.dir, 'issues.json'),
    JSON.stringify([
      {
        number: 1042,
        title: 'GitHub tracker 一等公民支持',
        body: 'spec 正文',
        state: 'OPEN',
        labels: [],
        url: 'https://github.com/o/r/issues/1042',
      },
      {
        number: 1043,
        title: 'blocker ticket',
        body: '无阻塞',
        state: 'OPEN',
        labels: [],
        url: 'https://github.com/o/r/issues/1043',
      },
      {
        number: 1044,
        title: 'blocked ticket',
        body: '无正文阻塞边',
        state: 'OPEN',
        labels: [],
        url: 'https://github.com/o/r/issues/1044',
      },
    ])
  );
  fs.writeFileSync(path.join(f.dir, 'subs.json'), JSON.stringify([{ number: 1043 }, { number: 1044 }]));
  const deps = path.join(f.dir, 'deps');
  fs.mkdirSync(deps);
  fs.writeFileSync(path.join(deps, '1044.json'), JSON.stringify([{ number: 1043 }]));
  fs.writeFileSync(path.join(deps, '1043.json'), JSON.stringify([]));
  const r = snapshot(
    f,
    ['--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/1042'],
    { ...withGh(f), GH_STUB_DEPS: deps }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const blocked = fs.readFileSync(path.join(f.tracker, 'issues', '1044-blocked-ticket.md'), 'utf8');
  assert.match(blocked, /^\*\*Blocked by:\*\* 1043$/m, 'native blocked_by 边落 Blocked by 行');
  const blocker = fs.readFileSync(path.join(f.tracker, 'issues', '1043-blocker-ticket.md'), 'utf8');
  assert.match(blocker, /^\*\*Blocked by:\*\* —$/m, '无边票据仍落占位 —');
  const specText = fs.readFileSync(path.join(f.tracker, 'spec.md'), 'utf8');
  assert.equal(
    (specText.match(/^\*\*\s*Status\s*:/gim) ?? []).length,
    1,
    'spec.md 恰好一行 Status（integration-05 缺陷 2，黑盒同验）'
  );
});

test('native 依赖边拉取失败：best-effort 警告不拦快照，该票 Blocked by 落占位 —（与 sub-issues 同待遇）', (t) => {
  const f = makeFixture(t);
  writeStubData(f);
  const r = snapshot(
    f,
    ['--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/1042'],
    { ...withGh(f), GH_STUB_DEPS_FAIL: '1' }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /原生依赖边拉取失败/, '警告点名依赖边拉取失败');
  const closed = fs.readFileSync(path.join(f.tracker, 'issues', '1044-sync-command.md'), 'utf8');
  assert.match(closed, /^\*\*Blocked by:\*\* 1043$/m, '正文 Blocked by 行仍在（兜底层不因 native 失败丢失）');
  assert.equal(fs.existsSync(`${f.tracker}.incoming`), false, '无落盘草稿残留');
});

// ====================================================================
// 续跑保护：快照已存在时拒绝，既有内容零覆盖
// ====================================================================

test('快照已存在：拒绝执行并说明原因，既有内容零覆盖', (t) => {
  const f = makeFixture(t);
  writeStubData(f);
  const first = snapshot(f, ['--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/1042'], withGh(f));
  assert.equal(first.status, 0, first.stdout);

  // 篡改既有内容 + 塞入额外文件——重跑不得动它们分毫
  const specPath = path.join(f.tracker, 'spec.md');
  fs.writeFileSync(specPath, 'TAMPERED\n');
  fs.writeFileSync(path.join(f.tracker, 'issues', '9999-keep.md'), 'keep\n');

  const again = snapshot(f, ['--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/1042'], withGh(f));
  assert.equal(again.status, 1);
  assert.match(again.stdout, /快照已存在/);
  assert.match(again.stdout, /拒绝|续跑保护/);
  assert.equal(fs.readFileSync(specPath, 'utf8'), 'TAMPERED\n', '既有 spec.md 零覆盖');
  assert.equal(fs.readFileSync(path.join(f.tracker, 'issues', '9999-keep.md'), 'utf8'), 'keep\n', '既有票文件零覆盖');
});

// ====================================================================
// gh 薄 IO 失败：报错清晰、不产生半成品快照
// ====================================================================

test('gh 拉取失败：报错清晰，快照零落盘（无半成品）', (t) => {
  const f = makeFixture(t);
  writeStubData(f);
  const r = snapshot(
    f,
    ['--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/1042'],
    { ...withGh(f), GH_STUB_FAIL: '1' }
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /gh issue list 拉取失败/);
  assert.match(r.stdout, /未落盘|半成品/);
  assert.equal(fs.existsSync(f.tracker), false, '失败不落盘');
  assert.equal(fs.existsSync(`${f.tracker}.incoming`), false, '无落盘草稿残留');
});

// ====================================================================
// 拒绝面：引用与旗标
// ====================================================================

test('local 路径 spec 引用：拒绝并提示 tracker=local 无需快照', (t) => {
  const f = makeFixture(t);
  writeStubData(f);
  const r = snapshot(f, ['--runtime-dir', f.runtime, '--spec', '.scratch/demo/spec.md'], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /spec 引用无法解析出 issue 号/);
  assert.match(r.stdout, /tracker=local 无需快照/);
  assert.equal(fs.existsSync(f.tracker), false);
});

test('缺 --spec 或给未知旗标：用法拒绝（exit 2），不触碰 gh', (t) => {
  const f = makeFixture(t);
  const missing = snapshot(f, ['--runtime-dir', f.runtime], withGh(f));
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /缺少必选参数 --spec/);

  const bogus = snapshot(f, ['--runtime-dir', f.runtime, '--spec', '#1042', '--bogus', 'x'], withGh(f));
  assert.equal(bogus.status, 2);
  assert.match(bogus.stdout, /未知旗标 --bogus/);
  assert.equal(fs.existsSync(f.tracker), false);
});
