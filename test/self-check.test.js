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
  TRUNK_DOC,
  CONTRACT_DOCUMENTS,
  resolveContractText,
  resolveContractCorpus,
  checkContractDocLocations,
  checkTrunkSkillRegistration,
  checkContractDocsPackaged,
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
  checkDispatchRunDeadlines,
  checkCoderDispatchTypedGate,
  checkDispatchSchemaMatchesSource,
  checkFixLoopHandRun,
  checkFixLoopAcceptanceDisabled,
  checkNoReportBans,
  checkGateCommandFlags,
  checkHardRulesRetained,
  checkPureVerdictGateAndRepair,
  checkNoIsolationBriefs,
  checkAxisSpawnContract,
  checkWorkflowScriptDelivery,
  checkDispatchScriptFiles,
  checkPartialDeliveryContinuation,
} = require('../scripts/registration-checks.js');
const { relocationRoot, contractRow } = require('./fixtures/contract-docs.js');

// agent 定义按注册面读：目录来自 package.json pi.subagents.agents（frontmatter 是注册事实，
// 必须在注册文件里），不在测试里写死目录。
function agentsDir() {
  const declared = manifest?.pi?.subagents?.agents ?? [];
  return String(declared[0] ?? 'agents').replace(/^\.\//, '');
}

function readAgentFrontmatter() {
  const frontmatter = {};
  for (const agentName of AGENT_NAMES) {
    frontmatter[agentName] = parseFrontmatter(readText(PKG_ROOT, `${agentsDir()}/${agentName}.md`));
  }
  return frontmatter;
}

const manifest = readPackageJson(PKG_ROOT);
const packageName = manifest.name;
// 指令文本一律按契约 id 取（权威位置见 scripts/registration-checks.js 的 CONTRACT_DOCUMENTS）：
// 检查器只吃文本，搬迁时改登记表，测试与断言原样跟随，测试里不再写文件路径。
const contractText = (id) => resolveContractText(PKG_ROOT, id);
// 指令语料（登记表全部权威文档按序拼接）：只供全局扫描（禁用词、派发交付形态）使用；
// 导航不靠它裁定——规则所在位置与披露入口另有 checkContractDocLocations。
const instructionCorpus = resolveContractCorpus(PKG_ROOT);
const skillFrontmatter = parseFrontmatter(readText(PKG_ROOT, TRUNK_DOC));

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
  assert.deepEqual(checkCoderBriefWorktreeReality(contractText('coder-brief-worktree-reality')), []);
});

test('Round 0 carries the environment-survey step (survey is prose, destination is the 环境事实 notes section)', () => {
  assert.deepEqual(checkRound0EnvSurvey(contractText('round0')), []);
});

test('pi.extensions declares the flow-config extension and the path exists', () => {
  assert.deepEqual(checkExtensionRegistration(manifest), []);
});

test('the flow-config extension file ships with the package', () => {
  assert.deepEqual(checkFlowConfigExtension(), []);
});

test('all three agents declare timeoutMs: 14400000 (4h run deadline, issue #26)', () => {
  assert.deepEqual(checkAgentTimeouts(readAgentFrontmatter()), []);
});

test('every new dispatch carries the freshly resolved run deadline; the retained resume carries none (issue #26)', () => {
  assert.deepEqual(checkDispatchRunDeadlines(contractText('run-deadlines')), []);
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
  assert.match(problems[0], /must declare timeoutMs: 14400000/);
});

test('breakage simulation: a dispatch template that drops the run deadline is flagged (issue #26)', () => {
  const skillText = contractText('run-deadlines');
  const broken = skillText.replace('    timeoutMs: RUN_TIMEOUT_MS,\n    task: `<reviewer brief', '    task: `<reviewer brief');
  assert.notEqual(broken, skillText);
  const problems = checkDispatchRunDeadlines(broken);
  assert.ok(problems.some((p) => /per-ticket review dispatch is missing the run deadline/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /fresh-dispatch template is missing `timeoutMs: RUN_TIMEOUT_MS`/.test(p)), problems.join('\n'));
});

test('breakage simulation: a resume snippet that smuggles a run deadline is flagged (issue #26)', () => {
  const skillText = contractText('run-deadlines');
  const broken = skillText.replace(
    'const r = await runs.run("fix-01-<fixNo>", { resume: "<coderRunId>",',
    'const r = await runs.run("fix-01-<fixNo>", { timeoutMs: RUN_TIMEOUT_MS, resume: "<coderRunId>",',
  );
  assert.notEqual(broken, skillText);
  assert.deepEqual(checkDispatchRunDeadlines(broken), [
    "SKILL.md retained-resume snippet must not carry a run deadline — a resume keeps the platform's retained-child contract and is never a new dispatch (issue #26)",
  ]);
});

test('breakage simulation: losing the run-deadline section or its resolution pointer is flagged (issue #26)', () => {
  const skillText = contractText('run-deadlines');
  const noSection = skillText.replace('### Run deadline (per new dispatch)', '### Deadlines (retired)');
  assert.match(checkDispatchRunDeadlines(noSection)[0], /missing the "### Run deadline" section/);
  const noCli = skillText.replaceAll('flow-config-cli.js run-timeout', 'flow-config-cli.js nothing');
  const problems = checkDispatchRunDeadlines(noCli);
  assert.ok(problems.some((p) => /run-deadline section is missing the anchor: flow-config-cli.js run-timeout/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /substitution pointer/.test(p)), problems.join('\n'));
});

test('breakage simulation: the final gate dropping the final-reviewer deadline is flagged (issue #26)', () => {
  const skillText = contractText('run-deadlines');
  const broken = skillText.replace('acceptance: false`, `timeoutMs: RUN_TIMEOUT_MS` (the run deadline', 'acceptance: false` (the run deadline');
  assert.notEqual(broken, skillText);
  const problems = checkDispatchRunDeadlines(broken);
  assert.ok(problems.some((p) => /final-reviewer dispatch must carry the run deadline/.test(p)), problems.join('\n'));
});

test('breakage simulation: the fix-loop fallback losing its deadline is flagged (issue #26)', () => {
  const skillText = contractText('run-deadlines');
  const broken = skillText.replace(
    'acceptance: false, timeoutMs: RUN_TIMEOUT_MS` (a fresh dispatch',
    'acceptance: false` (a fresh dispatch',
  );
  assert.notEqual(broken, skillText);
  const problems = checkDispatchRunDeadlines(broken);
  assert.ok(problems.some((p) => /fix-loop integrity fallback must carry the run deadline/.test(p)), problems.join('\n'));
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

const coderAgentText = contractText('coder-agent-definition');
// 简报契约的权威文本（破坏模拟从它做原句手术）。
const briefsText = contractText('briefs');
const { REPORT_CONTRACT } = require('../scripts/mechanical-report.js');

test('anchor-1: coder dispatch carries a typed gate (command/output-json/schema/timeoutMs), no acceptance object or outputSchema', () => {
  assert.deepEqual(checkCoderDispatchTypedGate(contractText('coder-dispatch-typed-gate')), []);
});

test('anchor-2: dispatch schema copy is verbatim-identical to the ticket-01 source (module export cross-check)', () => {
  assert.deepEqual(
    checkDispatchSchemaMatchesSource(contractText('dispatch-schema-copy'), REPORT_CONTRACT),
    []
  );
});

test('anchor-3: fix loop is a hand-run of the same script command (stdout is the report, exit code is the gate)', () => {
  assert.deepEqual(checkFixLoopHandRun(contractText('fix-loop')), []);
});

test('anchor-4: no report bans anywhere — the report duty is single-sourced to the platform, load-bearing close-outs stay (issue #7 负空间裁定)', () => {
  assert.deepEqual(checkNoReportBans(contractText('briefs'), coderAgentText), []);
});

test('anchor-5: every mechanical-report gate command carries --base and --test-command', () => {
  assert.deepEqual(checkGateCommandFlags(contractText('gate-commands')), []);
});

test('anchor-6: existing hard rules are retained (merge token, verdict values, ledger write authority)', () => {
  assert.deepEqual(checkHardRulesRetained(contractText('hard-rules')), []);
});

test('run/new-run.md flow configuration and new init expose reviewer/concurrency without a fix quota', () => {
  // 拆分后 Flow configuration / Round 0 都在 run/new-run.md：边界用同文档内的下一个标题。
  const config = sectionOf(contractText('preconditions-flow-config'), '## Flow configuration', '### Run deadline');
  const round0 = sectionOf(contractText('round0'), '### Round 0', null);
  assert.doesNotMatch(config + round0, /maxFixRounds|--max-fix-rounds|per-ticket fix budget/);
  assert.match(config, /--reviewer on\|off --max-concurrent N/);
});

test('run/ticket-loop.md ticket repairs use repair decisions and sequential attempts without budget escalation', () => {
  const ticket = contractText('ticket-round').match(/### Verify each finished ticket\n([\s\S]*?)(?=\n### Merge)/)?.[1] ?? '';
  assert.match(ticket, /Repair decisions/);
  assert.match(ticket, /fix-no.*attempt.*sequence/i);
  assert.doesNotMatch(ticket, /budget is consumed|rejects a third fix|two rounds are already dispatched|rejection is the escalation trigger/i);
  assert.doesNotMatch(instructionCorpus, /Fix budget then escalate|maxFixRounds|--max-fix-rounds/);
  const quotaFreeRules = '## Hard rules\nticket-NN approved changes_requested blocked\nNever hand-write or edit the ledger or the event stream.\n';
  assert.deepEqual(checkHardRulesRetained(quotaFreeRules), []);
});

test('run/ticket-loop.md formal review rounds are independent, deduplicated, and require approval for the current candidate', () => {
  const ticket = contractText('ticket-round').match(/### Verify each finished ticket\n([\s\S]*?)(?=\n### Merge)/)?.[1] ?? '';
  assert.match(ticket, /formal-review.*independent.*fix/i);
  assert.match(ticket, /same ticket.*same round.*duplicate/i);
  assert.match(ticket, /multiple repairs.*one review/i);
  assert.match(ticket, /without.*new.*fix.*fresh.*gate.*bundle.*settled/i);
  assert.match(ticket, /clarification.*withdrawal.*notes.*anomaly.*approved/i);
  assert.match(ticket, /approval.*validation.*current candidate/i);
  assert.match(ticket, /latest.*changes_requested.*merge/i);
});

test('run/recovery.md human handoff preserves escalation history without completing tickets or satisfying dependencies', () => {
  const handoff = contractText('human-handoff').match(/### Human handoff[^\n]*\n([\s\S]*?)(?=\n### )/)?.[1] ?? '';
  assert.match(handoff, /ticket-level.*escalate.*handoff.*history/i);
  assert.match(handoff, /not.*completion.*dependenc.*normal seal.*permanent/i);
  assert.match(handoff, /pending decisions.*user decisions.*pause stage.*recovery.*notes/i);
  assert.match(handoff, /ordinary.*decisions.*not.*anomaly/i);
  assert.match(handoff, /no.*pause.*resume.*authorization.*events/i);
  assert.match(handoff, /merged.*completed.*escalation history/i);
  assert.match(handoff, /unmerged.*facts.*notes.*current action/i);
  assert.match(handoff, /unmerged.*open.*downstream.*blocked/i);
  const ledger = sectionOf(contractText('ledger-discipline'), '## Ledger', '## Hard rules');
  assert.doesNotMatch(ledger, /Every state transition is recorded/);
  assert.match(ledger, /structured facts.*recorded/i);
});

test('run/recovery.md anomaly history retains facts while notes hold disposition evidence, not mechanical resolution', () => {
  const history = contractText('human-handoff').match(/### Human handoff[^\n]*\n([\s\S]*?)(?=\n### )/)?.[1] ?? '';
  assert.match(history, /anomaly.*refSeq.*immutable history/i);
  assert.match(history, /disposition.*evidence pointers.*notes/i);
  assert.match(history, /historical anomaly.*not.*closing.*unresolved/i);
  assert.match(history, /cannot.*revoke facts.*reset.*approval.*validation/i);
  assert.match(history, /evidence.*missing.*verify.*user/i);
  assert.match(history, /scripts.*not.*parse notes.*authoriz.*resolv/i);
  assert.match(history, /no.*anomaly-resolved.*event/i);
});

test('run/recovery.md cold resume verifies user-provided conditions against notes and facts without replaying completed work', () => {
  const resume = contractText('cold-resume').match(/### Cold resume[^\n]*\n([\s\S]*?)(?=\n### Round 0)/)?.[1] ?? '';
  assert.match(resume, /skip init.*pull/i);
  assert.match(resume, /rebuild.*reconcile/i);
  assert.match(resume, /notes.*referenced evidence.*git/i);
  assert.match(resume, /verify.*user.*new conditions.*evidence/i);
  assert.match(resume, /continue.*not.*all.*resolved/i);
  assert.match(resume, /necessary.*validation.*formal approval/i);
  assert.match(resume, /remaining.*not.*reimplement.*redispatch.*remerge.*completed/i);
  assert.match(resume, /running.*unsealed.*not.*child/i);
  assert.ok(resume.indexOf('Verify the user') < resume.indexOf('Recover the interrupted stage'));
});

test('run/recovery.md cold resume explains retired quotas without rewriting old settings/events or reopening sealed runs', () => {
  const resume = contractText('cold-resume').match(/### Cold resume[^\n]*\n([\s\S]*?)(?=\n### Round 0)/)?.[1] ?? '';
  assert.match(resume, /historical.*budget.*no longer.*limit/i);
  assert.match(resume, /explain.*new repair rules/i);
  assert.match(resume, /settings.*init.*event.*unchanged/i);
  assert.match(resume, /sealed.*historical.*never reopen/i);
});

test('SKILL.md repair decisions use evidence and approved scope to continue or request the user', () => {
  const decisions = sectionOf(contractText('repair-decisions'), '### Repair decisions', '## Ledger');
  assert.match(decisions, /approved scope/i);
  assert.match(decisions, /diagnostic evidence/i);
  assert.match(decisions, /continuous failures/i);
  assert.match(decisions, /request the user/i);
  assert.match(decisions, /requirements.*permissions.*external conditions/i);
  assert.match(decisions, /commit counts.*agent.*wording/i);
  assert.match(decisions, /tests.*acceptance.*safety/i);
});

test('anchor-7: no-isolation fixers keep pure-verdict gates and use repair decisions rather than two-red stops', () => {
  assert.deepEqual(checkPureVerdictGateAndRepair(contractText('merge-close')), []);
  const stages = sectionOf(contractText('merge-close'), '### Merge', null);
  assert.doesNotMatch(stages, /two consecutive reds/i);
  for (const stage of stages.split('### Final gate')) {
    assert.match(stage, /Repair decisions/);
  }
});

test('ledger discipline and cold resume reconcile before merge accounting (reconciliation stops ordinary progress, explained integration recovery still allowed)', () => {
  const ledger = sectionOf(contractText('ledger-discipline'), '## Ledger', '## Hard rules');
  assert.match(ledger, /pause ordinary dispatches, new ticket merges, and closing/i);
  assert.match(ledger, /verify and explain.*differences/i);
  assert.match(ledger, /directly resolve.*differences/i);
  assert.match(ledger, /unknown differences/i);
  assert.match(ledger, /schema.*commit.*approval.*seal/i);
  const resume = contractText('cold-resume').match(/### Cold resume[^\n]*\n([\s\S]*?)(?=\n### Round 0)/)?.[1] ?? '';
  assert.match(resume, /unrecorded merge.*integration fixer/i);
  assert.match(resume, /unrelated tickets/i);
  const merge = sectionOf(contractText('merge-close'), '### Merge', '### Final gate');
  assert.match(merge, /Only after.*validation.*passes.*record `merge`/i);
  assert.match(merge, /premature.*merge.*ticket.*green/i);
});

test('run/closing.md pre-seal sync records failure but allows verified idempotent recovery with notes evidence', () => {
  const sync = contractText('final-gate').match(/\*\*Pre-seal sync\*\*([\s\S]*?)(?=\n5\. )/)?.[1] ?? '';
  assert.match(sync, /failed sync must not seal/i);
  assert.match(sync, /record.*anomaly.*sync failed/i);
  assert.match(sync, /verify.*handle.*failure.*retry.*idempotent/i);
  assert.match(sync, /success.*evidence.*notes.*continue/i);
  assert.match(sync, /historical anomaly.*not.*permanent/i);
  assert.doesNotMatch(sync, /anomaly.*and stop to report/i);
  assert.match(sync, /sync always precedes.*ready/i);
});

test('run/ticket-loop.md an empty frontier with unfinished tickets pauses instead of entering the normal Final gate', () => {
  const loopEnd = contractText('merge-close').match(/Recompute the frontier\.([^]*?)(?=\n### Final gate)/)?.[1] ?? '';
  assert.match(loopEnd, /empty frontier.*unfinished.*not.*Final gate/i);
  assert.match(loopEnd, /user.*Partial delivery/i);
});

test('run/closing.md final repairs check each finding and record evidence-based re-review choices', () => {
  const final = sectionOf(contractText('final-gate'), '### Final gate', '### Partial delivery');
  assert.match(final, /each finding.*evidence/i);
  assert.match(final, /local.*explicit/i);
  assert.match(final, /requirements.*behavior.*broader impact.*insufficient evidence/i);
  assert.match(final, /orchestration notes/i);
  assert.match(final, /green tests.*old.*verdict.*coder.*alone/i);
  assert.match(final, /latest.*not_ready.*new.*final verdict/i);
});

test('run/closing.md partial delivery checks the current candidate and requires explicit user acceptance with notes evidence', () => {
  const partial = contractText('partial-delivery').match(/### Partial delivery[^\n]*\n([\s\S]*?)(?=\n### )/)?.[1] ?? '';
  assert.match(partial, /verify.*current.*deliverab.*not.*past merge/i);
  assert.match(partial, /completed.*unfinished.*impact.*risk/i);
  assert.match(partial, /only after.*user explicitly accepts.*branch.*SHA.*validation/i);
  assert.match(partial, /notes.*decision.*conditions.*next step/i);
  assert.match(partial, /not.*abandon.*remaining scope/i);
});

test('run/closing.md partial delivery retains an unsealed run and recovery artifacts outside the final sync chain', () => {
  assert.deepEqual(checkPartialDeliveryContinuation(contractText('partial-delivery')), []);
});

test('breakage simulation: partial-delivery continuation anchors must stay in their section', () => {
  const fixture = '### Partial delivery\nKeep unsealed tracker snapshot findings; skip final sync; follow Cold resume.\n### User abandonment\n';
  assert.deepEqual(checkPartialDeliveryContinuation(fixture), []);
  for (const anchor of ['unsealed', 'tracker snapshot', 'findings', 'final sync', 'Cold resume']) {
    const broken = fixture.replace(anchor, '') + anchor;
    assert.ok(checkPartialDeliveryContinuation(broken).some((p) => p.includes(anchor)), anchor);
  }
  assert.match(checkPartialDeliveryContinuation('### User abandonment\n')[0], /missing.*Partial delivery/);
});

test('run/closing.md user abandonment stops children and preserves unfinished code/evidence before tracker actions', () => {
  const abandon = sectionOf(contractText('user-abandonment'), '### User abandonment', null);
  assert.match(abandon, /user explicitly.*abandon/i);
  assert.match(abandon, /stop.*child.*confirm/i);
  assert.match(abandon, /preserve.*code.*evidence/i);
  assert.match(abandon, /completed.*unfinished.*branch.*SHA/i);
  assert.match(abandon, /decision.*notes/i);
  assert.match(abandon, /existing commits.*merges.*remain/i);
  assert.ok(abandon.indexOf('Stop') < abandon.indexOf('Preserve'));
});

test('run/closing.md abandonment sync must succeed before explicit abandoned close and never declares ready', () => {
  const abandon = sectionOf(contractText('user-abandonment'), '### User abandonment', null);
  assert.match(abandon, /sync .*--mode abandon .*--claimant .*--reason/);
  assert.match(abandon, /fail.*open.*anomaly/i);
  assert.match(abandon, /retry.*missing.*actions/i);
  assert.match(abandon, /contract.*no.*write surface.*no.*sync/i);
  assert.match(abandon, /success.*add close.*--outcome abandoned/i);
  assert.ok(abandon.indexOf('--mode abandon') < abandon.indexOf('--outcome abandoned'));
  assert.match(abandon, /no.*final.*escalate/i);
  assert.match(abandon, /never close unfinished tickets.*mark.*ready/i);
  assert.match(abandon, /delayed tracker.*evidence/i);
});

test('run/closing.md completed close rejects latest not_ready/escalation completion and preserves old close intent', () => {
  const final = contractText('final-gate').match(/### Final gate\n([\s\S]*?)(?=\n### User abandonment)/)?.[1] ?? '';
  assert.match(final, /--outcome completed.*omitt/i);
  assert.match(final, /latest.*not_ready.*reject.*normal/i);
  assert.match(final, /escalat.*not.*complet/i);
  assert.match(final, /User abandonment/);
  assert.doesNotMatch(final, /give-up through at warning level|record `close`.*as usual/i);
  const abandon = sectionOf(contractText('user-abandonment'), '### User abandonment', null);
  assert.match(abandon, /valid input.*initialized.*unsealed/i);
  assert.match(abandon, /sealed.*reject.*all.*events.*anomaly/i);
  assert.match(abandon, /old.*close.*outcome.*readable.*infer.*intent.*rewrite/i);
});

test('agents/coder.md follows the brief workspace for isolated tickets and serial main-feature repairs', () => {
  assert.match(coderAgentText, /ticket.*pi-managed worktree/i);
  assert.match(coderAgentText, /integration.*final.*main feature.*without isolation/i);
  assert.match(coderAgentText, /sole writer/i);
  assert.match(coderAgentText, /actual actions.*validation.*evidence pointers/i);
  assert.doesNotMatch(coderAgentText, /Your cwd is a pi-managed worktree/);
  const integrationBrief = sectionOf(briefsText, '### Integration fixer', '### Final fixer');
  const finalBrief = sectionOf(briefsText, '### Final fixer', null);
  assert.equal((integrationBrief.match(/sole writer/g) ?? []).length, 1);
  assert.equal((finalBrief.match(/sole writer/g) ?? []).length, 1);
});

test('anchor-8: the fifth no-isolation brief exists with zero report duties', () => {
  assert.deepEqual(checkNoIsolationBriefs(briefsText), []);
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
  assert.deepEqual(checkCoderDispatchTypedGate(contractText('coder-dispatch-typed-gate')), []);
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
  const problems = checkNoReportBans(withContract, coderAgentText);
  assert.ok(problems.some((p) => p.includes('report duty')));
});

test('breakage simulation: a coder agent re-adding SIBLING-keys wording is flagged (anchor-4)', () => {
  const problems = checkNoReportBans(briefsText, 'acceptanceReport is a SIBLING of value.\nNo handwritten reports.\n');
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
  const problems = checkHardRulesRetained('## Hard rules\napproved changes_requested.\n');
  assert.ok(problems.some((p) => p.includes('ticket-NN')));
});

test('breakage simulation: a no-isolation fixer without a gate or repair-decisions pointer is flagged (anchor-7)', () => {
  const noGate =
    '### Merge\ndispatch one coder without isolation on the feature branch.\n' +
    '### Final gate\ndispatch one coder without isolation to fix every finding.\n## Briefs\n';
  const problems = checkPureVerdictGateAndRepair(noGate);
  assert.ok(problems.some((p) => p.includes('pure-verdict gate')));
  assert.ok(problems.some((p) => p.includes('Repair decisions pointer')));
});

test('breakage simulation: a pure gate smuggling output/schema is flagged (anchor-7)', () => {
  const smuggled =
    '### Merge\ngate: { command: "<testCommand>", timeoutMs: 600000, output: "json", schema: {} }\n' +
    'Repair decisions.\n### Final gate\n## Briefs\n';
  const problems = checkPureVerdictGateAndRepair(smuggled);
  assert.ok(problems.some((p) => p.includes('must not carry output/schema')));
});

test('breakage simulation: a missing fifth brief is flagged (anchor-8)', () => {
  const fourBriefs =
    '## Briefs\nall five brief templates\n### Integration fixer (no isolation)\ncommit on the feature branch.\n' +
    '## Hard rules\n';
  const problems = checkNoIsolationBriefs(fourBriefs);
  assert.ok(problems.some((p) => p.includes('fifth brief')));
});

// --- issue #6 / ticket 37 回归护栏：共同双轴协议集中在共享运行文档，两类 reviewer 各自入场 ---
// 协议文本的权威位置是 `scripts/review-protocol.md`（登记表 review-protocol 行）；
// 两份 agent 定义只保留角色范围与加载入口，派发机制不再各存一份副本。

test('shared review protocol is the single axis-spawn contract (issue #6, ticket 37)', () => {
  assert.deepEqual(checkAxisSpawnContract(contractText('review-protocol')), []);
});

test('both reviewer definitions load the shared review protocol from their own entry (ticket 37)', () => {
  for (const carrier of ['agents/reviewer.md', 'agents/final-reviewer.md']) {
    const registry = [
      contractRow('review-protocol-entry', ['scripts/review-protocol.md'], {
        previous: [],
        carriers: [carrier],
        trigger: 'before dispatching the axes',
      }),
    ];
    assert.deepEqual(
      checkContractDocLocations(PKG_ROOT, { registry }),
      [],
      `${carrier} 必须自己披露共享协议：路径 + 动作前读取 + 触发条件`
    );
  }
});

test('ticket 37: 共享评审协议保留路径形态、两轴后裁决、最新时限指针、证据过滤与不跨轴合并', () => {
  // 行折行不定型：断言前把空白归一，只钉语义锚点。
  const protocol = contractText('review-protocol').replace(/\s+/g, ' ');
  // 路径形态：传输件与主仓库绝对路径，不是内联内容。
  assert.match(protocol, /three-dot diff/);
  assert.match(protocol, /absolute main-repo paths, marked read-only/i);
  // 两轴结束后才裁决 + 不跨轴合并排名 + 证据过滤。
  assert.match(protocol, /never end your turn while an axis is still running/i);
  assert.match(protocol, /## Standards. and .## Spec./i);
  assert.match(protocol, /without merging or reranking findings/i);
  assert.match(protocol, /never pick a single winner across axes/i);
  assert.match(protocol, /filter by evidence, not severity/i);
  assert.match(protocol, /No issues found\./);
  // 最新时限 + 主仓库配置指针（轴派发前重读）。
  assert.match(protocol, /run-timeout-settings\.md/);
  assert.match(protocol, /Run timeout settings/);
  assert.match(protocol, /timeoutMs: RUN_TIMEOUT_MS/);
  // 普通运行文档，不新增 skill。
  const entry = CONTRACT_DOCUMENTS.find((row) => row.id === 'review-protocol');
  assert.deepEqual(entry.docs, ['scripts/review-protocol.md']);
  assert.equal(
    manifest.pi.skills.some((skill) => String(skill).includes('review-protocol')),
    false,
    '共享协议不是 skill 注册面'
  );
});

test('breakage simulation: the shared protocol losing fresh timeout args or main-repo settings paths is flagged (#26, ticket 37)', () => {
  const text = contractText('review-protocol');
  const noDeadline = text.replaceAll('timeoutMs: RUN_TIMEOUT_MS', 'timeoutMs: 14400000');
  assert.notEqual(noDeadline, text, 'fixture surgery found no anchor — update the fixture to the current wording');
  assert.ok(checkAxisSpawnContract(noDeadline).some((p) => p.includes('timeoutMs: RUN_TIMEOUT_MS')));
  assert.notEqual(text.replaceAll('Run timeout settings', 'Retired settings'), text);
  assert.ok(
    checkAxisSpawnContract(text.replaceAll('Run timeout settings', 'Retired settings')).some((p) =>
      p.includes('settings paths')
    )
  );
  assert.notEqual(text.replaceAll('run-timeout-settings.md', 'retired.md'), text);
  assert.ok(
    checkAxisSpawnContract(text.replaceAll('run-timeout-settings.md', 'retired.md')).some((p) =>
      p.includes('resolution rules')
    )
  );
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

test('ticket 37: final-reviewer 保留跨票检查与延期 findings 处置，前提兼容 reviewer=off', () => {
  const text = contractText('final-reviewer-agent-definition');
  assert.match(text, /cross-file drift/);
  assert.match(text, /contradictions between components/);
  assert.match(text, /spec requirements with no implementing ticket/);
  assert.match(text, /docs that no longer match the shipped code/);
  assert.match(text, /minor finding deferred by per-ticket reviews/);
  assert.match(text, /reviewer=off/);
  assert.match(text, /runs either way/);
  assert.doesNotMatch(text, /after every per-ticket review has passed/);
  assert.match(text, /ready_with_fixes/);
  assert.match(text, /not_ready/);
});

test('ticket 37: reviewer 输入对齐 brief 与机械 gate 证据，标准来源定位责任明确', () => {
  const text = contractText('reviewer-agent-definition');
  assert.match(text, /typed report \(`headSha`, `testResult`\)/);
  assert.match(text, /no model-written implementer report/i);
  assert.match(text, /locating the repo's standards sources/i);
  assert.doesNotMatch(text, /already done for you/);
  assert.match(text, /approved/);
  assert.match(text, /changes_requested/);
  const brief = sectionOf(contractText('briefs'), '### Reviewer brief', '### Fix follow-up');
  assert.match(brief, /Gate evidence: the typed-gate report/);
  assert.doesNotMatch(brief, /Implementer's report/);
  assert.match(brief, /Axis script: .*axis-axes\.js/);
  assert.match(brief, /Shared protocol: .*review-protocol\.md/);
  assert.match(brief, /Run timeout settings: user: /);
});

// --- issue #9 回归护栏：派发交付形态（脚本写入文件 → 文件路径调用，围栏形态即红） ---

test('dispatch delivery: the ticket-loop and closing documents plus the shared review protocol dispatch workflows in script-file form (issue #9)', () => {
  const skill = contractText('dispatch-delivery');
  assert.deepEqual(checkWorkflowScriptDelivery(skill), [], 'SKILL.md violates the script-file dispatch form');
  assert.deepEqual(checkDispatchScriptFiles(skill), [], 'SKILL.md lost the dispatch-script file discipline');
  assert.deepEqual(
    checkWorkflowScriptDelivery(contractText('review-protocol')),
    [],
    'shared review protocol violates the script-file dispatch form'
  );
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

// --- issue #7 回归护栏：修复轮 resume 与完整性兜底一律 acceptance: false（断锚 9）+ 断锚 4 负空间 ---

test('anchor-9: fix-loop resume and the integrity fallback carry acceptance: false with no gate (issue #7)', () => {
  assert.deepEqual(checkFixLoopAcceptanceDisabled(contractText('fix-loop')), []);
});

test('breakage simulation: a fix-loop resume without acceptance: false is flagged (issue #7, 旧派发形态回潮即红)', () => {
  const oldResume =
    '### Fix loop\n' +
    '```js\nconst r = await runs.run("fix-01-r2", { resume: "<coderRunId>", task: `fix` });\n```\n' +
    "(`acceptance: false` — this round's verdict is the hand-run gate below.)\n" +
    'fall back to a fresh coder with `worktree: true, baseRef: "refs/heads/ticket-<NN>", acceptance: false` — no gate.\n' +
    '### Merge\n';
  const problems = checkFixLoopAcceptanceDisabled(oldResume);
  assert.ok(
    problems.some((p) => p.includes('resume snippet must carry `acceptance: false`')),
    `expected the old resume shape to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: a fallback fresh coder carrying a gate (or losing the no-gate rule) is flagged (issue #7)', () => {
  const gatedFallback =
    '### Fix loop\n' +
    '```js\nconst r = await runs.run("fix-01-r2", { resume: "r", task: "t", acceptance: false });\n```\n' +
    "this round's verdict is the hand-run gate below\n" +
    'fall back to a fresh coder with `worktree: true, baseRef: "refs/heads/ticket-<NN>", acceptance: false, gate: { command: "npm test" }`.\n' +
    '### Merge\n';
  const problems = checkFixLoopAcceptanceDisabled(gatedFallback);
  assert.ok(
    problems.some((p) => p.includes('gate object')),
    `expected the gated fallback to be flagged, got: ${JSON.stringify(problems)}`
  );
  assert.ok(problems.some((p) => p.includes('integrity fallback')));
});

test('breakage simulation: a report ban re-added to the coder agent is flagged (issue #7 负空间：禁令回流即红)', () => {
  const banned = `${coderAgentText}\nNo handwritten reports.\n`;
  const problems = checkNoReportBans(briefsText, banned);
  assert.ok(
    problems.some((p) => p.includes('agents/coder.md') && p.includes('report ban')),
    `expected the re-added ban to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: a report ban re-added to a brief is flagged (issue #7 负空间：双指令冲突回潮即红)', () => {
  const bannedBrief = briefsText.replace(
    'return the structured verdict.',
    'return the structured verdict. No work reports.'
  );
  assert.notEqual(bannedBrief, briefsText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(bannedBrief, coderAgentText);
  assert.ok(
    problems.some((p) => p.includes('SKILL.md') && p.includes('report ban')),
    `expected the re-added ban to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: the fix brief losing its verdict-source sentence is flagged (issue #7 边界护栏)', () => {
  const noVerdictSource = briefsText.replace(
    'hand-runs the gate for this round',
    'leaves the judging to nobody'
  );
  assert.notEqual(noVerdictSource, briefsText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(noVerdictSource, coderAgentText);
  assert.ok(
    problems.some((p) => p.includes('verdict-source')),
    `expected the lost verdict-source sentence to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: dropping a load-bearing close-out sentence is flagged (issue #7 边界护栏)', () => {
  const noPointer = coderAgentText.replaceAll('by context pointer', 'in the final message');
  assert.notEqual(noPointer, coderAgentText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(briefsText, noPointer);
  assert.ok(
    problems.some((p) => p.includes('load-bearing')),
    `expected the lost load-bearing sentence to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: re-adding "No report duties" to the fix brief is flagged (issue #7 负空间：最可能回潮的原句)', () => {
  const banned = briefsText.replace(
    'The orchestrator hand-runs the gate for this round (see Fix loop).',
    'No report duties — the orchestrator hand-runs the gate for this round (see Fix loop).'
  );
  assert.notEqual(banned, briefsText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(banned, coderAgentText);
  assert.ok(
    problems.some((p) => p.includes('report ban') && p.includes('"no report duties"')),
    `expected the re-added ban to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: dropping the dirty-tree close-out sentence is flagged (issue #7 边界护栏)', () => {
  const noDirtyRule = briefsText.replaceAll(
    'a dirty tree or an empty diff fails the gate',
    'no particular close-out rule'
  );
  assert.notEqual(noDirtyRule, briefsText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(noDirtyRule, coderAgentText);
  assert.ok(
    problems.some((p) => p.includes('load-bearing') && p.includes('dirty tree')),
    `expected the lost dirty-tree sentence to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: a single brief losing its SHA report is flagged (issue #7 逐简报钉死)', () => {
  const oneBriefLosesIt = briefsText.replace(
    'report the headSha and branch by context pointer.',
    'report the headSha and branch in the final message.'
  );
  assert.notEqual(oneBriefLosesIt, briefsText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(oneBriefLosesIt, coderAgentText);
  assert.ok(
    problems.some((p) => p.includes('Coder brief') && p.includes('SHA report')),
    `expected the single-brief loss to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: a brief re-stating the platform form duty is flagged (issue #7 复述即漂移源)', () => {
  const restated = briefsText.replace(
    'return the structured verdict.',
    'return the structured verdict. If the platform requires a form, that duty comes first.'
  );
  assert.notEqual(restated, briefsText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(restated, coderAgentText);
  assert.ok(
    problems.some((p) => p.includes('form duty')),
    `expected the restated form duty to be flagged, got: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: a dropped brief template is flagged (issue #7 模板在位)', () => {
  const droppedHeading = briefsText.replaceAll('### Reviewer brief', '### Peer review brief');
  assert.notEqual(droppedHeading, briefsText, 'fixture surgery found no anchor — update the fixture to the current wording');
  const problems = checkNoReportBans(droppedHeading, coderAgentText);
  assert.ok(
    problems.some((p) => p.includes('is missing the "### Reviewer brief" brief')),
    `expected the dropped brief template to be flagged, got: ${JSON.stringify(problems)}`
  );
});

// --- ticket 33 回归护栏：承重契约的权威位置与披露入口（让检查跟随指令搬迁） ---
// 位置由 scripts/registration-checks.js 的 CONTRACT_DOCUMENTS 登记表决定；测试按契约 id
// 取文本，不再在测试里写死文件路径。搬迁装置一律用假想根（临时目录 + 假想登记表），
// 绝不改动真实文件；负例的破坏必须真的让对应检查变红。

function sectionOf(text, start, end) {
  const s = text.indexOf(start);
  assert.notEqual(s, -1, `fixture surgery found no anchor: ${start}`);
  const e = text.indexOf(end, s + start.length);
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

test('contract registry: 每份登记的权威文档存在，非主干文档由主干以触发条件 + 动作前读取披露', () => {
  assert.deepEqual(checkContractDocLocations(PKG_ROOT), []);
});

test('contract registry: 主干就是 pi.skills 注册的技能文件（披露入口自身有注册面）', () => {
  assert.deepEqual(checkTrunkSkillRegistration(manifest), []);
});

test('contract registry: 每个契约 id 都能取到权威文本（登记表与检查器同源）', () => {
  for (const { id } of CONTRACT_DOCUMENTS) {
    assert.ok(resolveContractText(PKG_ROOT, id).length > 0, `contract id 取不到文本: ${id}`);
  }
});

test('relocation fixture: 契约搬到登记文档后检查器跟随新位置，承重规则丢失仍红', (t) => {
  const fixLoop = sectionOf(resolveContractCorpus(PKG_ROOT), '### Fix loop', '### Merge');
  assert.ok(fixLoop.includes('mechanical-report.js'), 'fixture 取自真实修复轮文本');
  const root = relocationRoot(t, { 'run/loop.md': fixLoop });
  const registry = [contractRow('fix-loop', ['run/loop.md'])];
  const text = resolveContractText(root, 'fix-loop', { registry });
  // 同一份断言，新位置照样全绿。
  assert.deepEqual(checkFixLoopHandRun(text), []);
  assert.deepEqual(checkFixLoopAcceptanceDisabled(text), []);
  // 承重规则丢失：手跑门禁锚点消失 → 红。
  const lostHandRun = text.replaceAll('mechanical-report.js', 'some-other-script.js');
  assert.notEqual(lostHandRun, text);
  assert.ok(
    checkFixLoopHandRun(lostHandRun).some((p) => p.includes('hand-run anchor')),
    `承重规则丢失必须红，实得: ${JSON.stringify(checkFixLoopHandRun(lostHandRun))}`
  );
  // 派发字段错误：修复轮 resume 的 acceptance 合同被改回 → 红。
  const lostResumeContract = text.replaceAll('acceptance: false', 'acceptance: true');
  assert.ok(
    checkFixLoopAcceptanceDisabled(lostResumeContract).some((p) => p.includes('acceptance: false')),
    '派发字段错误必须红'
  );
});

test('breakage simulation: 入口缺失 / 入口缺动作前读取语义 / 错误目标 / 权威位置缺失各自红', (t) => {
  const doc = { 'run/loop.md': '# Loop rules\n' };
  // 1) 入口缺失：主干没有任何指向登记文档的披露。
  const noEntry = relocationRoot(t, { ...doc, [TRUNK_DOC]: '# Implement, orchestrated\nNo pointers here.\n' });
  const entryProblems = checkContractDocLocations(noEntry, { registry: [contractRow('fix-loop', ['run/loop.md'])] });
  assert.ok(
    entryProblems.some((p) => p.includes('run/loop.md') && p.includes('does not disclose')),
    `入口缺失必须红，实得: ${JSON.stringify(entryProblems)}`
  );
  // 2) 入口在场但缺「动作前读取」语义：提到路径不等于动作前加载。
  const weakEntry = relocationRoot(t, {
    ...doc,
    [TRUNK_DOC]: '# Implement, orchestrated\n`run/loop.md` holds the loop rules.\n',
  });
  const weakProblems = checkContractDocLocations(weakEntry, { registry: [contractRow('fix-loop', ['run/loop.md'])] });
  assert.ok(
    weakProblems.some((p) => p.includes('pre-action read')),
    `缺动作前读取语义必须红，实得: ${JSON.stringify(weakProblems)}`
  );
  // 3) 错误目标：权威位置已搬走，主干仍指向旧路径。
  const stale = relocationRoot(t, {
    'run/ticket-loop.md': '# Loop rules\n',
    [TRUNK_DOC]: '# Implement, orchestrated\nRead `run/loop.md` before dispatching each round.\n',
  });
  const staleProblems = checkContractDocLocations(stale, {
    registry: [contractRow('fix-loop', ['run/ticket-loop.md'], { previous: ['run/loop.md'] })],
  });
  assert.ok(
    staleProblems.some((p) => p.includes('superseded')),
    `错误目标必须红，实得: ${JSON.stringify(staleProblems)}`
  );
  // 4) 权威位置缺失：登记了位置但文件没落地。
  const missing = relocationRoot(t, {
    [TRUNK_DOC]: '# Implement, orchestrated\nRead `run/loop.md` before dispatching each round.\n',
  });
  const missingProblems = checkContractDocLocations(missing, { registry: [contractRow('fix-loop', ['run/loop.md'])] });
  assert.ok(
    missingProblems.some((p) => p.includes('run/loop.md') && p.includes('missing')),
    `权威位置缺失必须红，实得: ${JSON.stringify(missingProblems)}`
  );
});

test('breakage simulation: 入口文档（agent 定义）仍指向已搬迁的旧路径即红（旧路径检查扫全部 carriers，ticket 37）', (t) => {
  // ticket 37 把共同评审协议从两份 agent 定义搬进共享运行文档：旧位置就在入口文档里，
  // 只扫主干会漏掉 agent 侧的回流指针——登记行的每份 carrier 都要查。
  const registry = [
    contractRow('review-protocol', ['scripts/review-protocol.md'], {
      previous: ['agents/old-protocol.md'],
      carriers: [TRUNK_DOC, 'agents/reviewer.md'],
      trigger: 'before dispatching the axes',
    }),
  ];
  const clean = relocationRoot(t, {
    'scripts/review-protocol.md': '# Shared review protocol\n',
    'agents/reviewer.md': '# reviewer\nRead `scripts/review-protocol.md` before dispatching the axes.\n',
    [TRUNK_DOC]: '# Implement, orchestrated\n',
  });
  assert.deepEqual(checkContractDocLocations(clean, { registry }), []);
  const stale = relocationRoot(t, {
    'scripts/review-protocol.md': '# Shared review protocol\n',
    'agents/reviewer.md':
      '# reviewer\nRead `scripts/review-protocol.md` (the rules that used to live in `agents/old-protocol.md`) before dispatching the axes.\n',
    [TRUNK_DOC]: '# Implement, orchestrated\n',
  });
  const problems = checkContractDocLocations(stale, { registry });
  assert.ok(
    problems.some((p) => p.includes('agents/old-protocol.md') && p.includes('superseded')),
    `入口文档里的旧路径必须红，实得: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: 入口段多段扫描——先前的随口提名不误杀后来的有效披露（ticket 37）', (t) => {
  const registry = [
    contractRow('fix-loop', ['run/loop.md'], { trigger: 'before dispatching the next round' }),
  ];
  const casualFirst = relocationRoot(t, {
    'run/loop.md': '# Loop rules\n',
    [TRUNK_DOC]:
      '# Implement, orchestrated\nThe docs under `run/loop.md` are context worth knowing.\n\n' +
      'Read `run/loop.md` before dispatching the next round.\n',
  });
  assert.deepEqual(
    checkContractDocLocations(casualFirst, { registry }),
    [],
    '后面已有合格披露段时，先前的随口提名不得誤报'
  );
  // 对照：只有随口提名（无动作前读取）仍然緂。
  const casualOnly = relocationRoot(t, {
    'run/loop.md': '# Loop rules\n',
    [TRUNK_DOC]: '# Implement, orchestrated\nThe docs under `run/loop.md` are context worth knowing.\n',
  });
  const problems = checkContractDocLocations(casualOnly, { registry });
  assert.ok(
    problems.some((p) => p.includes('pre-action read')),
    `只有提名没有动作前读取必须緂，实得: ${JSON.stringify(problems)}`
  );
});

test('relocation fixture: 派发模板搬到登记文档后，模板字段检查跟随新位置（字段错误仍红）', (t) => {
  // 字段检查同时钉运行时限节与各派发节：fixture 用该契约自己的登记文本（跨文档按阅读顺序拼接）。
  const templates = resolveContractText(PKG_ROOT, 'run-deadlines');
  assert.ok(/agent:\s*"pi-matt-implement-flow\./.test(templates), 'fixture 取自真实派发模板');
  const root = relocationRoot(t, { 'run/dispatch.md': templates });
  const registry = [contractRow('run-deadlines', ['run/dispatch.md'])];
  const relocated = resolveContractText(root, 'run-deadlines', { registry });
  assert.equal(relocated, templates, '登记位置决定取哪份文本');
  // 字段错误：新派发把新解析的时限换成写死值（丢字段）→ 同一套断言红。
  const hardcoded = relocated.replaceAll('timeoutMs: RUN_TIMEOUT_MS', 'timeoutMs: 14400000');
  assert.notEqual(hardcoded, relocated);
  const problems = checkDispatchRunDeadlines(hardcoded);
  assert.ok(
    problems.some((p) => /fresh-dispatch template is missing/.test(p)),
    `派发字段错误必须红，实得: ${JSON.stringify(problems)}`
  );
  assert.ok(problems.some((p) => /is missing the run deadline/.test(p)), JSON.stringify(problems));
});

test('contract registry: 每行都记录原位置、权威位置、触发入口与对应测试（对照数据完整且指针落地）', () => {
  for (const row of CONTRACT_DOCUMENTS) {
    assert.ok(row.contract && row.contract.length > 0, `缺契约摘要: ${row.id}`);
    assert.ok(row.docs.length > 0, `缺权威位置: ${row.id}`);
    assert.ok(row.previous.length > 0, `缺原位置: ${row.id}`);
    assert.ok(row.entry?.carriers?.length > 0, `缺触发入口所在文档: ${row.id}`);
    assert.ok(typeof row.entry.trigger === 'string' && row.entry.trigger.length > 0, `缺触发条件: ${row.id}`);
    assert.ok(row.tests.length > 0, `缺对应测试: ${row.id}`);
    for (const pointer of row.tests) {
      const file = pointer.split(' · ')[0];
      assert.ok(isFileAt(PKG_ROOT, file), `对照测试指针不存在: ${pointer}（契约 ${row.id}）`);
    }
    for (const carrier of [...row.docs, ...row.entry.carriers]) {
      assert.ok(isFileAt(PKG_ROOT, carrier), `登记/入口文档不存在: ${carrier}（契约 ${row.id}）`);
    }
  }
});

test('breakage simulation: 披露段缺触发条件锚点即红（触发入口不是只记录不执行）', (t) => {
  const trigger = 'before dispatching the next round';
  const registry = [contractRow('fix-loop', ['run/loop.md'], { trigger })];
  const withTrigger = relocationRoot(t, {
    'run/loop.md': '# Loop rules\n',
    [TRUNK_DOC]: '# Implement, orchestrated\nRead `run/loop.md` before dispatching the next round.\n',
  });
  assert.deepEqual(checkContractDocLocations(withTrigger, { registry }), []);
  const withoutTrigger = relocationRoot(t, {
    'run/loop.md': '# Loop rules\n',
    [TRUNK_DOC]: '# Implement, orchestrated\nRead `run/loop.md` before acting.\n',
  });
  const problems = checkContractDocLocations(withoutTrigger, { registry });
  assert.ok(
    problems.some((p) => p.includes('trigger')),
    `缺触发条件锚点必须红，实得: ${JSON.stringify(problems)}`
  );
});

test('breakage simulation: 入口所在文档（carrier）缺失即红', (t) => {
  const root = relocationRoot(t, {
    'run/loop.md': '# Loop rules\n',
    [TRUNK_DOC]: '# Implement, orchestrated\nRead `run/loop.md` before dispatching the next round.\n',
  });
  const registry = [
    contractRow('fix-loop', ['run/loop.md'], { carriers: ['run/missing-trunk.md'] }),
  ];
  const problems = checkContractDocLocations(root, { registry });
  assert.ok(
    problems.some((p) => p.includes('run/missing-trunk.md') && p.includes('missing')),
    `入口文档缺失必须红，实得: ${JSON.stringify(problems)}`
  );
});

test('relocation fixture: 派发交付契约搬到登记文档后，护栏跟随新位置（承重纪律丢失仍红）', (t) => {
  const delivery = contractText('dispatch-delivery');
  const root = relocationRoot(t, { 'run/dispatch.md': delivery });
  const registry = [contractRow('dispatch-delivery', ['run/dispatch.md'])];
  const relocated = resolveContractText(root, 'dispatch-delivery', { registry });
  assert.equal(relocated, delivery, '登记位置决定取哪份文本');
  // 同一份断言，新位置照样全绿。
  assert.deepEqual(checkWorkflowScriptDelivery(relocated), []);
  assert.deepEqual(checkDispatchScriptFiles(relocated), []);
  // 承重纪律丢失：落盘目录约定消失 → 红。
  const lostWfDir = relocated.replaceAll('/wf/', '/elsewhere/');
  assert.notEqual(lostWfDir, relocated);
  assert.ok(
    checkDispatchScriptFiles(lostWfDir).some((p) => p.includes('/wf/')),
    '落盘纪律丢失必须红'
  );
  // 围栏形态回潮（workflow: true）→ 红。
  const fenced = relocated.replace('workflow: "./.pi/matt-implement/<slug>/wf/', 'workflow: true, // ');
  assert.notEqual(fenced, relocated, 'fixture surgery found no anchor — update the fixture to the current wording');
  assert.ok(
    checkWorkflowScriptDelivery(fenced).some((p) => p.includes('reply-fenced')),
    '围栏形态回潮必须红'
  );
});

test('breakage simulation: 主干没被 pi.skills 注册即红（披露入口自身的注册面）', () => {
  assert.deepEqual(checkTrunkSkillRegistration({ pi: { skills: ['./SOMETHING-ELSE.md'] } }), [
    `package.json: pi.skills does not register the trunk instruction doc (${TRUNK_DOC}) — 主干是披露入口的入口，未注册即整套指令不可达`,
  ]);
});

// --- 环境诊断（git 版本 < 2.41 的 patch 捕获降级警告）属于票 03，不在此套件内。 ---
