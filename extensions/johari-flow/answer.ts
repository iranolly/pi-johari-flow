/**
 * A decision page is a `file://` document, so a click inside it has no way back to
 * the conversation on its own. This module is the missing wire: a loopback-only
 * listener that lives exactly as long as one question, accepts one answer, and
 * then disappears.
 *
 * Shape of the exchange:
 *   page  --POST text/plain "token|A"-->  127.0.0.1:<random port>
 *   tool  <-- resolves with "A" --------  (or null on timeout)
 *
 * `text/plain` is deliberate: it is a CORS "simple request", so a `file://` page
 * (opaque origin) can post without a preflight that Chrome would refuse.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface AnswerPick {
	id: string;
	/** One optional line the user typed while choosing; already trimmed and capped. */
	note?: string;
}

export interface AnswerWaiter {
	/** Full URL the page must post to. */
	endpoint: string;
	/** Random per-question secret; a stale page from an old question cannot answer. */
	token: string;
	/** Resolve with the chosen option (and any note the user typed), or null. */
	wait(ms: number): Promise<AnswerPick | null>;
	/** Stop listening and drop every open connection. */
	close(): void;
}

export interface AnswerServerOptions {
	/** Option ids the page may return; anything else is refused. */
	ids?: string[];
	/**
	 * Accept a free-form receipt instead of one id. A page with N questions cannot
	 * answer with a single id — the person answers all groups, then submits the
	 * receipt that lists each group's choice.
	 */
	receipt?: boolean;
}

function send(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
		"Access-Control-Allow-Headers": "*",
		"Cache-Control": "no-store",
		// No keep-alive: the server lives for one answer, and an idle socket would
		// hold the port open after the question is done.
		Connection: "close",
	});
	res.end(body);
}

function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > limit) {
				reject(new Error("body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

/**
 * Start a one-question listener. Throws when the port cannot be bound, so the
 * caller can fall back to the terminal picker instead of hanging.
 */
export async function startAnswerServer(opts: AnswerServerOptions): Promise<AnswerWaiter> {
	const ids = new Set(opts.ids ?? []);
	const receipt = opts.receipt === true;
	const token = randomBytes(16).toString("hex");
	let settled = false;
	let resolveAnswer: (pick: AnswerPick | null) => void = () => {};
	const answered = new Promise<AnswerPick | null>((resolve) => {
		resolveAnswer = resolve;
	});

	const finish = (pick: AnswerPick | null) => {
		if (settled) return;
		settled = true;
		resolveAnswer(pick);
	};

	const server: Server = createServer((req, res) => {
		const url = (req.url ?? "").split("?")[0];
		if (req.method === "OPTIONS") {
			send(res, 204, "");
			return;
		}
		if (req.method === "GET" && (url === "/" || url === "/ping")) {
			send(res, 200, settled ? "answered" : "waiting");
			return;
		}
		if (req.method !== "POST" || url !== "/answer") {
			send(res, 404, "not found");
			return;
		}
		void readBody(req, receipt ? 8192 : 4096)
			.then((body) => {
				const [gotToken, ...rest] = body.replace(/\r?\n/g, " ").split("|");
				if (gotToken !== token) {
					send(res, 403, "bad token");
					return;
				}
				if (settled) {
					send(res, 409, "already answered");
					return;
				}
				if (receipt) {
					// The receipt text is the answer: labels may contain `|`, so re-join.
					const text = rest.join("|").trim().slice(0, 4000);
					if (!text) {
						send(res, 400, "empty receipt");
						return;
					}
					finish({ id: text });
					send(res, 200, "ok");
					return;
				}
				const [id, rawNote] = rest;
				if (!id || !ids.has(id)) {
					send(res, 400, `unknown option: ${id ?? ""}`);
					return;
				}
				const note = (rawNote ?? "").trim().slice(0, 600) || undefined;
				finish({ id, note });
				send(res, 200, `ok:${id}`);
			})
			.catch(() => send(res, 400, "bad body"));
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	if (!port) {
		server.close();
		throw new Error("答案监听端口没有拿到");
	}

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		finish(null);
		server.close();
		server.closeIdleConnections?.();
		// A response may still be on the wire; give it a beat before the hard stop.
		const kill = setTimeout(() => server.closeAllConnections?.(), 200);
		kill.unref?.();
	};

	return {
		endpoint: `http://127.0.0.1:${port}/answer`,
		token,
		async wait(ms: number): Promise<AnswerPick | null> {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), ms);
				timer.unref?.();
			});
			const pick = await Promise.race([answered, timeout]);
			if (timer) clearTimeout(timer);
			close();
			return pick;
		},
		close,
	};
}
