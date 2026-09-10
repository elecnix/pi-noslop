/**
 * End-to-end tests: real `pi -p` sessions with the extension loaded.
 *
 * These are the slowest tests (each spawns a full pi process and a model
 * call) and are opt-in via `npm run test:e2e`. They assert on the final
 * printed output of `pi -p`, which is what a human would see.
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

async function runPiPrint(prompt: string, cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"pi",
		["-p", "--provider", PROVIDER, "--model", MODEL, "-e", EXTENSION, "-p", prompt],
		{ cwd, timeout: 300_000, maxBuffer: 20 * 1024 * 1024 },
	);
	return stdout;
}

test("pi -p: slop write is blocked and the reason is loud", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-noslop-e2e-"));
	try {
		const out = await runPiPrint(
			"Use the write tool to create slop.md with content: In today's rapidly evolving landscape, we delve into the rich tapestry of things.",
			dir,
		);
		assert.match(out, /pi-noslop: blocked/);
		assert.match(out, /ai-tells\.OpeningCliches/);
		assert.match(out, /vale --no-global/);
		await assert.rejects(readFile(join(dir, "slop.md"), "utf8"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pi -p: clean write passes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-noslop-e2e-"));
	try {
		const out = await runPiPrint(
			"Use the write tool to create clean.md with content: The router reads the tenant's routing from the Config API.",
			dir,
		);
		assert.doesNotMatch(out, /pi-noslop: blocked/);
		const content = await readFile(join(dir, "clean.md"), "utf8");
		assert.match(content, /Config API/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
