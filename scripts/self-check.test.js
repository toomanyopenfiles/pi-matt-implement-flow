'use strict';

// 自检套件：逐条校验包注册不变量。对包目录全程只读（readFile/stat/exists）。
// 「模拟破坏」用假想 fixture 喂给纯 checker（绝不改动真实文件），
// 证明每条不变量恰好被对应的那条测试守住。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
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
} = require('./registration-checks.js');
const { gitPatchCaptureWarning } = require('./git-patch-capture-guard.js');

const AGENT_NAMES = ['coder', 'reviewer', 'final-reviewer'];

function readAgentFrontmatter() {
  const frontmatter = {};
  for (const agentName of AGENT_NAMES) {
    frontmatter[agentName] = parseFrontmatter(readText(PKG_ROOT, `agents/${agentName}.md`));
  }
  return frontmatter;
}

const manifest = readPackageJson(PKG_ROOT);
const packageName = manifest.name;

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

test('SKILL.md frontmatter name matches the package name', () => {
  const problems = checkSkillFrontmatter(
    parseFrontmatter(readText(PKG_ROOT, 'SKILL.md')),
    packageName
  ).filter((p) => p.includes('name'));
  assert.deepEqual(problems, []);
});

test('SKILL.md frontmatter has a description', () => {
  const problems = checkSkillFrontmatter(
    parseFrontmatter(readText(PKG_ROOT, 'SKILL.md')),
    packageName
  ).filter((p) => p.includes('description'));
  assert.deepEqual(problems, []);
});

test('SKILL.md frontmatter disables model auto-invocation', () => {
  const problems = checkSkillFrontmatter(
    parseFrontmatter(readText(PKG_ROOT, 'SKILL.md')),
    packageName
  ).filter((p) => p.includes('disable-model-invocation'));
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

// --- 环境诊断：git 版本低于 2.41 时提示 patch 捕获降级（信息性，绝不让测试变红） ---

test('git below 2.41 emits a diagnostic warning but never fails the run', (t) => {
  const warning = gitPatchCaptureWarning(
    execFileSync('git', ['--version'], { encoding: 'utf8' })
  );
  if (warning) {
    t.diagnostic(warning);
  }
  // 本机 git 可能低于也可能高于阈值：无论哪边，测试都必须通过。
  assert.ok(true);
});
