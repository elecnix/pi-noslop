/**
 * pi-noslop — fail-closed AI-slop gate for pi's edit and write tools.
 *
 * Every `edit` and `write` tool call is linted with the vendored
 * vale-ai-tells ruleset (vale/styles/ai-tells) BEFORE the tool executes.
 * If the text the agent is about to write contains any slop, the tool call
 * is blocked with a loud, precise reason: the rule that broke, the vale
 * guidance, and the exact vale command to run for the full violation list.
 *
 * All logic lives in src/gate.ts (pure, unit-testable in milliseconds).
 * This file is the thin pi wiring.
 *
 * Design decisions (all load-bearing):
 *
 * 1. Lint the NEW text only, never the whole resulting file. The spec is
 *    "fails edits that write ANY slop, even if the old text contained slop
 *    and is merely copied" — so each `edits[i].newText` is linted on its
 *    own. Pre-existing slop elsewhere in the file is out of scope and must
 *    not block unrelated edits.
 * 2. Any file type. Vale parses the text as Markdown via `--ext=.md` on
 *    stdin, so a `.go` file or a `Makefile` gets the same prose rules as a
 *    README. Fenced code blocks and inline code spans are skipped by
 *    Vale's Markdown parser, so code identifiers that match slop tokens do
 *    not false-positive.
 * 3. Fail closed. If vale is missing, the vendored styles are missing, or
 *    vale errors out, the tool call is BLOCKED — a broken gate must never
 *    silently let slop through.
 * 4. No break-glass. There is no flag, env var, or config to disable the
 *    gate. The only way to write slop is to not write slop.
 * 5. Bash is untouched. Only `edit` and `write` are gated.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gate } from "./src/gate.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const decision = await gate(event.toolName, event.input as never);
		if (decision) {
			return decision;
		}
		return undefined;
	});
}
