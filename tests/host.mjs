/**
 * The extension imports three host packages by bare name (`@earendil-works/pi-ai`,
 * `@earendil-works/pi-coding-agent`, `typebox`). Pi supplies them through its own
 * module map; a plain `node` run does not. This helper finds them next to the
 * installed `pi` binary and links them into the repo so the tests stay zero-dep
 * (no `npm install` needed, nothing added to `dependencies`).
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const NEEDED = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"];

function isHostModules(dir) {
	return NEEDED.every((name) => existsSync(join(dir, name)));
}

function* candidates() {
	if (process.env.PI_HOST_MODULES) yield process.env.PI_HOST_MODULES;
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		if (!entry) continue;
		let names = [];
		try {
			names = readdirSync(entry).filter((n) => /^pi(\.cmd|\.exe|\.ps1)?$/.test(n));
		} catch {
			continue;
		}
		for (const name of names) {
			let dir;
			try {
				dir = dirname(realpathSync(join(entry, name)));
			} catch {
				continue;
			}
			// pi ships as `@agegr/pi-web`, which bundles the runtime; walk up until
			// a node_modules shows up and try both the bundle and the flat layout.
			for (let i = 0; i < 8; i += 1) {
				yield join(dir, "node_modules", "@agegr", "pi-web", "node_modules");
				yield join(dir, "node_modules");
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
	}
}

function linkDir(from, to) {
	mkdirSync(dirname(to), { recursive: true });
	if (existsSync(to)) return;
	try {
		symlinkSync(from, to, "junction");
	} catch {
		symlinkSync(from, to, "dir");
	}
}

/** Link or verify a usable node_modules for the extension, and return its path. */
export function ensureHostModules(repoRoot) {
	const target = join(repoRoot, "node_modules");
	if (isHostModules(target)) return target;
	for (const cand of candidates()) {
		if (!isHostModules(cand)) continue;
		for (const name of NEEDED) linkDir(join(cand, name), join(target, name));
		return target;
	}
	throw new Error(
		[
			"找不到 pi 的运行时模块目录，测试无法解析 @earendil-works/pi-ai、typebox。",
			"修法：设置环境变量 PI_HOST_MODULES 指向含这些包的 node_modules，例如",
			"  PI_HOST_MODULES=<pi 安装目录>/node_modules/@agegr/pi-web/node_modules",
		].join("\n"),
	);
}
