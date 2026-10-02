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
  EXTENSION_SCRIPT,
  checkExtensionRegistration,
  checkFlowConfigExtension,
  AGENT_TIMEOUT_MS,
  GATE_VERIFY_TIMEOUT_MS,
  checkAgentTimeouts,
  checkCoderDispatchTypedGate,
  checkDispatchSchemaMatchesSource,
  checkFixLoopHandRun,
  checkBriefsNoReportDuties,
  checkGateCommandFlags,
  checkHardRulesRetained,
  checkPureVerdictGateAndEscalation,
  checkNoIsolationBriefs,
  checkAxisSpawnContract,
  checkWorkflowScriptDelivery,
  checkDispatchScriptFiles,
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

test('pi.extensions declares the flow-config extension and the path exists', () => {
  assert.deepEqual(checkExtensionRegistration(manifest), []);
});

test('the flow-config extension file ships with the package', () => {
  assert.deepEqual(checkFlowConfigExtension(), []);
});

test('all three agents declare timeoutMs: 3600000 (1h run deadline)', () => {
  assert.deepEqual(checkAgentTimeouts(readAgentFrontmatter()), []);
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

test('breakage simulation: a removed pi.extensions declaration is flagged', () => {
  assert.deepEqual(checkExtensionRegistration({ pi: {} }), [
    'package.json: pi.extensions must declare at least one extension path',
  ]);
});

test('breakage simulation: a renamed extension directory is flagged', () => {
  assert.deepEqual(
    checkExtensionRegistration({ pi: { extensions: ['./extensions-renamed'] } }, { isFile: () => false, isDir: () => false }),
    ['pi.extensions entry points at a missing path: ./extensions-renamed'],
  );
});

test('breakage simulation: a deleted flow-config extension file is flagged', () => {
  assert.deepEqual(checkFlowConfigExtension({ isFile: () => false }), [
    `flow-config extension missing: ${EXTENSION_SCRIPT} — /matt-flow-config is its registration surface`,
  ]);
});

test('breakage simulation: an agent losing its timeoutMs is flagged', () => {
  const frontmatter = readAgentFrontmatter();
  const broken = { ...frontmatter, coder: { ...frontmatter.coder, timeoutMs: undefined } };
  const problems = checkAgentTimeouts(broken).filter((p) => p.includes('coder'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must declare timeoutMs: 3600000/);
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

// --- 票 02 断锚：typed gate 派发形态（8 条）+ breakage simulation ---
// 检查器吃 SKILL.md / agents/coder.md 文本；schema 副本与票 01 模块导出真源交叉比对。

const skillText = readText(PKG_ROOT, 'SKILL.md');
const coderAgentText = readText(PKG_ROOT, 'agents/coder.md');
const { REPORT_CONTRACT } = require('./mechanical-report.js');

test('anchor-1: coder dispatch carries a typed gate (command/output-json/schema/timeoutMs), no acceptance object or outputSchema', () => {
  assert.deepEqual(checkCoderDispatchTypedGate(skillText), []);
});

test('anchor-2: dispatch schema copy is verbatim-identical to the ticket-01 source (module export cross-check)', () => {
  assert.deepEqual(
    checkDispatchSchemaMatchesSource(skillText, REPORT_CONTRACT),
    []
  );
});

test('anchor-3: fix loop is a hand-run of the same script command (stdout is the report, exit code is the gate)', () => {
  assert.deepEqual(checkFixLoopHandRun(skillText), []);
});

test('anchor-4: briefs and the coder agent carry zero report duties (the model never hand-writes reports)', () => {
  assert.deepEqual(checkBriefsNoReportDuties(skillText, coderAgentText), []);
});

test('anchor-5: every mechanical-report gate command carries --base and --test-command', () => {
  assert.deepEqual(checkGateCommandFlags(skillText), []);
});

test('anchor-6: existing hard rules are retained (merge token, fix budget, verdict values, ledger write authority)', () => {
  assert.deepEqual(checkHardRulesRetained(skillText), []);
});

test('anchor-7: no-isolation fixers carry a pure-verdict gate with two-consecutive-reds escalation', () => {
  assert.deepEqual(checkPureVerdictGateAndEscalation(skillText), []);
});

test('anchor-8: the fifth no-isolation brief exists with zero report duties', () => {
  assert.deepEqual(checkNoIsolationBriefs(skillText), []);
});

test('breakage simulation: a dispatch block with unbalanced JS (stray timeoutMs/brace) is flagged (anchor-1)', () => {
  const brokenTail =
    '### Each round\n```js\n' +
    'const results = await runs.all([\n' +
    '  {\n' +
    '    key: "t-01",\n' +
    '    gate: {\n' +
    '      command: "node <this-package>/scripts/mechanical-report.js --base <b> --test-command \\"npm test\\"",\n' +
    '      output: "json",\n' +
    '      schema: {\n' +
    '        type: "object",\n' +
    '        required: ["headSha", "testResult", "changedFiles", "validationOutput"],\n' +
    '        properties: {},\n' +
    '        additionalProperties: false\n' +
    '      },\n' +
    '      timeoutMs: 600000\n' +
    '    }\n' +
    '      timeoutMs: 600000\n' +
    '    }\n' +
    '  }\n' +
    ']);\n' +
    'return results;\n```\n' +
    '### Verify\n';
  const problems = checkCoderDispatchTypedGate(brokenTail);
  assert.ok(
    problems.some((p) => p.includes('parseable')),
    `expected a parseable-JS problem, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: the old acceptance-object dispatch shape is flagged (anchor-1)', () => {
  const oldDispatch =
    '### Each round\n```js\n' +
    'acceptance: { level: "verified", report: "on", verify: [{ id: "gate", command: "npm test" }] },\n' +
    'outputSchema: { type: "object" }\n```\n' +
    '### Verify\n';
  const problems = checkCoderDispatchTypedGate(oldDispatch);
  assert.ok(problems.length >= 4, `expected the old shape to fail anchor-1 widely, got: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes('acceptance') || p.includes('outputSchema') || p.includes('old dispatch shape')));
  // 而真实派发不受影响（对照）。
  assert.deepEqual(checkCoderDispatchTypedGate(skillText), []);
});

test('breakage simulation: a drifted schema copy is flagged (anchor-2)', () => {
  const driftedSchema = { ...REPORT_CONTRACT.schema, required: ['headSha', 'testResult', 'changedFiles'] };
  const fixture = '### Each round\n```json\n' + JSON.stringify(driftedSchema, null, 2) + '\n```\n';
  const problems = checkDispatchSchemaMatchesSource(fixture, REPORT_CONTRACT);
  assert.ok(problems.some((p) => p.includes('drifted') || p.includes('required list')));
});

test('breakage simulation: a missing schema copy is flagged (anchor-2)', () => {
  const problems = checkDispatchSchemaMatchesSource('### Each round\nno fences here\n', REPORT_CONTRACT);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no fenced ```json schema copy/);
});

test('breakage simulation: the old run-the-suite-as-gate fix loop is flagged (anchor-3)', () => {
  const oldFixLoop =
    '### Fix loop\n' +
    'gate is rejected on a retained resume — you run the full suite and treat the result as the gate.\n' +
    'The resumed child replays its stored acceptance contract: report value + acceptanceReport.\n' +
    '### Merge\n';
  const problems = checkFixLoopHandRun(oldFixLoop);
  assert.ok(problems.some((p) => p.includes('hand-run anchor')));
  assert.ok(problems.some((p) => p.includes('old fix-loop wording')));
});

test('breakage simulation: a returning ## Acceptance Contract brief section is flagged (anchor-4)', () => {
  const withContract =
    '## Briefs\n## Acceptance Contract\nYour final structured_output call must carry acceptanceReport.\n' +
    'commit everything.\n## Hard rules\n';
  const problems = checkBriefsNoReportDuties(withContract, coderAgentText);
  assert.ok(problems.some((p) => p.includes('report duty')));
});

test('breakage simulation: a coder agent re-adding SIBLING-keys wording is flagged (anchor-4)', () => {
  const problems = checkBriefsNoReportDuties(skillText, 'acceptanceReport is a SIBLING of value.\nNo handwritten reports.\n');
  assert.ok(problems.some((p) => p.includes('agents/coder.md')));
});

test('gate 命令跨行续行时两旗标仍被识别，不误报缺旗标（anchor-5 折行归一化）', () => {
  const continued =
    'run the gate:\n' +
    'node <this-package>/scripts/mechanical-report.js \\\n' +
    '  --base <baseCommit> --test-command "npm test"\n';
  assert.deepEqual(checkGateCommandFlags(continued), []);
});

test('breakage simulation: a gate command losing --base is flagged (anchor-5)', () => {
  const problems = checkGateCommandFlags(
    'run node <this-package>/scripts/mechanical-report.js --test-command "npm test"\n'
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing --base/);
  // 折行不改变语义：命令跨行续行时两旗标仍在同一逻辑行不得误报——此处按单行匹配，散文提及不算命令。
  assert.deepEqual(checkGateCommandFlags('see scripts/mechanical-report.js (`REPORT_SCHEMA`, `--print-schema`)'), [
    'SKILL.md carries no mechanical-report gate command (`node <this-package>/scripts/mechanical-report.js …`)',
  ]);
});

test('breakage simulation: hard rules losing the merge-token clause are flagged (anchor-6)', () => {
  const problems = checkHardRulesRetained('## Hard rules\nFix budget then escalate.\n');
  assert.ok(problems.some((p) => p.includes('ticket-NN')));
});

test('breakage simulation: a no-isolation fixer without a gate or without escalation is flagged (anchor-7)', () => {
  const noGate =
    '### Merge\ndispatch one coder without isolation on the feature branch.\n' +
    '### Final gate\ndispatch one coder without isolation to fix every finding.\n## Briefs\n';
  const problems = checkPureVerdictGateAndEscalation(noGate);
  assert.ok(problems.some((p) => p.includes('pure-verdict gate')));
  assert.ok(problems.some((p) => p.includes('escalation anchor')));
});

test('breakage simulation: a pure gate smuggling output/schema is flagged (anchor-7)', () => {
  const smuggled =
    '### Merge\ngate: { command: "<testCommand>", timeoutMs: 600000, output: "json", schema: {} }\n' +
    'two consecutive reds escalate to the user.\n### Final gate\n## Briefs\n';
  const problems = checkPureVerdictGateAndEscalation(smuggled);
  assert.ok(problems.some((p) => p.includes('must not carry output/schema')));
});

test('breakage simulation: a missing fifth brief is flagged (anchor-8)', () => {
  const fourBriefs =
    '## Briefs\nall five brief templates\n### Integration fixer (no isolation)\ncommit on the feature branch.\n' +
    '## Hard rules\n';
  const problems = checkNoIsolationBriefs(fourBriefs);
  assert.ok(problems.some((p) => p.includes('fifth brief')));
});

// --- issue #6 回归护栏：双轴派发契约（阻塞调用 + 稳定 key + 不得提前收尾） ---

test('reviewer and final-reviewer axis-spawn contract: blocking call with stable keys (issue #6)', () => {
  for (const name of ['reviewer', 'final-reviewer']) {
    const text = readText(PKG_ROOT, `agents/${name}.md`) || '';
    assert.deepEqual(checkAxisSpawnContract(text), [], `agents/${name}.md violates the axis-spawn contract`);
  }
});

test('breakage simulation: an async:true axis spawn without keys and without the turn rule is flagged (issue #6)', () => {
  const broken =
    'Spawn the two axes as parallel read-only children — exactly ONE top-level `subagent` workflow call with `async: true`,\n' +
    'a `runs.all` of two children, both using your own agent, both with `context: "fork"`:\n';
  const problems = checkAxisSpawnContract(broken);
  assert.ok(problems.some((p) => p.includes('async: false')));
  assert.ok(problems.some((p) => p.includes('must not instruct `async: true`')));
  assert.ok(problems.some((p) => p.includes('stable keys')));
  assert.ok(problems.some((p) => p.includes('never-end-your-turn')));
});

// --- issue #9 回归护栏：派发交付形态（脚本写入文件 → 文件路径调用，围栏形态即红） ---

test('dispatch delivery: SKILL.md and both reviewer agents dispatch workflows in script-file form (issue #9)', () => {
  const skill = readText(PKG_ROOT, 'SKILL.md') || '';
  assert.deepEqual(checkWorkflowScriptDelivery(skill), [], 'SKILL.md violates the script-file dispatch form');
  assert.deepEqual(checkDispatchScriptFiles(skill), [], 'SKILL.md lost the dispatch-script file discipline');
  for (const name of ['reviewer', 'final-reviewer']) {
    const text = readText(PKG_ROOT, `agents/${name}.md`) || '';
    assert.deepEqual(checkWorkflowScriptDelivery(text), [], `agents/${name}.md violates the script-file dispatch form`);
  }
});

test('breakage simulation: a reply-fenced dispatch (workflow: true + same-reply block) is flagged (issue #9)', () => {
  const fenced =
    'and dispatch one wave — one top-level subagent workflow call with `async: true`:\n' +
    '```js workflow\nconst results = await runs.all([{ key: "t-01" }]);\n```\n' +
    'Then call `subagent({ workflow: true, async: true })`.\n';
  const problems = checkWorkflowScriptDelivery(fenced);
  assert.ok(problems.some((p) => p.includes('reply-fenced')));
  assert.ok(problems.some((p) => p.includes('script-file')));
});

test('breakage simulation: the removed workflowScript API and a lost file discipline are flagged (issue #9)', () => {
  const removed =
    'Then call `subagent({ workflowScript: "await runs.run(...)", async: true })`.\n' +
    'Deliver every script inline in the call.\n';
  const problems = checkWorkflowScriptDelivery(removed);
  assert.ok(problems.some((p) => p.includes('removed `workflowScript` API')));
  assert.ok(problems.some((p) => p.includes('script-file')));
  assert.ok(checkDispatchScriptFiles(removed).some((p) => p.includes('/wf/')));
});

// --- 环境诊断（git 版本 < 2.41 的 patch 捕获降级警告）属于票 03，不在此套件内。 ---
