/**
 * Block-logic tests for pi-noslop.
 *
 * These load the extension into a real pi process (print mode, local
 * ollama model) and drive it with prompts that force edit/write tool
 * calls, then assert on the tool_execution_end events in JSON mode.
 *
 * They are the "tested locally with pi -p" requirement: every scenario
 * runs through the actual extension code path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(import.meta.dirname, "..");
const EXTENSION = join(REPO_ROOT, "index.ts");

const MODEL = process.env.PI_NOSLOP_E2E_MODEL ?? "qwen3.8:27b-mlx";
const PROVIDER = process.env.PI_NOSLOP_E2E_PROVIDER ?? "ollama";

interface ToolEvent {
	type: string;
	toolName?: string;
	result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

/** Run pi in JSON mode with the extension loaded; return tool events. */
async function runPi(prompt: string, cwd: string): Promise<ToolEvent[]> {
	const { stdout } = await execFileAsync(
		"pi",
		[
			"--mode", "json",
			"--provider", PROVIDER,
			"--model", MODEL,
			"-e", EXTENSION,
			"-p", prompt,
		],
		{ cwd, timeout: 300_000, maxBuffer: 20 * 1024 * 1024 },
	);
	const events: ToolEvent[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const ev = JSON.parse(line);
			if (ev.type === "tool_execution_end") events.push(ev);
		} catch {
			// ignore non-JSON lines
		}
	}
	return events;
}

function toolResultText(ev: ToolEvent): string {
	return ev.result?.content?.map((c) => c.text ?? "").join("") ?? "";
}

test("edit writing slop is blocked with the precise rule", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-noslop-"));
	await writeFile(join(dir, "doc.md"), "The router reads the tenant's routing from the Config API.\n");
	try {
		const events = await runPi(
			"Use the edit tool on doc.md to replace 'reads the tenant' with 'delves into the rich tapestry of the tenant'.",
			dir,
		);
		const edit = events.find((e) => e.toolName === "edit");
		assert.ok(edit, "expected an edit tool call");
		assert.equal(edit.result?.isError, true, "edit must be blocked");
		const text = toolResultText(edit);
		assert.match(text, /pi-noslop: blocked/);
		assert.match(text, /ai-tells\.OverusedVocabulary/);
		assert.match(text, /delve/);
		// The file must be unchanged.
		const content = await readFile(join(dir, "doc.md"), "utf8");
		assert.equal(content, "The router reads the tenant's routing from the Config API.\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit copying slop from old text is blocked", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-noslop-"));
	// The old text already contains the slop opening; the edit must copy it
	// into newText to make its change, so the edit "merely copies" slop.
	await writeFile(join(dir, "doc.md"), "In today's rapidly evolving landscape, we must improve things.\n");
	try {
		const events = await runPi(
			"Use the edit tool on doc.md: replace the entire line with exactly: In today's rapidly evolving landscape, we must ship faster. Keep the opening phrase unchanged.",
			dir,
		);
		const edit = events.find((e) => e.toolName === "edit");
		assert.ok(edit, "expected an edit tool call");
		assert.equal(edit.result?.isError, true, "edit must be blocked even when copying slop");
		const text = toolResultText(edit);
		assert.match(text, /pi-noslop: blocked/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("write of a new slop file is blocked", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-noslop-"));
	try {
		const events = await runPi(
			"Use the write tool to create new.md with content: In today's rapidly evolving landscape, we delve into the rich tapestry of things.",
			dir,
		);
		const write = events.find((e) => e.toolName === "write");
		assert.ok(write, "expected a write tool call");
		assert.equal(write.result?.isError, true, "write must be blocked");
		const text = toolResultText(write);
		assert.match(text, /pi-noslop: blocked/);
		assert.match(text, /ai-tells\.OpeningCliches/);
		// The file must not exist.
		await assert.rejects(readFile(join(dir, "new.md"), "utf8"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("clean edit passes and lands", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-noslop-"));
	await writeFile(join(dir, "doc.md"), "The router reads the tenant's routing from the Config API.\n");
	try {
		const events = await runPi(
			"Use the edit tool on doc.md to replace 'reads the tenant' with 'loads the tenant'.",
			dir,
		);
		const edit = events.find((e) => e.toolName === "edit");
		assert.ok(edit, "expected an edit tool call");
		assert.notEqual(edit.result?.isError, true, "clean edit must not be blocked");
		const content = await readFile(join(dir, "doc.md"), "utf8");
		assert.match(content, /loads the tenant/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("bash tool calls are not gated", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-noslop-"));
	try {
		const events = await runPi(
			"Use the bash tool to run: printf 'In today's rapidly evolving landscape\\n' > bash-slop.txt",
			dir,
		);
		const bash = events.find((e) => e.toolName === "bash");
		assert.ok(bash, "expected a bash tool call");
		assert.notEqual(bash.result?.isError, true, "bash must not be gated");
		const content = await readFile(join(dir, "bash-slop.txt"), "utf8");
		assert.match(content, /rapidly evolving/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
