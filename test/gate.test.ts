/**
 * Unit tests for pi-noslop's gate: real vale runs against the vendored
 * styles, synthetic tool-call inputs, no model, no pi. Runs in well under
 * a second per test and is deterministic — this is the CI suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	gate,
	lintText,
	textsToLint,
	buildReason,
	parseValeOutput,
	valeArgs,
	valeCommandForFile,
	valeCommandForStdin,
	VALE_DIR,
} from "../src/gate.ts";

const SLOP = "In today's rapidly evolving landscape, we delve into the rich tapestry of things.\n";
const CLEAN = "The parser reads the schema's version from the header.\n";

// --- what gets linted ---

test("textsToLint: bash inputs are never selected", () => {
	assert.deepEqual(textsToLint("bash", { command: SLOP }), []);
});

test("textsToLint: edit selects every newText", () => {
	const texts = textsToLint("edit", {
		path: "doc.md",
		edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "" }],
	});
	assert.deepEqual(texts, ["b"]);
});

test("textsToLint: write selects the full content", () => {
	assert.deepEqual(textsToLint("write", { path: "n.md", content: SLOP }), [SLOP]);
});

// --- the gate ---

test("gate: lets a bash tool call through untouched", async () => {
	const decision = await gate("bash", { command: `printf '${SLOP}' > slop.txt` });
	assert.equal(decision, undefined);
});

test("gate passes a clean edit", async () => {
	const decision = await gate("edit", {
		path: "doc.md",
		edits: [{ oldText: "reads", newText: "loads" }],
	});
	assert.equal(decision, undefined);
});

test("gate passes a clean write", async () => {
	const decision = await gate("write", { path: "doc.md", content: CLEAN });
	assert.equal(decision, undefined);
});

test("gate blocks an edit whose newText contains slop", async () => {
	const decision = await gate("edit", {
		path: "doc.md",
		edits: [{ oldText: "reads", newText: "delves into the rich tapestry of things" }],
	});
	assert.ok(decision, "expected a block");
	assert.equal(decision.block, true);
	assert.match(decision.reason, /pi-noslop: blocked/);
	assert.match(decision.reason, /ai-tells\.OverusedVocabulary/);
});

test("gate blocks slop that is merely copied from the old text", async () => {
	// oldText contains the slop opening; the edit copies it verbatim.
	const decision = await gate("edit", {
		path: "doc.md",
		edits: [
			{
				oldText: "In today's rapidly evolving landscape, we must improve things.",
				newText: "In today's rapidly evolving landscape, we must ship faster.",
			},
		],
	});
	assert.ok(decision, "copied slop must still be blocked");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
});

test("gate blocks a write of new slop content", async () => {
	const decision = await gate("write", { path: "new.md", content: SLOP });
	assert.ok(decision, "expected a block");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
	assert.match(decision.reason, /ai-tells\.OverusedVocabulary/);
});

test("gate passes a .go write whose code has a clause-final semicolon", async () => {
	// The issue's repro: prose rules must not fire on Go code. Under the old
	// hardcoded --ext=.md, vale reads this as prose and flags the `; err` as
	// ai-tells.SemicolonUsage; as Go, tree-sitter lints comments only.
	const decision = await gate("write", {
		path: "main.go",
		content: "package main\n\nfunc main() {\n\tif err := run(); err != nil {\n\t\treturn err\n\t}\n}\n",
	});
	assert.equal(decision, undefined, "Go code must not be linted as Markdown prose");
});

test("gate blocks a .go write whose comment carries slop at the right line", async () => {
	const decision = await gate("write", {
		path: "main.go",
		content: "package main\n\n// In today's rapidly evolving landscape, we delve into the rich tapestry of things.\nfunc main() {}\n",
	});
	assert.ok(decision, "Go comment prose must still be blocked");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
	assert.match(decision.reason, /line 3/);
});

test("gate blocks a write to an extensionless path (NOTES-style)", async () => {
	const decision = await gate("write", {
		path: "NOTES",
		content: "In today's rapidly evolving landscape, we delve into the rich tapestry of things.\n",
	});
	assert.ok(decision, "extensionless targets must not silently pass");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
});

test("fenced code blocks in the written text are skipped", async () => {
	const decision = await gate("write", {
		path: "doc.md",
		content: "```go\nfunc delve() {\n\treturn \"In today's rapidly evolving world\"\n}\n```\n",
	});
	assert.equal(decision, undefined, "fenced code must not trip prose rules");
});

test("gate never blocks an edit that only deletes text", async () => {
	const decision = await gate("edit", {
		path: "doc.md",
		edits: [{ oldText: SLOP, newText: "" }],
	});
	assert.equal(decision, undefined, "a deletion writes no slop");
});

// --- the block reason ---

test("block reason names the rule, the match, and the vale command", async () => {
	const decision = await gate("edit", {
		path: "README.md",
		edits: [{ oldText: "x", newText: "In today's rapidly evolving world" }],
	});
	assert.ok(decision);
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
	assert.match(decision.reason, /In today's rapidly evolving/);
	assert.match(decision.reason, /Start with your actual point/);
	assert.match(decision.reason, /vale --no-global/);
	assert.match(decision.reason, /There is no bypass/);
});

test("edit guidance points at the file; write guidance points at stdin", async () => {
	const editDecision = await gate("edit", {
		path: "doc.md",
		edits: [{ oldText: "a", newText: "In today's rapidly evolving world" }],
	});
	assert.ok(editDecision);
	assert.match(editDecision.reason, /ext=\.md doc\.md/);

	const writeDecision = await gate("write", {
		path: "new.md",
		content: "In today's rapidly evolving world",
	});
	assert.ok(writeDecision);
	assert.match(writeDecision.reason, /pipe the content to stdin/);
});

// --- pure helpers ---

test("parseValeOutput flattens vale's per-file map", () => {
	const violations = parseValeOutput(JSON.stringify({
		"stdin.md": [{ Check: "ai-tells.X", Message: "m", Match: "delve", Line: 3 }],
	}));
	assert.equal(violations.length, 1);
	assert.equal(violations[0].Check, "ai-tells.X");
	assert.equal(violations[0].Line, 3);
});

test("buildReason caps the listed violations", () => {
	const many = Array.from({ length: 30 }, (_, i) => ({
		Check: `ai-tells.Rule${i}`,
		Message: "msg",
		Match: "m",
		Line: i + 1,
	}));
	const reason = buildReason(many, "f.md", "edit");
	assert.match(reason, /… and 10 more\./);
	assert.doesNotMatch(reason, /ai-tells\.Rule25/);
});

test("vale commands embed the vendored config path", () => {
	assert.match(valeCommandForFile("doc.md"), /ext=\.md doc\.md$/);
	assert.match(valeCommandForStdin(), /ext=\.md$/);
	assert.match(valeArgs().join(" "), /--no-global/);
	assert.ok(VALE_DIR.endsWith("vale"));
});

test("lintText surfaces vale guidance for a known rule", async () => {
	const result = await lintText("In today's rapidly evolving landscape.\n");
	assert.equal(result.error, undefined);
	const opening = result.violations.find((v) => v.Check === "ai-tells.OpeningCliches");
	assert.ok(opening);
	assert.match(opening.Message, /Start with your actual point/);
});

// --- fail-closed ---

test("fail-closed: an impossible vale binary blocks the call", async () => {
	const decision = await gate("write", { path: "x.md", content: CLEAN }, { valeBin: "vale-not-installed" });
	assert.ok(decision, "expected a fail-closed block");
	assert.match(decision.reason, /fail-closed/);
	assert.match(decision.reason, /vale could not run/);
});

test("fail-closed: a missing config blocks the call", async () => {
	const result = await lintText(CLEAN, { valeBin: "vale" });
	assert.equal(result.error, undefined, "sanity: the real setup must pass");
});