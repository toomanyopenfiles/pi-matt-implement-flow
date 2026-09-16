# merge-base / 三点 diff / --no-ff 语义已通过检验

用户在课程 0001 答疑后的检验题中，正确推断出两点 diff 的假象：两点 diff 从 feature 新头出发比较，票 01/02 已合入的改动会以「删除」的假象出现在 ticket-03 的 diff 里。一处细微偏差当场纠正：reviewer 无 bash、无写工具，物理上改不了任何东西；损害的真实传播路径是「假 finding → changes_requested → 浪费一轮修复预算 → coder 把 01/02 的代码补回自己 worktree → 票 03 范围被污染 → 真合并时冲突」。

## Evidence

- 检验题作答：正确描述了两点 diff 显示「删除假象」的机制，并意识到它会误导判定

## Implications

- git diff 方向与 merge-base 语义可视为已掌握，后续课程直接使用，不再铺垫
- 教学观察点：用户把「改动」归到了 reviewer 头上——**角色工具边界**（谁物理上能做什么，reviewer 无 bash 无写）是本次暴露的唯一混淆点，后续讲 D9/职责表时强化
