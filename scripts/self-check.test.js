'use strict';

// 自检套件：逐条校验包注册不变量。对包目录全程只读（readFile/stat/exists）。
// 「模拟破坏」用假想 fixture 喂给纯 checker（绝不改动真实文件），
// 证明每条不变量恰好被对应的那条测试守住。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  AGENT_NAMES,
  PKG_ROOT,
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
} = require('./registration-checks.js');

function readAgentFrontmatter() {
  const frontmatter = {};
  for (const agentName of AGENT_NAMES) {
    frontmatter[agentName] = parseFrontmatter(readText(PKG_ROOT, `agents/${agentName}.md`));
  }
  return frontmatter;
}

const manifest = readPackageJson(PKG_ROOT);
const packageName = manifest.name;
const skillFrontmatter = parseFrontmatter(readText(PKG_ROOT, 'SKILL.md'));

// --- 真实包树上的注册不变量（每条一个独立测试用例） ---

test('package.json declares a test script invoking node --test', () => {
  assert.deepEqual(checkTestScript(manifest), []);
});

test('every pi.skills entry points at an existing file', () => {
  assert.deepEqual(checkSkillFileRegistration(manifest, { isFile: (p) => isFileAt(PKG_ROOT, p) }), []);
});

test('every pi.subagents.agents entry points at an existing directory', () => {
  assert.deepEqual(checkAgentDirRegistration(manifest, { isDir: (p) => isDirAt(PKG_ROOT, p) }), []);
});

test('ledger script exists and --help exits 0 (mechanical-ledger protocol ships with the package)', () => {
  assert.deepEqual(checkLedgerScript({ isFile: (p) => isFileAt(PKG_ROOT, p) }), []);
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, LEDGER_SCRIPT), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `ledger.js --help must exit 0, got ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /add/);
  assert.match(r.stdout, /build/);
  assert.match(r.stdout, /check/);
});

test('SKILL.md has a parseable frontmatter block', () => {
  // 前置不变量：后续按字段断言的测试都依赖这一条——
  // frontmatter 不可解析时，本测试先红，字段测试不会被子串过滤掩蔽。
  assert.ok(skillFrontmatter, 'SKILL.md frontmatter is unparseable');
});

test('SKILL.md frontmatter name matches the package name', () => {
  assert.ok(skillFrontmatter, 'SKILL.md frontmatter is unparseable');
  const problems = checkSkillFrontmatter(skillFrontmatter, packageName).filter((p) =>
    p.includes('name')
  );
  assert.deepEqual(problems, []);
});

test('SKILL.md frontmatter has a description', () => {
  assert.ok(skillFrontmatter, 'SKILL.md frontmatter is unparseable');
  const problems = checkSkillFrontmatter(skillFrontmatter, packageName).filter((p) =>
    p.includes('description')
  );
  assert.deepEqual(problems, []);
});

test('SKILL.md frontmatter disables model auto-invocation', () => {
  assert.ok(skillFrontmatter, 'SKILL.md frontmatter is unparseable');
  const problems = checkSkillFrontmatter(skillFrontmatter, packageName).filter((p) =>
    p.includes('disable-model-invocation')
  );
  assert.deepEqual(problems, []);
});

test('all three agent files exist: coder, reviewer, final-reviewer', () => {
  const frontmatter = readAgentFrontmatter();
  const problems = checkAgentRegistration(frontmatter, packageName).filter((p) =>
    p.includes('missing agent file')
  );
  assert.deepEqual(problems, []);
});

test('every agent declares its name in package-full-name form (name + package fields)', () => {
  const frontmatter = readAgentFrontmatter();
  const problems = checkAgentRegistration(frontmatter, packageName).filter(
    (p) => !p.includes('missing agent file')
  );
  assert.deepEqual(problems, []);
});

test('coder brief carries the worktree-reality contract (block in, notes pointer out, soft fence verbatim)', () => {
  const skillText = readText(PKG_ROOT, 'SKILL.md');
  assert.deepEqual(checkCoderBriefWorktreeReality(skillText), []);
});

test('Round 0 carries the environment-survey step (survey is prose, destination is the 环境事实 notes section)', () => {
  const skillText = readText(PKG_ROOT, 'SKILL.md');
  assert.deepEqual(checkRound0EnvSurvey(skillText), []);
});

// --- 模拟破坏：假想 fixture，绝不改动真实文件。每条恰好对应一条真实不变量。 ---

test('breakage simulation: a pi.skills entry renamed to a missing file is flagged', () => {
  const broken = { pi: { skills: ['./SKILL-RENAMED-AWAY.md'] } };
  const fakeIsFile = () => false;
  assert.deepEqual(checkSkillFileRegistration(broken, { isFile: fakeIsFile }), [
    'pi.skills entry points at a missing file: ./SKILL-RENAMED-AWAY.md',
  ]);
  // 而真实树不受影响（对照：同一 checker 对假想路径断言，真实声明仍然全绿）。
  assert.deepEqual(checkSkillFileRegistration(manifest, { isFile: (p) => isFileAt(PKG_ROOT, p) }), []);
});

test('breakage simulation: a renamed agent directory is flagged', () => {
  const broken = { pi: { subagents: { agents: ['./agents-renamed'] } } };
  assert.deepEqual(checkAgentDirRegistration(broken, { isDir: () => false }), [
    'pi.subagents.agents entry points at a missing directory: ./agents-renamed',
  ]);
});

test('breakage simulation: a missing ledger script is flagged', () => {
  assert.deepEqual(checkLedgerScript({ isFile: () => false }), [
    `ledger script missing: ${LEDGER_SCRIPT} — the mechanical-ledger protocol's only write surface`,
  ]);
});

test('breakage simulation: SKILL.md name drifting from the package name is flagged', () => {
  assert.deepEqual(
    checkSkillFrontmatter({ name: 'some-other-skill', description: 'd', 'disable-model-invocation': 'true' }, packageName),
    ['SKILL.md name "some-other-skill" does not match package name "pi-matt-implement-flow"']
  );
});

test('breakage simulation: a deleted SKILL.md description is flagged', () => {
  assert.deepEqual(
    checkSkillFrontmatter({ name: packageName, 'disable-model-invocation': 'true' }, packageName),
    ['SKILL.md frontmatter is missing a description']
  );
});

test('breakage simulation: re-enabled model invocation is flagged', () => {
  assert.deepEqual(
    checkSkillFrontmatter({ name: packageName, description: 'd', 'disable-model-invocation': 'false' }, packageName),
    [
      'SKILL.md frontmatter must set disable-model-invocation: true (skill is orchestrator-only, not for model auto-invocation)',
    ]
  );
});

test('breakage simulation: an agent file going missing is flagged', () => {
  assert.deepEqual(checkAgentFrontmatter(null, 'reviewer', packageName), [
    'missing agent file for "reviewer"',
  ]);
});

test('breakage simulation: an agent losing its package field is flagged', () => {
  assert.deepEqual(
    checkAgentFrontmatter({ name: 'coder' }, 'coder', packageName),
    [
      'agent "coder" frontmatter is missing the package field — without it the agent registers under its bare name, colliding with builtin reviewer and user aliases',
    ]
  );
});

test('breakage simulation: an agent declaring a wrong package is flagged', () => {
  assert.deepEqual(
    checkAgentFrontmatter({ name: 'coder', package: 'other-pkg' }, 'coder', packageName),
    [
      'agent "coder" declares package "other-pkg", which does not match package name "pi-matt-implement-flow"',
    ]
  );
});

test('breakage simulation: a coder brief losing the Worktree reality block is flagged', () => {
  assert.deepEqual(
    checkCoderBriefWorktreeReality('Ticket 07: …\nBase commit: abc.\n').filter((p) =>
      p.includes('Worktree reality')
    ),
    ['SKILL.md is missing the "## Worktree reality" block in the coder brief']
  );
});

test('breakage simulation: the retired orchestration-notes pointer returning to the coder brief is flagged', () => {
  const withPointer = '## Worktree reality\nNotes (read if present): .pi/matt-implement/<slug>/notes.md.\n';
  assert.deepEqual(
    checkCoderBriefWorktreeReality(withPointer).filter((p) => p.includes('orchestration notes')),
    [
      'SKILL.md still points coders at the orchestration notes ("Notes (read if present)") — the pointer is retired: coders never read the orchestration notes',
    ]
  );
});

test('breakage simulation: the soft-fence sentence being reworded or dropped is flagged', () => {
  const reworded =
    '## Worktree reality\nOther tickets under .scratch/ are context, not scope — report them and continue.\n';
  assert.deepEqual(
    checkCoderBriefWorktreeReality(reworded).filter((p) => p.includes('soft-fence')),
    [
      'SKILL.md is missing the user-adjudicated soft-fence sentence ("…are context, not scope — never implement them") — do not reword or drop it',
    ]
  );
  // 换行折行不改变语义：同一句合到一行必须通过（空白归一化）。
  const unwrapped =
    '## Worktree reality\nOther tickets under .scratch/ and anything else in the main repo are context, not scope — never implement them.\n';
  assert.deepEqual(checkCoderBriefWorktreeReality(unwrapped), []);
});

test('breakage simulation: the environment-survey step going missing is flagged', () => {
  assert.deepEqual(checkRound0EnvSurvey('### Round 0\n1. Record init.\n'), [
    'SKILL.md Round 0 is missing the environment-survey step (read .gitignore, write the 环境事实 section of the orchestration notes; missing anchors: Environment survey, 环境事实)',
  ]);
  // 锚点在 Round 0 小节之外不算数：小节缺失时整条检查红。
  assert.deepEqual(checkRound0EnvSurvey('### Round 1\nEnvironment survey 环境事实\n'), [
    'SKILL.md is missing the "### Round 0" section',
  ]);
});

// --- 环境诊断（git 版本 < 2.41 的 patch 捕获降级警告）属于票 03，不在此套件内。 ---
