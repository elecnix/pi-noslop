/**
 * The slop gate: pure logic, no pi imports. Unit-testable in milliseconds.
 *
 * Given a tool name and its input, decide whether the call must be blocked.
 * `edit` gates each `edits[i].newText` (the text being written — so slop
 * that is merely copied from the old text is still caught); `write` gates
 * the full `content`. Bash never reaches this module.
 *
 * The rule set comes from the repo being edited when that repo declares
 * one, and from the vendored default pack otherwise. See src/config.ts.
 *
 * Vale's parse format (`--ext`) is derived from the tool call's target
 * `path`: a write to `main.go` is linted as Go (comments only), a write
 * to `README.md` as Markdown. Unrecognized, extensionless, and dotfile
 * paths fall back to `md`, so prose rules still fire, which fails closed.
 */

import { spawn } from "node:child_process";
import { extname, join } from "node:path";
import {
	configLabel,
	resolveValeConfig,
	resolveValeConfigForDir,
	VALE_DIR,
	VALE_INI,
	VENDORED_CONFIG,
	type ResolvedConfig,
} from "./config.ts";

export { VALE_DIR, VALE_INI, VENDORED_CONFIG, resolveValeConfig, resolveValeConfigForDir, configLabel };
export type { ResolvedConfig };

/**
 * The binary is always `vale` on PATH. It is not configurable at runtime —
 * an overridable binary would be a break-glass, since a fake `vale` that
 * always exits 0 would pass slop. The only injection point is the `opts`
 * parameter, used by tests.
 */
export const VALE_BIN = "vale";

/** Cap on how many violations are listed in a block reason. */
export const MAX_REPORTED = 20;

/** Timeout for one vale invocation. */
export const VALE_TIMEOUT_MS = 30_000;

export interface ValeViolation {
	Check: string;
	Message: string;
	Match: string;
	Line: number;
}

export interface LintResult {
	violations: ValeViolation[];
	/** Set when vale itself failed — the caller must fail closed. */
	error?: string;
}

/** Extensions vale 3.20 parses with a tree-sitter grammar (its "code"
 * kind): the file's comments are linted and its code is not. Vale
 * normalizes each alias family to one grammar (cp onto cpp, sass onto
 * c), so every alias is listed here explicitly.
 */
const CODE_EXT: Record<string, true> = {
	// Python is vale's [rc]?py[3w]? alias family.
	py: true, rpy: true, cpy: true, py3: true, pyw: true, cpy3: true, rpy3: true, rpyw: true, cpyw: true,
	// Clojure.
	clj: true, cljs: true, cljc: true, cljd: true,
	// C and C++.
	c: true, cc: true, cpp: true, cp: true, cxx: true, "c++": true, h: true, hpp: true, "h++": true,
	// C# (vale merges it onto the C grammar).
	cs: true, csx: true,
	// Elixir.
	ex: true, exs: true,
	go: true,
	// Haskell.
	hs: true,
	// Java.
	java: true, bsh: true,
	// Julia.
	jl: true,
	// JavaScript.
	js: true, jsx: true,
	// Lua.
	lua: true,
	// PHP.
	php: true,
	// Perl (vale merges it onto the R grammar).
	pl: true, pm: true, pod: true,
	// Protobuf.
	proto: true,
	// PowerShell.
	ps1: true, psm1: true, psd1: true,
	// QML.
	qml: true,
	// R.
	r: true,
	// Ruby.
	rb: true,
	// Rust.
	rs: true,
	// Sass and LESS (vale merges them onto the C grammar).
	sass: true, scss: true, less: true,
	// Scala.
	scala: true, sbt: true,
	// Swift.
	swift: true,
	// TypeScript.
	ts: true, tsx: true,
	// CSS.
	css: true,
};

/**
 * Extensions vale 3.20 reads natively as prose documents (its "markup"
 * and "text" kinds). The whole text is the prose, so whole-text linting
 * is the gate doing its job rather than a fallback. Only the readers
 * vale runs on its own are listed. The markup formats that need an
 * external converter (rst, adoc, dita, xml, typ) are skipped instead:
 * vale errors on them without the converter, so mapping them made every
 * write to them fail closed.
 */
const PROSE_EXT: Record<string, true> = {
	// Markdown family.
	md: true, mdown: true, markdown: true, markdn: true, rmd: true,
	// MDX, MyST, Quarto, and Qt documentation.
	mdx: true, myst: true, qmd: true, qdoc: true, qdocinc: true,
	// Emacs Org.
	org: true,
	// Plain text.
	txt: true,
	// HTML.
	html: true, htm: true, shtml: true, xhtml: true,
};

export type LintKind = "code" | "prose";

/**
 * Whether the gate lints a target path, and as what. `undefined` means
 * the target is skipped: the gate does not run vale on it, whatever its
 * content. The skip set is every target vale has no usable parser for:
 *
 * - extensionless, dotfile, trailing-dot, and absent paths;
 * - languages with no grammar at all, such as shell and terraform;
 * - vale's "data" kinds (yaml, yml, json, toml). Vale reads them back
 *   as plain text, so `key:` structure trips prose rules while their
 *   real prose is no easier to isolate than a code file's;
 * - the markup formats vale cannot read without an external converter
 *   it will not fetch (rst, adoc, dita, xml, typ). Mapping these to
 *   their own formats fails closed on every write to them.
 *
 * Issue #6 recorded the decision: for these targets the gate skips the
 * file. Slop in them passes silently. That is the accepted weakening of
 * the fail-closed promise, traded for zero false positives.
 */
export function lintKindForPath(path: string | undefined): LintKind | undefined {
	if (!path || path === "<unknown>") {
		return undefined;
	}
	const ext = extname(path).slice(1).toLowerCase();
	if (CODE_EXT[ext]) {
		return "code";
	}
	if (PROSE_EXT[ext]) {
		return "prose";
	}
	return undefined;
}

/**
 * The `--ext` value the gate passes to vale for a target path, or
 * `undefined` for a path the gate skips. The extension is lowercased
 * first because vale does not accept `--ext=.GO`. The value keeps its
 * leading dot: vale accepts `--ext=.md` and not `--ext=md`.
 */
export function formatForPath(path: string | undefined): string | undefined {
	if (lintKindForPath(path) === undefined) {
		return undefined;
	}
	return "." + extname(path).slice(1).toLowerCase();
}

/** The exact args the extension passes to vale. Exported for tests. */
export function valeArgs(configPath: string = VALE_INI, path?: string): string[] {
	const args = [
		"--no-global",
		`--config=${configPath}`,
		"--output=JSON",
		"--no-wrap",
	];
	const ext = formatForPath(path);
	if (ext) {
		args.push(`--ext=${ext}`);
	}
	return args;
}

/** Options for injecting test doubles. The gate itself has no off switch. */
export interface GateOptions {
	/** Vale binary override (tests inject a name that cannot exist). */
	valeBin?: string;
	/** Rule set to use. Resolved from the edited path when absent. */
	config?: ResolvedConfig;
	/** Directory relative paths resolve against. Defaults to pi's cwd. */
	cwd?: string;
	/** Target path, used only to derive vale's `--ext` parse format. */
	path?: string;
}

/**
 * Vale reports a config failure as a JSON envelope on stderr and exits 2.
 * Turn that into one line that names the code and the actual problem.
 */
export function describeValeExit(code: number | null, stderr: string): string {
	const trimmed = stderr.trim();
	try {
		const parsed = JSON.parse(trimmed) as { Text?: string; Code?: string; Path?: string };
		if (parsed && typeof parsed.Text === "string") {
			const where = parsed.Path ? ` in ${parsed.Path}` : "";
			const text = parsed.Text.replace(/\s*Execution stopped with code \d+\.\s*$/, "")
				.replace(/\s+/g, " ")
				.trim();
			return `${parsed.Code ?? "error"}${where}: ${text}`;
		}
	} catch {
		// Not vale's JSON envelope. Fall through to the raw output.
	}
	return `exited with code ${code}: ${trimmed}`;

}

/**
 * Spawn vale, feed `text` on stdin, resolve with its JSON stdout.
 * Vale exits 0 (clean) or 1 (violations found); both produce valid JSON.
 * Any other exit, a spawn error, or a timeout rejects. `path` only picks
 * the parse format (`--ext`); the text itself always travels on stdin.
 */
export function runVale(
	text: string,
	configPath: string = VALE_INI,
	valeBin: string = VALE_BIN,
	path?: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(valeBin, valeArgs(configPath, path), { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`vale timed out after ${VALE_TIMEOUT_MS / 1000}s`));
		}, VALE_TIMEOUT_MS);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && code !== 1) {
				reject(new Error(describeValeExit(code, stderr)));
				return;
			}
			resolve(stdout);
		});
		// Vale exits before draining stdin whenever it cannot load the config,
		// which is exactly what an unsynced repo does. Writing a payload past
		// the pipe buffer then raises EPIPE, and an unhandled `error` event on
		// stdin would kill the host process instead of producing a verdict —
		// neither allowed nor blocked. The `close` and `error` handlers above
		// already reach the right answer, so this one only has to not throw.
		child.stdin.on("error", () => {});
		child.stdin.write(text);
		child.stdin.end();
	});
}

/** Parse vale's JSON output into a flat violation list. */
export function parseValeOutput(stdout: string): ValeViolation[] {
	const parsed = JSON.parse(stdout) as Record<string, ValeViolation[]>;
	const violations: ValeViolation[] = [];
	for (const file of Object.values(parsed)) {
		for (const v of file) {
			violations.push(v);
		}
	}
	return violations;
}

/**
 * Why the gate could not reach a verdict, and what to do about it.
 *
 * A repo that declares its own rules never falls back to the vendored
 * pack. Falling back would let a deleted styles directory quietly swap in
 * a weaker rule set, and the edit would look approved.
 */
export function describeFailure(config: ResolvedConfig, detail: string): string {
	const lines = [
		`vale could not run: ${detail}`,
		`Rules: ${configLabel(config)}`,
	];
	if (config.source === "project") {
		lines.push(
			`This repo declares its own rules, so pi-noslop blocks here instead of falling back to its vendored pack.`,
			`If the rules are pinned with a \`Packages =\` line they have to be fetched once: cd ${config.root} && vale sync.`,
			`pi-noslop never fetches them for you — a hook that runs before every edit stays off the network.`,
		);
	} else {
		lines.push(`Check that vale is installed and the vendored styles are present at ${VALE_DIR}.`);
	}
	return lines.join(" ");
}

/** Run vale over `text`; never throws — vale failures come back as `error`. */
export async function lintText(text: string, opts?: GateOptions): Promise<LintResult> {
	const config = opts?.config ?? VENDORED_CONFIG;
	try {
		const stdout = await runVale(text, config.configPath, opts?.valeBin, opts?.path);
		return { violations: parseValeOutput(stdout) };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { violations: [], error: describeFailure(config, detail) };
	}
}

export interface GateInput {
	path?: string;
	edits?: Array<{ newText?: string }>;
	content?: string;
}

export interface GateResult {
	block: boolean;
	reason: string;
}

/** Extract the texts a tool call would write. Empty = nothing to lint. */
export function textsToLint(toolName: string, input: GateInput): string[] {
	if (toolName === "edit" && Array.isArray(input.edits)) {
		return input.edits
			.map((e) => (typeof e?.newText === "string" ? e.newText : ""))
			.filter((t) => t.length > 0);
	}
	if (toolName === "write" && typeof input.content === "string" && input.content.length > 0) {
		return [input.content];
	}
	return [];
}

/** The vale command that reproduces the full violation list for a file. */
export function valeCommandForFile(path: string, configPath: string = VALE_INI): string {
	return `vale ${valeArgs(configPath, path).join(" ")} ${path}`;
}

/** The vale command that lints text piped to stdin (for new-file writes). */
export function valeCommandForStdin(path?: string, configPath: string = VALE_INI): string {
	return `vale ${valeArgs(configPath, path).join(" ")}`;

}

/** Build the block reason: rule set, rule, vale guidance, match, command. */
export function buildReason(
	violations: ValeViolation[],
	path: string,
	toolName: string,
	config: ResolvedConfig = VENDORED_CONFIG,
): string {
	const shown = violations.slice(0, MAX_REPORTED);
	const lines = [
		"pi-noslop: blocked — the text you are about to write contains AI-slop prose.",
		"",
		`File: ${path}`,
		`Rules: ${configLabel(config)}`,
		`Violations: ${violations.length}`,
		"",
		...shown.map((v) => `- ${v.Check}: ${v.Message} (match: "${v.Match}", line ${v.Line})`),
	];
	if (violations.length > MAX_REPORTED) {
		lines.push(`… and ${violations.length - MAX_REPORTED} more.`);
	}
	lines.push("", "To see every violation at once, run:");
	if (toolName === "edit") {
		lines.push(`  ${valeCommandForFile(path, config.configPath)}`);
	} else {
		lines.push(`  ${valeCommandForStdin(path, config.configPath)}  # pipe the content to stdin`);
	}
	lines.push("", "Fix the flagged prose and re-issue the edit. There is no bypass.");
	return lines.join("\n");
}

/**
 * Decide a tool call. Returns undefined when the call may proceed.
 * Never throws: a vale failure is a fail-closed block.
 */
export async function gate(
	toolName: string,
	input: GateInput,
	opts?: GateOptions,
): Promise<GateResult | undefined> {
	if (toolName !== "edit" && toolName !== "write") {
		return undefined;
	}
	const texts = textsToLint(toolName, input);
	if (texts.length === 0) {
		return undefined;
	}

	const path = opts?.path ?? input.path;
	const displayPath = input.path ?? "<unknown>";
	// Issue #6: a target vale has no usable parser for is skipped, so the
	// gate does not run vale on it at all. Linting it whole-file as prose
	// is where the .sh and .yml false positives came from.
	if (lintKindForPath(path) === undefined) {
		return undefined;
	}
	const cwd = opts?.cwd ?? process.cwd();
	// A call with no path is judged by the rules governing pi's own cwd.
	const config =
		opts?.config ??
		(input.path ? resolveValeConfig(input.path, cwd) : resolveValeConfigForDir(cwd));

	const allViolations: ValeViolation[] = [];
	for (const text of texts) {
		const result = await lintText(text, { ...opts, config, path });
		if (result.error) {
			return {
				block: true,
				reason: `pi-noslop: blocked — the slop gate could not run (fail-closed). ${result.error}`,
			};
		}
		allViolations.push(...result.violations);
	}
	if (allViolations.length > 0) {
		return { block: true, reason: buildReason(allViolations, displayPath, toolName, config) };
	}
	return undefined;
}
