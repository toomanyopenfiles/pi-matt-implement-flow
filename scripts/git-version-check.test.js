'use strict';

// 票 03：git 版本探测——patch 降级坑机器可见。
// 纯判定（版本字符串进、警告与否出）+ 一次性运行时读取（git --version）。
// 警告只经测试跑器的诊断通道（t.diagnostic）输出，任何分支都不会判红。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  GIT_PATCH_CAPTURE_MIN,
  gitPatchCaptureWarning,
  readLocalGitVersion,
} = require('./git-version-check.js');

test('git version below 2.41 yields a patch-capture degradation warning', () => {
  const warning = gitPatchCaptureWarning('git version 2.39.5 (Apple Git-154)');
  assert.ok(warning, 'expected a warning for git 2.39.5');
  assert.match(warning, /2\.41/);
  assert.match(warning, /patch capture/i);
});

test('git version at or above 2.41 yields no warning', () => {
  assert.equal(gitPatchCaptureWarning('git version 2.41.0'), null);
  assert.equal(gitPatchCaptureWarning('git version 2.45.1 (Apple Git-154)'), null);
});

test('an unparseable git version string still warns (never silently passes)', () => {
  const warning = gitPatchCaptureWarning('git: command not found');
  assert.ok(warning, 'expected a warning when the version cannot be parsed');
});

test('the decision never throws, whatever string it is fed', () => {
  for (const input of [null, undefined, '', 'git version', 42, 'git version x.y.z']) {
    const outcome = gitPatchCaptureWarning(input);
    assert.ok(outcome === null || typeof outcome === 'string');
  }
});

test('local git version is read and any degradation is emitted as a diagnostic', (t) => {
  const version = readLocalGitVersion();
  // 读取失败（无 git / 不可解析）返回 null——诊断照发，测试照绿。
  const warning =
    version === null
      ? '[git-guard] could not read the local git version (git --version failed or was unparseable); ' +
        `on git < ${GIT_PATCH_CAPTURE_MIN.join('.')} pi-subagents patch capture silently degrades to empty (design docs §10.9)`
      : gitPatchCaptureWarning(version);
  if (warning) t.diagnostic(warning);
  assert.ok(
    version === null || /^git version \d+\.\d+/.test(version),
    'runtime read must return null or a "git version X.Y..." string'
  );
});
