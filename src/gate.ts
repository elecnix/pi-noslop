/**
 * The slop gate: pure logic, no pi imports. Unit-testable in milliseconds.
 *
 * Given a tool name and its input, decide whether the call must be blocked.
 * `edit` gates each `edits[i].newText` (the text being written — so slop
 * that is merely copied from the old text is still caught); `write` gates
 * the full `content`. Bash never reaches this module.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Absolute path to this repo's vendored vale config. */
export const VALE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vale");

/**
 * The config is always the vendored one; the binary is always `vale` on
 * PATH. Neither is configurable at runtime — an overridable binary would
 * be a break-glass (a fake `vale` that always exits 0 would pass slop).
 * The only injection point is the `opts` parameter, used by tests.
 */
export const VALE_BIN = "vale";
export const VALE_INI = join(VALE_DIR, ".vale.ini");

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

/** The exact args the extension passes to vale. Exported for tests. */
export function valeArgs(): string[] {
	return [
		"--no-global",
		`--config=${VALE_INI}`,
		"--output=JSON",
		"--no-wrap",
		"--ext=.md",
	];
}

/** Options for injecting test doubles. The gate itself has no off switch. */
export interface GateOptions {
	/** Vale binary override (tests inject a name that cannot exist). */
	valeBin?: string;
}

/**
 * Spawn vale, feed `text` on stdin, resolve with its JSON stdout.
 * Vale exits 0 (clean) or 1 (violations found); both produce valid JSON.
 * Any other exit, a spawn error, or a timeout rejects.
 */
export function runVale(text: string, valeBin: string = VALE_BIN): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(valeBin, valeArgs(), { stdio: ["pipe", "pipe", "pipe"] });
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
				reject(new Error(`vale exited with code ${code}: ${stderr.trim()}`));
				return;
			}
			resolve(stdout);
		});
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

/** Run vale over `text`; never throws — vale failures come back as `error`. */
export async function lintText(text: string, opts?: GateOptions): Promise<LintResult> {
	try {
		const stdout = await runVale(text, opts?.valeBin);
		return { violations: parseValeOutput(stdout) };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			violations: [],
			error: `vale could not run: ${detail}. Check that vale is installed and the vendored styles are present at ${VALE_DIR}.`,
		};
	}
}

export interface GateOptions {
	/** Vale binary override (tests inject a name that cannot exist). */
	valeBin?: string;
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
export function valeCommandForFile(path: string): string {
	return `vale --no-global --config=${VALE_INI} --output=JSON --no-wrap --ext=.md ${path}`;
}

/** The vale command that lints text piped to stdin (for new-file writes). */
export function valeCommandForStdin(): string {
	return `vale --no-global --config=${VALE_INI} --output=JSON --no-wrap --ext=.md`;
}

/** Build the block reason: rule, vale guidance, match, and how to run vale. */
export function buildReason(
	violations: ValeViolation[],
	path: string,
	toolName: string,
): string {
	const shown = violations.slice(0, MAX_REPORTED);
	const lines = [
		"pi-noslop: blocked — the text you are about to write contains AI-slop prose.",
		"",
		`File: ${path}`,
		`Violations: ${violations.length}`,
		"",
		...shown.map((v) => `- ${v.Check}: ${v.Message} (match: "${v.Match}", line ${v.Line})`),
	];
	if (violations.length > MAX_REPORTED) {
		lines.push(`… and ${violations.length - MAX_REPORTED} more.`);
	}
	lines.push("", "To see every violation at once, run:");
	if (toolName === "edit") {
		lines.push(`  ${valeCommandForFile(path)}`);
	} else {
		lines.push(`  ${valeCommandForStdin()}  # pipe the content to stdin`);
	}
	lines.push("", "Fix the flagged prose and re-issue the edit. There is no bypass.");
	return lines.join("\n");
}

export interface GateContext {
	/** pi's working directory — unused by the gate itself, kept for parity. */
	cwd?: string;
}

/**
 * Decide a tool call. Returns undefined when the call may proceed.
 * Never throws: a vale failure is a fail-closed block.
 */
export async function gate(
	toolName: string,
	input: GateInput,
	opts?: GateOptions,
): Promise<{ block: boolean; reason: string } | undefined> {
	if (toolName !== "edit" && toolName !== "write") {
		return undefined;
	}
	const texts = textsToLint(toolName, input);
	if (texts.length === 0) {
		return undefined;
	}

	const path = input.path ?? "<unknown>";
	const allViolations: ValeViolation[] = [];
	for (const text of texts) {
		const result = await lintText(text, opts);
		if (result.error) {
			return {
				block: true,
				reason: `pi-noslop: blocked — the slop gate could not run (fail-closed). ${result.error}`,
			};
		}
		allViolations.push(...result.violations);
	}
	if (allViolations.length > 0) {
		return { block: true, reason: buildReason(allViolations, path, toolName) };
	}
	return undefined;
}
