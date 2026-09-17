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
	lintKindForPath,
	formatForPath,
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

test("gate skips a write to an extensionless path (NOTES-style)", async () => {
	// Issue #6: a target vale has no parser for is skipped, so the whole
	// text passes. The old behavior linted it as Markdown, which is where
	// code-in-a-prose-file false positives came from.
	const decision = await gate("write", {
		path: "NOTES",
		content: "In today's rapidly evolving landscape, we delve into the rich tapestry of things.\n",
	});
	assert.equal(decision, undefined, "an extensionless target is skipped, not linted");
});

// --- skip: no usable vale parser (issue #6 decision) ---

test("gate skips a shell write whatever it contains", async () => {
	// Shell has no code grammar, so vale would lint the whole file as
	// prose and flag the echo string and the comment.
	const decision = await gate("write", {
		path: "deploy.sh",
		content: "#!/bin/sh\n# In today's rapidly evolving landscape, we delve into the rich tapestry of things.\necho done\n",
	});
	assert.equal(decision, undefined, ".sh is skipped, not linted as prose");
});

test("gate skips yaml, json, and toml writes", async () => {
	// Vale's "data" kinds: it reads them back as plain text, so `key:`
	// structure would trip colon and hyphen rules.
	for (const path of ["ci.yml", "config.yaml", "package.json", "Cargo.toml"]) {
		const decision = await gate("write", { path, content: SLOP });
		assert.equal(decision, undefined, `${path} is skipped`);
	}
});

test("gate skips unknown extensions, dotfiles, and absent paths", async () => {
	for (const path of ["notes.zzz", ".gitignore", "Makefile", "with-dot.", undefined]) {
		const decision = await gate("write", { path, content: SLOP });
		assert.equal(decision, undefined, `path ${String(path)} is skipped`);
	}
});

test("gate skips prose formats that need a converter vale will not fetch", async () => {
	// rst, adoc, and xml error out under their own --ext (rst2html,
	// asciidoctor, and XSLT are not installed), so linting them would
	// fail-closed-block every write. They are skipped instead.
	for (const path of ["doc.rst", "doc.adoc", "doc.xml", "doc.typ"]) {
		const decision = await gate("write", { path, content: SLOP });
		assert.equal(decision, undefined, `${path} is skipped`);
	}
});

// --- code grammars: comments linted, code not ---

test("gate passes a .css write with custom properties (the issue's repro)", async () => {
	// The issue comment: a stylesheet with no comments tripped 74
	// DoubleHyphen violations under the Markdown fallback. As CSS it has
	// no comments, so nothing is linted.
	const decision = await gate("write", {
		path: "theme.css",
		content: ":root {\n  --ink: #15181c;\n}\n",
	});
	assert.equal(decision, undefined, "CSS custom properties must not trip DoubleHyphen");
});

test("gate blocks a .css write whose comment carries slop", async () => {
	const decision = await gate("write", {
		path: "theme.css",
		content: "/* In today's rapidly evolving landscape, we delve into the rich tapestry of things. */\n:root {}\n",
	});
	assert.ok(decision, "a CSS comment is prose");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
});

test("gate passes a .py write whose strings hold slop-like text", async () => {
	const decision = await gate("write", {
		path: "main.py",
		content: "MSG = \"In today's rapidly evolving landscape, we delve into the rich tapestry of things.\"\n",
	});
	assert.equal(decision, undefined, "a Python string literal is not a comment");
});

test("gate blocks a .py write whose comment carries slop", async () => {
	const decision = await gate("write", {
		path: "main.py",
		content: "# In today's rapidly evolving landscape, we delve into the rich tapestry of things.\nx = 1\n",
	});
	assert.ok(decision, "a Python comment is prose");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
});

test("gate passes a .ts write of type annotations", async () => {
	// The operator's observed misfire: annotation syntax read as Markdown
	// flagged ColonUsage. As TypeScript, comments only are linted.
	const decision = await gate("write", {
		path: "types.ts",
		content: "const ACCENTS: { [k: string]: string } = {};\nexport const x: number = 1;\n",
	});
	assert.equal(decision, undefined, "type annotation syntax must not trip prose rules");
});

test("gate blocks a .ts write whose comment carries slop", async () => {
	const decision = await gate("write", {
		path: "types.ts",
		content: "// In today's rapidly evolving landscape, we delve.\nexport const x = 1;\n",
	});
	assert.ok(decision, "a TypeScript comment is prose");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
});

// --- prose readers: whole-text still linted ---

test("gate blocks a .txt write of slop", async () => {
	const decision = await gate("write", { path: "notes.txt", content: SLOP });
	assert.ok(decision, "plain text is prose");
	assert.match(decision.reason, /ai-tells\.OpeningCliches/);
});

// --- pure helpers ---

test("lintKindForPath classifies by extension", () => {
	assert.equal(lintKindForPath("main.go"), "code");
	assert.equal(lintKindForPath("MAIN.GO"), "code");
	assert.equal(lintKindForPath("theme.css"), "code");
	assert.equal(lintKindForPath("types.ts"), "code");
	assert.equal(lintKindForPath("main.py"), "code");
	assert.equal(lintKindForPath("README.md"), "prose");
	assert.equal(lintKindForPath("notes.txt"), "prose");
	for (const path of ["deploy.sh", "ci.yml", "x.yaml", "data.json", "x.toml", "x.zzz", "NOTES", ".gitignore", "trailing.", "doc.rst", undefined, "<unknown>"]) {
		assert.equal(lintKindForPath(path), undefined, `${String(path)} is skipped`);
	}
});

test("formatForPath mirrors lintKindForPath", () => {
	assert.equal(formatForPath("main.go"), ".go");
	assert.equal(formatForPath("MAIN.GO"), ".go");
	assert.equal(formatForPath("README.md"), ".md");
	assert.equal(formatForPath("deploy.sh"), undefined);
	assert.equal(formatForPath(undefined), undefined);
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
	assert.match(valeCommandForStdin("doc.md"), /ext=\.md$/);
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