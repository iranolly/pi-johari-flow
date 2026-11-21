/**
 * Johari-window self-check — *validator*, not author.
 *
 * The self-check belongs to the model, written at the end of its own reply: it is
 * a judgement about wording ("did I write 应该 when I meant 未验证?"), framing
 * ("did I turn your question into mine?"), and omission. No regex can make that
 * judgement, so this module does not try:
 *
 *   - it defines the eight dimensions the self-check must cover;
 *   - it verifies the block exists and that every dimension carries content;
 *   - when it does not, the hook asks the model to finish the job on its next
 *     turn — never a machine-fabricated score.
 *
 * Two failure modes this version is built to avoid:
 *   1. Treating a *mention* of the title as the block. Only a heading-shaped line
 *      (`## `, `**…**`, `- …`) counts, and the last such line wins.
 *   2. Accepting a bare label as coverage. Every dimension needs at least
 *      MIN_DIM_CHARS of non-space content after its colon, so "证据：无" fails
 *      while "证据：无，本轮未跑测试" passes.
 *
 * Earlier versions of this file scored replies with regexes and printed
 * "开放区 100%". That was the agent grading itself with a ruler it wrote; the
 * number measured regex hits, not honesty. Removed.
 */

import type { Phase } from "./types.ts";

export const SELF_CHECK_TITLE = "乔哈里自检";

/** Non-space characters a dimension needs after its label to count as written. */
const MIN_DIM_CHARS = 4;

export interface SelfCheckDimension {
	/** Label that must appear in the self-check block. */
	key: string;
	/** What the model must actually ask itself. */
	prompt: string;
}

export const SELF_CHECK_DIMENSIONS: SelfCheckDimension[] = [
	{
		key: "证据",
		prompt: "每条事实断言是否指到可核查的东西（path:line / URL / 命令输出）；哪些其实只是推断",
	},
	{
		key: "用词",
		prompt:
			"有没有绝对化（一定 / 必然 / 从来）、软化逃避（应该 / 大概 / 可能）、用形容词替数字、临时造术语、被动卸责（「被要求」「被认为是」）",
	},
	{
		key: "框架",
		prompt: "有没有把你的问题改写成我的问题、只答字面而回避真问题、把设计缺陷降级成实现细节、悄悄扩大或缩小范围",
	},
	{
		key: "假设",
		prompt: "我默认了什么却没说出口；哪一条一旦不成立，结论就崩",
	},
	{
		key: "未知",
		prompt: "我不知道什么、需要什么证据才能确定、哪一处本该去查却靠猜",
	},
	{
		key: "隐藏",
		prompt: "我隐去了什么：代价、风险、没做的事、失败过的尝试、被否掉的方案",
	},
	{
		key: "一致性",
		prompt: "与前面轮次或已定决策有无冲突；目标、验收标准是否被我悄悄改掉",
	},
	{
		key: "下一步",
		prompt: "下一步是否明确；有没有该问用户却自己拍板、有没有该停下却继续做",
	},
];

export interface SelfCheckReport {
	present: boolean;
	found: string[];
	/** Dimensions whose label never appears. */
	missing: string[];
	/** Dimensions whose label appears but carries (almost) no content. */
	short: string[];
	/** Present but so short overall it is probably boilerplate. */
	thin: boolean;
	verdict: "ok" | "incomplete" | "absent";
}

/**
 * Locate the self-check block. Only a heading-shaped line counts, so a reply that
 * *quotes* the rule ("hook 只会校验有没有写「乔哈里自检」") is not mistaken for the
 * block itself. The last matching line wins.
 */
export function findSelfCheckBlock(text: string): string | null {
	// Only a heading-shaped line counts: markdown markers, then the title, nothing else.
	const re = /(?:^|\n)[ \t]{0,3}(?:[-*+>][ \t]+)*(?:#{1,6}[ \t]+)?\**[ \t]*乔哈里自检/g;
	const candidates: number[] = [];
	for (let m = re.exec(text); m !== null; m = re.exec(text)) candidates.push(m.index);
	if (!candidates.length) return null;
	// Walk backwards: a real block is followed by dimension labels, so a trailing
	// one-line mention (`乔哈里自检：已补齐`) cannot hide the block above it.
	for (let i = candidates.length - 1; i >= 0; i -= 1) {
		const tail = text.slice(candidates[i]);
		const labelled = SELF_CHECK_DIMENSIONS.filter((d) =>
			new RegExp(`\\*{0,2}${d.key}\\*{0,2}\\s*[:：]`).test(tail),
		).length;
		if (labelled >= 3 || i === 0) return tail;
	}
	return text.slice(candidates[candidates.length - 1]);
}

/** Content the model wrote after a dimension label, whitespace stripped. */
function dimensionContent(block: string, key: string): string | null {
	const re = new RegExp(`^[^\\n]*?${key}\\*{0,2}\\s*[:：]\\s*([^\\n]*)`, "m");
	const m = re.exec(block);
	if (!m) return null;
	return m[1].replace(/[\s*_`>]/g, "");
}

export function checkSelfCheck(text: string, _phase?: Phase): SelfCheckReport {
	const block = findSelfCheckBlock(text);
	if (block === null) {
		return {
			present: false,
			found: [],
			missing: SELF_CHECK_DIMENSIONS.map((d) => d.key),
			short: [],
			thin: false,
			verdict: "absent",
		};
	}
	const found: string[] = [];
	const missing: string[] = [];
	const short: string[] = [];
	for (const dim of SELF_CHECK_DIMENSIONS) {
		const content = dimensionContent(block, dim.key);
		if (content === null) missing.push(dim.key);
		else if (content.length < MIN_DIM_CHARS) short.push(dim.key);
		else found.push(dim.key);
	}
	const thin = block.replace(/\s+/g, "").length < 40;
	const verdict = missing.length || short.length ? "incomplete" : "ok";
	return { present: true, found, missing, short, thin, verdict };
}

/** Short human-readable description of what is wrong, for the hook's message. */
export function describeSelfCheckGap(report: SelfCheckReport): string {
	if (report.verdict === "ok") return "";
	const bits: string[] = [];
	if (report.verdict === "absent") bits.push("整段缺失");
	else {
		if (report.missing.length) bits.push(`缺 ${report.missing.join(" / ")}`);
		if (report.short.length) bits.push(`只有标签、没有内容：${report.short.join(" / ")}`);
		if (report.thin) bits.push("整段过短，像套话");
	}
	return bits.join("；");
}

/** Markdown marker describing a miss (shown to the user / stored in an entry). */
export function renderSelfCheckMarker(report: SelfCheckReport): string {
	if (report.verdict === "ok") return "";
	if (report.verdict === "absent") {
		return `[自检缺] 这条回复没有「${SELF_CHECK_TITLE}」。八项待补：${SELF_CHECK_DIMENSIONS.map((d) => d.key).join(" / ")}。`;
	}
	return `[自检不全] ${describeSelfCheckGap(report)}。`;
}

/** The block the model is expected to append itself. */
export function selfCheckTemplate(): string {
	return [
		`**${SELF_CHECK_TITLE}**`,
		...SELF_CHECK_DIMENSIONS.map((d) => `- ${d.key}：…`),
	].join("\n");
}

/** Rules injected into the system prompt (kept next to the dimensions they describe). */
export function selfCheckRules(): string {
	const dims = SELF_CHECK_DIMENSIONS.map((d) => `- **${d.key}**：${d.prompt}`).join("\n");
	return [
		"### 每条回复末尾必须由你亲手写「乔哈里自检」",
		"这不是选项，也不是分数。它是你在把回复交给用户之前，对自己的输出做一次审查：",
		dims,
		"",
		"格式（八项都要，写「无」时必须说清为什么无）。**默认写紧凑版**：八项挤在同一个引用块里，每项一句、整段不超过 6 行 —— 用户要看的是内容，不是排版：",
		"",
		"```",
		selfCheckTemplate(),
		"```",
		"",
		"硬约束：",
		"- hook 只**校验**有没有写、八项齐不齐、每项有没有实际内容；它不会替你生成自检，也不会给你打分。",
		"- 每项标签后面必须有内容（≥4 个非空白字符），只写「无」会被判为未写。",
		"- 缺项时你会收到一条 followUp 提醒，那不是新任务，是让你把自检补完。",
		"- 标题必须是行首的独立一行（`**乔哈里自检**` 或 `## 乔哈里自检`），正文里提到这句话不算。",
	].join("\n");
}
