/**
 * pi-noslop — fail-closed AI-slop gate for pi's edit and write tools.
 *
 * Every `edit` and `write` tool call is linted BEFORE the tool executes,
 * with the rules of the repo the file lands in when that repo declares
 * any, and with the vendored vale-ai-tells ruleset otherwise.
 * If the text the agent is about to write contains any slop, the tool call
 * is blocked with a loud, precise reason: the rule that broke, the vale
 * guidance, and the exact vale command to run for the full violation list.
 *
 * All logic lives in src/gate.ts and src/config.ts (pure, unit-testable
 * in milliseconds). This file is the thin pi wiring.
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
 * 3. The edited repo's rules win. Resolution walks up from the edited file
 *    to the nearest `.vale.ini`, stopping at the repository root, and
 *    falls back to the vendored pack only when the repo declares nothing.
 *    `$HOME` is skipped, so a personal `~/.vale.ini` cannot decide a
 *    verdict. The resolved config is cached per repo.
 * 4. Fail closed. If vale is missing, the styles are missing, or vale
 *    errors out, the tool call is BLOCKED — a broken gate must never
 *    silently let slop through. A repo whose declared rules cannot load
 *    blocks too; it never downgrades to the vendored pack.
 * 5. No break-glass. There is no flag, env var, or config to disable the
 *    gate. The only way to write slop is to not write slop.
 * 6. Bash is untouched. Only `edit` and `write` are gated.
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
