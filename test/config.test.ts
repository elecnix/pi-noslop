/**
 * Which rule set judges the text: the edited repo's own, or the vendored
 * default. Every fixture here is a throwaway directory under the OS temp
 * dir, so the suite needs no network and no model — only the vale binary.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
	resolveValeConfig,
	resolveValeConfigForDir,
	clearConfigCache,
	configLabel,
	VENDORED_CONFIG,
	VALE_INI,
} from "../src/config.ts";
import { gate, lintText } from "../src/gate.ts";

const made: string[] = [];

afterEach(() => {
	clearConfigCache();
	for (const dir of made.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A throwaway directory that looks like a git repo.
 *
 * `realpathSync` because the resolver reports real paths and the OS temp dir
 * is itself a symlink on macOS (`/var` -> `/private/var`). Without it every
 * path assertion below compares two spellings of the same directory.
 */
function makeRepo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "noslop-")));
	made.push(dir);
	mkdirSync(join(dir, ".git"));
	return dir;
}

/** Give `repo` a working rule set whose only rule bans one token. */
function withRuleBanning(repo: string, token: string): void {
	mkdirSync(join(repo, "styles", "house"), { recursive: true });
	writeFileSync(
		join(repo, "styles", "house", "NoToken.yml"),
		`extends: existence\nmessage: "House rule: avoid '${token}'."\nlevel: error\ntokens:\n  - ${token}\n`,
	);
	writeFileSync(
		join(repo, ".vale.ini"),
		"StylesPath = styles\nMinAlertLevel = error\n\n[*]\nBasedOnStyles = house\n",
	);
}

// The same two sentences, judged by two rule sets. Each is clean under one
// and blocked under the other.
const HOUSE_SLOP = "The parser reads foo from the header.\n";
const VENDORED_SLOP = "We delve into the rich tapestry of things.\n";

// --- resolution ---

test("a repo's own .vale.ini wins over the vendored default", () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const config = resolveValeConfig(join(repo, "docs", "guide.md"));
	assert.equal(config.source, "project");
	assert.equal(config.configPath, join(repo, ".vale.ini"));
});

test("the walk starts at the edited file and climbs to the repo root", () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	mkdirSync(join(repo, "a", "b", "c"), { recursive: true });
	const config = resolveValeConfig(join(repo, "a", "b", "c", "deep.md"));
	assert.equal(config.configPath, join(repo, ".vale.ini"));
});

test("a repo with no rules falls back to the vendored default", () => {
	const repo = makeRepo();
	const config = resolveValeConfig(join(repo, "README.md"));
	assert.equal(config.source, "vendored");
	assert.equal(config.configPath, VALE_INI);
});

test("the walk stops at the repo root and ignores a .vale.ini above it", () => {
	const outer = realpathSync(mkdtempSync(join(tmpdir(), "noslop-outer-")));
	made.push(outer);
	writeFileSync(join(outer, ".vale.ini"), "StylesPath = styles\n");
	const repo = join(outer, "inner");
	mkdirSync(join(repo, ".git"), { recursive: true });
	const config = resolveValeConfig(join(repo, "README.md"));
	assert.equal(config.source, "vendored");
});

test("a personal ~/.vale.ini never decides the verdict", () => {
	// Same hole `--no-global` closes: one developer's home config must not
	// change what the gate accepts.
	const config = resolveValeConfig(join(homedir(), "scratch.md"));
	assert.notEqual(config.configPath, join(homedir(), ".vale.ini"));
	assert.equal(config.source, "vendored");
});

test("the resolved config is cached, so the tree is walked once per repo", () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const first = resolveValeConfig(join(repo, "README.md"));
	rmSync(join(repo, ".vale.ini"));
	const second = resolveValeConfig(join(repo, "README.md"));
	assert.equal(second.configPath, first.configPath);
	clearConfigCache();
	assert.equal(resolveValeConfig(join(repo, "README.md")).source, "vendored");
});

test("one walk caches every directory it climbed through", () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	mkdirSync(join(repo, "a", "b"), { recursive: true });
	resolveValeConfig(join(repo, "a", "b", "deep.md"));
	rmSync(join(repo, ".vale.ini"));
	// `repo/a` was on the first walk, so it answers from the cache.
	assert.equal(resolveValeConfig(join(repo, "a", "x.md")).source, "project");
});

// --- the same text, two verdicts ---

test("the repo's rules block text the vendored pack allows", async () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const decision = await gate("write", { path: join(repo, "doc.md"), content: HOUSE_SLOP });
	assert.ok(decision, "expected the house rule to block");
	assert.match(decision.reason, /house\.NoToken/);
});

test("the vendored pack allows the very same text elsewhere", async () => {
	const plain = makeRepo();
	const decision = await gate("write", { path: join(plain, "doc.md"), content: HOUSE_SLOP });
	assert.equal(decision, undefined);
});

test("the vendored pack blocks text the repo's rules allow", async () => {
	const plain = makeRepo();
	const decision = await gate("write", { path: join(plain, "doc.md"), content: VENDORED_SLOP });
	assert.ok(decision, "expected the vendored pack to block");
	assert.match(decision.reason, /ai-tells\./);
});

test("a repo with its own rules is judged only by them", async () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const decision = await gate("write", { path: join(repo, "doc.md"), content: VENDORED_SLOP });
	assert.equal(decision, undefined, "the repo's rules say nothing about 'delve'");
});

test("an edit inside a repo with rules is judged by that repo's rules", async () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const decision = await gate("edit", {
		path: join(repo, "docs", "guide.md"),
		edits: [{ oldText: "x", newText: HOUSE_SLOP }],
	});
	assert.ok(decision);
	assert.match(decision.reason, /house\.NoToken/);
});

// --- fail-closed on a repo whose rules cannot load ---

test("rules that cannot load block the edit and name the problem", async () => {
	const repo = makeRepo();
	// A repo that pins its rules upstream and gitignores them: a fresh clone
	// has the config and none of the styles.
	writeFileSync(
		join(repo, ".vale.ini"),
		"StylesPath = styles\nMinAlertLevel = error\nPackages = https://example.invalid/pack.zip\n\n[*]\nBasedOnStyles = pack\n",
	);
	const decision = await gate("write", { path: join(repo, "doc.md"), content: "Plain text.\n" });
	assert.ok(decision, "expected a fail-closed block");
	assert.match(decision.reason, /fail-closed/);
	assert.match(decision.reason, /does not exist/);
	assert.match(decision.reason, /vale sync/);
});

test("a broken config blocks rather than falling back to the vendored pack", async () => {
	const repo = makeRepo();
	writeFileSync(join(repo, ".vale.ini"), "this is not an ini {{{\n");
	const decision = await gate("write", { path: join(repo, "doc.md"), content: "Plain text.\n" });
	assert.ok(decision, "expected a fail-closed block");
	assert.match(decision.reason, /fail-closed/);
	assert.match(decision.reason, new RegExp(join(repo, "\\.vale\\.ini").replace(/\//g, "\\/")));
});

// --- the verdict always names its rule set ---

test("a block reason names the rule set that produced the verdict", async () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const decision = await gate("write", { path: join(repo, "doc.md"), content: HOUSE_SLOP });
	assert.ok(decision);
	assert.match(decision.reason, /Rules:/);
	assert.match(decision.reason, new RegExp(join(repo, "\\.vale\\.ini").replace(/\//g, "\\/")));
	assert.match(decision.reason, /project/);
});

test("a vendored-default verdict says so too", async () => {
	const plain = makeRepo();
	const decision = await gate("write", { path: join(plain, "doc.md"), content: VENDORED_SLOP });
	assert.ok(decision);
	assert.match(decision.reason, /Rules:/);
	assert.match(decision.reason, /vendored/);
});

test("a fail-closed reason names the rule set too", async () => {
	const decision = await gate("write", { path: "x.md", content: "Plain text.\n" }, {
		valeBin: "vale-not-installed",
	});
	assert.ok(decision);
	assert.match(decision.reason, /vendored/);
});

test("the reproduce command carries the resolved config, not the vendored one", async () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const decision = await gate("edit", {
		path: join(repo, "doc.md"),
		edits: [{ oldText: "x", newText: HOUSE_SLOP }],
	});
	assert.ok(decision);
	assert.match(decision.reason, new RegExp(`--config=${join(repo, "\\.vale\\.ini").replace(/\//g, "\\/")}`));
	assert.match(decision.reason, /--no-global/);
});

// --- labels ---

test("configLabel distinguishes the two sources", () => {
	assert.match(configLabel(VENDORED_CONFIG), /vendored/);
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	assert.match(configLabel(resolveValeConfig(join(repo, "d.md"))), /project/);
});

test("lintText honours an explicit config", async () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const config = resolveValeConfig(join(repo, "d.md"));
	const result = await lintText(HOUSE_SLOP, { config });
	assert.equal(result.error, undefined);
	assert.equal(result.violations.length, 1);
	assert.equal(result.violations[0].Check, "house.NoToken");
});

test("a call with no path is judged by the rules governing pi's cwd", () => {
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const config = resolveValeConfigForDir(repo);
	assert.equal(config.configPath, join(repo, ".vale.ini"));
	// The file-path form of the same directory must not climb one too far.
	assert.equal(resolveValeConfig(join(repo, "any.md")).configPath, config.configPath);
});

test("a new file in a directory that does not exist yet still resolves", async () => {
	// Agents write into directories they are about to create. The walk has to
	// climb past the missing directory rather than give up on it.
	const repo = makeRepo();
	withRuleBanning(repo, "foo");
	const config = resolveValeConfig(join(repo, "not", "yet", "there.md"));
	assert.equal(config.configPath, join(repo, ".vale.ini"));
	const decision = await gate("write", {
		path: join(repo, "not", "yet", "there.md"),
		content: HOUSE_SLOP,
	});
	assert.ok(decision, "expected the repo's rule to block");
	assert.match(decision.reason, /house\.NoToken/);
});
