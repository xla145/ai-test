/**
 * UI 用例归组：步骤、预期、前置条件的「骨架」相同、只有参数取值不同的用例归为一组。
 * 同组用例共用一份脚本模板——AI 只需探索其中一条，其余按参数替换派生，不再调用模型。
 *
 * 参数 = 文本里的引号内容（「」“”""''《》）与英文 / 数字片段（如 TAG-1001、30、click）。
 * 中文措辞不同（如「停用」与「启用」）视为不同流程，不会归到一组。
 * 纯函数，主进程与渲染进程（演示数据）共用。
 */

export interface GroupableCase {
  id: string;
  title: string;
  execution_mode: string;
  steps?: string[];
  expected?: string[];
  preconditions?: string[];
}

export interface CaseGroup<T extends GroupableCase = GroupableCase> {
  /** 骨架的短 hash，同一批用例内稳定 */
  id: string;
  /** 组名：成员标题的公共前缀 */
  label: string;
  cases: T[];
  /** 每条用例按出现顺序提取的参数值；同组内长度一致 */
  values: Record<string, string[]>;
  /** 组内取值不完全相同的参数位置 */
  varying: number[];
  /** 前多少个参数来自步骤与预期（其后的来自前置条件）；脚本只按这部分替换 */
  scriptValues: number;
}

const QUOTED = "「[^」]*」|“[^”]*”|\"[^\"]*\"|'[^']*'|《[^》]*》";
const TOKEN = "[A-Za-z0-9][A-Za-z0-9_\\-.:/@%]*";
const VALUE = new RegExp(`${QUOTED}|${TOKEN}`, "g");
const SLOT = "\u0001";

const unquote = (v: string) => (/^[「“"'《]/.test(v) ? v.slice(1, -1) : v);

/** 把一段文本拆成骨架（参数位置换成占位符）与参数值 */
export function maskText(text: string): { skeleton: string; values: string[] } {
  const values: string[] = [];
  const skeleton = text.replace(VALUE, (m) => {
    values.push(unquote(m));
    // 引号本身属于骨架：带引号与不带引号是两种写法
    return /^[A-Za-z0-9]/.test(m) ? SLOT : `${m[0]}${SLOT}${m[m.length - 1]}`;
  }).replace(/\s+/g, " ").trim();
  return { skeleton, values };
}

/** 用例骨架：执行方式 + 前置条件 / 步骤 / 预期的骨架；不含标题（标题措辞不影响脚本） */
export function caseSignature(c: GroupableCase): { skeleton: string; values: string[]; scriptValues: number } {
  const values: string[] = [];
  const part = (lines: string[] = []) => lines.map((line) => {
    const m = maskText(line);
    values.push(...m.values);
    return m.skeleton;
  }).join("\n");
  // 顺序固定：步骤 → 预期 → 前置条件，参数位置才能在组内一一对应
  const head = [c.execution_mode, part(c.steps), part(c.expected)];
  const scriptValues = values.length;
  const skeleton = [...head, part(c.preconditions)].join("\u0002");
  return { skeleton, values, scriptValues };
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function commonPrefix(titles: string[]): string {
  let prefix = titles[0] ?? "";
  for (const t of titles) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++;
    prefix = prefix.slice(0, i);
  }
  // 去掉末尾残留的分隔符、数字与半个英文词
  return prefix.replace(/[A-Za-z0-9_\-.:/@%\s（(【\[「“"'·、，,:：#]+$/u, "").trim();
}

/** 按骨架归组，保持用例原有顺序（组的位置取第一条成员的位置） */
export function groupCases<T extends GroupableCase>(cases: T[]): CaseGroup<T>[] {
  const groups = new Map<string, CaseGroup<T>>();
  for (const c of cases) {
    const sig = caseSignature(c);
    // 没有步骤的用例无从比较，各自成组
    const key = c.steps?.length ? sig.skeleton : `${sig.skeleton}\u0003${c.id}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { id: `g_${hash(key)}`, label: "", cases: [], values: {}, varying: [], scriptValues: sig.scriptValues }));
    g.cases.push(c);
    g.values[c.id] = sig.values;
  }
  for (const g of groups.values()) {
    const first = g.values[g.cases[0].id];
    g.varying = first.map((_, i) => i).filter((i) => g.cases.some((c) => g.values[c.id][i] !== first[i]));
    g.label = g.cases.length > 1 ? commonPrefix(g.cases.map((c) => c.title)) || g.cases[0].title : g.cases[0].title;
  }
  return [...groups.values()];
}

/** 一条用例用于改写脚本的参数：只取步骤与预期里的，前置条件描述的是数据准备，不进脚本 */
export function scriptParams(group: Pick<CaseGroup, "values" | "scriptValues">, caseId: string): string[] {
  return (group.values[caseId] ?? []).slice(0, group.scriptValues);
}

/** 一条用例在组内与众不同的参数取值，用于列表里区分成员 */
export function variantLabel(group: Pick<CaseGroup, "values" | "varying">, caseId: string): string {
  const values = group.values[caseId] ?? [];
  return [...new Set(group.varying.map((i) => values[i]).filter(Boolean))].join(" · ");
}

// --------------------------------------------------------------------------- 参数替换

export type Derivation<S> = { ok: true; steps: S[]; replaced: number } | { ok: false; reason: string };

/** 这些字段是结构而不是数据，替换时跳过 */
const STRUCTURAL = new Set(["id", "action", "role", "source", "kind", "secretEnv", "caseStep", "name"]);
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alnum = (ch?: string) => !!ch && /[A-Za-z0-9]/.test(ch);

/**
 * 把模板用例的脚本步骤改写成同组另一条用例的步骤：按参数位置把模板取值替换为目标取值。
 * 一次扫描完成替换（长的优先），英文 / 数字取值按整词匹配，避免「1」误伤「10」。
 * 无法安全替换时返回原因，这类用例仍交给 AI 探索。
 */
export function deriveSteps<S extends object>(steps: S[], from: string[], to: string[]): Derivation<S> {
  if (from.length !== to.length) return { ok: false, reason: "参数个数与模板不一致" };
  const map = new Map<string, string>();
  for (let i = 0; i < from.length; i++) {
    if (from[i] === to[i]) continue;
    if (!from[i]) return { ok: false, reason: "模板中的参数为空，无法定位替换位置" };
    const known = map.get(from[i]);
    if (known !== undefined && known !== to[i]) return { ok: false, reason: `模板中的「${from[i]}」对应多个不同取值，无法确定替换关系` };
    map.set(from[i], to[i]);
  }
  if (!map.size) return { ok: false, reason: "与模板用例的参数完全相同" };
  // 模板里没变的取值如果与某个待替换值相同，会被一并改掉
  for (let i = 0; i < from.length; i++) {
    if (from[i] === to[i] && map.has(from[i])) return { ok: false, reason: `「${from[i]}」在模板中既是固定值又是参数，无法确定替换关系` };
  }
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map((k) =>
    `${alnum(k[0]) ? "(?<![A-Za-z0-9])" : ""}${escapeRe(k)}${alnum(k[k.length - 1]) ? "(?![A-Za-z0-9])" : ""}`).join("|"), "g");
  let replaced = 0;
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key && STRUCTURAL.has(key)) return value;
      return value.replace(pattern, (m) => { replaced++; return map.get(m)!; });
    }
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  const out = steps.map((st) => walk(st) as S);
  // role 定位的 name（按钮文字等）是数据，单独处理：STRUCTURAL 里的 name 指请求捕获的变量名
  const fixed = out.map((st, i) => {
    const target = (steps[i] as { target?: { kind?: string; name?: string } }).target;
    if (target?.kind !== "role" || typeof target.name !== "string") return st;
    const name = target.name.replace(pattern, (m) => { replaced++; return map.get(m)!; });
    return { ...st, target: { ...(st as { target: object }).target, name } } as S;
  });
  if (!replaced) return { ok: false, reason: "模板脚本中没有出现这些参数，无法通过替换生成" };
  // 只要有一个变化的参数落到了脚本里就派生；其余可能只体现在测试数据中，由试跑把关
  return { ok: true, steps: fixed, replaced };
}
