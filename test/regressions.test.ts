/**
 * Regressions the rest of the suite hides.
 *
 * Every fixture elsewhere writes a one-line payload into a repo whose rules
 * load, so three of the four cases below never arise there. Each test states
 * the real-world shape it stands for.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveValeConfig, clearConfigCache } from "../src/config.ts";
import { gate } from "../src/gate.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const made: string[] = [];
const realHome = process.env.HOME;

afterEach(() => {
	clearConfigCache();
	if (realHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = realHome;
	}
	for (const dir of made.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeDir(prefix: string): string {
	// Real path: the resolver reports real paths, and the OS temp dir is a
	// symlink on macOS.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
}

/** A repo that pins its rules upstream and has never been synced. */
function makeUnsyncedRepo(): string {
	const dir = makeDir("noslop-unsynced-");
	mkdirSync(join(dir, ".git"));
	writeFileSync(
		join(dir, ".vale.ini"),
		"StylesPath = styles\nMinAlertLevel = error\nPackages = https://example.invalid/p.zip\n\n[*]\nBasedOnStyles = pack\n",
	);
	return dir;
}

// --- 1. vale exiting before it drains stdin ---

test("a repo whose rules cannot load blocks a large write instead of crashing", async () => {
	// Vale exits 2 the moment it cannot load the config, long before it reads
	// stdin. Anything past the OS pipe buffer — roughly 64 KB, which is an
	// ordinary README — then hits a closed pipe. An unhandled EPIPE takes the
	// whole pi process down, so the call gets no verdict at all: not allowed,
	// not blocked, just gone.
	const repo = makeUnsyncedRepo();
	const big = "The parser reads the schema version from the header.\n".repeat(1400);
	assert.ok(big.length > 64 * 1024, "the payload has to exceed the pipe buffer");

	const decision = await gate("write", { path: join(repo, "README.md"), content: big });
	assert.ok(decision, "expected a fail-closed block, not a crash");
	assert.match(decision.reason, /fail-closed/);
});

test("a missing vale binary blocks a large write too", async () => {
	const big = "The parser reads the schema version from the header.\n".repeat(1400);
	const decision = await gate(
		"write",
		{ path: join(makeDir("noslop-plain-"), "README.md"), content: big },
		{ valeBin: "vale-not-installed" },
	);
	assert.ok(decision);
	assert.match(decision.reason, /fail-closed/);
});

// --- 2. the $HOME guard ---

test("a trailing slash in $HOME does not let the personal config decide", () => {
	const home = makeDir("noslop-home-");
	mkdirSync(join(home, "proj"));
	writeFileSync(join(home, ".vale.ini"), "StylesPath = styles\n");
	process.env.HOME = `${home}/`;
	assert.equal(resolveValeConfig(join(home, "proj", "a.md")).source, "vendored");
});

test("a symlinked $HOME does not let the personal config decide", () => {
	// The common shape on Linux and in containers.
	const parent = makeDir("noslop-homelink-");
	const home = join(parent, "h");
	mkdirSync(join(home, "proj"), { recursive: true });
	writeFileSync(join(home, ".vale.ini"), "StylesPath = styles\n");
	symlinkSync(home, join(parent, "hlink"));
	process.env.HOME = join(parent, "hlink");
	assert.equal(resolveValeConfig(join(home, "proj", "a.md")).source, "vendored");
});

// --- 3. symlinked edit paths ---

test("a symlinked path is judged by the repo the file really lives in", () => {
	// `resolve()` normalizes `..` but not symlinks, so a logical walk climbs
	// out of the repo entirely: it never meets the `.git` that is supposed to
	// stop it, and a config outside the repo wins.
	const parent = makeDir("noslop-symlink-");
	const repo = join(parent, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "sub"));
	writeFileSync(join(repo, ".vale.ini"), "StylesPath = styles\n");

	const outside = join(parent, "elsewhere");
	mkdirSync(outside);
	writeFileSync(join(outside, ".vale.ini"), "StylesPath = other\n");
	symlinkSync(join(repo, "sub"), join(outside, "link"));

	const direct = resolveValeConfig(join(repo, "sub", "a.md"));
	const viaLink = resolveValeConfig(join(outside, "link", "a.md"));
	assert.equal(direct.configPath, join(repo, ".vale.ini"));
	assert.equal(viaLink.configPath, direct.configPath, "the same file, one rule set");
});

// --- 4. the scrub reporting clean when grep never ran ---

test("the scrub fails loudly when its pattern is malformed", () => {
	// A scrub that passes because grep errored is the failure the script's own
	// header calls worse than no scrub at all.
	let status = 0;
	let output = "";
	try {
		output = execFileSync("./tools/scrub.sh", {
			cwd: REPO,
			env: { ...process.env, SCRUB_PATTERN: "foo(bar" },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const e = err as { status?: number; stdout?: string };
		status = e.status ?? -1;
		output = e.stdout ?? "";
	}
	assert.notEqual(status, 0, "a pattern grep cannot compile must not report clean");
	assert.doesNotMatch(output, /scrub: clean\./);
});
