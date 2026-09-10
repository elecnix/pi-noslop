# pi-noslop

A fail-closed pi extension that **blocks `edit` and `write` tool calls whose text contains AI-slop prose**. It lints the text the agent is about to write with the [vale-ai-tells](https://github.com/tbhb/vale-ai-tells) ruleset (vendored, MIT) and refuses the call with a loud, precise reason.

No break-glass. No bypass. Bash is untouched.

## Why

Coding agents write prose: READMEs, commit messages, PR descriptions, docs, comments. Left to their own devices they reach for "In today's rapidly evolving landscape", "delve into the rich tapestry", "it's not just X, it's Y", and the rest of the AI-tell canon. pi-noslop makes that impossible through the tools that write files.

## How it works

Every `edit` and `write` tool call is intercepted before execution:

1. The **new text** is extracted — each `edits[i].newText` for edits, `content` for writes.
2. It is piped to the vendored `vale` binary (`vale/styles/ai-tells`, 132 rules, all `level: error`) with `--ext=.md`, so **any file type** gets the same prose rules. Fenced code blocks and inline code spans are skipped by Vale's Markdown parser, so code identifiers that match slop tokens don't false-positive.
3. Any violation → the tool call is **blocked** with a reason naming the rule, the vale guidance, and the exact vale command to reproduce the full list.
4. If vale is missing, the styles are missing, or vale errors — the call is **blocked anyway** (fail-closed). A broken gate never silently passes slop.

### What gets linted

- `edit` — each `newText`, individually. If the old text contained slop and the edit merely copies it, the copy is still blocked. Pre-existing slop elsewhere in the file does not block unrelated edits.
- `write` — the full `content`.
- `bash` — never gated. The gate is on the file-writing tools, not the shell.

### The block reason

```
pi-noslop: blocked — the text you are about to write contains AI-slop prose.

File: README.md
Violations: 2

- ai-tells.OpeningCliches: AI opening: 'In today's rapidly evolving'. Start with your actual point instead of this generic lead-in.
- ai-tells.OverusedVocabulary: AI vocabulary: 'delve'. Replace with a more specific or common word.

To see every violation at once, run:
  vale --no-global --config=/path/to/vale/.vale.ini --output=JSON --no-wrap --ext=.md README.md

Fix the flagged prose and re-issue the edit. There is no bypass.
```

## Install

```bash
pi install git:github.com/elecnix/pi-noslop
```

Requires the `vale` binary on `PATH` (the extension shells out to it). The styles are vendored in the package — no network, no `vale sync`.

```bash
brew install vale
```

## Test

```bash
npm test          # 21 gate tests: real vale runs, synthetic tool inputs, no model — CI-safe, < 1s
```

The suite drives `gate()` directly with synthetic `edit`/`write`/`bash` inputs, so it needs no model, no API key, and no network — only the `vale` binary. The real-harness behavior (a live `pi -p` session whose write is blocked with the full reason) was verified during development; wire it into CI only with a model available.

```bash
pi -p -e ./index.ts "Use the write tool to create x.md with content: In today's rapidly evolving landscape, we delve into the rich tapestry of things."
# → pi-noslop blocks the write; x.md is not created; the model reports the four rules.
```

## Design decisions

| Decision | Why |
|---|---|
| Lint new text only, not the whole file | The spec: "fails edits that write ANY slop, even if the old text contained slop and is merely copied". Whole-file linting would block unrelated edits in a file that already has slop. |
| `--ext=.md` on stdin | Any file type gets the same prose rules; Vale's Markdown parser skips fenced/inline code. |
| Fail closed | A missing vale or styles must block, never pass. |
| No break-glass | No flag, env var, or config disables the gate — the binary and config are hardcoded. |
| Bash untouched | The gate is on file-writing tools. |

## License

MIT. The vendored ruleset is [vale-ai-tells](https://github.com/tbhb/vale-ai-tells) (MIT, © Tony Burns), vendored at v1.34.0 — see `vale/LICENSE.vale-ai-tells`.
