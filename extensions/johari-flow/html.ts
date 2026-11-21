/**
 * HTML rendering for flow pages.
 *
 * Three page kinds share one document shell so the user learns the layout once:
 *   intent   — "did I understand you?" (the blind-spot check)
 *   decision — "here are the options, you pick" (the hidden-area check)
 *   report   — "here is what actually happened" (the unknown-area check)
 *
 * Everything is local and offline: no CDNs, no fonts, no network. Option rows
 * copy a paste-ready receipt to the clipboard, so a `file://` page can still
 * answer back into Pi without a server.
 */

export type Tone = "plain" | "facts" | "assumptions" | "unknowns" | "risks" | "deliverables";

export interface PageOption {
	id: string;
	label: string;
	detail?: string;
	cost?: string;
	recommended?: boolean;
}

/**
 * One candidate answer inside a single-choice question.
 * A question group is never a bundle: the user picks one row per group and the
 * groups are independent, so N questions give N independent answers.
 */
export interface PageChoice {
	id: string;
	label: string;
	detail?: string;
	recommended?: boolean;
}

/** One single-choice question on the page (a radio group, not a bundle of answers). */
export interface PageQuestion {
	id: string;
	prompt: string;
	hint?: string;
	choices: PageChoice[];
}

/**
 * A visual block. Text is the last resort: a report the reader cannot skim has
 * already failed, so every block here is a shape (chain, line, bar, pair, loop)
 * instead of a paragraph.
 */
export type Block =
	| { kind: "flow"; steps: Array<{ title: string; note?: string; status?: "done" | "now" | "next" }> }
	| { kind: "timeline"; events: Array<{ when: string; title: string; note?: string }> }
	| { kind: "stats"; stats: Array<{ value: string; unit?: string; label: string; note?: string }> }
	| {
			kind: "bars";
			bars: Array<{ label: string; value: number; max?: number; note?: string; tone?: "open" | "blind" | "hidden" | "unknown" }>;
			caption?: string;
	  }
	| { kind: "compare"; left: { title: string; items: string[] }; right: { title: string; items: string[] } }
	| { kind: "callout"; tone?: "info" | "warn" | "ok"; title?: string; text: string }
	| { kind: "loop"; steps: Array<{ title: string; note?: string }> }
	| { kind: "facts"; facts: Array<{ label: string; value: string }> }
	/** Hierarchical map (project/module structure). Flat list + `parent` ids — no recursion in the schema. */
	| { kind: "tree"; items: Array<TreeNode> }
	/** Decision/branch trace: every node hangs off a parent through a condition. */
	| { kind: "branch"; items: Array<BranchNode> }
	/** Multi-actor exchange: who talks to whom, in order. */
	| { kind: "sequence"; actors: string[]; messages: Array<SeqMessage> }
	/** Dependency/relationship net drawn on a circle. */
	| { kind: "graph"; nodes: Array<GraphNode>; edges: Array<GraphEdge> }
	/** State machine: states plus labeled transitions. */
	| { kind: "state"; states: Array<StateNode>; transitions: Array<StateTransition> };

export interface TreeNode {
	id: string;
	parent?: string;
	label: string;
	note?: string;
}

export interface BranchNode {
	id: string;
	parent?: string;
	label: string;
	/** The condition that leads into this node, e.g. "如果用户没确认". */
	cond?: string;
	note?: string;
}

export interface SeqMessage {
	from: string;
	to: string;
	text?: string;
	/** dashed = reply / async. */
	style?: "solid" | "dashed";
}

export interface GraphNode {
	id: string;
	label: string;
	kind?: "plain" | "core" | "weak";
	note?: string;
}

export interface GraphEdge {
	from: string;
	to: string;
	label?: string;
}

export interface StateNode {
	id: string;
	label: string;
	kind?: "start" | "plain" | "end";
}

export interface StateTransition {
	from: string;
	to: string;
	label?: string;
}

export interface PageSection {
	heading: string;
	/** One plain sentence under the heading — the focal line of the block. */
	lead?: string;
	body?: string;
	items?: string[];
	blocks?: Block[];
	tone?: Tone;
}

export interface PageSpec {
	kind: "intent" | "decision" | "report";
	title: string;
	kicker?: string;
	summary?: string;
	sections: PageSection[];
	options?: PageOption[];
	/** Independent single-choice questions; each renders its own radio group. */
	questions?: PageQuestion[];
	johari?: { open?: string[]; blind?: string[]; hidden?: string[]; unknown?: string[] };
	meta?: Record<string, string>;
	/** Raw page-level CSS, appended last so it wins. Use for per-page layout experiments. */
	css?: string;
}

/* ------------------------------------------------------------------ markdown */

/** CSS is model-authored: strip anything that could close the style element or fetch remote code. */
function sanitizeCss(src: string): string {
	return String(src)
		.replace(/<\/?\s*(?:style|script|link|iframe)[^>]*>/gi, "")
		.replace(/<!--|-->/g, "")
		.replace(/@import[^;]*;?/gi, "")
		.replace(/javascript\s*:/gi, "")
		.replace(/expression\s*\(/gi, "(")
		.replace(/url\s*\(\s*['"]?\s*(?:javascript|data):/gi, "url(");
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Only these link shapes are emitted as <a>: anything else (javascript:, data:) stays text. */
const SAFE_HREF = /^(https?:\/\/|mailto:|file:\/\/|#|\/|\.\/|\.\.\/)/i;

function inline(s: string): string {
	let out = esc(s);
	out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。]|$)/g, "$1<em>$2</em>");
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text: string, href: string) =>
		SAFE_HREF.test(href)
			? `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`
			: `${text} (${href})`,
	);
	out = out.replace(/(^|\s)((?:[A-Za-z]:)?[\w.@+-]*(?:[/\\][\w.@+-]+)+\.\w{1,6}(?::\d+)?)/g, '$1<code class="path">$2</code>');
	return out;
}

/** Tiny Markdown subset: headings, lists, tables, fences, quotes, paragraphs. */
export function mdToHtml(src: string): string {
	const lines = src.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let list: "ul" | "ol" | null = null;
	let para: string[] = [];

	const flushPara = () => {
		if (para.length) {
			out.push(`<p>${inline(para.join(" "))}</p>`);
			para = [];
		}
	};
	const flushList = () => {
		if (list) {
			out.push(`</${list}>`);
			list = null;
		}
	};
	const flush = () => {
		flushPara();
		flushList();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (/^\s*```/.test(line)) {
			flush();
			const buf: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
			out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			flush();
			const level = Math.min(6, h[1].length + 2);
			out.push(`<h${level}>${inline(h[2])}</h${level}>`);
			continue;
		}
		// table: | a | b |  +  | --- | --- |
		if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
			flush();
			const cells = (row: string) =>
				row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
			const head = cells(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
			i--;
			out.push(
				'<div class="tablewrap"><table><thead><tr>' +
					head.map((c) => `<th>${inline(c)}</th>`).join("") +
					"</tr></thead><tbody>" +
					rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
					"</tbody></table></div>",
			);
			continue;
		}
		if (/^\s*>\s?/.test(line)) {
			flush();
			const buf: string[] = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
			i--;
			out.push(`<blockquote>${mdToHtml(buf.join("\n"))}</blockquote>`);
			continue;
		}
		const ul = line.match(/^\s*[-*+]\s+(.*)$/);
		const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
		if (ul || ol) {
			flushPara();
			const want: "ul" | "ol" = ul ? "ul" : "ol";
			if (list && list !== want) flushList();
			if (!list) {
				list = want;
				out.push(`<${want}>`);
			}
			out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
			continue;
		}
		flushList();
		para.push(line.trim());
	}
	flush();
	return out.join("\n");
}

/* ---------------------------------------------------------------------- css */

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#0a0b0d; --bg-2:#101216; --panel:#14171c; --panel-2:#181c22;
  --line:#23272f; --line-2:#2f353f;
  --fg:#e9e7e2; --fg-dim:#a9a8a3; --fg-mute:#74777d;
  --accent:#e2a13c; --accent-dim:#8a6425;
  --open:#63b98c; --blind:#e2a13c; --hidden:#d96a4d; --unknown:#7b8ea8;
  --mono:ui-monospace,"JetBrains Mono","SF Mono",Consolas,"Liberation Mono",monospace;
  --sans:ui-sans-serif,-apple-system,"Segoe UI Variable Display","Segoe UI",Inter,"Helvetica Neue",Arial,sans-serif;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Songti SC","Source Han Serif SC",serif;
}
html{color-scheme:dark;background:#0a0b0d}
body{
  margin:0;min-height:100vh;background:
    radial-gradient(1200px 600px at 15% -10%, #16181d 0%, transparent 60%),
    radial-gradient(900px 500px at 105% 105%, #14161a 0%, transparent 55%),
    var(--bg);
  color:var(--fg);font-family:var(--sans);font-size:16px;line-height:1.62;
  -webkit-font-smoothing:antialiased;letter-spacing:.006em;
}
.wrap{max-width:1080px;margin:0 auto;padding:0 28px 96px}
.topbar{
  position:sticky;top:0;z-index:20;backdrop-filter:blur(14px) saturate(140%);
  background:color-mix(in oklab,var(--bg) 82%,transparent);
  border-bottom:1px solid var(--line);
}
.topbar .inner{max-width:1080px;margin:0 auto;padding:11px 28px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.brand{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-dim)}
.brand b{color:var(--accent);font-weight:600}
.chip{
  font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;
  padding:3px 9px;border:1px solid var(--line-2);border-radius:999px;color:var(--fg-dim);white-space:nowrap
}
.chip.kind{border-color:var(--accent-dim);color:var(--accent)}
.spacer{flex:1}
.meta{font-family:var(--mono);font-size:11px;color:var(--fg-mute);letter-spacing:.04em}

header.hero{padding:64px 0 40px;border-bottom:1px solid var(--line)}
.kicker{
  font-family:var(--mono);font-size:11px;letter-spacing:.24em;text-transform:uppercase;
  color:var(--accent);margin-bottom:20px;display:flex;align-items:center;gap:10px
}
.kicker::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--accent-dim),transparent)}
h1{
  font-family:var(--serif);font-weight:600;font-size:clamp(30px,4.4vw,52px);
  line-height:1.1;letter-spacing:-.018em;margin:0 0 18px;text-wrap:balance
}
.lede{font-size:17.5px;color:var(--fg-dim);max-width:70ch;margin:0}
.lede strong{color:var(--fg);font-weight:600}

section{display:grid;grid-template-columns:64px 1fr;gap:24px;padding:34px 0;border-bottom:1px solid var(--line)}
section:last-of-type{border-bottom:0}
.num{
  font-family:var(--mono);font-size:11px;letter-spacing:.1em;color:var(--fg-mute);
  padding-top:6px
}
section h2{
  font-family:var(--sans);font-size:clamp(20px,2.2vw,25px);font-weight:650;letter-spacing:-.01em;
  color:var(--fg);margin:0 0 10px;line-height:1.25;text-wrap:balance;display:flex;gap:11px;align-items:baseline
}
section h2::before{content:"";flex:0 0 4px;align-self:stretch;border-radius:2px;background:var(--line-2);transform:translateY(2px)}
section.tone-facts h2::before{background:var(--open)}
section.tone-assumptions h2::before{background:var(--blind)}
section.tone-risks h2::before{background:var(--hidden)}
section.tone-unknowns h2::before{background:var(--unknown)}
section.tone-deliverables h2::before{background:var(--accent)}
.lead{font-size:17px;color:var(--fg);margin:0 0 20px;max-width:62ch;line-height:1.7;font-weight:450}
.lead em{font-style:normal;color:var(--accent)}
.body{min-width:0}
.body p{margin:0 0 14px;max-width:74ch}
.body p:last-child{margin-bottom:0}
.body ul,.body ol{margin:0 0 14px;padding-left:22px}
.body li{margin:5px 0}
.body li::marker{color:var(--fg-mute)}
h3,h4,h5,h6{font-family:var(--sans);font-size:14.5px;font-weight:600;color:var(--fg);margin:22px 0 10px;letter-spacing:.01em}
code{
  font-family:var(--mono);font-size:.875em;background:var(--panel-2);border:1px solid var(--line);
  border-radius:4px;padding:.1em .38em;color:#dcd9d2
}
code.path{color:#c9c2b2;background:transparent;border:0;border-bottom:1px dotted var(--line-2);border-radius:0;padding:0}
pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;margin:0 0 16px}
pre code{background:none;border:0;padding:0;font-size:12.5px;line-height:1.6}
blockquote{
  margin:0 0 16px;padding:2px 0 2px 20px;border-left:2px solid var(--accent-dim);
  color:var(--fg-dim);font-family:var(--serif);font-size:16.5px
}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid color-mix(in oklab,var(--accent) 35%,transparent)}
a:hover{border-bottom-color:var(--accent)}
.tablewrap{overflow:auto;margin:0 0 16px;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg-mute);background:var(--panel)}
tr:last-child td{border-bottom:0}

.quad{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:34px 0 8px}
.q{background:linear-gradient(180deg,var(--panel) 0%,var(--bg-2) 100%);border:1px solid var(--line);border-top:2px solid var(--line-2);border-radius:8px;padding:16px 18px}
.q.open{border-top-color:var(--open)} .q.blind{border-top-color:var(--blind)}
.q.hidden{border-top-color:var(--hidden)} .q.unknown{border-top-color:var(--unknown)}
.q h4{margin:0 0 4px;font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--fg-mute);font-weight:500}
.q .cn{font-size:15px;font-weight:600;margin-bottom:10px}
.q ul{margin:0;padding-left:16px;font-size:13.5px;color:var(--fg-dim);line-height:1.55}
.q li{margin:3px 0}
.q .empty{font-size:13px;color:var(--fg-mute);font-style:italic}

.options{margin:6px 0 0;display:flex;flex-direction:column;gap:10px}
.opt{
  display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:start;
  background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:15px 17px;
  cursor:pointer;transition:border-color .13s ease,background .13s ease,transform .13s ease;text-align:left;
  font:inherit;color:inherit;width:100%
}
.opt:hover{border-color:var(--accent-dim);background:var(--panel-2);transform:translateX(2px)}
.opt:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.opt .id{font-family:var(--mono);font-size:11px;color:var(--fg-mute);padding-top:3px;letter-spacing:.08em}
.opt .label{font-weight:600;font-size:15.5px;display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.opt .detail{color:var(--fg-dim);font-size:13.5px;margin-top:5px;line-height:1.55}
.opt .cost{font-family:var(--mono);font-size:11px;color:var(--fg-mute);margin-top:7px;letter-spacing:.03em}
.badge{
  font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
  padding:2px 7px;border-radius:3px;background:color-mix(in oklab,var(--accent) 18%,transparent);
  color:var(--accent);border:1px solid var(--accent-dim)
}
.copy{font-family:var(--mono);font-size:10.5px;color:var(--fg-mute);letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;padding-top:4px}

.hint{
  margin-top:26px;padding:15px 18px;border:1px dashed var(--line-2);border-radius:8px;
  font-size:13.5px;color:var(--fg-dim);background:color-mix(in oklab,var(--panel) 55%,transparent)
}
.hint b{color:var(--fg)}

.qlist{display:flex;flex-direction:column;gap:16px;margin:4px 0 0}
.qitem{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px}
.qhead{display:flex;gap:12px;align-items:baseline;margin-bottom:12px}
.qid{font-family:var(--mono);font-size:11px;letter-spacing:.1em;color:var(--accent);padding-top:3px;white-space:nowrap}
.qtext{font-size:15.5px;font-weight:600;line-height:1.5}
.qhint{font-size:12.5px;color:var(--fg-mute);margin-top:4px;line-height:1.5}
.choices{display:flex;flex-wrap:wrap;gap:8px}
.choice{
  display:flex;gap:10px;align-items:flex-start;max-width:100%;text-align:left;
  background:var(--panel-2);border:1px solid var(--line-2);border-radius:6px;padding:10px 13px;
  cursor:pointer;font:inherit;color:inherit;transition:.13s
}
.choice:hover{border-color:var(--accent-dim)}
.choice:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.choice .cid{font-family:var(--mono);font-size:11px;color:var(--fg-mute);letter-spacing:.08em;padding-top:2px}
.choice .cl{font-size:14px;line-height:1.45;font-weight:500}
.choice .cd{display:block;font-size:12.5px;color:var(--fg-dim);margin-top:3px;line-height:1.5;font-weight:400}
.choice.on{border-color:var(--accent);background:color-mix(in oklab,var(--accent) 12%,var(--panel-2))}
.choice.on .cid{color:var(--accent)}
.receipt{
  margin-top:22px;padding:14px 16px;border:1px dashed var(--line-2);border-radius:8px;
  background:color-mix(in oklab,var(--panel) 55%,transparent)
}
.receipt .rl{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-mute);margin-bottom:9px}
#receiptText{font-family:var(--mono);font-size:12.5px;color:var(--fg-dim);line-height:1.65;word-break:break-word;margin-bottom:12px;white-space:pre-wrap}
#receiptNote{
  width:100%;box-sizing:border-box;background:var(--bg-2);border:1px solid var(--line);color:var(--fg);
  border-radius:6px;padding:10px 12px;font:inherit;font-size:13px;line-height:1.5;min-height:54px;resize:vertical;margin-bottom:12px
}
#receiptNote:focus{outline:1px solid var(--accent-dim)}

/* ---------------------------------------------------------------- blocks */
.blk{margin:0 0 20px}
.blk:last-child{margin-bottom:0}

/* chain of steps */
.flowline{display:grid;gap:12px;grid-template-columns:repeat(var(--cols,6),minmax(0,1fr))}
.step{
  position:relative;background:var(--panel);border:1px solid var(--line);
  border-radius:9px;padding:13px 14px 12px;border-top:2px solid var(--line-2)
}
.step .sn{
  font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;color:var(--fg-dim);display:block;margin-bottom:7px
}
.step .st{font-size:15px;font-weight:600;line-height:1.42}
.step .so{font-size:13px;color:var(--fg-dim);margin-top:6px;line-height:1.55}
.step.done{border-color:color-mix(in oklab,var(--open) 45%,var(--line));border-top-color:var(--open);background:color-mix(in oklab,var(--open) 7%,var(--panel))}
.step.done .sn{color:var(--open)}
.step.now{border-color:var(--accent-dim);border-top-color:var(--accent);background:color-mix(in oklab,var(--accent) 9%,var(--panel));box-shadow:0 0 0 1px color-mix(in oklab,var(--accent) 22%,transparent)}
.step.now .sn{color:var(--accent)}
.step.next{opacity:.88}

/* vertical timeline */
.tl{position:relative;padding-left:26px}
.tl::before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:1px;background:color-mix(in oklab,var(--fg-mute) 42%,transparent)}
.tl-item{position:relative;padding:0 0 22px 0}
.tl-item:last-child{padding-bottom:0}
.tl-dot{
  position:absolute;left:-26px;top:5px;width:11px;height:11px;border-radius:50%;
  background:var(--bg);border:2px solid var(--line-2)
}
.tl-item.on .tl-dot{border-color:var(--accent);background:var(--accent);box-shadow:0 0 0 4px color-mix(in oklab,var(--accent) 18%,transparent)}
.tl-when{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;color:var(--fg-mute);margin-bottom:3px}
.tl-title{font-size:15px;font-weight:600;line-height:1.4}
.tl-note{font-size:13.5px;color:var(--fg-dim);margin-top:4px;line-height:1.6;max-width:58ch}

/* big numbers */
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.stat{
  background:linear-gradient(180deg,var(--panel) 0%,var(--bg-2) 100%);border:1px solid var(--line);
  border-radius:9px;padding:18px 16px 15px;animation:rise .5s ease-out
}
.stat:nth-child(2){animation-delay:.06s}.stat:nth-child(3){animation-delay:.12s}.stat:nth-child(4){animation-delay:.18s}
.stat .v{font-family:var(--serif);font-size:40px;line-height:1;letter-spacing:-.02em;color:var(--fg)}
.stat .u{font-size:15px;color:var(--fg-dim);margin-left:3px;font-family:var(--sans)}
.stat .l{font-size:13.5px;color:var(--fg);margin-top:9px;font-weight:600}
.stat .n{font-size:12px;color:var(--fg-mute);margin-top:5px;line-height:1.5}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

/* bars */
.barlist{display:flex;flex-direction:column;gap:12px}
.barrow{display:grid;grid-template-columns:minmax(110px,34%) 1fr auto;gap:12px;align-items:center}
.barlabel{font-size:14px;color:var(--fg-dim)}
.bartrack{height:10px;background:var(--panel-2);border:1px solid var(--line);border-radius:99px;overflow:hidden}
.barfill{
  height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent-dim),var(--accent));
  transform-origin:left;animation:grow .8s cubic-bezier(.22,1,.36,1)
}
.barfill.open{background:linear-gradient(90deg,color-mix(in oklab,var(--open) 60%,#000),var(--open))}
.barfill.blind{background:linear-gradient(90deg,var(--accent-dim),var(--blind))}
.barfill.hidden{background:linear-gradient(90deg,color-mix(in oklab,var(--hidden) 55%,#000),var(--hidden))}
.barfill.unknown{background:linear-gradient(90deg,color-mix(in oklab,var(--unknown) 55%,#000),var(--unknown))}
.barval{font-family:var(--mono);font-size:11.5px;color:var(--fg-mute);white-space:nowrap}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.bnote{font-size:12.5px;color:var(--fg-mute);display:block;margin-top:3px;max-width:52ch}

/* two columns: before / after */
.cmp{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.cmpcol{background:var(--panel);border:1px solid color-mix(in oklab,var(--fg-mute) 30%,transparent);border-radius:9px;padding:15px 17px}
.cmpcol.right{border-color:color-mix(in oklab,var(--open) 40%,var(--line));background:color-mix(in oklab,var(--open) 6%,var(--panel))}
.cmpcol h4{margin:0 0 10px;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-mute)}
.cmpcol.right h4{color:var(--open)}
.cmpcol ul{margin:0;padding-left:17px;font-size:14px;color:var(--fg-dim);line-height:1.6}
.cmpcol li{margin:5px 0}

/* callout */
.callout{
  border:1px solid var(--line-2);border-left:3px solid var(--accent);border-radius:8px;
  padding:14px 17px;background:color-mix(in oklab,var(--accent) 6%,var(--panel))
}
.callout.ok{border-left-color:var(--open);background:color-mix(in oklab,var(--open) 7%,var(--panel))}
.callout.warn{border-left-color:var(--hidden);background:color-mix(in oklab,var(--hidden) 8%,var(--panel))}
.callout .ct{font-size:14.5px;font-weight:650;margin-bottom:5px}
.callout .cx{font-size:14px;color:var(--fg-dim);line-height:1.65;max-width:62ch}

/* loop */
.loopline{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.looppill{
  background:var(--panel);border:1px solid var(--line-2);border-radius:99px;padding:9px 16px;
  font-size:14px;display:flex;gap:9px;align-items:center
}
.looppill .ln{font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:.1em}
.looppill::before{content:"⟶";color:var(--fg-mute);margin-right:2px;font-size:12px}
.looppill:first-child::before{display:none}
.loopback{
  margin-top:12px;font-family:var(--mono);font-size:11px;letter-spacing:.1em;color:var(--accent);
  display:flex;align-items:center;gap:9px
}
.loopback .arc{
  flex:0 0 44px;height:16px;border:1px dashed var(--accent-dim);border-bottom:0;
  border-radius:14px 14px 0 0;position:relative;animation:spin 6.5s linear infinite;transform-origin:50% 100%
}
@keyframes spin{to{transform:rotate(360deg)}}

/* facts */
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.fact{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:11px 14px}
.fact .fl{font-size:12px;color:var(--fg-mute);letter-spacing:.04em}
.fact .fv{font-size:14.5px;margin-top:4px;line-height:1.5;word-break:break-word}

/* tree — hierarchy / code map */
.tree{font-size:14px}
.tree ul{list-style:none;margin:0;padding-left:22px;border-left:1px dashed color-mix(in oklab,var(--fg-mute) 55%,transparent)}
.tree>ul{padding-left:0;border-left:0}
.tree li{position:relative;padding:3px 0}
.tree li::before{content:"";position:absolute;left:-20px;top:17px;width:14px;height:1px;background:var(--line-2)}
.tree>ul>li::before{display:none}
.tnode{display:inline-flex;gap:9px;align-items:baseline;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 11px}
.tnode .tl2{font-weight:600;color:var(--fg)}
.tnode .tn2{font-size:12px;color:var(--fg-mute)}
details.td>summary{list-style:none;cursor:pointer;display:inline-block}
details.td>summary::-webkit-details-marker{display:none}
details.td>summary .tnode::after{content:"▾";margin-left:7px;color:var(--fg-mute);font-size:10px}
details.td:not([open])>summary .tnode::after{content:"▸"}

/* branch — decision trace */
.branch{font-size:14px}
.brow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bnode{display:inline-block;background:var(--panel-2);border:1px solid var(--line-2);border-radius:7px;padding:7px 13px;font-weight:600;color:var(--fg);font-size:14.5px}
.bnode.root{border-color:var(--accent-dim);background:color-mix(in oklab,var(--accent) 10%,var(--panel));padding:8px 14px}
.branch .bnote{display:inline;margin:0;font-size:13px;color:var(--fg-dim);font-weight:400}
.bchild{position:relative;padding:9px 0 9px 22px;border-left:2px solid color-mix(in oklab,var(--line-2) 90%,transparent)}
.bchild:first-of-type{margin-top:6px}
.bchild::before{content:"";position:absolute;left:0;top:25px;width:16px;height:2px;background:color-mix(in oklab,var(--line-2) 90%,transparent)}
.bcond{display:inline-block;font-size:12px;letter-spacing:0;color:#f3d9ae;background:color-mix(in oklab,var(--accent) 16%,var(--panel));border:1px solid color-mix(in oklab,var(--accent) 40%,var(--line));border-radius:6px;padding:3px 9px;margin:0;font-weight:500}

/* svg figures: sequence / graph / state */
.fig{overflow:auto;border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:10px 12px}
.fig svg{display:block;max-width:100%;height:auto}
.fig svg text{font-family:var(--sans);font-size:12.5px;fill:var(--fg-dim)}
.fig .actor{fill:var(--panel-2);stroke:var(--line-2)}
.fig .actortext{fill:var(--fg);font-size:12.5px}
.fig .lifeline{stroke:var(--line-2);stroke-dasharray:4 4;stroke-width:1}
.fig .msgline{stroke:var(--fg-mute);stroke-width:1.2}
.fig .msglabel{fill:var(--fg-dim);font-size:12px}
.fig .nodebox{fill:var(--panel-2);stroke:var(--line-2)}
.fig .nodebox.core{stroke:var(--accent);fill:color-mix(in oklab,var(--accent) 10%,var(--panel-2))}
.fig .nodebox.weak{stroke-dasharray:3 3;opacity:.8}
.fig .nodetext{fill:var(--fg);font-size:12.5px}
.fig .edgeline{stroke:var(--fg-mute);stroke-width:1.1;fill:none;opacity:.75}
.fig .edgelabel{fill:var(--fg-mute);font-size:11px}
.fig .statebox{fill:var(--panel-2);stroke:var(--line-2)}
.fig .statebox.start{fill:color-mix(in oklab,var(--open) 18%,var(--panel-2));stroke:var(--open)}
.fig .statebox.end{fill:color-mix(in oklab,var(--accent) 16%,var(--panel-2));stroke:var(--accent)}
.fig .transline{stroke:var(--fg-mute);stroke-width:1.2;fill:none;opacity:.85}
.fig .transtext{fill:var(--fg-mute);font-size:11px}

/* toc */
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 0}
.toc a{
  font-size:13px;color:var(--fg-dim);border:1px solid var(--line);border-bottom:1px solid var(--line);
  border-radius:99px;padding:6px 13px;text-decoration:none;transition:.13s
}
.toc a:hover{color:var(--accent);border-color:var(--accent-dim)}

@media (max-width:720px){
  .cmp{grid-template-columns:1fr}
  .flowline{grid-template-columns:repeat(min(var(--cols,6),2),minmax(0,1fr))}
}
@media (prefers-reduced-motion:reduce){
  .stat,.barfill,.loopback .arc{animation:none}
}

footer{
  margin-top:56px;padding-top:22px;border-top:1px solid var(--line);
  display:flex;gap:18px;flex-wrap:wrap;align-items:center;
  font-family:var(--mono);font-size:11px;color:var(--fg-mute);letter-spacing:.04em
}
.btn{
  font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  background:var(--panel-2);border:1px solid var(--line-2);color:var(--fg-dim);
  border-radius:5px;padding:7px 13px;cursor:pointer;transition:.13s
}
.btn:hover{border-color:var(--accent-dim);color:var(--accent)}
#toast{
  position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);opacity:0;pointer-events:none;
  background:var(--accent);color:#120d02;font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;
  text-transform:uppercase;padding:9px 18px;border-radius:6px;transition:.18s ease;z-index:60;font-weight:600
}
#toast.on{opacity:1;transform:translate(-50%,0)}
@media (max-width:720px){
  .wrap,.topbar .inner{padding-left:18px;padding-right:18px}
  section{grid-template-columns:1fr;gap:10px;padding:28px 0}
  .num{border:0;padding:0}
  header.hero{padding:40px 0 28px}
}
@media print{
  body{background:#fff;color:#111}
  .topbar,#toast,footer .btn{display:none}
  .q,.opt,.tablewrap{border-color:#ccc;background:#fff}
  a{color:#111}
}
`;

/* --------------------------------------------------------------------- html */

const KIND_LABEL: Record<PageSpec["kind"], string> = {
	intent: "意图确认 · INTENT",
	decision: "决策简报 · DECISION",
	report: "完成报告 · REPORT",
};

const QUAD: Array<{ key: "open" | "blind" | "hidden" | "unknown"; cn: string; en: string }> = [
	{ key: "open", cn: "开放区", en: "open / arena" },
	{ key: "blind", cn: "盲目区", en: "blind spot" },
	{ key: "hidden", cn: "隐藏区", en: "hidden / façade" },
	{ key: "unknown", cn: "未知区", en: "unknown" },
];

function renderQuadrant(johari: PageSpec["johari"]): string {
	if (!johari) return "";
	const cards = QUAD.map(({ key, cn, en }) => {
		const items = (johari[key] ?? []).filter(Boolean);
		const body = items.length
			? `<ul>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`
			: `<div class="empty">—</div>`;
		return `<div class="q ${key}"><h4>${en}</h4><div class="cn">${cn}</div>${body}</div>`;
	}).join("");
	return `<div class="quad">${cards}</div>`;
}

function kindPrefix(spec: PageSpec): string {
	return spec.kind === "intent" ? "[flow] 意图" : spec.kind === "decision" ? "[flow] 决策" : "[flow] 报告";
}

function renderQuestions(spec: PageSpec): string {
	const questions = spec.questions ?? [];
	if (!questions.length) return "";
	const items = questions
		.map((q) => {
			const choices = q.choices
				.map(
					(c) => `<button class="choice" type="button" data-q="${esc(q.id)}" data-a="${esc(c.id)}" data-label="${esc(c.label)}">
  <span class="cid">${esc(c.id)}</span>
  <span><span class="cl">${inline(c.label)}${c.recommended ? ' <span class="badge">推荐</span>' : ""}</span>${c.detail ? `<span class="cd">${inline(c.detail)}</span>` : ""}</span>
</button>`,
				)
				.join("\n");
			return `<div class="qitem" data-qid="${esc(q.id)}">
  <div class="qhead"><span class="qid">${esc(q.id)}</span>
    <div><div class="qtext">${inline(q.prompt)}</div>${q.hint ? `<div class="qhint">${inline(q.hint)}</div>` : ""}</div>
  </div>
  <div class="choices">${choices}</div>
</div>`;
		})
		.join("\n");
	return `<section><div class="num">?</div><div class="body"><h2>逐题单选 / one per group</h2>
<div class="qlist" data-kind="${spec.kind}" data-prefix="${esc(kindPrefix(spec))}">${items}</div>
<div class="receipt">
  <div class="rl">答案回执</div>
  <div id="receiptText">尚未作答 —— 每组点一个，可随时改选，组与组之间互不影响。</div>
  <textarea id="receiptNote" placeholder="补充条件（可留空）：例如「如果评审发现安全问题就回来问我」"></textarea>
  <button class="btn" id="copyReceipt" type="button">复制答案回执</button>
</div>
</div></section>`;
}

function replyFor(spec: PageSpec, opt: PageOption): string {
	return `${kindPrefix(spec)} · 选择 ${opt.id}：${opt.label}`;
}

function renderOptions(spec: PageSpec): string {
	const options = spec.options ?? [];
	if (!options.length) return "";
	const rows = options
		.map(
			(o) => `<button class="opt" type="button" data-reply="${esc(replyFor(spec, o))}">
  <span class="id">${esc(o.id)}</span>
  <span>
    <span class="label">${inline(o.label)}${o.recommended ? '<span class="badge">推荐</span>' : ""}</span>
    ${o.detail ? `<span class="detail">${inline(o.detail)}</span>` : ""}
    ${o.cost ? `<span class="cost">${esc(o.cost)}</span>` : ""}
  </span>
  <span class="copy">复制回执</span>
</button>`,
		)
		.join("\n");
	return `<section><div class="num">→</div><div class="body"><h2>请选择 / Your call</h2>
<div class="options" data-kind="${spec.kind}">${rows}</div>
<div class="hint">点任意一项会把回执复制到剪贴板，<b>直接粘贴回 Pi 发送</b>即可。想改主意就在回执后面补充你的条件。</div>
</div></section>`;
}

function renderTree(items: TreeNode[]): string {
	const byId = new Map(items.map((i) => [i.id, i]));
	const kids = new Map<string, TreeNode[]>();
	const roots: TreeNode[] = [];
	for (const it of items) {
		if (it.parent && byId.has(it.parent)) {
			const arr = kids.get(it.parent) ?? [];
			arr.push(it);
			kids.set(it.parent, arr);
		} else roots.push(it);
	}
	const seen = new Set<string>();
	const node = (n: TreeNode): string => {
		if (seen.has(n.id)) return "";
		seen.add(n.id);
		const chip = `<span class="tnode"><span class="tl2">${inline(n.label)}</span>${
			n.note ? `<span class="tn2">${inline(n.note)}</span>` : ""
		}</span>`;
		const children = (kids.get(n.id) ?? []).filter((c) => !seen.has(c.id));
		if (!children.length) return `<li>${chip}</li>`;
		return `<li><details class="td" open><summary>${chip}</summary><ul>${children
			.map(node)
			.join("")}</ul></details></li>`;
	};
	return `<div class="blk tree"><ul>${roots.map(node).join("")}</ul></div>`;
}

function renderBranch(items: BranchNode[]): string {
	const byId = new Map(items.map((i) => [i.id, i]));
	const kids = new Map<string, BranchNode[]>();
	const roots: BranchNode[] = [];
	for (const it of items) {
		if (it.parent && byId.has(it.parent)) {
			const arr = kids.get(it.parent) ?? [];
			arr.push(it);
			kids.set(it.parent, arr);
		} else roots.push(it);
	}
	const seen = new Set<string>();
	const node = (n: BranchNode, isRoot = false): string => {
		if (seen.has(n.id)) return "";
		seen.add(n.id);
		const head = `<div class="brow">${
			n.cond ? `<span class="bcond">${inline(n.cond)}</span>` : ""
		}<span class="bnode${isRoot ? " root" : ""}">${inline(n.label)}</span>${
			n.note ? `<span class="bnote">${inline(n.note)}</span>` : ""
		}</div>`;
		const children = (kids.get(n.id) ?? []).filter((c) => !seen.has(c.id));
		if (!children.length) return `<div class="bitem">${head}</div>`;
		return `<div class="bitem">${head}<div class="bchild">${children
			.map((c) => node(c))
			.join("")}</div></div>`;
	};
	return `<div class="blk branch">${roots.map((r) => node(r, true)).join("")}</div>`;
}

let figSeq = 0;

function renderSequence(actors: string[], messages: SeqMessage[]): string {
	const list = actors.length ? actors : ["A", "B"];
	const n = list.length;
	const pad = 26;
	const colW = Math.max(132, Math.min(232, Math.floor((920 - pad * 2) / Math.max(1, n))));
	const width = pad * 2 + colW * n;
	const rowH = 40;
	const headH = 54;
	const height = headH + messages.length * rowH + 22;
	const cx = (i: number) => pad + colW * (i + 0.5);
	const idx = new Map(list.map((a, i) => [a, i]));
	const arrowId = `sq${++figSeq}`;
	const parts: string[] = [];
	list.forEach((a, i) => {
		const w = Math.min(colW - 16, Math.max(58, a.length * 13 + 20));
		parts.push(
			`<rect class="actor" x="${cx(i) - w / 2}" y="8" width="${w}" height="28" rx="7"/>` +
				`<text class="actortext" x="${cx(i)}" y="27" text-anchor="middle">${esc(a)}</text>` +
				`<line class="lifeline" x1="${cx(i)}" y1="36" x2="${cx(i)}" y2="${height - 14}"/>`,
		);
	});
	messages.forEach((m, i) => {
		const y = headH + i * rowH;
		const a = idx.get(m.from);
		const b = idx.get(m.to);
		const x1 = a === undefined ? cx(0) : cx(a);
		const x2 = b === undefined ? cx(0) : cx(b);
		const dash = m.style === "dashed" ? ' stroke-dasharray="5 4"' : "";
		if (x1 === x2) {
			parts.push(
				`<path class="msgline" d="M ${x1} ${y} h 34 v 16 h -34" fill="none"${dash} marker-end="url(#${arrowId})"/>` +
					`<text class="msglabel" x="${x1 + 42}" y="${y + 12}">${esc(m.text ?? "")}</text>`,
			);
		} else {
			const dir = x2 > x1 ? 1 : -1;
			parts.push(
				`<line class="msgline" x1="${x1}" y1="${y}" x2="${x2 - dir * 6}" y2="${y}"${dash} marker-end="url(#${arrowId})"/>` +
					`<text class="msglabel" x="${(x1 + x2) / 2}" y="${y - 6}" text-anchor="middle">${esc(m.text ?? "")}</text>`,
			);
		}
	});
	return `<div class="blk fig"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"><defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--fg-mute)"/></marker></defs>${parts.join("")}</svg></div>`;
}

function renderGraph(nodes: GraphNode[], edges: GraphEdge[]): string {
	const n = Math.max(1, nodes.length);
	const deg = new Map<string, number>();
	for (const e of edges) {
		deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
		deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
	}
	const maxDeg = Math.max(0, ...nodes.map((x) => deg.get(x.id) ?? 0));
	const starLayout = n >= 3 && n <= 8 && maxDeg >= n - 2;
	const R = starLayout ? 150 : Math.max(120, Math.min(240, 36 * n));
	const width = starLayout ? Math.max(2 * R + 300, 170 * n + 80) : 2 * R + 300;
	const height = starLayout ? R + 140 : 2 * R + 130;
	const cxp = width / 2;
	const cyp = height / 2;
	const ordered = [...nodes].sort((a, b) => {
		const ca = a.kind === "core" ? 1 : 0;
		const cb = b.kind === "core" ? 1 : 0;
		if (ca !== cb) return cb - ca;
		return (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0);
	});
	const wOf = (nd: GraphNode) => Math.min(Math.max(120, R * 0.9), Math.max(66, nd.label.length * 13 + 24));
	const pos = new Map<string, { x: number; y: number; w: number }>();
	// 星形图（一个中心连几乎所有）：用「中心在上、其余排成一行」比圆环好读
	const hub = ordered[0];
	if (starLayout && hub) {
		// 辐条保持作者给的顺序（作者用它表达含义），只是把中心挑出来放最上面
		const spokes = nodes.filter((x) => x.id !== hub.id);
		const gapX = (width - 120) / Math.max(1, spokes.length - 1 || 1);
		pos.set(hub.id, { x: cxp, y: 62, w: wOf(hub) });
		spokes.forEach((nd, i) => {
			const x = spokes.length === 1 ? cxp : 60 + i * gapX;
			pos.set(nd.id, { x, y: 62 + R * 0.92, w: wOf(nd) });
		});
	} else {
		ordered.forEach((nd, i) => {
			const ang = (Math.PI * 2 * i) / Math.max(1, n) - Math.PI / 2;
			pos.set(nd.id, { x: cxp + R * Math.cos(ang), y: cyp + R * Math.sin(ang), w: wOf(nd) });
		});
	}
	const edgeId = `eg${++figSeq}`;
	const pairSeen = new Map<string, number>();
	const lines = edges
		.map((e) => {
			const a = pos.get(e.from);
			const b = pos.get(e.to);
			if (!a || !b) return "";
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dist = Math.hypot(dx, dy) || 1;
			const ux = dx / dist;
			const uy = dy / dist;
			// 线从盒子边缘出发，避免箭头被方块盖住
			const ax = a.x + ux * (a.w / 2 + 8);
			const ay = a.y + uy * (a.w / 2 + 8);
			const bx = b.x - ux * (b.w / 2 + 10);
			const by = b.y - uy * (b.w / 2 + 10);
			const key = [e.from, e.to].sort().join("~");
			const k = pairSeen.get(key) ?? 0;
			pairSeen.set(key, k + 1);
			const bend = 0.1 + k * 0.11;
			let mx = (ax + bx) / 2 + (by - ay) * bend;
			let my = (ay + by) / 2 - (bx - ax) * bend;
			if (starLayout && e.from !== hub.id && e.to !== hub.id) {
				// 星形图里「辐条之间」的关系往下方弯，避免压在中心连线上
				my += 52;
				mx = (ax + bx) / 2;
			}
			const label = e.label
				? `<text class="edgelabel" x="${mx}" y="${my - 5}" text-anchor="middle">${esc(e.label)}</text>`
				: "";
			return `<path class="edgeline" d="M ${ax} ${ay} Q ${mx} ${my} ${bx} ${by}" marker-end="url(#${edgeId})"/>${label}`;
		})
		.join("");
	const boxes = ordered
		.map((nd) => {
			const p = pos.get(nd.id)!;
			return `<rect class="nodebox ${nd.kind ?? "plain"}" x="${p.x - p.w / 2}" y="${p.y - 15}" width="${p.w}" height="30" rx="8"/><text class="nodetext" x="${p.x}" y="${p.y + 4}" text-anchor="middle">${esc(nd.label)}</text>`;
		})
		.join("");
	return `<div class="blk fig"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"><defs><marker id="${edgeId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--fg-mute)"/></marker></defs>${lines}${boxes}</svg></div>`;
}

function renderState(states: StateNode[], transitions: StateTransition[]): string {
	const n = Math.max(1, states.length);
	const step = Math.max(130, Math.min(210, Math.round(920 / n)));
	const pad = 28;
	const width = pad * 2 + step * (n - 1) + 150;
	const idx = new Map(states.map((s, i) => [s.id, i]));
	const cx = (i: number) => pad + 74 + i * step;
	const widths = states.map((s) => Math.min(step - 18, Math.max(78, s.label.length * 13 + 26)));
	const half = (i: number) => widths[i] / 2;

	// 先把每条跳转分配一条「上方的弧道」，避免弧线互相压住
	type Arc = { t: StateTransition; a: number; b: number; lift: number };
	const arcs: Arc[] = [];
	let lane = 0;
	for (const t of transitions) {
		const a = idx.get(t.from);
		const b = idx.get(t.to);
		if (a === undefined || b === undefined) continue;
		const forwardAdjacent = b - a === 1;
		if (forwardAdjacent) continue;
		const span = Math.abs(b - a);
		arcs.push({ t, a, b, lift: 48 + Math.min(58, span * 9) + lane * 30 });
		lane += 1;
	}
	const maxLift = arcs.reduce((m, x) => Math.max(m, x.lift), 0);
	const baseY = 24 + (maxLift ? maxLift + 18 : 14);
	const height = Math.round(baseY + 22 + 20);
	const arrowId = `st${++figSeq}`;

	const boxes = states
		.map((s, i) => {
			const w = widths[i];
			return `<rect class="statebox ${s.kind ?? "plain"}" x="${cx(i) - w / 2}" y="${baseY - 16}" width="${w}" height="32" rx="16"/><text class="nodetext" x="${cx(i)}" y="${baseY + 4}" text-anchor="middle">${esc(s.label)}</text>`;
		})
		.join("");

	const arcByKey = new Map(arcs.map((x) => [`${x.a}>${x.b}`, x]));
	const used = new Set<string>();
	const lines = transitions
		.map((t) => {
			const a = idx.get(t.from);
			const b = idx.get(t.to);
			if (a === undefined || b === undefined) return "";
			const label = t.label ? esc(t.label) : "";
			const x1 = cx(a);
			const x2 = cx(b);
			if (b - a === 1) {
				used.add(`${a}>${b}`);
				return `<line class="transline" x1="${x1 + half(a) + 6}" y1="${baseY}" x2="${x2 - half(b) - 8}" y2="${baseY}" marker-end="url(#${arrowId})"/><text class="transtext" x="${(x1 + x2) / 2}" y="${baseY - 10}" text-anchor="middle">${label}</text>`;
			}
			const arc = arcByKey.get(`${a}>${b}`);
			const lift = arc ? arc.lift : 48;
			if (a === b) {
				return `<path class="transline" d="M ${x1 + half(a) - 8} ${baseY - 12} q 30 -${lift * 0.8} 4 -6" marker-end="url(#${arrowId})"/><text class="transtext" x="${x1 + half(a) + 34}" y="${baseY - lift * 0.8 + 10}" text-anchor="middle">${label}</text>`;
			}
			const top = baseY - lift;
			return `<path class="transline" d="M ${x1} ${baseY - 16} Q ${(x1 + x2) / 2} ${top} ${x2} ${baseY - 16}" marker-end="url(#${arrowId})"/><text class="transtext" x="${(x1 + x2) / 2}" y="${top + 16}" text-anchor="middle">${label}</text>`;
		})
		.join("");

	return `<div class="blk fig"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"><defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--fg-mute)"/></marker></defs>${lines}${boxes}</svg></div>`;
}

function renderBlock(b: Block): string {
	switch (b.kind) {
		case "flow": {
			const steps = (b.steps ?? [])
				.map((s, i) => {
					const tag = s.status === "now" ? " · 现在" : s.status === "done" ? " · 完成" : "";
					return `<div class="step ${s.status ?? ""}">
  <span class="sn">${String(i + 1).padStart(2, "0")}${tag}</span>
  <div class="st">${inline(s.title)}</div>${s.note ? `<div class="so">${inline(s.note)}</div>` : ""}
</div>`;
				})
				.join("");
			const cols = Math.min(Math.max(b.steps?.length ?? 1, 1), 6);
			return `<div class="blk flowline" style="--cols:${cols}">${steps}</div>`;
		}
		case "timeline": {
			const items = (b.events ?? [])
				.map(
					(e) => `<div class="tl-item${/现在|本轮|today/i.test(e.when) ? " on" : ""}">
  <span class="tl-dot"></span>
  <div class="tl-when">${esc(e.when)}</div>
  <div class="tl-title">${inline(e.title)}</div>${e.note ? `<div class="tl-note">${inline(e.note)}</div>` : ""}
</div>`,
				)
				.join("");
			return `<div class="blk tl">${items}</div>`;
		}
		case "stats": {
			const cells = (b.stats ?? [])
				.map(
					(s) => `<div class="stat"><div class="v">${esc(s.value)}${s.unit ? `<span class="u">${esc(s.unit)}</span>` : ""}</div>
  <div class="l">${inline(s.label)}</div>${s.note ? `<div class="n">${inline(s.note)}</div>` : ""}</div>`,
				)
				.join("");
			return `<div class="blk statgrid">${cells}</div>`;
		}
		case "bars": {
			const rows = (b.bars ?? [])
				.map((r) => {
					const pct = Math.max(0, Math.min(100, Math.round((r.value / (r.max ?? 100)) * 100)));
					return `<div class="barrow">
  <div class="barlabel">${inline(r.label)}${r.note ? `<span class="bnote">${inline(r.note)}</span>` : ""}</div>
  <div class="bartrack"><div class="barfill ${r.tone ?? ""}" style="width:${pct}%"></div></div>
  <div class="barval">${esc(String(r.value))}${r.max && r.max !== 100 ? `/${r.max}` : "%"}</div>
</div>`;
				})
				.join("");
			return `<div class="blk barlist">${rows}</div>${b.caption ? `<div class="blk"><div class="bnote">${inline(b.caption)}</div></div>` : ""}`;
		}
		case "compare": {
			const side = (s: { title?: string; items?: string[] } | undefined, cls: string) => {
				if (!s) return "";
				const items = (s.items ?? []).map((i) => `<li>${inline(i)}</li>`).join("");
				return `<div class="cmpcol ${cls}"><h4>${esc(s.title ?? "")}</h4><ul>${items}</ul></div>`;
			};
			return `<div class="blk cmp">${side(b.left, "left")}${side(b.right, "right")}</div>`;
		}
		case "callout":
			return `<div class="blk callout ${b.tone ?? "info"}">${b.title ? `<div class="ct">${inline(b.title)}</div>` : ""}<div class="cx">${inline(b.text ?? "")}</div></div>`;
		case "loop": {
			const pills = (b.steps ?? [])
				.map((s, i) => `<div class="looppill"><span class="ln">${i + 1}</span>${inline(s.title)}</div>`)
				.join("");
			return `<div class="blk"><div class="loopline">${pills}</div><div class="loopback"><span class="arc"></span>走完最后一个就回到第 1 步，如此往复直到不再缺东西</div></div>`;
		}
		case "facts": {
			const cells = (b.facts ?? [])
				.map((f) => `<div class="fact"><div class="fl">${esc(f.label)}</div><div class="fv">${inline(f.value)}</div></div>`)
				.join("");
			return `<div class="blk facts">${cells}</div>`;
		}
		case "tree":
			return renderTree(b.items ?? []);
		case "branch":
			return renderBranch(b.items ?? []);
		case "sequence":
			return renderSequence(b.actors ?? [], b.messages ?? []);
		case "graph":
			return renderGraph(b.nodes ?? [], b.edges ?? []);
		case "state":
			return renderState(b.states ?? [], b.transitions ?? []);
		default:
			// A misspelled kind must be visible, never a silently blank page.
			return `<div class="blk callout warn"><div class="ct">未知的展示块</div><div class="cx">kind = ${esc(String((b as { kind?: string }).kind ?? "(空)"))}。可用：flow / timeline / stats / bars / compare / callout / loop / facts / tree / branch / sequence / graph / state。</div></div>`;
	}
}

function renderBlocks(blocks?: Block[]): string {
	if (!blocks || !blocks.length) return "";
	return blocks.map(renderBlock).filter(Boolean).join("\n");
}

export function renderPage(
	spec: PageSpec,
	meta: { phase: string; cwd: string; sessionId: string; project?: string; version?: string },
): string {
	const sections = spec.sections
		.map((s, idx) => {
			const tone = s.tone && s.tone !== "plain" ? ` tone-${s.tone}` : "";
			const body = [
				s.lead ? `<p class="lead">${inline(s.lead)}</p>` : "",
				renderBlocks(s.blocks),
				s.body ? mdToHtml(s.body) : "",
				s.items && s.items.length
					? `<ul>${s.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`
					: "",
			]
				.filter(Boolean)
				.join("\n");
			return `<section class="s${tone}" id="s${idx + 1}"><div class="num">${String(idx + 1).padStart(2, "0")}</div>
<div class="body"><h2>${esc(s.heading)}</h2>${body || '<p class="empty">—</p>'}</div></section>`;
		})
		.join("\n");

	const toc = spec.sections.length
		? `<nav class="toc">${spec.sections
				.map((s, i) => `<a href="#s${i + 1}">${String(i + 1).padStart(2, "0")} ${esc(s.heading)}</a>`)
				.join("")}</nav>`
		: "";

	const metaPairs = Object.entries(spec.meta ?? {})
		.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`)
		.join('<span class="spacer"></span>');

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.title)} · Johari Flow</title>
<style>${CSS}</style>${spec.css ? `<style>/* page-level override */\n${sanitizeCss(spec.css)}</style>` : ""}
</head>
<body>
<div class="topbar"><div class="inner">
  <span class="brand">PI <b>/</b> JOHARI FLOW</span>
  <span class="chip kind">${esc(KIND_LABEL[spec.kind])}</span>
  <span class="chip">阶段 ${esc(meta.phase)}</span>${meta.project ? `<span class="chip">${esc(meta.project)}</span>` : ""}${meta.version ? `<span class="chip">v${esc(meta.version)}</span>` : ""}
  <span class="spacer"></span>
  <span class="meta">会话 ${esc(meta.sessionId)} ｜ ${esc(new Date().toLocaleString("zh-CN", { hour12: false }))}</span>
</div></div>

<div class="wrap">
  <header class="hero">
    <div class="kicker">${esc(spec.kicker ?? "Johari window · 开放区优先")}</div>
    <h1>${inline(spec.title)}</h1>
    ${spec.summary ? `<p class="lede">${mdToHtml(spec.summary).replace(/^<p>|<\/p>$/g, "")}</p>` : ""}
    ${toc}
  </header>

  <div class="quadrow">${renderQuadrant(spec.johari)}</div>

  ${sections}
  ${renderQuestions(spec)}
  ${renderOptions(spec)}

  <footer>
    <button class="btn" type="button" id="copyAll">复制整页文本</button>
    <button class="btn" type="button" id="copyPath">复制页面路径</button>
    <span class="spacer"></span>
    ${metaPairs}
    <span>session ${esc(meta.sessionId.slice(0, 8))}</span>
    <span>${esc(meta.cwd)}</span>
  </footer>
</div>

<div id="toast">已复制</div>
<script>
(function(){
  var toast = document.getElementById('toast');
  var t;
  function flash(msg){
    toast.textContent = msg || '已复制';
    toast.classList.add('on');
    clearTimeout(t);
    t = setTimeout(function(){ toast.classList.remove('on'); }, 1500);
  }
  function copy(text){
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function(){ flash(); }, fallback);
    } else { fallback(); }
    function fallback(){
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); flash(); }
      catch(e){ flash('复制失败，请手动选择'); }
      document.body.removeChild(ta);
    }
  }
  document.querySelectorAll('[data-reply]').forEach(function(el){
    el.addEventListener('click', function(){ copy(el.getAttribute('data-reply')); });
  });

  // Per-question single choice: each group is independent (a radio group, not a bundle).
  var chosen = {};
  var qlist = document.querySelector('.qlist');
  var prefix = qlist ? (qlist.getAttribute('data-prefix') || '[flow]') : '[flow]';
  function buildReceipt(){
    var ids = Object.keys(chosen).sort(function(a, b){
      return a.localeCompare(b, 'en', { numeric: true });
    });
    if (!ids.length) return '尚未作答 —— 每组点一个，可随时改选，组与组之间互不影响。';
    var parts = ids.map(function(q){
      var v = chosen[q];
      return q + '=' + v.id + '（' + v.label + '）';
    });
    var noteEl = document.getElementById('receiptNote');
    var note = noteEl && noteEl.value ? noteEl.value.trim() : '';
    return prefix + ' · 逐题作答 ' + parts.join('；') + (note ? '\\n补充：' + note : '');
  }
  function refreshReceipt(){
    var el = document.getElementById('receiptText');
    if (el) el.textContent = buildReceipt();
  }
  document.querySelectorAll('.choice').forEach(function(btn){
    btn.addEventListener('click', function(){
      var q = btn.getAttribute('data-q');
      var a = btn.getAttribute('data-a');
      if (chosen[q] && chosen[q].id === a) {
        delete chosen[q];
        btn.classList.remove('on');
      } else {
        chosen[q] = { id: a, label: btn.getAttribute('data-label') };
        document.querySelectorAll('[data-q]').forEach(function(b){ if (b.getAttribute('data-q') === q) b.classList.remove('on'); });
        btn.classList.add('on');
      }
      refreshReceipt();
    });
  });
  var noteInput = document.getElementById('receiptNote');
  if (noteInput) noteInput.addEventListener('input', refreshReceipt);
  var copyReceipt = document.getElementById('copyReceipt');
  if (copyReceipt) copyReceipt.addEventListener('click', function(){ copy(buildReceipt()); });
  document.getElementById('copyAll').addEventListener('click', function(){
    copy(document.querySelector('.wrap').innerText);
  });
  document.getElementById('copyPath').addEventListener('click', function(){
    var p = location.pathname;
    try { p = decodeURIComponent(p); } catch (err) { /* keep raw */ }
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    copy(p);
  });
})();
</script>
</body>
</html>`;
}
