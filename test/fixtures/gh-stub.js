'use strict';

// 有状态 gh 桩（PATH 注入）：close/comment/edit 真实改写 GH_STUB_STATE 指向的 JSON 状态，
// 调用追加进 GH_STUB_LOG。GH_STUB_FAIL=任意值模拟全失败；GH_STUB_FAIL_WRITE=<num> 或
// <num>:<command> 模拟指定写入失败。单源共享：sync-cli 黑盒与包级系统回归共用同一桩，
// 避免两份桩脚本各自漂移。

const GH_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.GH_STUB_STATE;
const log = process.env.GH_STUB_LOG;
if (log) fs.appendFileSync(log, args.join(' ') + '\\n');
const die = (msg) => { console.error('gh: ' + msg); process.exit(1); };
if (process.env.GH_STUB_FAIL) die('simulated failure (network down)');
const rest = args[0] === '-R' ? args.slice(2) : args;
const sub = rest[0];
// #17：PR 是外部收尾面；只有场景 fixture 使用此有状态命令桩，不模拟模型判断。
if (sub === 'pr') {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (rest[1] === 'list') {
    process.stdout.write(JSON.stringify(state.pr ? [state.pr] : []));
    process.exit(0);
  }
  if (rest[1] === 'ready' && state.pr) {
    state.pr.isDraft = false;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    process.exit(0);
  }
  die('unhandled PR invocation: ' + args.join(' '));
}
if (sub !== 'issue') { console.error('gh stub: unhandled invocation: ' + args.join(' ')); process.exit(64); }
const kind = rest[1];
const num = String(rest[2] ?? '');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const it = state.issues[num];
const load = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const writeFail = () => {
  const f = process.env.GH_STUB_FAIL_WRITE;
  if (!f) return false;
  delete process.env.GH_STUB_FAIL_WRITE; // 只防同进程内重入——每个 gh 调用是独立进程，跨调用各自判定
  return num === f || num + ':' + kind === f;
};
if (kind === 'view') {
  if (!it) die('issue #' + num + ' not found');
  process.stdout.write(JSON.stringify({
    number: Number(num),
    state: it.state === 'closed' ? 'CLOSED' : 'OPEN',
    assignees: (it.assignees ?? []).map((login) => ({ login })),
    comments: (it.comments ?? []).map((body) => ({ body })),
  }));
} else if (kind === 'close') {
  if (!it) die('issue #' + num + ' not found');
  if (writeFail()) die('simulated write failure (close ' + num + ')');
  const ci = rest.indexOf('--comment');
  const body = ci !== -1 ? rest[ci + 1] : null;
  const s = load();
  s.issues[num].state = 'closed';
  if (body) s.issues[num].comments.push(body);
  save(s);
} else if (kind === 'comment') {
  if (!it) die('issue #' + num + ' not found');
  if (writeFail()) die('simulated write failure (comment ' + num + ')');
  const bi = rest.indexOf('--body');
  const body = rest[bi + 1];
  const s = load();
  s.issues[num].comments.push(body);
  save(s);
} else if (kind === 'edit') {
  if (!it) die('issue #' + num + ' not found');
  if (writeFail()) die('simulated write failure (edit ' + num + ')');
  const s = load();
  const ai = rest.indexOf('--add-assignee');
  if (ai !== -1) {
    // 占坑写面（票 05 claim 子命令）：追加 assignee（幂等：已在位不重复）
    const login = rest[ai + 1];
    if (!(s.issues[num].assignees ?? []).includes(login)) s.issues[num].assignees = [...(s.issues[num].assignees ?? []), login];
    save(s);
  } else {
    const ri = rest.indexOf('--remove-assignee');
    const login = rest[ri + 1];
    s.issues[num].assignees = (s.issues[num].assignees ?? []).filter((a) => a !== login);
    save(s);
  }
} else {
  console.error('gh stub: unhandled issue subcommand: ' + kind);
  process.exit(64);
}
`;

module.exports = { GH_STUB };
