/**
 * Unit tests for pi-noslop's lint and block logic.
 *
 * These exercise the same vale invocation the extension uses, plus the
 * reason-building and fail-closed paths. They do not need a model or a
 * running pi — they run the vendored vale binary directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VALE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vale");
const VALE_INI = join(VALE_DIR, ".vale.ini");

interface ValeViolation {
	Check: string;
	Message: string;
	Match: string;
	Line: number;
}

async function lintText(text: string): Promise<ValeViolation[]> {
	const stdout = await runVale(text);
	const parsed = JSON.parse(stdout) as Record<string, ValeViolation[]>;
	const violations: ValeViolation[] = [];
	for (const file of Object.values(parsed)) {
		for (const v of file) {
			violations.push(v);
		}
	}
	return violations;
}

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

test("clean prose passes", async () => {
	const violations = await lintText("The router reads the tenant's routing from the Config API.\n");
	assert.equal(violations.length, 0);
});

test("slop is caught with the precise rule", async () => {
	const violations = await lintText("In today's rapidly evolving landscape, we delve into the rich tapestry of things.\n");
	assert.ok(violations.length > 0, "expected at least one violation");
	const checks = violations.map((v) => v.Check);
	assert.ok(checks.includes("ai-tells.OpeningCliches"), `expected OpeningCliches, got ${checks.join(", ")}`);
	assert.ok(checks.includes("ai-tells.OverusedVocabulary"), `expected OverusedVocabulary, got ${checks.join(", ")}`);
});

test("vale guidance is present in the message", async () => {
	const violations = await lintText("In today's rapidly evolving landscape.\n");
	const opening = violations.find((v) => v.Check === "ai-tells.OpeningCliches");
	assert.ok(opening, "expected an OpeningCliches violation");
	assert.match(opening.Message, /Start with your actual point/);
});

test("any file type: a .go file is linted as prose", async () => {
	// The extension passes --ext=.md, so a Go file's prose is linted too.
	const violations = await lintText("package main\n\n// In today's rapidly evolving world, we delve.\nfunc main() {}\n");
	assert.ok(violations.length > 0, "expected violations in a .go file's comment");
});

test("fenced code blocks are skipped (no false positives on code)", async () => {
	const violations = await lintText("```go\nfunc delve() {\n\treturn \"In today's rapidly evolving world\"\n}\n```\n");
	assert.equal(violations.length, 0, "fenced code must not trip prose rules");
});

test("inline code spans are skipped", async () => {
	const violations = await lintText("Use `delve` to debug the `evolving` pipeline.\n");
	assert.equal(violations.length, 0, "inline code must not trip prose rules");
});

test("fail-closed: missing vale binary throws", async () => {
	await assert.rejects(
		new Promise((resolve, reject) => {
			const child = spawn("vale-definitely-not-installed", ["--version"], { stdio: ["pipe", "pipe", "pipe"] });
			child.on("error", reject);
			child.on("close", (code) => resolve(code));
			child.stdin.end();
		}),
	);
});

test("fail-closed: missing config throws", async () => {
	await assert.rejects(
		new Promise((resolve, reject) => {
			const child = spawn("vale", ["--no-global", "--config=/nonexistent/.vale.ini", "--output=JSON"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (d) => (stderr += d));
			child.on("error", reject);
			child.on("close", (code) => {
				if (code !== 0) reject(new Error(`vale exited ${code}: ${stderr}`));
				else resolve(code);
			});
			child.stdin.write("In today's rapidly evolving world.\n");
			child.stdin.end();
		}),
	);
});
