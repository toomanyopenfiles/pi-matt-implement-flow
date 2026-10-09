// axis-axes.js —— reviewer / final-reviewer 的双轴派发脚本（随包发货，文件路径形态调用）
//
// 调用形态（issue #9：脚本文件路径是唯一可靠交付）：
//   subagent({
//     workflow: "<this-package>/scripts/axis-axes.js",
//     args: {
//       agent: "pi-matt-implement-flow.reviewer", // 轴子代理：生产 = 调用方自身 agent（探针可注入廉价 agent）
//       context: "fork",                          // 可选，默认 "fork"（轴继承调用方的阅读）
//       timeoutMs: 14400000,                      // 必填，axis 派发前新读的配置（不是父启动值）
//       standards: "<Standards 轴任务书>",          // 必填，非空字符串
//       spec: "<Spec 轴任务书>",                    // 必填，非空字符串
//     },
//     async: <调用方契约值>,
//   })
//
// 双轴 item 的 key 钉死在本脚本（standards / spec）：runs.all 条目缺 key 会被平台整调用
// 拒绝（issue #6 的契约事实），轴任务书走 args 传入——脚本内容与调用方解耦，升级只改这里。
//
// 这是 pi-subagents 的 workflow 脚本（沙箱内无文件系统），不是 node CLI：不要 require。

for (const name of ['agent', 'standards', 'spec']) {
  if (typeof args[name] !== 'string' || !args[name].trim()) {
    throw new Error(`axis-axes.js: args.${name} must be a non-empty string`);
  }
}
if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 2147483647) {
  throw new Error('axis-axes.js: args.timeoutMs must be a positive integer no larger than 2147483647');
}
const context = typeof args.context === 'string' && args.context.trim() ? args.context : 'fork';

const results = await runs.all([
  { key: 'standards', label: 'Review against standards', agent: args.agent, context, timeoutMs: args.timeoutMs, task: args.standards },
  { key: 'spec', label: 'Review against spec', agent: args.agent, context, timeoutMs: args.timeoutMs, task: args.spec },
]);

return results.map((r) => ({
  key: r.key,
  ok: r.ok,
  runId: r.runId ?? null,
  output: r.output ?? '',
  structuredOutput: r.structuredOutput ?? null,
}));
