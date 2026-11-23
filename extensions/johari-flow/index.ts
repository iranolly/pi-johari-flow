/**
 * Johari Flow — a Johari-window driven delivery workflow for Pi.
 *
 * The extension is the *enforcement* half of the workflow:
 *   - a phase state machine persisted in the session (idle → intent → research →
 *     design → review → approved → execute → report → done)
 *   - hard gates: nothing may be written while the intent is unconfirmed; nothing
 *     may be executed before a design is approved
 *   - three HTML surfaces (intent / decision / report) so the user confirms what
 *     the agent believes instead of guessing from prose
 *   - a Johari audit appended to every user-facing reply, so blind spots, hidden
 *     uncertainty and un-investigated unknowns surface before the reply lands
 *
 * The *playbook* half (how to run each phase) lives in
 * skills/johari-flow/SKILL.md and is injected from protocol.ts while a flow is
 * active.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type AnswerWaiter, startAnswerServer } from "./answer.ts";
import { type PageQuestion, type PageSection, type PageSpec, renderPage } from "./html.ts";
import { buildProtocol, phaseBadge } from "./protocol.ts";
import {
	EDGES,
	type FlowState,
	PHASES,
	type Phase,
	initialState,
	isActive,
	isPreApproval,
} from "./types.ts";

const ENTRY_TYPE = "johari-flow";
const STATUS_KEY = "johari";

const PHASE_CN: Record<Phase, string> = {
	idle: "空闲",
	intent: "① 意图澄清",
	research: "② 项目调研",
	design: "③ 方案设计",
	review: "④ 交叉评审",
	approved: "⑤ 方案已批准",
	execute: "⑥ 监督执行",
	report: "⑦ 完成报告",
	done: "已收尾",
};

const TRANSITION_TARGETS = [
	"intent",
	"research",
	"design",
	"review",
	"approved",
	"execute",
	"report",
	"done",
	"idle",
] as const;

/* ------------------------------------------------------------------ schemas */

const StepSchema = Type.Object({
	title: Type.String({ description: "步骤标题：用大白话说做什么（不许写函数名/文件名）" }),
	note: Type.Optional(Type.String({ description: "一行补充" })),
	status: Type.Optional(
		StringEnum(["done", "now", "next"] as const, { description: "已完成 / 正在做 / 待做" }),
	),
});

const BlockSchema = Type.Object({
	kind: StringEnum(
		[
			"flow",
			"timeline",
			"stats",
			"bars",
			"compare",
			"callout",
			"loop",
			"facts",
			"tree",
			"branch",
			"sequence",
			"graph",
			"state",
			"image",
		] as const,
		{
			description:
				"视觉载体：flow=步骤链 timeline=时间线 stats=大数字卡 bars=条形对比 compare=左右对照 callout=重点框 loop=循环示意 facts=键值卡 tree=层级地图（代码地图/模块结构，可折叠） branch=分支流程（如果…就…的岔路） sequence=多方顺序（谁跟谁说了什么） graph=关系网（依赖/关联） state=状态机（状态与跳转条件） image=真图（本地截图内联进页面，点开可放大）",
		},
	),
	steps: Type.Optional(Type.Array(StepSchema, { description: "flow / loop 用" })),
	items: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ description: "本图内唯一 id" }),
				parent: Type.Optional(Type.String({ description: "父节点 id；不填则为根" })),
				label: Type.String({ description: "节点名（大白话）" }),
				note: Type.Optional(Type.String({ description: "一行补充，可不写" })),
				cond: Type.Optional(
					Type.String({ description: "branch 专用：进入这个分支的条件，如「如果用户没确认」" }),
				),
			}),
			{ description: "tree / branch 用：扁平列表 + parent 指向上级，不要嵌套结构" },
		),
	),
	actors: Type.Optional(
		Type.Array(Type.String(), { description: "sequence 用：参与者名，按从左到右的顺序写" }),
	),
	messages: Type.Optional(
		Type.Array(
			Type.Object({
				from: Type.String({ description: "参与者名" }),
				to: Type.String({ description: "参与者名；与 from 相同则为自调用" }),
				text: Type.Optional(Type.String()),
				style: Type.Optional(
					StringEnum(["solid", "dashed"] as const, { description: "dashed=回复/异步" }),
				),
			}),
			{ description: "sequence 用：按时间顺序排的消息" },
		),
	),
	nodes: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				label: Type.String(),
				kind: Type.Optional(StringEnum(["plain", "core", "weak"] as const, {})),
				note: Type.Optional(Type.String()),
			}),
			{ description: "graph 用：节点" },
		),
	),
	edges: Type.Optional(
		Type.Array(
			Type.Object({ from: Type.String(), to: Type.String(), label: Type.Optional(Type.String()) }),
			{ description: "graph 用：连线（谁指向谁）" },
		),
	),
	states: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				label: Type.String(),
				kind: Type.Optional(StringEnum(["start", "plain", "end"] as const, {})),
			}),
			{ description: "state 用：状态（按横向顺序写）" },
		),
	),
	transitions: Type.Optional(
		Type.Array(
			Type.Object({ from: Type.String(), to: Type.String(), label: Type.Optional(Type.String()) }),
			{ description: "state 用：状态跳转与条件" },
		),
	),
	images: Type.Optional(
		Type.Array(
			Type.Object({
				src: Type.String({
					description:
						"本地图片路径：相对项目根目录（如 sample-qa/a.png）或绝对路径；远程 http(s) 地址会被拒绝",
				}),
				caption: Type.Optional(Type.String({ description: "图下小字；不写就只显示图" })),
				alt: Type.Optional(Type.String({ description: "读屏用的替代文字，默认取文件名" })),
			}),
			{ description: "image 用：一次 1～4 张，多张自动排两列" },
		),
	),
	events: Type.Optional(
		Type.Array(
			Type.Object({
				when: Type.String({ description: "时间或序号，如「今天」「第 1 天」" }),
				title: Type.String(),
				note: Type.Optional(Type.String()),
			}),
		),
	),
	stats: Type.Optional(
		Type.Array(
			Type.Object({
				value: Type.String({ description: "大数字，如 \"8\" / \"29\"" }),
				unit: Type.Optional(Type.String()),
				label: Type.String(),
				note: Type.Optional(Type.String()),
			}),
		),
	),
	bars: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String(),
				value: Type.Number({ description: "0～max 的数，默认 max=100" }),
				max: Type.Optional(Type.Number()),
				note: Type.Optional(Type.String()),
				tone: Type.Optional(StringEnum(["open", "blind", "hidden", "unknown"] as const, {})),
			}),
		),
	),
	caption: Type.Optional(Type.String({ description: "bars / image 用：整块的说明，一行" })),
	left: Type.Optional(
		Type.Object({ title: Type.String(), items: Type.Array(Type.String()) }),
	),
	right: Type.Optional(
		Type.Object({ title: Type.String(), items: Type.Array(Type.String()) }),
	),
	tone: Type.Optional(StringEnum(["info", "warn", "ok"] as const, {})),
	title: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	facts: Type.Optional(
		Type.Array(Type.Object({ label: Type.String(), value: Type.String() })),
	),
});

const SectionSchema = Type.Object({
	heading: Type.String({ description: "小节标题（一句话，中文，不用术语）" }),
	lead: Type.Optional(
		Type.String({ description: "这一块的视觉重心：一句大白话结论，比正文大一号；读者只看这一句也能懂" }),
	),
	blocks: Type.Optional(
		Type.Array(BlockSchema, {
			description: "视觉载体块。能画图就别写段落；一个 section 里 1～2 块最合适",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"Markdown 正文——只在没有合适载体时用，写短句。报告页禁止贴代码/堆英文标识符（读者不看代码）",
		}),
	),
	items: Type.Optional(Type.Array(Type.String(), { description: "要点列表（与 body 二选一或并用）" })),
	tone: Type.Optional(
		StringEnum(["plain", "facts", "assumptions", "unknowns", "risks", "deliverables"] as const, {
			description: "语义色调，决定左栏强调色",
		}),
	),
});

const OptionSchema = Type.Object({
	id: Type.String({ description: "短 id，如 A / B / confirm / revise" }),
	label: Type.String({ description: "选项一句话标题" }),
	detail: Type.Optional(Type.String({ description: "这个选项具体意味着什么、代价与收益" })),
	cost: Type.Optional(Type.String({ description: "成本/风险行，如「改动 3 个文件 · 不可回滚」" })),
	recommended: Type.Optional(Type.Boolean({ description: "是否为推荐项" })),
});

const ChoiceSchema = Type.Object({
	id: Type.String({ description: "候选短 id，如 A / keep / drop" }),
	label: Type.String({ description: "候选一句话标题" }),
	detail: Type.Optional(Type.String({ description: "这个候选具体意味着什么" })),
	recommended: Type.Optional(Type.Boolean({ description: "是否标注推荐" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "题号，如 Q1 / Q2（页面按题号排序）" }),
	prompt: Type.String({ description: "一道单选题的问法" }),
	hint: Type.Optional(Type.String({ description: "补充说明：为什么问、选错会怎样" })),
	choices: Type.Array(ChoiceSchema, { minItems: 2, description: "该题自己的候选（≥ 2）" }),
});

const JohariSchema = Type.Object({
	open: Type.Optional(Type.Array(Type.String(), { description: "开放区：双方都确认的事实" })),
	blind: Type.Optional(Type.Array(Type.String(), { description: "盲目区：agent 的假定，需用户确认" })),
	hidden: Type.Optional(Type.Array(Type.String(), { description: "隐藏区：风险/成本/没做的事" })),
	unknown: Type.Optional(Type.Array(Type.String(), { description: "未知区：需要什么证据才能确定" })),
});

/* -------------------------------------------------------------------- state */

let state: FlowState = initialState();

function nowIso(): string {
	return new Date().toISOString();
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext): void {
	state.updatedAt = nowIso();
	try {
		// Snapshot, not reference: appendEntry stores the object as-is, so a shared
		// reference would make every historical entry show the *current* phase and
		// /tree rewinds would read the newest state back.
		pi.appendEntry(ENTRY_TYPE, JSON.parse(JSON.stringify(state)));
	} catch (err) {
		// Do not die silently: if the entry cannot be written, the next /resume would
		// resurrect an older phase and look like the flow rewound on its own.
		try {
			ctx.ui.notify(`流程状态未能写入会话（下次恢复可能回退）：${err instanceof Error ? err.message : String(err)}`, "warning");
		} catch {
			/* no UI: keep going, the in-memory state still drives this turn */
		}
	}
	try {
		ctx.ui.setStatus(STATUS_KEY, phaseBadge(state));
	} catch {
		/* status is cosmetic */
	}
}

function reconstruct(ctx: ExtensionContext): void {
	let latest: FlowState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE) {
			latest = (entry as any).data as FlowState;
		}
	}
	state = latest
		? {
				...initialState(),
				...latest,
				// A stale entry can carry a phase that no longer exists (renamed phase,
				// hand-edited session): clamp it instead of rendering `undefined` forever.
				phase: PHASES.includes(latest.phase) ? latest.phase : "idle",
				// Copy the mutable arrays: appendEntry stores `data` by reference, so pushing
				// into a shared array would rewrite the entry we just rebuilt from.
				artifacts: [...(latest.artifacts ?? [])],
				decisions: [...(latest.decisions ?? [])],
				history: [...(latest.history ?? [])],
			}
		: initialState();
}

/* ------------------------------------------------------------------ helpers */

function renderStatus(): string {
	if (!isActive(state)) {
		return [
			"**Johari Flow** · 空闲",
			"",
			"还没有进行中的流程。开始方式二选一：",
			"- 用户直接描述需求，你调用 `flow_plan {action:\"start\", goal:\"<用户原话>\"}`",
			"- 用户输入 `/flow start <目标>`",
		].join("\n");
	}
	const artifacts = state.artifacts.length
		? state.artifacts
				.slice(-6)
				.map((a) => `- \`${a.kind}\` ${a.title}${a.path ? ` → ${a.path}` : ""}`)
				.join("\n")
		: "- （暂无）";
	const decisions = state.decisions.length
		? state.decisions
				.slice(-4)
				.map((d) => `- ${d.question} → **${d.answer}**`)
				.join("\n")
		: "- （暂无）";
	const next = (EDGES[state.phase] ?? []).filter((p) => p !== "idle");
	return [
		`**Johari Flow** · ${PHASE_CN[state.phase]}`,
		`意图：${state.intentConfirmed ? "已确认" : "**未确认**"} ｜ 方案：${
			state.approval ? `已批准（${state.approval.label}）` : "**未批准**"
		}`,
		"",
		"**原始意图**",
		`> ${state.goal || "（未记录）"}`,
		"",
		"**产出物**",
		artifacts,
		"",
		"**已定决策**",
		decisions,
		"",
		`**可推进到**：${next.length ? next.join(" / ") : "无（终态）"}`,
	].join("\n");
}

function reply(text: string, extra?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details: { phase: state.phase, ...extra },
	};
}

function sessionSlug(ctx: ExtensionContext): string {
	const id = (() => {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return "session";
		}
	})();
	return String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "session";
}

async function openInBrowser(pi: ExtensionAPI, absPath: string): Promise<boolean> {
	try {
		// exec does not throw on a non-zero exit: the code is the only signal we get.
		let code: number | undefined;
		if (process.platform === "win32") {
			code = (await pi.exec("cmd", ["/c", "start", "", absPath], { timeout: 8000 }))?.code;
		} else if (process.platform === "darwin") {
			code = (await pi.exec("open", [absPath], { timeout: 8000 }))?.code;
		} else {
			code = (await pi.exec("xdg-open", [absPath], { timeout: 8000 }))?.code;
		}
		return code === undefined || code === 0;
	} catch {
		return false;
	}
}

function plainSummary(spec: PageSpec): string {
	const lines: string[] = [`## ${spec.title}`];
	if (spec.summary) lines.push(spec.summary);
	for (const s of spec.sections) {
		lines.push(`- **${s.heading}**${s.items?.length ? `：${s.items.slice(0, 3).join("；")}` : ""}`);
	}
	if (spec.options?.length) {
		lines.push(`- **选项**：${spec.options.map((o) => `${o.id}) ${o.label}`).join(" / ")}`);
	}
	if (spec.questions?.length) {
		lines.push(`- **单选题**：${spec.questions.map((q) => `${q.id} ${q.prompt}`).join(" / ")}`);
	}
	return lines.join("\n");
}

/* --------------------------------------------------------------- gate rules */

/** Shell tools can write files without ever calling write/edit. */
const SHELL_TOOLS = new Set(["bash", "sh", "shell", "zsh", "powershell", "pwsh", "cmd"]);

/** Sub-agent tool names differ per build (Agent / subagent / task …). Word boundary, not prefix. */
const SUBAGENT_RE = /^(?:agent|subagent|task|delegate|spawn|parallel)(?:[_-]|$)/i;

/** Note-like files are only allowed inside the scratch area (temp), not in the repo. */
const SCRATCH_EXT_RE = /\.(?:md|txt|log|json|html?)$/i;

/**
 * Interpreter one-liners can write anything without ever looking like a write.
 * We do not ban them (people inspect data that way), we only ban the ones that
 * name a write API: `node -e "console.log(1)"` stays allowed.
 */
const INLINE_WRITE_RE =
	/\b(?:node|deno|bun)\b[^|]*(?:\s-e\s|--eval|\beval\s)[^|]*(?:writeFile|appendFile|createWriteStream|writeSync|openSync|unlink|rmSync|rmdir|rename|copyFile|mkdirSync|spawn|execSync)/i;

/** Python -c style one-liners that open or move files. */
const PY_INLINE_WRITE_RE =
	/\b(?:python|python3|py)\b[^|]*\s-c\s[^|]*(?:open\s*\(|shutil|os\.remove|os\.rename|os\.makedirs|subprocess)/i;

/** Optional option clusters: `git -C repo commit`, `npm --prefix . install`, … */
const OPTS = String.raw`(?:-[^\s]+\s+(?:[^\s]+\s+)?)*`;

/** Repo-mutating shell verbs: blocked until the design is approved. */
const PRE_APPROVAL_MUTATION_RE = new RegExp(
	String.raw`\b(?:sed\s+-i|perl\s+-[a-z]*i\s+-p|git\s+${OPTS}(?:apply|checkout|restore|reset|commit|merge|rebase|add|mv|rm|pull|push|clean)\b|git\s+${OPTS}stash\s+(?!list\b|show\b)|(?:npm|pnpm|yarn)\s+${OPTS}(?:install|i|add|uninstall|remove|update|ci|link|publish)\b|pip3?\s+(?:install|uninstall)|chmod\s|chown\s|truncate)`,
	"i",
);

/** Shell one-liners that create or modify file content. */
const SHELL_WRITE_RE =
	/\btee\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bNew-Item\b|\btouch\b|\bsed\s+-i\b|\bperl\s+-[a-z]*i\b|\bgit\s+apply\b|\bcp\b|\bmv\b|\bmkdir\b|\bsort\b[^|]*-o\b/i;

/** Read-only commands whose arguments may legitimately quote scary strings. */
const INSPECT_RE =
	/^(?:rg|grep|egrep|fgrep|ag|ack|fd|find|cat|type|Get-Content|less|more|head|tail|wc|sort|uniq|cut|jq|echo|printf|git\s+(?:log|show|diff|grep|status|branch|remote|rev-parse|ls-files))\b/i;

/** Tools whose very name says they write. Anything else is assumed read-only. */
const WRITE_TOOL_RE = /(?:write|edit|patch|replace|create|move|delete|remove|rename|insert|append|save)/i;
const READ_ONLY_TOOL_RE = /^(?:read|ls|glob|grep|find|search|webfetch|fetch|list|todo|flow_|websearch|tree)/i;

/** Is `child` inside `parent` (case-insensitive on Windows)? */
function isInside(parent: string, child: string): boolean {
	const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
	const p = norm(resolve(parent));
	const c = norm(resolve(child));
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Scratch area: the page directory and the OS temp dir. Repo files are never scratch. */
function inScratchDir(cwd: string, target: string): boolean {
	if (!target) return false;
	const abs = resolve(cwd, target);
	if (isInside(resolve(cwd, ".pi"), abs)) return true;
	try {
		return isInside(tmpdir(), abs) && SCRATCH_EXT_RE.test(abs);
	} catch {
		return false;
	}
}

/** Strip quotes and collapse whitespace before matching command shape. */
function normalizeCmd(cmd: string): string {
	return cmd.replace(/["'`]/g, "").replace(/[^\S\r\n]+/g, " ").trim();
}

/** Drop output-suppression noise that is never a mutation on its own. */
function stripNoise(cmd: string): string {
	return cmd
		.replace(/\d?>>?\s*\/dev\/null/g, " ")
		.replace(/&>\s*\/dev\/null/g, " ")
		.replace(/\d?>?&\d/g, " ");
}

interface Segment {
	raw: string;
	norm: string;
}

/**
 * Split a shell line into independently executable segments.
 * Newlines are real separators; so is every command substitution body
 * (`$(…)`, backticks, `<(…)`) — otherwise `cat $(rm -rf src)` reads as read-only.
 */
function segments(input: string, depth = 0): Segment[] {
	const out: Segment[] = [];
	for (const line of input.split(/\r?\n/)) {
		const cleaned = stripNoise(line);
		for (const piece of cleaned.split(/&&|\|\||;|\||&(?![>&])/)) {
			const norm = normalizeCmd(piece);
			if (norm) out.push({ raw: piece.trim(), norm });
		}
		if (depth < 3) {
			const re = /\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(line))) {
				const body = m[1] ?? m[2] ?? m[3] ?? "";
				if (body.trim()) out.push(...segments(body, depth + 1));
			}
			// `bash -c "echo hi > f"`: the payload is shell too, quotes are not protection.
			const cmdPayload = /(?:^|\s)-[a-z]*c\s+"([\s\S]*?)"|(?:^|\s)-[a-z]*c\s+'([\s\S]*?)'/i.exec(line);
			const inner = cmdPayload ? (cmdPayload[1] ?? cmdPayload[2] ?? "") : "";
			if (inner.trim()) out.push(...segments(inner, depth + 1));
		}
	}
	return out;
}

/** Redirect targets that are real files (quoted targets included). */
/** Redirect targets that are real files (quoted targets included, quotes respected). */
function redirectTargets(rawSegment: string): string[] {
	const out: string[] = [];
	let quote = "";
	for (let i = 0; i < rawSegment.length; i += 1) {
		const ch = rawSegment[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch !== ">") continue;
		if (i > 0 && /[0-9&]/.test(rawSegment[i - 1])) continue;
		// `>>` is one redirect
		let j = i + 1;
		if (rawSegment[j] === ">") j += 1;
		while (j < rawSegment.length && /\s/.test(rawSegment[j])) j += 1;
		if (rawSegment[j] === "&") {
			// fd duplication: >&2, >&1
			j += 1;
			while (j < rawSegment.length && /[0-9-]/.test(rawSegment[j])) j += 1;
			i = j - 1;
			continue;
		}
		const opener = rawSegment[j];
		let target = "";
		if (opener === '"' || opener === "'") {
			const close = rawSegment.indexOf(opener, j + 1);
			target = close === -1 ? rawSegment.slice(j + 1) : rawSegment.slice(j + 1, close);
			i = close === -1 ? rawSegment.length : close;
		} else {
			let k = j;
			while (k < rawSegment.length && !/[\s>|;&]/.test(rawSegment[k])) k += 1;
			target = rawSegment.slice(j, k);
			i = k - 1;
		}
		target = target.trim();
		if (!target) continue;
		if (target === "/dev/null" || /^nul$/i.test(target)) continue;
		out.push(target);
	}
	return out;
}

function redirectsToFile(rawSegment: string): boolean {
	return redirectTargets(rawSegment).length > 0;
}

/** Remove the *contents* of quoted spans, so quoted text cannot hide a verb. */
function stripQuoted(raw: string): string {
	return raw
		.replace(/"([^"]*)"/g, '""')
		.replace(/'([^']*)'/g, '""');
}

/** Could this single segment destroy data or history? */
function segmentDestroys(seg: Segment): boolean {
	// A read-only verb keeps its right to quote scary arguments (rg "rm -rf" docs),
	// but anything outside the quotes is still judged as a command.
	const s = INSPECT_RE.test(seg.norm) ? normalizeCmd(stripQuoted(seg.raw)) : seg.norm;
	if (/\brm\b[^|]*\s(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)/.test(s)) return true;
	if (/\bfind\b[^|]*-delete\b/.test(s)) return true;
	if (redirectsToFile(seg.raw)) return true;
	if (/\.\s*\/\s*\S/.test(s) || /^\s*\.\s+/.test(s)) return true;
	if (/\bdd\s+if=|\btruncate\s+(?:--size|-s)\b|(^|\s):\s*>/.test(s)) return true;
	if (
		/\bgit\b[^|]*\s(?:push\s+(?:-f\b|--force|\+\w)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+(?:--\s|\.)|restore\s+(?:--\s|\.)|stash\s+drop|reflog\s+expire|branch\s+-D)/.test(
			s,
		)
	)
		return true;
	if (/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/.test(s)) return true;
	if (/\bRemove-Item\b[^|]*-Recurse|\bshred\b|\bmkfs|\bformat\s+[a-z]:/.test(s)) return true;
	if (/\b(?:del|erase)\s+\/[sq]\b|\b(?:rd|rmdir)\s+\/s\b/.test(s)) return true;
	return false;
}

/** Could this single segment write or change files? */
function segmentWrites(seg: Segment): boolean {
	if (redirectsToFile(seg.raw)) return true;
	if (SHELL_WRITE_RE.test(seg.norm) || PRE_APPROVAL_MUTATION_RE.test(seg.norm)) return true;
	if (INLINE_WRITE_RE.test(seg.norm) || PY_INLINE_WRITE_RE.test(seg.norm)) return true;
	return false;
}

/** Path-like tokens a segment names (flags dropped). */
function pathTokens(norm: string): string[] {
	return norm
		.split(/\s+/)
		.filter((t) => !t.startsWith("-") && (t.includes("/") || t.includes("\\") || /\.[a-z0-9]{1,6}$/i.test(t)))
		.map((t) => t.replace(/^[("']+|[)"',;]+$/g, ""))
		.filter((t) => t && !/^https?:/i.test(t));
}

/** Does every path this segment touches live in the scratch area? */
/** A bare `cd`/`pushd` only changes scope; it writes nothing. */
const DIR_CHANGE_RE = /^(?:cd|pushd|chdir)\s+(?:"([^"]*)"|'([^']*)'|([^\s&|;]+))\s*$/i;

/** True when a directory change stays inside the workspace, false when it
 *  leaves it, undefined when the segment is not a directory change at all. */
function directoryScope(cwd: string, seg: Segment): boolean | undefined {
	const m = DIR_CHANGE_RE.exec(seg.raw.trim());
	if (!m) return undefined;
	const target = m[1] ?? m[2] ?? m[3] ?? "";
	if (!target) return undefined;
	const abs = resolve(cwd, target);
	return isInside(cwd, abs) || isInside(tmpdir(), abs);
}
function segmentStaysInScratch(cwd: string, seg: Segment): boolean {
	const scope = directoryScope(cwd, seg);
	if (scope !== undefined) return scope;
	const targets = [...redirectTargets(seg.raw), ...pathTokens(seg.norm)];
	if (targets.length === 0) return false;
	return targets.every((t) => inScratchDir(cwd, t));
}

/** Does every segment of this line stay inside the scratch area? */
function shellTouchesOnlyScratch(cwd: string, raw: string): boolean {
	const segs = segments(raw);
	return segs.length > 0 && segs.every((seg) => segmentStaysInScratch(cwd, seg));
}

/** Could this shell line destroy data or history? */
function isDestructive(raw: string): boolean {
	return segments(raw).some(segmentDestroys);
}

/** Shell line that mutates the repo, ignoring writes that stay in the scratch area. */
function shellMutates(cwd: string, raw: string): boolean {
	return segments(raw).some(
		(seg) => (segmentDestroys(seg) || segmentWrites(seg)) && !segmentStaysInScratch(cwd, seg),
	);
}

/** Is this tool name a file-writing tool (write / edit / patch / any extension tool that writes)? */
function isWriteToolName(name: string): boolean {
	if (SUBAGENT_RE.test(name)) return false;
	if (READ_ONLY_TOOL_RE.test(name)) return false;
	return WRITE_TOOL_RE.test(name);
}

/**
 * Write a page under a collision-free name.
 * `wx` makes the write atomic, so two tool calls in the same turn cannot overwrite
 * each other; on EEXIST we take the next free number.
 */
async function writePage(dir: string, kind: string, html: string): Promise<string> {
	try {
		await mkdir(dir, { recursive: true });
	} catch (err) {
		throw new Error(`页面目录创建失败（${dir}）：${err instanceof Error ? err.message : String(err)}`);
	}
	let next = await nextPageSeq(dir);
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const target = join(dir, `${String(next).padStart(2, "0")}-${kind}.html`);
		try {
			await writeFile(target, html, { encoding: "utf8", flag: "wx" });
			return target;
		} catch (err) {
			if ((err as { code?: string }).code !== "EEXIST") {
				throw new Error(`页面写入失败（${target}）：${err instanceof Error ? err.message : String(err)}`);
			}
			next += 1;
		}
	}
	throw new Error(`页面写入失败：${dir} 下连续 20 次文件名冲突`);
}

/**
 * Every page gets a sibling `.json` record: the exact spec, phase and cwd it was
 * rendered from. The HTML alone cannot be audited or re-generated field by field.
 */
async function writePageRecord(
	ctx: ExtensionContext,
	absPath: string,
	record: Record<string, unknown>,
): Promise<string | null> {
	const target = absPath.replace(/\.html$/, ".json");
	try {
		await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		return target;
	} catch (err) {
		try {
			ctx.ui.notify(
				`页面配置记录没写成（页面本身正常）：${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		} catch {
			/* no UI: the page itself is still on disk */
		}
		return null;
	}
}

/** Next free page number: the directory is the source of truth, not pageSeq. */
async function nextPageSeq(dir: string): Promise<number> {
	try {
		let max = 0;
		for (const name of await readdir(dir)) {
			const m = /^(\d+)-/.exec(name);
			if (m) max = Math.max(max, Number(m[1]));
		}
		return max + 1;
	} catch {
		return 1;
	}
}

/** Names of dispatch tools this build actually exposes (none on a stock install). */
function dispatchToolNames(pi: ExtensionAPI): string[] {
	try {
		const all = (pi as unknown as { getAllTools?: () => Array<{ name?: string }> }).getAllTools?.() ?? [];
		return all.map((t) => String(t.name ?? "")).filter((n) => n && SUBAGENT_RE.test(n));
	} catch {
		return [];
	}
}

/** How long a live decision page may take to answer before the picker steps in. */
const PAGE_WAIT_MS = 5 * 60 * 1000;

/** Kept in step with package.json by hand: pages show it in the header chip. */
const PKG_VERSION = "0.3.0";

/* --------------------------------------------------------------------- init */

export default function johariFlow(pi: ExtensionAPI) {
	/* ------------------------------------------------------------- lifecycle */

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		try {
			ctx.ui.setStatus(STATUS_KEY, phaseBadge(state));
		} catch {
			/* cosmetic */
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
	});

	/* ------------------------------------------------- system prompt injection */

	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions.sections as Record<string, string>;
		if (isActive(state)) {
			sections.johari_flow = buildProtocol(state, dispatchToolNames(pi));
		} else {
			delete sections.johari_flow;
		}
	});

	/* ------------------------------------------------------------- hard gates */

	pi.on("tool_call", (event, ctx) => {
		if (!isActive(state)) return;
		const name = String(event.toolName ?? "");
		const lower = name.toLowerCase();
		const input = (event.input ?? {}) as Record<string, unknown>;
		const cmd = String(input.command ?? input.script ?? input.cmd ?? "");
		const targetPath = String(input.path ?? input.file_path ?? input.filePath ?? "");
		const isShell = SHELL_TOOLS.has(lower);
		const isSubAgent = SUBAGENT_RE.test(lower);
		const isFileTool = isWriteToolName(lower);
		const scratchPath =
			targetPath ||
			String(
				(input.paths as string[] | undefined)?.[0] ??
					input.target ??
					input.destination ??
					"",
			);

		if (state.phase === "intent") {
			const writesFile =
				(isFileTool && !inScratchDir(ctx.cwd, scratchPath)) || (isShell && shellMutates(ctx.cwd, cmd));
			if (writesFile) {
				return {
					block: true,
					reason:
						"Johari Flow 处于「意图澄清」阶段：意图未确认前不改项目文件（含 shell 重定向 / Set-Content / tee）。允许在 <cwd>/.pi/ 下写页面与草稿（含 shell 重定向进去）。先调用 flow_page {kind:\"intent\"} 出确认页，等用户确认后再 flow_plan 推进。",
				};
			}
			if (isSubAgent) {
				return {
					block: true,
					reason:
						"Johari Flow 处于「意图澄清」阶段：意图未确认前不得派发 sub agent。先确认意图，再进入 research。",
				};
			}
		}

		// Before approval every phase is guarded: code changes must wait for the user's verdict.
		if (isPreApproval(state) && state.phase !== "intent") {
			const editsProjectFile = isFileTool && !inScratchDir(ctx.cwd, scratchPath);
			const shellWrites = isShell && shellMutates(ctx.cwd, cmd);
			if (editsProjectFile || shellWrites) {
				return {
					block: true,
					reason: [
						`Johari Flow 处于 ${PHASE_CN[state.phase]} 阶段：方案未获用户批准前不改项目文件。`,
						"允许的例外：<cwd>/.pi/ 下的页面与草稿（含 shell 重定向进去）、系统临时目录。",
						"要把改动写进方案页（含回退方式），拿到用户回执后 approve，再动代码。",
					].join(""),
				};
			}
		}

		if (isPreApproval(state) && isShell && isDestructive(cmd) && !shellTouchesOnlyScratch(ctx.cwd, cmd)) {
			return {
				block: true,
				reason: `Johari Flow 处于 ${PHASE_CN[state.phase]} 阶段：方案未批准前禁止不可逆命令。把这条命令写进决策页，让用户拍板。`,
			};
		}

		// Evidence, not a gate: how many angles were actually hired for the review.
		if (isSubAgent && state.phase === "review") {
			state.dispatches += 1;
			persist(pi, ctx);
		}
	});

	/* ------------------------------------------------------------------ tools */

	pi.registerTool({
		name: "flow_plan",
		label: "Flow · 流程控制",
		description:
			"Johari 工作流的控制面：start 开始 / setGoal 改意图 / status 查看 / advance 推进阶段 / confirm 意图已确认 / approve 方案已批准 / abort 终止。没有进行中的流程时，用户描述需求后先调用 start。",
		promptSnippet: "推进或查看 Johari 工作流阶段（start / setGoal / status / advance / confirm / approve / abort）",
		promptGuidelines: [
			"Use flow_plan with action=\"start\" as soon as the user describes a non-trivial task, before writing any code.",
			"Use flow_plan with action=\"confirm\" once the user has confirmed the intent page; advance to research is refused until then.",
			"Use flow_plan with action=\"approve\" once the user has picked a design (record their words in reason); advance to execute is refused until then.",
			"Use flow_plan with action=\"advance\" only after the current phase's checklist is done; it refuses illegal transitions.",
			"Call flow_plan with action=\"status\" when you lose track of the phase.",
		],
		parameters: Type.Object({
			action: StringEnum(
				["start", "setGoal", "status", "advance", "confirm", "approve", "abort"] as const,
			),
			goal: Type.Optional(
				Type.String({ description: "action=start / setGoal 时：用户原始意图，逐字复制" }),
			),
			to: Type.Optional(StringEnum(TRANSITION_TARGETS, { description: "action=advance 时：目标阶段" })),
			reason: Type.Optional(Type.String({ description: "action=advance 时：为什么现在可以推进（一句话）" })),
			optionId: Type.Optional(
				Type.String({ description: "action=approve 时：用户选中的选项 id（如 A / keep），用于在看记录时认出他选了哪个" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "start": {
					if (isActive(state)) {
						return reply(
							`已经有一个进行中的流程（${PHASE_CN[state.phase]}）。先 flow_plan {action:"abort"} 或用 flow_plan {action:"status"} 查看。`,
						);
					}
					const goal = String(params.goal ?? "").trim();
					if (!goal) {
						return reply("action=start 需要 goal：把用户的原话逐字放进来，不要改写。");
					}
					state = initialState(goal);
					persist(pi, ctx);
					return reply(
						[
							`流程已开始 · ${PHASE_CN[state.phase]}`,
							"",
							"下一步（本阶段硬性要求）：",
							"1. 调用 `flow_page {kind:\"intent\"}` 出意图确认页：复述、假设、不在范围内、风险、待确认项。",
							"2. 把工具返回的「打开地址」原样贴给用户，请他打开页面确认或修正，然后停下等待。",
							"3. 用户确认后 `flow_plan {action:\"confirm\"}`，再 `flow_plan {action:\"advance\", to:\"research\"}`。",
						].join("\n"),
					);
				}
				case "status":
					return reply(renderStatus());
				case "confirm": {
					if (state.phase !== "intent") {
						return reply(
							`当前阶段 ${PHASE_CN[state.phase]} 不需要确认意图。确认只在「① 意图澄清」阶段有意义。`,
						);
					}
					state.intentConfirmed = true;
					state.decisions.push({
						question: "意图理解是否正确？",
						answer: String(params.reason ?? "").trim() || "用户确认无误",
						options: ["confirm", "correct"],
						at: nowIso(),
					});
					persist(pi, ctx);
					return reply(
						[
							"意图已标记为确认。",
							"",
							"下一步：`flow_plan {action:\"advance\", to:\"research\"}` 进入只读调研（可并行派 scout / explore / net-research）。",
						].join("\n"),
					);
				}
				case "setGoal": {
					const goal = String(params.goal ?? "").trim();
					if (!goal) return reply("action=setGoal 需要 goal：把用户修正后的原话逐字放进来。");
					if (!isActive(state)) return reply("没有进行中的流程，用 action=start 开始。");
					if (state.approval) {
						return reply(
							"方案已批准，改意图等于改方案。先 `advance` 退回 ③ 方案设计（批准会被作废），或 abort 后重开。",
						);
					}
					const from = state.phase;
					const prevGoal = state.goal;
					state.goal = goal;
					state.intentConfirmed = false;
					state.phase = "intent";
					state.decisions.push({
						question: "意图修正",
						answer: goal,
						options: [prevGoal],
						at: nowIso(),
					});
					state.history.push({
						from,
						to: "intent",
						reason: "用户修正意图，回到 ① 重新确认",
						at: nowIso(),
					});
					persist(pi, ctx);
					return reply(
						[
							"意图已按用户原话更新，回到 ① 意图澄清（需重新确认）。",
							`旧意图：${prevGoal || "（空）"}`,
							`新意图：${goal}`,
							'下一步：`flow_page {kind:"intent"}` 出新版确认页，不要再问一遍旧问题。',
						].join("\n"),
					);
				}
				case "approve": {
					if (state.phase !== "review") {
						return reply(
							[
								`当前阶段 ${PHASE_CN[state.phase]} 不能批准方案：批准只在 ④ 交叉评审 阶段有效。`,
								'先 `flow_plan {action:"advance", to:"review"}`，把评审真正做完再来批准。',
							].join("\n"),
						);
					}
					const label = String(params.reason ?? "").trim();
					if (!label) {
						return reply("action=approve 需要 reason：把用户批准的是哪个方案、原话或选项 id 写进去。");
					}
					state.approval = {
						optionId: String((params as Record<string, unknown>).optionId ?? "user"),
						label,
						at: nowIso(),
					};
					const fromApprove = state.phase;
					state.phase = "approved";
					state.decisions.push({
						question: "方案是否批准？",
						answer: label,
						options: [],
						at: nowIso(),
					});
					state.history.push({ from: fromApprove, to: "approved", reason: `用户批准：${label}`, at: nowIso() });
					persist(pi, ctx);
					const thinReview =
						state.dispatches < 2
							? `注意：④ 交叉评审只记录了 ${state.dispatches} 次 sub agent 派发（协议要求 ≥2 个不同视角）。这个批准已记在 history 里，但它建立在不足的评审上。`
							: "";
					return reply(
						[
							`方案已批准：${label}`,
							thinReview,
							"",
							`下一步：\`flow_plan {action:"advance", to:"execute"}\`，然后按编排大循环派活 → 验收 → 判断是否需要问用户。`,
						]
							.filter(Boolean)
							.join("\n"),
					);
				}
				case "advance": {
					const to = params.to as Phase | undefined;
					if (!to) return reply("action=advance 需要 to。");
					const legal = EDGES[state.phase] ?? [];
					if (!legal.includes(to)) {
						return reply(
							`非法推进：${PHASE_CN[state.phase]} → ${PHASE_CN[to]}。当前可推进到：${legal.join(" / ")}`,
						);
					}
					if (to === "research" && !state.intentConfirmed) {
						return reply(
							"推进被拒：意图尚未确认。先用 flow_page 出意图确认页，拿到用户明确确认后 `flow_plan {action:\"confirm\"}`，再推进到 research。",
						);
					}
					if (to === "execute" && !state.approval) {
						return reply(
							"推进被拒：方案尚未批准。先用 flow_page {kind:\"decision\"} + flow_ask 拿到用户对某个方案的明确选择。",
						);
					}
					if (to === "done" && !state.artifacts.some((a) => a.kind === "report")) {
						return reply(
							"推进被拒：还没有完成报告。先 flow_page {kind:\"report\"} 出报告页，再收尾。",
						);
					}
					const from = state.phase;
					// Walking back out of an approved plan invalidates the approval, otherwise a
					// stale approval would immediately re-unlock execute.
					if (
						(from === "approved" || from === "execute" || from === "report") &&
						(to === "research" || to === "design" || to === "review" || to === "intent")
					) {
						delete state.approval;
					}
					if (to === "intent") state.intentConfirmed = false;
					state.phase = to;
					state.history.push({
						from,
						to,
						reason: String(params.reason ?? "").trim() || "（未写理由）",
						at: nowIso(),
					});
					persist(pi, ctx);
					return reply(`已推进：${PHASE_CN[from]} → ${PHASE_CN[to]}\n\n${renderStatus()}`);
				}
				case "abort": {
					const from = state.phase;
					state = initialState();
					persist(pi, ctx);
					return reply(`流程已终止（${PHASE_CN[from]} → 空闲）。`);
				}
			}
		},
	});

	pi.registerTool({
		name: "flow_page",
		label: "Flow · HTML 展示页",
		description:
			"渲染一个 Johari 展示页并在浏览器打开：intent 意图确认 / decision 决策简报 / report 完成报告。页面自带四象限面板与可点击回执。",
		promptSnippet: "生成并打开 Johari 展示页（intent / decision / report）",
		promptGuidelines: [
			"Use flow_page {kind:\"intent\"} before any research so the user can confirm your understanding of the request.",
			"Never bundle independent decisions into one options list: when a page asks N questions, pass `questions` (N groups, each with its own choices) so the user answers them one by one.",
			"Use `options` only when the page has exactly one decision, and then include a do-nothing option.",
			"Use flow_page {kind:\"report\"} when the work is done; every conclusion in it must cite evidence.",
			"Fill the johari panel on every flow_page call — an empty quadrant is a claim in itself.",
			"Write for someone who never reads code: no code blocks, no file names, no identifiers, no jargon. Say it in plain spoken language.",
			"One decision per section: give one `lead` sentence and 1-2 blocks; leave `note` inside blocks empty unless the number or picture genuinely cannot carry the point.",
			"Pick the carrier that matches the shape of the content: hierarchy (code map / module structure) → `tree`; if-then paths → `branch`; who-talks-to-whom in order → `sequence`; what-depends-on-what → `graph`; states and transitions → `state`.",
			"When the reader must see something for real (screenshot, before/after, failure screen), use a block `{kind:\"image\", images:[{src,caption?}]}` with a local file path — relative to the project root or absolute. It is inlined into the page, so the page still opens offline. Remote http(s) images are refused on purpose; save them locally first.",
			"Evidence in a report is a screenshot (`image` block) or a number the reader can read. Never put json / log / csv record files in the page as links or paths — the reader will not open them, and the page should not mention them.",
			"Use `css` only when the default layout truly cannot hold the content; it appends to the default stylesheet and overrides it.",
		],
		parameters: Type.Object({
			kind: StringEnum(["intent", "decision", "report"] as const),
			title: Type.String({ description: "页面主标题（一句具体的判断，不要写「关于…的说明」）" }),
			kicker: Type.Optional(Type.String({ description: "顶部小字，默认「Johari window · 开放区优先」" })),
			summary: Type.Optional(Type.String({ description: "导语：一段话讲清这一页要让用户确认什么" })),
			sections: Type.Optional(Type.Array(SectionSchema)),
			css: Type.Optional(
				Type.String({
					description:
						"整页自定义样式（CSS），追加在默认样式之后、会覆盖默认值。只在默认版式确实放不下内容时才用",
				}),
			),
			options: Type.Optional(Type.Array(OptionSchema)),
			questions: Type.Optional(
				Type.Array(QuestionSchema, {
					description:
						"页面上的一组独立单选题（互不绑定，每题单选）；有多个决策点时用它，而不是把答案打包成 options",
				}),
			),
			johari: Type.Optional(JohariSchema),
			open: Type.Optional(
				Type.Boolean({
					description:
						"是否顺便在浏览器打开，默认 false（不打开）：默认做法是把页面地址贴给用户，由他自己打开",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.kind === "report" && state.phase !== "execute" && state.phase !== "report") {
				return reply(
					`报告页只能在 ⑥ 监督执行 / ⑦ 完成报告 阶段生成（当前 ${PHASE_CN[state.phase]}）。先把活干完、证据收齐 —— 在意图阶段出「完成报告」等于凭空写结果。`,
				);
			}
			const dir = resolve(ctx.cwd, ".pi", "flow", sessionSlug(ctx));
			const spec: PageSpec = {
				kind: params.kind,
				title: params.title,
				kicker: params.kicker,
				summary: params.summary,
				sections: (params.sections ?? []) as unknown as PageSection[],
				options: params.options,
				questions: params.questions as PageQuestion[] | undefined,
				johari: params.johari,
				meta: {
					阶段: PHASE_CN[state.phase],
					意图: state.intentConfirmed ? "已确认" : "未确认",
				},
				css: params.css,
			};
			const html = renderPage(spec, {
				phase: PHASE_CN[state.phase],
				cwd: ctx.cwd,
				sessionId: sessionSlug(ctx),
				project: basename(ctx.cwd),
				version: PKG_VERSION,
				dir,
			});
			let absPath: string;
			try {
				absPath = await writePage(dir, params.kind, html);
			} catch (err) {
				return reply(
					[
						`页面没写成：${err instanceof Error ? err.message : String(err)}`,
						"不要把页面当作已经给用户看过。先用聊天把结论讲清楚，或修好目录权限后重试。",
					].join("\n"),
				);
			}
			const fileName = absPath.split(/[\\/]/).pop() ?? "";
			state.pageSeq = Number.parseInt(fileName, 10) || state.pageSeq;

			const relPath = join(".pi", "flow", sessionSlug(ctx), fileName).replace(/\\/g, "/");
			const relRecord = relPath.replace(/\.html$/, ".json");
			state.artifacts.push({
				kind: params.kind,
				title: params.title,
				takeaway: params.summary?.slice(0, 160),
				path: relPath,
				at: nowIso(),
			});
			persist(pi, ctx);

			const wroteRecord = await writePageRecord(ctx, absPath, {
				version: PKG_VERSION,
				at: nowIso(),
				phase: state.phase,
				kind: params.kind,
				title: params.title,
				page: relPath,
				cwd: ctx.cwd,
				opened: params.open === true,
				spec,
			});

			// Pages stay closed unless the caller asks: the link is handed to the
			// user in the reply instead of a browser window taking focus.
			let opened = false;
			if (params.open === true && ctx.hasUI) opened = await openInBrowser(pi, absPath);
			try {
				ctx.ui.notify(`页面已生成：${relPath}`, "info");
			} catch {
				/* cosmetic */
			}

			return reply(
				[
					`已生成 ${params.kind} 页面：\`${relPath}\``,
					`打开地址（原样贴给用户，不要改写）：${pathToFileURL(absPath).href}`,
					wroteRecord ? `配置记录：\`${relRecord}\`` : "配置记录：没写成（页面本身正常）",
					opened ? "（本次按 open:true 已自动打开）" : "（默认不自动打开）",
					"",
					plainSummary(spec),
					"",
					"---",
					"**接下来必须做的一件事**：把「打开地址」贴给用户，请他打开页面确认/选择（选项点击即复制回执），然后 **停下等待**。",
					"不要在同一轮里继续推进阶段。",
				].join("\n"),
				{ page: relPath, record: relRecord, url: pathToFileURL(absPath).href },
			);
		},
	});

	pi.registerTool({
		name: "flow_ask",
		label: "Flow · 向用户提问",
		description:
			"向用户提一个必须由人拍板的决策问题：默认在对话里弹选择框（界面会给未读提示），选项自带代价；要页面作答就传 open:true。",
		promptSnippet: "向用户提出一个带选项的决策问题并等待回答",
		promptGuidelines: [
			"Use flow_ask whenever a decision belongs to the user (scope, trade-off, irreversible action, conflicting requirements) instead of guessing.",
			"Give flow_ask at least two real options plus the cost line of each; never offer a single option.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "一句话问题，必须是能回答的选择题" }),
			context: Type.Optional(Type.String({ description: "决策背景：为什么现在必须决定、已经验证了什么" })),
			options: Type.Array(OptionSchema, {
				description: "至少两个真实选项（每个都要写代价）；只给 1 个会被拒绝",
			}),
			johari: Type.Optional(JohariSchema),
			page: Type.Optional(Type.Boolean({ description: "是否同时生成 HTML 决策简报，默认 true" })),
			open: Type.Optional(
				Type.Boolean({
					description: "是否打开决策页并等用户在上面点选（默认 false：只在对话里弹选择框，不打扰用户）",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const options = params.options ?? [];
			// The picker is the default surface, so it has to carry the cost, not just the
			// title: a dialog without a price tag is a coin flip.
			const labels = options.map((o) => `${o.id}) ${o.label}${o.cost ? ` — ${o.cost}` : ""}`);
			if (options.length < 2) {
				return reply(
					"flow_ask 至少要两个真实选项（每个都写代价）。如果这道题只有一个正确答案，那不该问用户，该你自己决定并说明理由。",
					{ answered: false },
				);
			}

			// The card is the page, for the 90% of questions that do not need one: it lands
			// in the conversation as soon as the tool starts, so the person can read while
			// the picker is already open. The final result replaces it with the decision.
			const card = [
				`**需要你拍板：${params.question}**`,
				params.context ? String(params.context).trim() : "",
				options
					.map(
						(o) =>
							`- **${o.id}) ${o.label}**${o.recommended ? "（推荐）" : ""}${o.cost ? ` — 代价：${o.cost}` : ""}`,
					)
					.join("\n"),
			]
				.filter(Boolean)
				.join("\n\n");
			try {
				onUpdate?.({ content: [{ type: "text", text: card }], details: { waiting: true } } as never);
			} catch {
				/* a host without partial results still gets the picker */
			}
			// A pending dialog already dots the session; the widget keeps the question visible
			// in the chat itself, and the status line keeps it visible in the footer.
			try {
				ctx.ui.setWidget("johari · 待拍板", [
					`⏳ 等你拍板：${params.question}`,
					`${options.length} 个选项，每个都写了代价；点一项就继续。`,
				]);
				ctx.ui.setStatus("johari", "等你拍板");
			} catch {
				/* fire-and-forget */
			}
			const clearAsk = () => {
				try {
					ctx.ui.setWidget("johari · 待拍板", undefined);
					ctx.ui.setStatus("johari", undefined);
				} catch {
					/* fire-and-forget */
				}
			};

			let pageUrl = "";
			let pageRecord = "";
			// The listener is the wire back from a `file://` page: it exists only for this
			// one question and dies with it. No listener, no live page — the picker below
			// still asks the same question.
			let waiter: AnswerWaiter | null = null;
			if (params.page !== false) {
				try {
					// No UI means nobody can click, and a page nobody asked to open must not
					// start one either: print/json runs still get the page as an artifact.
					if (!ctx.hasUI) throw new Error("当前模式没有交互界面");
					if (params.open !== true) throw new Error("没有要求打开页面");
					waiter = await startAnswerServer({ ids: options.map((o) => o.id) });
				} catch (err) {
					waiter = null;
					// Asking for a page and silently not getting one is the surprise to avoid;
					// not asking for one is the normal path and needs no notice.
					if (params.open === true && ctx.hasUI) {
						try {
							ctx.ui.notify(
								`页面作答通道没起来（不影响提问，会改用选择框）：${err instanceof Error ? err.message : String(err)}`,
								"warning",
							);
						} catch {
							/* no UI */
						}
					}
				}
				const dir = resolve(ctx.cwd, ".pi", "flow", sessionSlug(ctx));
				const spec: PageSpec = {
					kind: "decision",
					title: params.question,
					kicker: "Johari window · 需要你拍板",
					summary: params.context,
					sections: [
						{
							heading: "决策背景",
							body: params.context ?? "（未提供背景：这本身就是盲区，请补充）",
							tone: "facts",
						},
					],
					options,
					johari: params.johari,
					meta: { 阶段: PHASE_CN[state.phase] },
				};
				const html = renderPage(spec, {
					phase: PHASE_CN[state.phase],
					cwd: ctx.cwd,
					sessionId: sessionSlug(ctx),
					project: basename(ctx.cwd),
					version: PKG_VERSION,
					dir,
					live: waiter ? { endpoint: waiter.endpoint, token: waiter.token } : undefined,
				});
				try {
					const absPath = await writePage(dir, "decision", html);
					const fileName = absPath.split(/[\\/]/).pop() ?? "";
					state.pageSeq = Number.parseInt(fileName, 10) || state.pageSeq;
					const relPath = join(".pi", "flow", sessionSlug(ctx), fileName).replace(/\\/g, "/");
					const relRecord = relPath.replace(/\.html$/, ".json");
					state.artifacts.push({
						kind: "decision",
						title: params.question,
						path: relPath,
						at: nowIso(),
					});
					pageUrl = pathToFileURL(absPath).href;
					const rec = await writePageRecord(ctx, absPath, {
						version: PKG_VERSION,
						at: nowIso(),
						phase: state.phase,
						kind: "decision",
						title: params.question,
						page: relPath,
						cwd: ctx.cwd,
						opened: false,
						spec,
					});
					if (rec) pageRecord = relRecord;
					// The wait below blocks the turn, so the page has to be in front of the
					// user now — a link they have to paste is not an answer channel.
					const opened = waiter ? await openInBrowser(pi, pageUrl) : false;
					// A page nobody could open cannot answer: hand the question back to the picker.
					if (waiter && !opened) {
						waiter.close();
						waiter = null;
					}
					try {
						ctx.ui.notify(
							opened ? `决策页已打开，点一项就算作答：${pageUrl}` : `决策页：${pageUrl}`,
							"info",
						);
					} catch {
						/* cosmetic */
					}
				} catch (err) {
					// The question matters more than the page: report the failure, then ask anyway.
					try {
						ctx.ui.notify(
							`决策页没写成（不影响继续提问）：${err instanceof Error ? err.message : String(err)}`,
							"warning",
						);
					} catch {
						/* no UI */
					}
				}
			}

			let answer: string | undefined;
			let timedOut = false;
			let fromPage = false;
			try {
				if (waiter) {
					const stop = () => waiter?.close();
					_signal?.addEventListener("abort", stop, { once: true });
					const pickedId = await waiter.wait(PAGE_WAIT_MS);
					_signal?.removeEventListener("abort", stop);
					if (pickedId) {
						answer = pickedId;
						fromPage = true;
					}
				}
				// The page gets the first word; the picker is the guaranteed way out —
				// closed tab, no browser, or a user who would rather click in the chat.
				if (!answer && !_signal?.aborted && ctx.hasUI) {
					const picked = await ctx.ui.select(params.question, labels);
					if (picked == null) timedOut = true;
					else answer = picked;
				}
			} catch {
				timedOut = true;
			} finally {
				waiter?.close();
				waiter = null;
				clearAsk();
			}

			if (!answer) {
				clearAsk();
				persist(pi, ctx);
				return reply(
					[
						`问题没有得到回答${timedOut ? "（页面没点、选择框也取消了）" : "（当前模式没有交互 UI）"}：`,
						`**${params.question}**`,
						...labels.map((l) => `- ${l}`),
						"",
						"请把这道题用自然语言直接问用户，拿到回答后用 `flow_ask` 重新记录，或继续下一步。",
					].join("\n"),
					{ answered: false },
				);
			}

			const picked =
				options.find((o) => `${o.id}) ${o.label}` === answer) ??
				options.find((o) => {
					const a = answer.trim();
					return a === o.id || a === `${o.id})` || a.startsWith(`${o.id})`);
				});
			if (!picked) {
				clearAsk();
				persist(pi, ctx);
				return reply(
					[
						`终端返回了「${answer}」，但它对不上任何选项 id，所以没有记成用户决定。`,
						`可选：${labels.join(" / ")}`,
						"请用自然语言跟用户核实后再记一次；不要替用户选。",
					].join("\n"),
					{ answered: false },
				);
			}
			state.decisions.push({
				question: params.question,
				answer: `${picked.id}) ${picked.label}`,
				options: labels,
				at: nowIso(),
			});
			persist(pi, ctx);

			return reply(
				[
					`用户已选择：**${picked.id}) ${picked.label}**${fromPage ? "（在页面上点的）" : ""}`,
					picked.detail ? `含义：${picked.detail}` : "",
					pageUrl ? `决策页（背景写得更全，没有自动打开）：${pageUrl}` : "",
					pageRecord ? `配置记录：\`${pageRecord}\`` : "",
					"",
					"下一步：按这个选择继续。若它改变了已批准方案的边界，先更新决策页再动手。",
				]
					.filter(Boolean)
					.join("\n"),
				{ answered: true, choice: picked.id },
			);
		},
	});

	/* --------------------------------------------------------------- commands */

	pi.registerCommand("flow", {
		description: "Johari 工作流：/flow [status|start <目标>|approve|report|abort]",
		getArgumentCompletions: (prefix: string) => {
			const items = ["status", "start", "approve", "report", "abort"].map((v) => ({
				value: v,
				label: v,
			}));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = String(args ?? "").trim();
			const [head, ...rest] = raw.split(/\s+/);
			const tail = rest.join(" ").trim();

			if (!head || head === "status") {
				ctx.ui.notify(renderStatus().replace(/\*\*/g, ""), "info");
				return;
			}

			if (head === "start") {
				if (!tail) {
					ctx.ui.notify("用法：/flow start <你想做的事>", "warning");
					return;
				}
				if (isActive(state)) {
					ctx.ui.notify(`已有进行中的流程（${PHASE_CN[state.phase]}），先 /flow abort`, "warning");
					return;
				}
				state = initialState(tail);
				persist(pi, ctx);
				pi.sendUserMessage(
					`[flow] 以 Johari 工作流开始这个需求（先出意图确认页，不要写代码）：${tail}`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			if (head === "approve") {
				if (state.phase !== "review") {
					ctx.ui.notify(
						`当前阶段 ${PHASE_CN[state.phase]} 不能批准方案（只在 ④ 交叉评审 阶段有效）`,
						"warning",
					);
					return;
				}
				state.approval = {
					optionId: tail || "manual",
					label: tail || "用户在终端直接批准",
					at: nowIso(),
				};
				const from = state.phase;
				state.phase = "approved";
				state.history.push({ from, to: "approved", reason: `用户批准：${tail || "（无备注）"}`, at: nowIso() });
				persist(pi, ctx);
				ctx.ui.notify("方案已批准，可以进入 execute", "info");
				return;
			}

			if (head === "report") {
				if (!isActive(state)) {
					ctx.ui.notify("没有进行中的流程", "warning");
					return;
				}
				if (state.phase !== "execute" && state.phase !== "report") {
					ctx.ui.notify(
						`当前阶段 ${PHASE_CN[state.phase]} 不能出完成报告（先到 ⑥ 监督执行）`,
						"warning",
					);
					return;
				}
				const from = state.phase;
				state.phase = "report";
				state.history.push({ from, to: "report", reason: "用户手动要求出报告", at: nowIso() });
				persist(pi, ctx);
				pi.sendUserMessage("[flow] 出完成报告页（flow_page kind=report），逐条给证据。", {
					deliverAs: "followUp",
				});
				return;
			}

			if (head === "abort") {
				const from = state.phase;
				state = initialState();
				persist(pi, ctx);
				ctx.ui.notify(`流程已终止（${PHASE_CN[from]} → 空闲）`, "info");
				return;
			}

			ctx.ui.notify(`未知子命令：${head}`, "warning");
		},
	});
}
