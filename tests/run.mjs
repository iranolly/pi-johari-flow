/**
 * Johari Flow — self-contained test suite.
 *
 *   node --experimental-strip-types tests/run.mjs
 *
 * No framework, no install step: `host.mjs` links the three host packages pi
 * already ships with, then everything below drives the extension through the
 * same hooks pi does (fake `pi`, fake `ctx`, fake `sessionManager`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHostModules } from "./host.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
ensureHostModules(repoRoot);

const WORK = join(repoRoot, ".pi", "test-work");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const { default: johariFlow } = await import("../extensions/johari-flow/index.ts");
const { renderPage } = await import("../extensions/johari-flow/html.ts");

/* ------------------------------------------------------------------ harness */
function harness() {
	const entries = [];
	const tools = {};
	const handlers = {};
	const sent = [];
	const notes = [];
	const exec = [];
	let status = null;
	const pi = {
		on(evt, fn) {
			(handlers[evt] ||= []).push(fn);
		},
		registerTool(def) {
			tools[def.name] = def;
		},
		registerCommand(name, def) {
			tools["/" + name] = def;
		},
		appendEntry(type, data) {
			// Snapshot like the real host does: a live reference would hide aliasing bugs.
			entries.push({ type: "custom", customType: type, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) });
		},
		async exec(cmd, args) {
			exec.push([cmd, args]);
			return { stdout: "", stderr: "", code: 1 };
		},
		sendUserMessage(content, opts) {
			sent.push({ content, opts });
		},
	};
	let widget;
	const ui = {
		notify: (m) => notes.push(m),
		setStatus: (k, v) => {
			status = [k, v];
		},
		setWidget: (k, v) => {
			widget = [k, v];
		},
		select: async () => undefined,
		confirm: async () => false,
	};
	const ctx = {
		cwd: WORK,
		hasUI: false,
		ui,
		sessionManager: {
			getBranch: () => entries.slice(),
			getSessionId: () => "testsession01",
			getCwd: () => WORK,
		},
	};
	johariFlow(pi);
	const fire = async (evt, event = {}) => {
		const out = [];
		for (const h of handlers[evt] ?? []) {
			const r = await h(event, ctx);
			if (r !== undefined) out.push(r);
		}
		return out;
	};
	const tool = (name) => tools[name].execute("call", {}, undefined, undefined, ctx);
	return {
		entries,
		exec,
		fire,
		notes,
		sent,
		status: () => status,
		widget: () => widget,
		askWith: (p, onUpdate) => tools.flow_ask.execute("call", p, undefined, onUpdate, ctx),
		plan: (p) => tools.flow_plan.execute("call", p, undefined, undefined, ctx),
		fire_tool: fire,
		page: (p) => tools.flow_page.execute("call", p, undefined, undefined, ctx),
		ask: (p) => tools.flow_ask.execute("call", p, undefined, undefined, ctx),
		tool,
		text(r) {
			return String(r?.content?.[0]?.text ?? r ?? "");
		},
		blocked: (r) => Boolean(r?.block),
	};
}

const results = [];
function check(id, ok, detail = "") {
	results.push({ id, ok: Boolean(ok), detail });
	console.log(`${ok ? "  ok  " : " FAIL "} ${id}${detail ? ` — ${detail}` : ""}`);
}
const firstLine = (s) => String(s).split("\n")[0];

/* ------------------------------------------------------- A. intent-phase gates */
{
	const h = harness();
	h.fire("session_start", { reason: "startup" });
	check("A1 start", firstLine(h.text(await h.plan({ action: "start", goal: "测试意图" }))).includes("意图"));

	const write = await h.fire("tool_call", { toolName: "write", input: { path: join(WORK, "src/a.ts") } });
	check("A2 write blocked in intent", h.blocked(write[0]));

	const shellWrite = await h.fire("tool_call", {
		toolName: "bash",
		input: { command: "echo hi | tee out.txt" },
	});
	check("A3 shell write blocked in intent", h.blocked(shellWrite[0]));

	const dispatch = await h.fire("tool_call", { toolName: "Agent", input: {} });
	check("A4 sub-agent blocked in intent", h.blocked(dispatch[0]));

	const readOnly = await h.fire("tool_call", {
		toolName: "bash",
		input: { command: "rg 'rm -rf' docs" },
	});
	check("A5 read-only command allowed in intent", !h.blocked(readOnly[0]));

	// protocol injection only exists while a flow is active
	const sp = { systemPromptOptions: { sections: {} } };
	await h.fire("before_agent_start", sp);
	check("A6 protocol injected", (sp.systemPromptOptions.sections.johari_flow ?? "").length > 500);
}

/* ------------------------------------------------------ B. pre-approval gates */
{
	const h = harness();
	h.fire("session_start", {});
	await h.plan({ action: "start", goal: "测试意图" });
	await h.plan({ action: "confirm", reason: "用户说要" });
	await h.plan({ action: "advance", to: "research" });

	const cases = [
		["B1 project write blocked", { toolName: "write", input: { path: join(WORK, "src/b.ts") } }, true],
		["B2 note under .pi allowed", { toolName: "write", input: { path: join(WORK, ".pi/notes/research.md") } }, false],
		["B2b note outside .pi blocked", { toolName: "write", input: { path: join(WORK, "notes/research.md") } }, true],
		["B2c package.json blocked", { toolName: "write", input: { path: join(WORK, "package.json") } }, true],
		["B3 page write allowed", { toolName: "write", input: { path: join(WORK, ".pi/flow/x/01-intent.html") } }, false],
		["B4 sed -i blocked", { toolName: "bash", input: { command: "sed -i 's/a/b/' src/a.ts" } }, true],
		["B5 chained rm blocked", { toolName: "bash", input: { command: "rg foo && rm -rf src" } }, true],
		["B6 npm install blocked", { toolName: "bash", input: { command: "npm install left-pad" } }, true],
		["B7 git commit blocked", { toolName: "bash", input: { command: 'git commit -am "wip"' } }, true],
		["B8 devnull redirect allowed", { toolName: "bash", input: { command: "git status > /dev/null 2>&1" } }, false],
		["B9 awk compare allowed", { toolName: "bash", input: { command: "awk '$3 > 100' data.txt" } }, false],
		["B10 grep in quotes allowed", { toolName: "bash", input: { command: 'grep "drop table" notes.md' } }, false],
		["B11 git log allowed", { toolName: "bash", input: { command: "git log --oneline -5" } }, false],
		["B12 rm -Rf blocked", { toolName: "bash", input: { command: "rm -Rf build" } }, true],
		["B13 git restore . blocked", { toolName: "bash", input: { command: "git restore ." } }, true],
		["B14 drop database blocked", { toolName: "bash", input: { command: "mysql -e 'drop database prod'" } }, true],
		["B15 find -delete blocked", { toolName: "bash", input: { command: "find . -name '*.ts' -delete" } }, true],
		["B16 branch -D blocked", { toolName: "bash", input: { command: "git branch -D main" } }, true],
		["B17 force refspec push blocked", { toolName: "bash", input: { command: "git push origin +main" } }, true],
		["B18 git -C commit blocked", { toolName: "bash", input: { command: "git -C repo commit -am wip" } }, true],
		["B19 npm --prefix install blocked", { toolName: "bash", input: { command: "npm --prefix . install lodash" } }, true],
		["B20 redirect without extension blocked", { toolName: "bash", input: { command: "echo hi > out" } }, true],
		["B21 command substitution blocked", { toolName: "bash", input: { command: "cat $(rm -rf src)" } }, true],
		["B22 multi-line command blocked", { toolName: "bash", input: { command: "cat README.md\nrm -rf src" } }, true],
		["B23 quoted shell payload blocked", { toolName: "bash", input: { command: 'bash -c "echo hi > src/x.ts"' } }, true],
		["B24 stash list allowed", { toolName: "bash", input: { command: "git stash list" } }, false],
		["B25 awk float compare allowed", { toolName: "bash", input: { command: "awk '$3 > 1.5' data.txt" } }, false],
		["B26 scratch redirect allowed", { toolName: "bash", input: { command: "echo hi > .pi/flow/note.md" } }, false],
		[
			"B27 cd inside workspace + scratch redirect allowed",
			{ toolName: "bash", input: { command: `cd "${WORK}" && echo hi > .pi/flow/note2.md` } },
			false,
		],
		[
			"B28 cd to a subdir does not launder a destructive command",
			{ toolName: "bash", input: { command: `cd "${WORK}/src" && rm -rf build` } },
			true,
		],
		[
			"B29 cd out of the workspace does not launder a scratch redirect",
			{ toolName: "bash", input: { command: `cd / && echo hi > .pi/flow/x.md` } },
			true,
		],
	];
	for (const [id, event, shouldBlock] of cases) {
		const out = await h.fire("tool_call", event);
		check(id, h.blocked(out[0]) === shouldBlock);
	}
}

/* ----------------------------------------------------------- C. phase machine */
{
	const h = harness();
	h.fire("session_start", {});
	await h.plan({ action: "start", goal: "测试意图" });
	check("C1 advance w/o confirm refused", h.text(await h.plan({ action: "advance", to: "research" })).includes("被拒"));
	await h.plan({ action: "confirm", reason: "用户确认" });
	check("C2 advance to research", h.text(await h.plan({ action: "advance", to: "research" })).includes("已推进"));
	await h.plan({ action: "advance", to: "design" });
	check("C3 approve refused outside review", h.text(await h.plan({ action: "approve", reason: "x" })).includes("不能批准"));
	await h.plan({ action: "advance", to: "review" });
	check("C4 approve in review", h.text(await h.plan({ action: "approve", reason: "用户：全部按推荐" })).includes("已批准"));
	check("C5 skipped phase refused", h.text(await h.plan({ action: "advance", to: "done" })).includes("非法推进"));
	await h.plan({ action: "advance", to: "execute" });
	const early = await h.page({ kind: "report", title: "早产报告", sections: [] });
	check("C6 report page allowed in execute", !h.text(early).includes("只能"));

	// a stale/corrupt phase must not leave the flow unusable
	const h2 = harness();
	h2.entries.push({ type: "custom", customType: "johari-flow", data: { phase: "bogus-phase" } });
	await h2.fire("session_start", { reason: "resume" });
	const sp = { systemPromptOptions: { sections: {} } };
	await h2.fire("before_agent_start", sp);
	check("C7 unknown phase clamps to idle", (sp.systemPromptOptions.sections.johari_flow ?? "").trim() === "");
}

/* --------------------------------------------------------------- D. artefacts */
{
	const h = harness();
	h.fire("session_start", {});
	await h.plan({ action: "start", goal: "测试意图" });
	await h.plan({ action: "confirm", reason: "用户确认" });
	for (const to of ["research", "design", "review"]) await h.plan({ action: "advance", to });
	await h.plan({ action: "approve", reason: "用户批准" });
	await h.plan({ action: "advance", to: "execute" });

	// a page must exist before the flow can claim it is finished
	const toReport = h.text(await h.plan({ action: "advance", to: "report" }));
	check("D0 report phase reached", toReport.includes("已推进"), toReport.slice(0, 60));
	const early = h.text(await h.plan({ action: "advance", to: "done" }));
	check("D0b done needs a report first", early.includes("报告") && !early.includes("已推进"), early.slice(0, 60));

	// many pages requested in the same turn must each land in their own file
	const flowFiles = (suffix) =>
		readdirSync(join(WORK, ".pi/flow")).flatMap((s) =>
			readdirSync(join(WORK, ".pi/flow", s))
				.filter((f) => f.endsWith(suffix))
				.map((f) => join(WORK, ".pi/flow", s, f)),
		);
	const countReports = () => flowFiles("-report.html").length;
	const countRecords = () => flowFiles("-report.json").length;
	const before = countReports();
	const beforeRecords = countRecords();
	await Promise.all(
		Array.from({ length: 12 }, (_, i) =>
			h.page({ kind: "report", title: `并排${i}`, sections: [], open: false }),
		),
	);
	const grown = countReports() - before;
	check("D1 concurrent pages never overwrite", grown === 12, "grew by " + grown);
	const grownRecords = countRecords() - beforeRecords;
	check("D1b every page writes a sibling json record", grownRecords === 12, "grew by " + grownRecords);

	const recordFile = flowFiles("-report.json").sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	let record = null;
	try {
		record = JSON.parse(readFileSync(recordFile, "utf8"));
	} catch {
		record = null;
	}
	check(
		"D1c record keeps kind, phase, version and the full spec",
		Boolean(record && record.kind === "report" && record.phase && record.version && record.spec?.title),
		record ? Object.keys(record).join(",") : "no record",
	);

	const unknown = await h.page({
		kind: "report",
		title: "未知块",
		sections: [{ heading: "h", blocks: [{ kind: "sparkline", items: [] }] }],
		open: false,
	});
	check("D2 unknown block is visible", h.text(unknown).includes("已生成"));
	const unknownPage = readdirSync(join(WORK, ".pi/flow"))
		.flatMap((s) => readdirSync(join(WORK, ".pi/flow", s)).map((f) => join(WORK, ".pi/flow", s, f)))
		.filter((f) => f.endsWith(".html"))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	const unknownHtml = readFileSync(unknownPage, "utf8");
	check(
		"D2b unknown block warns on the page",
		unknownHtml.includes("未知的展示块") && unknownHtml.includes("sparkline"),
	);

	// images: local files are inlined (page stays one offline file), anything else warns
	const shots = join(WORK, "shots");
	mkdirSync(shots, { recursive: true });
	writeFileSync(
		join(shots, "ok.png"),
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	writeFileSync(join(shots, "fake.png"), "this is not an image");
	const shotHtml = renderPage(
		{
			kind: "report",
			title: "图片",
			sections: [
				{ heading: "一张", blocks: [{ kind: "image", images: [{ src: "shots/ok.png", caption: "草地" }] }] },
				{
					heading: "坏图",
					blocks: [
						{
							kind: "image",
							images: [{ src: "shots/missing.png" }, { src: "https://example.test/a.png" }],
						},
					],
				},
				{ heading: "假图", blocks: [{ kind: "image", images: [{ src: "shots/fake.png" }] }] },
				{ heading: "markdown", body: "![截图](shots/ok.png)" },
			],
		},
		{ phase: "测试", cwd: WORK, sessionId: "s" },
	);
	check(
		"D2e local image is inlined as a data uri",
		shotHtml.includes('class="blk shots single"') &&
			shotHtml.includes("data:image/png;base64,") &&
			shotHtml.includes("草地"),
	);
	check(
		"D2f missing and remote images warn instead of going blank",
		shotHtml.includes("图片没有嵌进来") &&
			shotHtml.includes("远程图片不嵌入") &&
			!shotHtml.includes('src="https://'),
	);
	check("D2g a text file renamed to .png is refused", shotHtml.includes("不像图片"));
	check("D2h a markdown image line becomes a figure", /<figure class="shot"><img src="data:image\/png/.test(shotHtml));

	const shotPage = await h.page({
		kind: "report",
		title: "截图页",
		sections: [{ heading: "图", blocks: [{ kind: "image", images: [{ src: "shots/ok.png" }] }] }],
		open: false,
	});
	const shotRecordFile = flowFiles("-report.json").sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	const shotRecord = JSON.parse(readFileSync(shotRecordFile, "utf8"));
	check(
		"D2i the record keeps the path, not the base64",
		shotRecord.spec?.sections?.[0]?.blocks?.[0]?.images?.[0]?.src === "shots/ok.png" &&
			!JSON.stringify(shotRecord).includes("base64") &&
			h.text(shotPage).includes("已生成"),
	);

	// bare paths in the copy: a link when the file exists, code when it does not
	mkdirSync(join(WORK, "notes"), { recursive: true });
	writeFileSync(join(WORK, "notes", "evidence.html"), "<html>ok</html>");
	const siblingDir = join(WORK, ".pi/flow/linktest");
	mkdirSync(siblingDir, { recursive: true });
	writeFileSync(join(siblingDir, "05-report.html"), "<html>ok</html>");
	const linkHtml = renderPage(
		{
			kind: "report",
			title: "链接",
			sections: [
				{
					heading: "证据",
					body: "看实拍 (notes/evidence.html) · 旧报告 (05-report.html) · 不存在的 (notes/none.html)",
				},
			],
		},
		{ phase: "测试", cwd: WORK, sessionId: "s", dir: siblingDir },
	);
	const links = linkHtml.match(/<a class="pathlink" href="([^"]+)"/g) ?? [];
	check(
		"D2j existing paths become file links",
		links.length === 2 &&
			links.every((l) => l.includes("href=\"file://")) &&
			linkHtml.includes("notes/evidence.html</a>") &&
			linkHtml.includes("05-report.html</a>"),
		`${links.length} links`,
	);
	check(
		"D2k a missing path stays code",
		linkHtml.includes('<code class="path">notes/none.html</code>'),
	);
	const urlHtml = renderPage(
		{
			kind: "report",
			title: "网址",
			sections: [{ heading: "u", body: "看 https://example.com/a 与 [文档](https://example.com/b)。" }],
		},
		{ phase: "测试", cwd: WORK, sessionId: "s" },
	);
	const urlAnchors = urlHtml.match(/<a [^>]*href="https:\/\/example\.com\/[ab]"/g) ?? [];
	check(
		"D2l bare urls become links, markdown links stay single",
		urlAnchors.length === 2 && !/<a [^>]*<a /.test(urlHtml),
		`${urlAnchors.length} anchors`,
	);

	// a picture written as a link is a picture; a record file is never a link
	writeFileSync(join(shots, "rec.json"), '{"ok":true}');
	const picLinkHtml = renderPage(
		{
			kind: "report",
			title: "证据",
			sections: [
				{
					heading: "末页",
					body: "[末页实拍](shots/ok.png) · [末页出现时机](shots/rec.json)",
				},
			],
		},
		{ phase: "测试", cwd: WORK, sessionId: "s" },
	);
	check(
		"D2m a link to a picture renders as a picture",
		/<figure class="shot"><img src="data:image\/png/.test(picLinkHtml) &&
			picLinkHtml.includes("<figcaption>末页实拍</figcaption>"),
	);
	check(
		"D2n a record file never becomes a link",
		!picLinkHtml.includes("rec.json</a>") &&
			!picLinkHtml.includes('<code class="path">shots/rec.json') &&
			picLinkHtml.includes("末页出现时机"),
	);

	// a page must hand the caller an address and must not grab a browser window
	const execBefore = h.exec.length;
	const linked = await h.page({ kind: "report", title: "地址测试", sections: [], open: false });
	check(
		"D2c page returns a file url",
		String(linked?.details?.url ?? "").startsWith("file://"),
		String(linked?.details?.url ?? ""),
	);
	check("D2d default does not launch a browser", h.exec.length === execBefore, `exec: ${h.exec.length - execBefore}`);

	// css override is model-authored: it must never close the style element
	const html = renderPage(
		{
			kind: "report",
			title: "注入",
			sections: [],
			css: "body{color:red}</style><script>alert(1)</script><style>",
		},
		{ phase: "测试", cwd: WORK, sessionId: "s" },
	);
	const styleCloses = (html.match(/<\/style>/g) ?? []).length;
	check("D3 css cannot break out", styleCloses === 2 && !html.includes("<script>alert(1)"), `${styleCloses} closers`);

	const copyPath =
		/decodeURIComponent\(p\)/.test(html) &&
		/\^\\\/\[A-Za-z\]:/.test(html) &&
		!/location\.href\.replace/.test(html);
	check("D4 copy-path gives a usable path", copyPath);

	// every page must ship script that parses: one stray escape and every button dies
	const scriptSrc = (html.match(/<script>([\s\S]*?)<\/script>/) ?? [null, ""])[1];
	let parses = true;
	try {
		new Function(scriptSrc);
	} catch {
		parses = false;
	}
	check("D6 page script parses", parses && scriptSrc.length > 100);

	check("D7 done after the report", h.text(await h.plan({ action: "advance", to: "done" })).includes("已推进"));
}

function name(list) {
	return list.join(",");
}

/* ------------------------------------------------- E. no self-check nudge */
{
	const judge = async (text) => {
		const h = harness();
		h.fire("session_start", {});
		await h.plan({ action: "start", goal: "测试意图" });
		const out = await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
		return { result: out[0], nags: h.sent.length, notes: h.notes };
	};

	const absent = await judge("做完了，就这样。");
	check("E1 no self-check nudge", absent.nags === 0 && absent.result === undefined);

	const full = await judge(
		[
			"结论在这里。",
			"**乔哈里自检**",
			"- 证据：读了 extensions/johari-flow/index.ts 与测试输出",
			"- 用词：把「门禁」写成「未批准前不许动代码」",
			"- 框架：先给结论再给证据，最后给下一步",
			"- 假设：假定你要的是能发布而不是能跑",
			"- 未知：没有你的真实屏幕尺寸",
			"- 隐藏：放宽误伤等于放宽拦截",
			"- 一致性：与上一轮的阶段判断一致",
			"- 下一步：等你点头再改版本号",
		].join("\n"),
	);
	check("E2 complete self-check is silent", full.nags === 0 && full.result === undefined);

	const bare = await judge("**乔哈里自检**\n- 证据：无\n- 用词：无\n- 框架：无\n- 假设：无\n- 未知：无\n- 隐藏：无\n- 一致性：无\n- 下一步：无");
	check("E3 label-only block is not nudged", bare.nags === 0, notes2(bare.notes));

	const quoted = await judge(
		[
			"**乔哈里自检**",
			"- 证据：测试脚本输出",
			"- 用词：都用大白话",
			"- 框架：结论先行",
			"- 假设：假定你在白天看这个页面",
			"- 未知：没测过 4K 屏",
			"- 隐藏：样式还有弹性",
			"- 一致性：与前面说法一致",
			"- 下一步：等你回执",
			"",
			"顺带说一句，上面那行「乔哈里自检」只是引用格式。",
		].join("\n"),
	);
	check("E4 trailing mention is not mistaken for the block", quoted.nags === 0);
}

function notes2(list) {
	return (list ?? []).join(" | ").slice(0, 60);
}

/* -------------------------------------------------------- F. ask / setGoal / abort */
{
	const h = harness();
	h.fire("session_start", {});
	await h.plan({ action: "start", goal: "原始意图" });

	const asked = await h.ask({
		question: "选哪个？",
		options: [
			{ id: "A", label: "方案 A" },
			{ id: "B", label: "方案 B" },
		],
	});
	const payload = asked?.details ?? asked?.content?.[0]?.text ?? "";
	check("F1 ask without UI answers false", payload.answered === false);
	check("F1b ask explains itself without UI", h.text(asked).includes("没有交互 UI"));


	check("F2 setGoal before approval", h.text(await h.plan({ action: "setGoal", goal: "新意图" })).includes("重新确认"));
	await h.plan({ action: "confirm", reason: "用户确认" });
	await h.plan({ action: "advance", to: "research" });
	check("F3 abort returns to idle", h.text(await h.plan({ action: "abort", reason: "用户喊停" })).includes("已终止"));
	const sp = { systemPromptOptions: { sections: {} } };
	await h.fire("before_agent_start", sp);
	check("F4 protocol gone after abort", (sp.systemPromptOptions.sections.johari_flow ?? "").trim() === "");
}

/* --------------------------------------- G. gate matrix, phase by phase */
{
	const shouldBlock = [
		"rm -rf src",
		"rm --recursive --force src",
		"rm -Rf src",
		"rg foo && rm -rf src",
		"sed -i.bak 's/a/b/' src/x.ts",
		"perl -pi -e 's/a/b/' x.ts",
		"git checkout .",
		"git restore .",
		"git reset --hard HEAD~1",
		"git apply p.patch",
		"git commit -am wip",
		"npm install lodash",
		'bash -c "echo hi > src/x.ts"',
		"echo hi | tee x.ts",
		"cp a.ts src/b.ts",
		"mv a.ts src/b.ts",
		"truncate -s 0 src/x.ts",
		"git push --force origin main",
		"git -C repo push -f",
		'shred f',
	];
	const shouldAllow = [
		'rg "rm -rf" docs',
		"git status",
		"git log --oneline -5",
		"cat README.md",
		"awk '$3 > 100' data.txt",
		"git status > /dev/null 2>&1",
		'find . -name "*.ts" | head',
		"ls -la",
		"wc -l x.ts",
		'node -e "console.log(1)"',
		"git diff",
		"echo hi",
	];
	for (const phase of ["intent", "research", "review"]) {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.plan({ action: "start", goal: "矩阵" });
		if (phase !== "intent") {
			await h.plan({ action: "confirm", reason: "用户确认" });
			await h.plan({ action: "advance", to: "research" });
			if (phase === "review") {
				await h.plan({ action: "advance", to: "design" });
				await h.plan({ action: "advance", to: "review" });
			}
		}
		const leaks = [];
		for (const command of shouldBlock) {
			const r = await h.fire("tool_call", { toolName: "bash", input: { command } });
			if (!h.blocked(r[0])) leaks.push(command);
		}
		const noise = [];
		for (const command of shouldAllow) {
			const r = await h.fire("tool_call", { toolName: "bash", input: { command } });
			if (h.blocked(r[0])) noise.push(command);
		}
		check(`G1 ${phase}: mutations blocked`, leaks.length === 0, leaks.join(" | "));
		check(`G2 ${phase}: read-only allowed`, noise.length === 0, noise.join(" | "));
	}
	// interpreter one-liners that name a write API are mutations, not inspection
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await h.plan({ action: "start", goal: "内联脚本" });
	const inline = await h.fire("tool_call", {
		toolName: "bash",
		input: { command: `node -e "require('fs').writeFileSync('src/x.ts','')"` },
	});
	check("G3 inline write blocked", h.blocked(inline[0]));
	const py = await h.fire("tool_call", {
		toolName: "bash",
		input: { command: `python -c "open('src/x.ts','w').write(1)"` },
	});
	check("G4 python inline write blocked", h.blocked(py[0]));
	const note = await h.fire("tool_call", {
		toolName: "write",
		input: { path: join(WORK, ".pi", "flow", "note.md"), content: "草稿" },
	});
	check("G5 scratch note writable in intent", !h.blocked(note[0]));
	const code = await h.fire("tool_call", {
		toolName: "write",
		input: { path: join(WORK, "src", "a.ts"), content: "x" },
	});
	check("G6 project file blocked in intent", h.blocked(code[0]));
}

/* ------------------------------------------------------------ H. release hygiene */
{
	// the version is written twice (package.json + the footer constant); prove they agree
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const src = readFileSync(join(repoRoot, "extensions/johari-flow/index.ts"), "utf8");
	const constant = (src.match(/const PKG_VERSION = "([^"]+)"/) ?? [null, null])[1];
	check("H1 PKG_VERSION matches package.json", constant === pkg.version, `${constant} vs ${pkg.version}`);

	const skill = readFileSync(join(repoRoot, "skills/johari-flow/SKILL.md"), "utf8");
	check("H2 skill has frontmatter", /^---\r?\nname: johari-flow\r?\n/.test(skill));
	check("H3 skill lists every carrier", ["tree", "branch", "sequence", "graph", "state"].every((k) => skill.includes(k)));

	const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
	check("H4 changelog has this version", changelog.includes(`## [${pkg.version}]`));
}

/* ------------------------------------------------- I. answering on the page */
{
	// The picker is the default surface: a choice without a price tag is a coin flip.
	const h = harness();
	h.fire("session_start", {});
	const asked = await h.ask({
		question: "选哪个？",
		options: [
			{ id: "A", label: "快但粗糙", cost: "代价：之后返工" },
			{ id: "B", label: "慢但稳", cost: "代价：多花一天" },
		],
	});
	const text = h.text(asked);
	check("I8 picker carries the cost line", text.includes("代价：之后返工") && text.includes("代价：多花一天"));

	// The card lands while the picker is open, so the question is readable in the chat.
	const partials = [];
	const askedWithCard = await h.askWith(
		{
			question: "先做哪块？",
			context: "两件事都想要，但只能先做一件。",
			options: [
				{ id: "A", label: "先修图片", cost: "代价：链接晚一天" },
				{ id: "B", label: "先修链接", cost: "代价：图片晚一天", recommended: true },
			],
		},
		(partial) => partials.push(partial),
	);
	const card = String(partials[0]?.content?.[0]?.text ?? "");
	check(
		"I9 the card appears while waiting",
		card.includes("需要你拍板") && card.includes("代价：链接晚一天") && card.includes("（推荐）"),
	);
	check("I10 the question is visible outside the dialog", h.widget()?.[0]?.includes("待拍板") === true);
	// the footer status is shared: the flow re-renders its own line right after, so only the
	// widget is expected to be gone by itself.
	check("I11 the banner is cleared after the answer", h.widget()?.[1] === undefined);
	check("I12 an unanswered question says so", h.text(askedWithCard).includes("没有得到回答"));
}
{
	const { startAnswerServer } = await import("../extensions/johari-flow/answer.ts");
	const waiter = await startAnswerServer({ ids: ["A", "B"] });
	const post = (body) =>
		fetch(waiter.endpoint, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
	const wrong = await post(`nope|A`);
	const unknown = await post(`${waiter.token}|Z`);
	const ok = await post(`${waiter.token}|B`);
	const answer = await waiter.wait(3000);
	const late = await post(`${waiter.token}|A`).catch(() => ({ status: 409 }));
	check("I1 a page click reaches the tool", answer === "B", String(answer));
	check("I2 wrong token refused", wrong.status === 403);
	check("I3 unknown option refused", unknown.status === 400);
	check("I4 first answer wins", ok.status === 200 && late.status === 409);

	const timeout = await startAnswerServer({ ids: ["A"] });
	const before = Date.now();
	const none = await timeout.wait(150);
	check("I5 silence resolves to null", none === null && Date.now() - before >= 140);
	await timeout.close();

	const liveHtml = renderPage(
		{ kind: "decision", title: "选哪个", sections: [], options: [{ id: "A", label: "甲" }, { id: "B", label: "乙" }] },
		{ phase: "测试", cwd: WORK, sessionId: "s", live: { endpoint: "http://127.0.0.1:9/answer", token: "tok123" } },
	);
	check(
		"I6 live page carries the wire",
		liveHtml.includes('"endpoint":"http://127.0.0.1:9/answer"') &&
			liveHtml.includes('"token":"tok123"') &&
			liveHtml.includes('data-opt="A"') &&
			liveHtml.includes("点一项就直接作答"),
	);
	const deadHtml = renderPage(
		{ kind: "decision", title: "选哪个", sections: [], options: [{ id: "A", label: "甲" }] },
		{ phase: "测试", cwd: WORK, sessionId: "s" },
	);
	check(
		"I7 a saved page stays a clipboard page",
		deadHtml.includes('"endpoint"') === false && deadHtml.includes("粘贴回 Pi"),
	);
}

/* ------------------------------------------------------------------ summary */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
	console.log(`失败：${failed.map((f) => f.id).join("、")}`);
	process.exitCode = 1;
}
