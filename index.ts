/**
 * pi-noslop — fail-closed AI-slop gate for pi's edit and write tools.
 *
 * Every `edit` and `write` tool call is linted with the vendored
 * vale-ai-tells ruleset (vale/styles/ai-tells) BEFORE the tool executes.
 * If the text the agent is about to write contains any slop, the tool call
 * is blocked with a loud, precise reason: the rule that broke, the vale
 * guidance, and the exact vale command to run for the full violation list.
 *
 * Design decisions (all load-bearing):
 *
 * 1. Lint the NEW text only, never the whole resulting file. The spec is
 *    "fails edits that write ANY slop, even if the old text contained slop
 *    and is merely copied" — so each `edits[i].newText` is linted on its
 *    own. Pre-existing slop elsewhere in the file is out of scope and must
 *    not block unrelated edits.
 * 2. Any file type. Vale is told to parse the text as Markdown via
 *    `--ext=.md` on stdin, so a `.go` file or a `Makefile` gets the same
 *    prose rules as a README. Fenced code blocks inside the text are
 *    skipped by Vale's Markdown parser, so code identifiers that happen to
 *    match slop tokens do not false-positive.
 * 3. Fail closed. If vale is missing, the vendored styles are missing, or
 *    vale errors out, the tool call is BLOCKED — a broken gate must never
 *    silently let slop through.
 * 4. No break-glass. There is no flag, env var, or config to disable the
 *    gate. The only way to write slop is to not write slop.
 * 5. Bash is untouched. Only `edit` and `write` are gated.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Absolute path to this repo's vendored vale config. */
const VALE_DIR = join(dirname(fileURLToPath(import.meta.url)), "vale");
const VALE_INI = join(VALE_DIR, ".vale.ini");

/** Cap on how many violations are listed in a block reason. */
const MAX_REPORTED = 20;

interface ValeViolation {
	Check: string;
	Message: string;
	Match: string;
	Line: number;
}

interface ValeOutput {
	[key: string]: ValeViolation[];
}

/**
 * Run vale over `text` (parsed as Markdown) and return the violations.
 * Throws on any failure — the caller treats a throw as "block".
 */
async function lintText(text: string): Promise<ValeViolation[]> {
	const stdout = await runVale(text);
	const parsed = JSON.parse(stdout) as ValeOutput;
	const violations: ValeViolation[] = [];
	for (const file of Object.values(parsed)) {
		for (const v of file) {
			violations.push(v);
		}
	}
	return violations;
}

/** Spawn vale, feed `text` on stdin, resolve with stdout. Rejects on error. */
function runVale(text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"vale",
			[
				"--no-global",
				`--config=${VALE_INI}`,
				"--output=JSON",
				"--no-wrap",
				"--ext=.md",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("vale timed out after 30s"));
		}, 30_000);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			// vale exits 0 (clean) or 1 (violations found); both produce valid JSON.
			// Anything else is a real failure (missing binary, bad config, …).
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

/** The vale command that reproduces the full violation list for a file. */
function valeCommandForFile(path: string): string {
	return `vale --no-global --config=${VALE_INI} --output=JSON --no-wrap --ext=.md ${path}`;
}

/** The vale command that lints text piped to stdin (for new-file writes). */
function valeCommandForStdin(): string {
	return `vale --no-global --config=${VALE_INI} --output=JSON --no-wrap --ext=.md`;
}

/** Format one violation for the block reason. */
function formatViolation(v: ValeViolation): string {
	return `- ${v.Check}: ${v.Message}`;
}

/** Build the block reason for a set of violations. */
function buildReason(violations: ValeViolation[], path: string, toolName: string): string {
	const shown = violations.slice(0, MAX_REPORTED);
	const lines = [
		"pi-noslop: blocked — the text you are about to write contains AI-slop prose.",
		"",
		`File: ${path}`,
		`Violations: ${violations.length}`,
		"",
		...shown.map(formatViolation),
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

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") {
			return undefined;
		}

		const input = event.input as {
			path?: string;
			edits?: Array<{ newText?: string }>;
			content?: string;
		};

		const path = input.path ?? "<unknown>";
		const texts: string[] = [];

		if (event.toolName === "edit" && Array.isArray(input.edits)) {
			input.edits.forEach((edit) => {
				if (typeof edit.newText === "string" && edit.newText.length > 0) {
					texts.push(edit.newText);
				}
			});
		} else if (event.toolName === "write" && typeof input.content === "string") {
			texts.push(input.content);
		}

		if (texts.length === 0) {
			return undefined;
		}

		let violations: ValeViolation[] = [];
		try {
			for (const text of texts) {
				violations = violations.concat(await lintText(text));
			}
		} catch (err) {
			// Fail closed: a broken gate must block, never pass.
			const detail = err instanceof Error ? err.message : String(err);
			return {
				block: true,
				reason:
					`pi-noslop: blocked — the slop gate could not run (fail-closed). ` +
					`${detail} ` +
					`Check that vale is installed and the vendored styles are present at ${VALE_DIR}.`,
			};
		}

		if (violations.length > 0) {
			return { block: true, reason: buildReason(violations, path, event.toolName) };
		}

		return undefined;
	});
}
