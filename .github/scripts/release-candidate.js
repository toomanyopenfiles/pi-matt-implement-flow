'use strict';

// 发布候选检查（release workflow 的验证脚本；不随 npm 包发布）：
//   1. package.json 版本是严格 semver；
//   2. CHANGELOG.md 有对应 `## [x.y.z]` 小节，抽出该小节作为 Release notes；
//   3. 把版本号写到 $GITHUB_OUTPUT（GitHub Actions）。
// tag 冲突与 npm 已发布版本的核验涉及网络，由 workflow 步骤执行。
//
// 用法：node .github/scripts/release-candidate.js [--notes-out <path>]

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const notesOut = args.includes('--notes-out') ? args[args.indexOf('--notes-out') + 1] : null;

const fail = (msg) => {
  console.error(`release-candidate: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`package.json 版本不是严格 semver: ${version}`);
}
if (!pkg.repository || !/github\.com[/:]toomanyopenfiles\/pi-matt-implement-flow(\.git)?$/.test(pkg.repository.url || '')) {
  fail(`package.json repository.url 与 GitHub 仓库不一致（provenance/可信发布要求精确匹配）: ${(pkg.repository || {}).url}`);
}

const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
const heading = `## [${version}]`;
// 行首锚定 + `]` 后限行尾/空格：避免 0.3.1 误配 0.3.10 之类的前缀碰撞。
const headingRe = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?:$| )`, 'm');
const hit = headingRe.exec(changelog);
if (!hit) fail(`CHANGELOG.md 缺少 ${heading} 小节`);
const start = hit.index;
const lineEnd = changelog.indexOf('\n', start);
const headingLine = changelog.slice(start, lineEnd === -1 ? undefined : lineEnd).trim();
const rest = changelog.slice(lineEnd === -1 ? changelog.length : lineEnd);
const nextHeading = rest.search(/\n## \[/);
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
if (!body) fail(`CHANGELOG.md 的 ${heading} 小节为空`);
const notes = `${headingLine}\n\n${body}\n`;

if (notesOut) {
  fs.writeFileSync(notesOut, notes);
  console.log(`release-candidate: notes → ${notesOut}`);
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(`release-candidate: version=${version}（格式与 CHANGELOG 小节已核对）`);
