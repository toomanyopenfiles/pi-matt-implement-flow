'use strict';

// 纯决策：给定本地 `git --version` 输出，判断是否低于 patch 捕获降级阈值（2.41）。
// 设计文档 §10.9：git < 2.41 时 pi-subagents 的 patch 捕获会静默降级为空。
// 只做决策，不做子进程调用——两侧都能在任何机器上单测。

const GIT_PATCH_THRESHOLD = { major: 2, minor: 41 };

function parseGitVersion(versionOutput) {
  const match = /version (\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

// 返回 null 表示无法解析（未知版本，不警告——警告只对已知低于阈值的情况发出）。
function gitPatchCaptureWarning(versionOutput) {
  const version = parseGitVersion(versionOutput);
  if (!version) return null;
  const below =
    version.major < GIT_PATCH_THRESHOLD.major ||
    (version.major === GIT_PATCH_THRESHOLD.major &&
      version.minor < GIT_PATCH_THRESHOLD.minor);
  return below
    ? `local git ${version.major}.${version.minor}.${version.patch} is below 2.41: pi-subagents patch capture silently degrades to empty (design docs §10.9)`
    : null;
}

module.exports = { GIT_PATCH_THRESHOLD, parseGitVersion, gitPatchCaptureWarning };
