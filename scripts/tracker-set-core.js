'use strict';

// 票集解析（tracker 同步核心的第三组纯函数）——票 04 解析、票 05 契约化。
// 从 spec 引用与 tracker 的 issue 集合表示解析出一次 run 的票号集合；兜底链与引用形态
// 由契约驱动（contract.ticketSet.edges / contract.identity），不再按 tracker 形态分叉：
//   ① spec issue 的原生 sub-issues（仅当 'sub-issues' 在兜底链里）
//   ② `## Parent` 边反查（上游 issue-template 自带的正文边：每张工单正文引用 spec issue；
//      仅当 'parent-edges' 在兜底链里）
//   ③ init 票号清单（兜底层；同一清单以 --tickets 旗标冻结进账本，防中途偷加票）
// spec 母票不进任务票集合——封账门按 Type: spec 豁免，解析产物与票 02 的转写口径一致。
// 本模块不做任何 IO；票号归一与账本共用 ledger-schema 的 normalizeTicket（单一转换点）。
//
// 契约注入（票 05 接缝②参数化）：input { contract } 是 01 的解析产物（或合成契约）；
// 缺省 = 未经判型的调用面沿用既有形态（票 04 的三层链 + 既有引用形态）——等价于 github
// 契约的兜底链，既有测试与调用面零改动。
//
// issue 集合表示（快照初始化的拉取产物，形态由调用方供给）：
//   [{ number: <issue 号>, body: '<正文>', subIssues?: [<issue 号>, ...] }]

const { normalizeTicket } = require('./ledger-schema');
const { GITHUB_CONTRACT } = require('./tracker-contracts');

// ------------------------------------------------------------------
// 形态编译：契约 identity 是数据，解析正则由它派生（票 05 接缝②，零 per-tracker 硬编码）
// ------------------------------------------------------------------

// 形态模板里的占位符按形状处理，不看名字：
//   - 该形态最后一个占位符 = 票号（\d{1,6}；票号语法三种 tracker 不动，ADR-0004）
//   - 紧贴 scheme:// 的第一占位符 = host（[^/\s]+，容忍点号；hostLiteral 存在时不用）
//   - 其余占位符 = 命名段（[\w.-]+）
// 字面文本（'issues'、'-/'、'github.com'…）转义后按原文匹配。
const PLACEHOLDER_RE = /<([^<>]+)>/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 形态模板 → { re, numGroup, groupCount }：
//   非整 URL 形态（无 scheme）整引用锚定 ^…$（'o/r#205' 是完整引用，散文不算）；
//   整 URL 形态不锚左端、尾巴容忍 [?#] 后缀（'…/issues/7?tab=reactions'，既有 GitHub
//   URL 容忍同口径）。
function compileForm(pattern) {
  const text = String(pattern);
  const cells = [...text.matchAll(PLACEHOLDER_RE)];
  if (!cells.length) return null;
  const numCell = cells[cells.length - 1];
  const isUrlForm = /:\/\//.test(text);
  let source = isUrlForm ? '' : '^';
  let at = 0;
  let groupCount = 0;
  let numGroup = 0;
  let hostGroup = 0;
  for (const cell of cells) {
    const literal = text.slice(at, cell.index);
    // host 段（gitlab 的 'https://<host>/…'）：紧贴 scheme 的第一占位符。
    // host 是实例地址，不属于 repo 组（repoOfSpecRef 提取 owner/repo 时跳过）。
    const isHost = cell === cells[0] && /^https?:\/\/$/.test(literal) && cell !== numCell;
    source += escapeRe(literal);
    if (isHost) {
      source += '([^/\\s]+)';
      hostGroup = groupCount + 1;
    } else if (cell === numCell) {
      source += '(\\d{1,6})';
      numGroup = groupCount + 1;
    } else source += '([\\w.-]+)';
    groupCount += 1;
    at = cell.index + cell[0].length;
  }
  source += escapeRe(text.slice(at));
  if (isUrlForm) {
    // scheme 容忍 http/https（既有行为同口径）；URL 形态不锚左端
    source = source.replace(/^https:/, 'https?:');
    source += '(?:[?#].*)?$';
  } else {
    source += '$';
  }
  return { re: new RegExp(source), numGroup, groupCount, hostGroup };
}

// 契约 identity（或缺省 = 既有 github 四形态口径）的 spec 引用形态组。
function refForms(contract) {
  const identity = contract?.identity ?? GITHUB_CONTRACT.identity;
  const forms = [];
  for (const form of identity.specRef?.accepts ?? []) {
    const compiled = compileForm(form);
    if (compiled) forms.push(compiled);
  }
  return forms;
}

// spec 引用 → issue 号（单一转换点）：按契约形态清单解析（形态来自
// identity.specRef.accepts；GitHub 契约下与票 04 的四形态行为等价）；local 的 spec 引用
// 是文件路径，不经票号解析（返回 null）。形态外（散文、超 6 位、空值）一律解析不出。
function parseSpecRef(specRef, { contract } = {}) {
  const s = String(specRef ?? '').trim();
  if ((contract?.identity ?? GITHUB_CONTRACT.identity).specRef.kind === 'path') return null;
  for (const form of refForms(contract)) {
    const m = form.re.exec(s);
    if (m) {
      const num = normalizeTicket(m[form.numGroup]);
      if (num) return num;
    }
  }
  return null;
}

// spec 引用 → owner/repo（供 api REST 路径模板的 <repo> 占位与 -R 作用域）：形态里
// 票号之前的命名段联 '/'。纯票号 / #号不携带 repo（返回 null，调用方走契约的 repoView
// 探测，不猜）。缺省（契约未注入）= 既有 github 两带前缀形态口径。
function repoOfSpecRef(specRef, { contract } = {}) {
  const s = String(specRef ?? '').trim();
  for (const form of refForms(contract)) {
    const m = form.re.exec(s);
    if (m && form.numGroup > 1) {
      const parts = [];
      for (let g = 1; g < form.numGroup; g++) {
        if (form.hostGroup && g === form.hostGroup) continue; // host 占位符不是 repo 段
        parts.push(m[g]);
      }
      const repo = parts.join('/');
      if (repo) return repo;
    }
  }
  return null;
}

// tracker 原址 URL → { num, repo }：契约 identity.sourceUrl（host + path 形态数据）派生
// 的正则；GitHub 契约下与既有 /github\.com\/…/ 口径等价；host=null 的契约（自建实例，
// spec User Story 9）按路径形态识别、不认域名。解析不出返回 null（调用方按拒绝处理）。
// repo = 票号之前的命名段联 '/'（owner/repo 或 namespace/project）。
function parseTrackerUrl(url, { contract } = {}) {
  const s = String(url ?? '').trim();
  const identity = contract?.identity ?? GITHUB_CONTRACT.identity;
  const sourceUrl = identity.sourceUrl;
  if (sourceUrl.kind !== 'url') return null;
  const path = compileForm(String(sourceUrl.path ?? ''));
  if (!path) return null;
  // path 正则去锚（'^(…)$' → '…'）：'/<owner>/<repo>/issues/<num>' → host 前缀 + path 段
  const pathSource = path.re.source.slice(1, -1);
  // host 前缀：契约给出 host → 字面精确匹配；host=null → 任意 host（路径形态识别，
  // spec User Story 9：自建实例按路径识别，不认域名）
  const prefix = sourceUrl.host ? escapeRe(String(sourceUrl.host)) : '[^/\\s]+';
  const re = new RegExp(`(?:https?:\\/\\/)?(?:${prefix})${pathSource}`);
  const m = re.exec(s);
  if (!m) return null;
  const num = normalizeTicket(m[path.numGroup]);
  if (!num) return null;
  // repo = 票号之前的命名段联 '/'（owner/repo 或 namespace/project）；纯 '/issues/<num>'
  // 类无命名段形态 → repo null（调用方按需走 -R/cwd 解析，不猜）
  const parts = [];
  for (let g = 1; g < path.numGroup; g++) parts.push(m[g]);
  return { num, repo: parts.length ? parts.join('/') : null };
}

// ------------------------------------------------------------------
// ## Parent 边反查（仅 'parent-edges' 在兜底链时启用）
// ------------------------------------------------------------------

// 正文里的 `## Parent` 边（上游 issue-template 的父子关系信号）。三值返回：
//   null  —— 正文没有 `## Parent` 节（没有边）
//   []    —— 有节但没引用任何 issue 号（有边、无引用）
//   [num] —— 节内引用的 issue 号（去重归一；只支持单一父票，多条即多义，由调用方裁决）
// 节的范围：`## Parent` 独占一行起，到下一个任意级别的标题行（或正文结尾）为止；
// 引用认 `#号` 与 `/issues/号`（URL）两种写法；节外的散文数字不算引用。
const PARENT_HEADING = /^##\s+Parent\s*$/;
const HEADING_LINE = /^#{1,6}\s+\S/;
const NUM_IN_SECTION = /#(\d{1,6})\b|\/issues\/(\d{1,6})\b/g;

function parseParentEdge(body) {
  if (body == null) return null;
  const lines = String(body).split('\n');
  const start = lines.findIndex((l) => PARENT_HEADING.test(l.trim()));
  if (start === -1) return null;
  const refs = [];
  const seen = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_LINE.test(lines[i])) break;
    for (const m of lines[i].matchAll(NUM_IN_SECTION)) {
      const n = normalizeTicket(m[1] ?? m[2]);
      if (n && !seen.has(n)) {
        seen.add(n);
        refs.push(n);
      }
    }
  }
  return refs;
}

// ------------------------------------------------------------------
// 票集解析：spec 引用 + issue 集合表示 → 票号集合（兜底链由契约能力驱动）
// ------------------------------------------------------------------

// 契约兜底链：contract?.ticketSet?.edges（数据）；缺省 = 未经判型调用面的既有三层链。
const DEFAULT_EDGES = ['sub-issues', 'parent-edges', 'init-list'];

const EMPTY_EDGE_HINTS = {
  'sub-issues': (specNum) => `spec ${specNum} 无 sub-issues`,
  'parent-edges': (specNum) => '## Parent 反查无子票',
  'init-list': (specNum) => 'init 票号清单未提供或为空',
};

// 返回 { ok, specNum, tickets, source, errors, warnings }：
//   ok=true   —— tickets 即本 run 的任务票集合（去重、数值序；不含 spec 母票），
//                source 标记命中的层：'sub-issues' | 'parent-edges' | 'init-list'
//   ok=false  —— 票集边界不可定（spec 引用不可用 / 不在集合、非法票号、多义 Parent、
//                兜底链皆空）；tickets 为空，errors 点名原因
// 拒绝语义（票 04）：非法票号与空集合拒绝；多义 Parent 只在边涉及本 spec 时拒绝——
// 不涉本 spec 的多义边是别家 spec 的共享票，与本 run 的票集边界无关。
// 契约能力（票 05）：contract.ticketSet.edges 是兜底链的唯一声明源——不在链里的层
// 整层跳过（即使数据存在），「皆空」诊断按链内层生成，不点名未声明的能力。
function resolveTicketSet({ issues, specRef, initTickets, contract } = {}) {
  const errors = [];
  const warnings = [];
  const no = () => ({ ok: false, specNum: null, tickets: [], source: null, errors, warnings });

  const specNum = parseSpecRef(specRef, { contract });
  if (!specNum) {
    errors.push(
      `spec 引用无法解析出 issue 号：${JSON.stringify(specRef ?? '')}——` +
        'GitHub 传 issue 号 / #号 / issue URL（local 传 spec 文件路径，不经此解析）'
    );
    return no();
  }

  const list = Array.isArray(issues) ? issues : [];
  const numOf = (it) => (it == null ? null : normalizeTicket(it.number));
  const spec = list.find((it) => numOf(it) === specNum);
  if (!spec) {
    errors.push(`spec 引用指向的 issue ${specNum} 不在 issue 集合中——快照拉取不全或引用有误`);
    return no();
  }

  const dedupeSorted = (nums) => [...new Set(nums)].sort((a, b) => Number(a) - Number(b));
  // 收集一层票号：非法形态整层拒绝；spec 母票排除（封账门 Type: spec 豁免的产物口径）。
  const collect = (tokens, what) => {
    const nums = [];
    for (const tok of tokens ?? []) {
      const n = normalizeTicket(tok);
      if (!n) {
        errors.push(`${what} 含非法票号：${JSON.stringify(tok)}（票号是 1–6 位数字）`);
        return null;
      }
      nums.push(n);
    }
    return dedupeSorted(nums.filter((n) => n !== specNum));
  };

  // init 票号清单（层 ③ 兜底源，也是 --tickets 冻结边界的同一清单）：无论命中哪一层，
  // 先做形态校验——吞掉非法清单会掩盖冻结边界的坏数据。
  const initList = collect(initTickets ?? [], 'init 票号清单');
  if (initList === null) return no();

  const edges = contract?.ticketSet?.edges ?? DEFAULT_EDGES;

  // 层 ①：spec issue 的原生 sub-issues（契约未声明该层时整层跳过——不合并层间兜底）
  const layer1 = edges.includes('sub-issues') ? collect(spec.subIssues ?? [], `spec ${specNum} 的 sub-issues`) : [];
  if (layer1 === null) return no();

  // 层 ②：## Parent 边反查（仅当层 ① 无成员才作为定界依据——兜底链不合并）。
  // 多义边只在引用了本 spec 时拒绝（边界因此不定）；与他 spec 的多义边与本 run 无关。
  let layer2 = [];
  if (edges.includes('parent-edges') && !layer1.length) {
    const candidates = [];
    for (const it of list) {
      const num = numOf(it);
      if (!num || num === specNum) continue;
      const refs = parseParentEdge(it.body);
      if (refs === null) continue;
      if (refs.length > 1 && refs.includes(specNum)) {
        errors.push(
          `多义 Parent：票 ${num} 的 ## Parent 边同时引用 ${refs.join('、')}——` +
            '无法判定其父票，票集边界不定；先在 tracker 修正该 issue 的 Parent 边再重跑'
        );
        return no();
      }
      if (refs.length === 1 && refs[0] === specNum) candidates.push(num);
    }
    layer2 = dedupeSorted(candidates);
  }

  // 层 ③：init 票号清单兜底（上两层任一有成员即不启用）
  let layer3 = [];
  if (!layer1.length && !layer2.length) layer3 = initList;

  if (layer1.length) return { ok: true, specNum, tickets: layer1, source: 'sub-issues', errors, warnings };
  if (layer2.length) return { ok: true, specNum, tickets: layer2, source: 'parent-edges', errors, warnings };
  if (layer3.length) return { ok: true, specNum, tickets: layer3, source: 'init-list', errors, warnings };
  // 皆空诊断按契约兜底链逐层生成（票 05：未声明的能力不点名）
  const why = edges.map((e) => EMPTY_EDGE_HINTS[e]?.(specNum)).filter(Boolean);
  errors.push(
    `票集边界兜底链皆空（按契约 ${edges.length} 层）：${why.join('，')}——无法确定本 run 的票集；` +
      '先在 tracker 补齐关系，或以 init --tickets 显式给定清单'
  );
  return no();
}

module.exports = { parseSpecRef, repoOfSpecRef, parseTrackerUrl, parseParentEdge, resolveTicketSet };
