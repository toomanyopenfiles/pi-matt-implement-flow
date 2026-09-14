'use strict';

// 票 03：git 版本探测。设计文档 §10.9 的已知坑：本机 git < 2.41 时
// pi-subagents 的 patch 捕获静默降级为空。这里把该坑变成每次测试运行的可见输出。
//
// 结构遵循 spec 的「纯判定 + 薄运行时读取」决策：
//   - gitPatchCaptureWarning(versionString) 是纯函数：版本字符串进，警告（或 null）出。
//     只有它被单元测试（两侧分支 + 不可解析输入）。
//   - readLocalGitVersion() 是唯一的进程边界：跑一次 `git --version`，失败返回 null。
//
// 警告是信息性的：由测试经 t.diagnostic() 输出，永远不会导致测试失败。

const { execFileSync } = require('node:child_process');

// patch 捕获依赖 `git apply --default-prefix`，需要 git >= 2.41。
const GIT_PATCH_CAPTURE_MIN = [2, 41, 0];

// 纯判定：给定 `git --version` 的输出（或 null/任何字符串），返回警告文本或 null。
// 不可解析的输入同样警告——环境无法证明时按坑可见处理，绝不静默放行。
function gitPatchCaptureWarning(versionOutput) {
  if (typeof versionOutput !== 'string') {
    return (
      '[git-guard] could not read the local git version; ' +
      `on git < ${GIT_PATCH_CAPTURE_MIN.join('.')} pi-subagents patch capture silently degrades to empty (design docs §10.9)`
    );
  }
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput.trim());
  if (!match) {
    return (
      '[git-guard] could not parse the local git version output; ' +
      `on git < ${GIT_PATCH_CAPTURE_MIN.join('.')} pi-subagents patch capture silently degrades to empty (design docs §10.9)`
    );
  }
  const version = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 0),
  ];
  const belowThreshold =
    version[0] !== GIT_PATCH_CAPTURE_MIN[0]
      ? version[0] < GIT_PATCH_CAPTURE_MIN[0]
      : version[1] !== GIT_PATCH_CAPTURE_MIN[1]
        ? version[1] < GIT_PATCH_CAPTURE_MIN[1]
        : version[2] < GIT_PATCH_CAPTURE_MIN[2];
  if (belowThreshold) {
    return (
      `[git-guard] local git is ${version.join('.')} (< ${GIT_PATCH_CAPTURE_MIN.join('.')}); ` +
      'pi-subagents patch capture silently degrades to empty on this machine (design docs §10.9). ' +
      'Install git >= 2.41 to restore the patch-based routes.'
    );
  }
  return null;
}

// 运行时薄读取：跑一次 `git --version`。任何失败（无 git、非零退出、输出异常）都返回 null，
// 由调用方决定以诊断形式呈现「无法验证」。
function readLocalGitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

module.exports = {
  GIT_PATCH_CAPTURE_MIN,
  gitPatchCaptureWarning,
  readLocalGitVersion,
};
