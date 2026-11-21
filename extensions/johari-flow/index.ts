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
import { join, resolve } from "node:path";
import { type PageQuestion, type PageSection, type PageSpec, renderPage } from "./html.ts";
import { checkSelfCheck, describeSelfCheckGap, selfCheckRules } from "./johari.ts";
import { buildProtocol, phaseBadge } from "./protocol.ts";
import {
	EDGES,
	type FlowState,
	type Phase,
	initialState,
	isActive,
	isPreApproval,
} from "./types.ts";

const ENTRY_TYPE = "johari-flow";
const SELFCHECK_ENTRY_TYPE = "johari-selfcheck";
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
		] as const,
		{
			description:
				"视觉载体：flow=步骤链 timeline=时间线 stats=大数字卡 bars=条形对比 compare=左右对照 callout=重点框 loop=循环示意 facts=键值卡 tree=层级地图（代码地图/模块结构，可折叠） branch=分支流程（如果…就…的岔路） sequence=多方顺序（谁跟谁说了什么） graph=关系网（依赖/关联） state=状态机（状态与跳转条件）",
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
	caption: Type.Optional(Type.String()),
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
/** Follow-up nudges per self-check miss; capped so a stubborn turn cannot loop. */
let selfCheckNags = 0;

function nowIso(): string {
	return new Date().toISOString();
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext): void {
	state.updatedAt = nowIso();
	try {
		pi.appendEntry(ENTRY_TYPE, state);
	} catch {
		/* appendEntry is best-effort; the in-memory state still drives this turn */
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
		if (process.platform === "win32") {
			await pi.exec("cmd", ["/c", "start", "", absPath], { timeout: 8000 });
		} else if (process.platform === "darwin") {
			await pi.exec("open", [absPath], { timeout: 8000 });
		} else {
			await pi.exec("xdg-open", [absPath], { timeout: 8000 });
		}
		return true;
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

/** Sub-agent tool names differ per build (Agent / subagent / task …). */
const SUBAGENT_RE = /^(agent|task|subagent|delegate|spawn|parallel)/;

/** Shell one-liners that mutate the filesystem. */
const SHELL_WRITE_RE =
	/(^|[^0-9&])>\s*[^>\s]|\btee\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bNew-Item\b|\btouch\b|\bcp\b|\bmv\b|\bsed\s+-i\b|\bmkdir\b/i;

/** Irreversible commands: blocked until the user approved a design (see isDestructive). */

/** Read-only commands whose arguments may legitimately quote scary strings. */
const INSPECT_RE = /^(rg|grep|egrep|ag|ack|fd|cat|type|Get-Content|less|head|tail|git\s+(log|show|diff|grep)|echo)\b/i;

/** Strip quotes and collapse whitespace before matching command shape. */
function normalizeCmd(cmd: string): string {
	return cmd.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
}

/** Could this shell line destroy data or history? */
function isDestructive(raw: string): boolean {
	const cmd = normalizeCmd(raw);
	if (/\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r|r)\b/.test(cmd)) return true;
	if (/\bfind\b[^|]*\s-delete\b/.test(cmd)) return true;
	if (
		/\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+(push\s+(-f\b|--force)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/.test(cmd)
	)
		return true;
	if (/(^|[^0-9&])>\s*\S/.test(cmd) || /\bdd\s+if=|\btruncate\s+(--size|-s)\b|(^|\s):\s*>/.test(cmd)) return true;
	if (/\b(drop\s+table|truncate\s+table)\b/i.test(cmd)) return true;
	if (/\b(Remove-Item\b[^|]*-Recurse|shred\b|mkfs|format\s+[a-z]:)/i.test(cmd)) return true;
	return false;
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

/* --------------------------------------------------------------------- init */

export default function johariFlow(pi: ExtensionAPI) {
	/* ------------------------------------------------------------- lifecycle */

	pi.on("session_start", async (_event, ctx) => {
		selfCheckNags = 0;
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
			sections.johari_flow = buildProtocol(state);
		} else {
			delete sections.johari_flow;
		}
	});

	/* ---------------------------------------------------- Johari post-process */

	pi.on("message_end", (event, ctx) => {
		if (!isActive(state)) return;
		const msg = event.message as any;
		if (!msg || msg.role !== "assistant") return;
		const parts = Array.isArray(msg.content) ? msg.content : [];
		// Intermediate assistant messages carry tool calls; only finalize user-facing text.
		if (parts.some((p: any) => p?.type === "toolCall" || p?.type === "tool_call")) return;
		const text = parts
			.filter((p: any) => p?.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("\n")
			.trim();
		if (!text) return;

		const report = checkSelfCheck(text, state.phase);
		if (report.verdict === "ok") {
			selfCheckNags = 0;
			return;
		}

		// The self-check is the model's own work: nudge it to finish the block, and
		// record the verdict in a custom entry (not in LLM context). The marker is
		// never spliced into the assistant message — that would put words the model
		// never wrote into its own transcript and into every later turn.
		const gap = describeSelfCheckGap(report);
		try {
			pi.appendEntry(SELFCHECK_ENTRY_TYPE, {
				at: nowIso(),
				phase: state.phase,
				verdict: report.verdict,
				found: report.found,
				missing: report.missing,
				short: report.short,
				thin: report.thin,
			});
		} catch {
			/* best effort */
		}
		try {
			ctx.ui.notify(`乔哈里自检 · ${gap}`, "warning");
		} catch {
			/* cosmetic */
		}
		if (selfCheckNags < 2) {
			selfCheckNags += 1;
			pi.sendUserMessage(
				[
					`你的上一条回复的自检不完整：${gap}。`,
					"请在回复末尾自己补写「乔哈里自检」，八项：证据 / 用词 / 框架 / 假设 / 未知 / 隐藏 / 一致性 / 下一步。",
					"每项标签后要有实际内容（只写「无」不算）；写「无」必须说明为什么无。这不是新任务，只是把自检补完。",
				].join(""),
				{ deliverAs: "followUp" },
			);
		}
	});

	/* ------------------------------------------------------------- hard gates */

	pi.on("tool_call", (event, ctx) => {
		if (!isActive(state)) return;
		const name = String(event.toolName ?? "");
		const lower = name.toLowerCase();
		const input = (event.input ?? {}) as Record<string, unknown>;
		const cmd = String(input.command ?? input.script ?? input.cmd ?? "");
		const isShell = SHELL_TOOLS.has(lower);
		const isSubAgent = SUBAGENT_RE.test(lower);

		if (state.phase === "intent") {
			const writesFile =
				lower === "write" || lower === "edit" || (isShell && SHELL_WRITE_RE.test(cmd));
			if (writesFile) {
				return {
					block: true,
					reason:
						"Johari Flow 处于「意图澄清」阶段：意图未确认前禁止写文件（含 shell 重定向 / Set-Content / tee）。先调用 flow_page {kind:\"intent\"} 出确认页，等用户确认后再 flow_plan 推进。",
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

		if (isPreApproval(state) && isShell && !INSPECT_RE.test(cmd.trim()) && isDestructive(cmd)) {
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
					persist(pi, ctx);					return reply(
						[
							`流程已开始 · ${PHASE_CN[state.phase]}`,
							"",
							"下一步（本阶段硬性要求）：",
							"1. 调用 `flow_page {kind:\"intent\"}` 出意图确认页：复述、假设、不在范围内、风险、待确认项。",
							"2. 告诉用户「页面已打开，请确认或修正」，然后停下等待。",
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
					selfCheckNags = 0;
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
					state.approval = { optionId: params.to ?? "user", label, at: nowIso() };
					selfCheckNags = 0;
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
					selfCheckNags = 0;
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
			open: Type.Optional(Type.Boolean({ description: "是否自动打开浏览器，默认 true" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.kind === "report" && state.phase !== "execute" && state.phase !== "report") {
				return reply(
					`报告页只能在 ⑥ 监督执行 / ⑦ 完成报告 阶段生成（当前 ${PHASE_CN[state.phase]}）。先把活干完、证据收齐 —— 在意图阶段出「完成报告」等于凭空写结果。`,
				);
			}
			const dir = resolve(ctx.cwd, ".pi", "flow", sessionSlug(ctx));
			const seqNum = await nextPageSeq(dir);
			state.pageSeq = seqNum;
			const seq = String(seqNum).padStart(2, "0");
			const fileName = `${seq}-${params.kind}.html`;
			const absPath = join(dir, fileName);
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
			});
			await mkdir(dir, { recursive: true });
			await writeFile(absPath, html, "utf8");

			const relPath = join(".pi", "flow", sessionSlug(ctx), fileName).replace(/\\/g, "/");
			state.artifacts.push({
				kind: params.kind,
				title: params.title,
				takeaway: params.summary?.slice(0, 160),
				path: relPath,
				at: nowIso(),
			});
			persist(pi, ctx);

			let opened = false;
			if (params.open !== false) opened = await openInBrowser(pi, absPath);
			try {
				ctx.ui.notify(opened ? `已打开 ${params.kind} 页面` : `页面已生成：${relPath}`, "info");
			} catch {
				/* cosmetic */
			}

			return reply(
				[
					`已生成 ${params.kind} 页面：\`${relPath}\`${opened ? "（已在浏览器打开）" : "（未能自动打开，请手动打开）"}`,
					"",
					plainSummary(spec),
					"",
					"---",
					"**接下来必须做的一件事**：用一句话请用户确认/选择（页面里的选项点击即复制回执），然后 **停下等待**。",
					"不要在同一轮里继续推进阶段。",
				].join("\n"),
				{ page: relPath },
			);
		},
	});

	pi.registerTool({
		name: "flow_ask",
		label: "Flow · 向用户提问",
		description:
			"向用户提一个必须由人拍板的决策问题（终端选择 + 可选 HTML 简报），阻塞直到用户回答，并把答案记进流程状态。",
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options = params.options ?? [];
			const labels = options.map((o) => `${o.id}) ${o.label}`);
			if (options.length < 2) {
				return reply(
					"flow_ask 至少要两个真实选项（每个都写代价）。如果这道题只有一个正确答案，那不该问用户，该你自己决定并说明理由。",
					{ answered: false },
				);
			}

			if (params.page !== false) {
				const dir = resolve(ctx.cwd, ".pi", "flow", sessionSlug(ctx));
				const seqNum = await nextPageSeq(dir);
				state.pageSeq = seqNum;
				const seq = String(seqNum).padStart(2, "0");
				const absPath = join(dir, `${seq}-decision.html`);
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
				await mkdir(dir, { recursive: true });
				await writeFile(
					absPath,
					renderPage(spec, { phase: PHASE_CN[state.phase], cwd: ctx.cwd, sessionId: sessionSlug(ctx) }),
					"utf8",
				);
				state.artifacts.push({
					kind: "decision",
					title: params.question,
					path: join(".pi", "flow", sessionSlug(ctx), `${seq}-decision.html`).replace(/\\/g, "/"),
					at: nowIso(),
				});
				await openInBrowser(pi, absPath);
			}

			let answer: string | undefined;
			let timedOut = false;
			try {
				if (ctx.hasUI) {
					const picked = await ctx.ui.select(params.question, labels);
					if (picked == null) timedOut = true;
					else answer = picked;
				}
			} catch {
				timedOut = true;
			}

			if (!answer) {
				persist(pi, ctx);
				return reply(
					[
						`问题未在终端得到回答${timedOut ? "（用户取消或超时）" : "（当前模式没有交互 UI）"}：`,
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
					`用户已选择：**${picked.id}) ${picked.label}**`,
					picked.detail ? `含义：${picked.detail}` : "",
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
				if (state.phase !== "execute" && state.phase !== "approved" && state.phase !== "report") {
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
