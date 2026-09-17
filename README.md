# pi-noslop

A fail-closed pi extension that **blocks `edit` and `write` tool calls whose text contains AI-slop prose**. It lints the text the agent is about to write and refuses the call with a loud, precise reason.

The rules come from the repo being edited when that repo has any. A project that already lints its own prose gets its own verdict, including its own vocabulary. Everywhere else falls back to the vendored [vale-ai-tells](https://github.com/tbhb/vale-ai-tells) ruleset (MIT).

No break-glass. No bypass. Bash is untouched.

## Why

Coding agents write prose: READMEs, commit messages, PR descriptions, docs, comments. Left to their own devices they reach for "In today's rapidly evolving landscape", "delve into the rich tapestry", "it's not just X, it's Y", and the rest of the AI-tell canon. pi-noslop makes that impossible through the tools that write files.

## How it works

Every `edit` and `write` tool call is intercepted before execution:

1. The **new text** is extracted: each `edits[i].newText` for edits, `content` for writes.
2. The **rule set is resolved** from the path being written (see below).
3. The text is piped to `vale`, whose `--ext` parse format is derived from the target path: a write to `main.go` is parsed as Go, so its comments are linted and its code is not; a write to `README.md` is parsed as Markdown. A target vale has no parser for is skipped: the gate does not run vale on it at all. See "What the gate skips". Fenced code blocks and inline code spans are skipped by Vale's Markdown parser, so prose documents don't false-positive on code identifiers.
4. Any violation and the tool call is **blocked**, with a reason that specifies the rule set, the rule, the vale guidance, and the exact vale command to reproduce the full list.
5. If vale is missing, the styles are missing, or vale errors, the call is **blocked anyway** (fail-closed). A broken gate never silently passes slop.

### What the gate skips

The parse format comes from the target path's extension. Vale 3.20 has a grammar or a reader for a fixed set of extensions; everything else is a third bucket. The gate behaves per bucket:

| Bucket | Examples | Behavior |
|---|---|---|
| Code grammars | `.go .py .js .ts .css .rb .rs` and 30+ more | Linted as code. Comments are prose, code is not. |
| Prose documents | `.md .markdown .txt .html .org` and the other native readers | Linted in full. The document is the prose. |
| Everything else | `.sh .yml .yaml .json .toml`, no extension, unknown extensions | **Skipped**. The gate does not run vale. |

Issue #6 recorded the decision for the third bucket: skip the file. The old behavior linted those targets whole-file as Markdown, which is where the false positives came from. A shell `echo "In today's rapidly evolving world"` or a yaml `key:` line made the prose rules fire on code.

Skipping weakens the fail-closed promise: slop in a skipped file passes without a verdict. That trade was accepted so the gate stops blocking code. Bash is still the place slop can always hide, and it stays untouched.

Three formats need a note of their own. Vale lists `rst`, `adoc`, `xml`, and `typ` as prose formats, but it reads them through external converters (`rst2html`, `asciidoctor`, XSLT, `typst2vast`). Without the converter, linting those files fails with a vale runtime error, so the gate blocked every write to them, fail-closed on a whole format rather than on slop. They are skipped too.

### Which rules apply

Resolution walks up from the edited file, the way Vale itself resolves config:

1. **The edited repo's own rules.** The nearest `.vale.ini` (or `_vale.ini`) at or above the file's directory.
2. **The vendored defaults**, when the climb ends at the repository root without finding one.

The walk has three guards:

- It **stops at the repository root**, so a stray config in a parent directory cannot alter the verdict for an unrelated checkout.
- It **skips `$HOME`**. A personal `~/.vale.ini` must never decide a gate verdict, and that is the hole `--no-global` closes. Reading the same file through `--config=` would reopen it, so `--no-global` is passed on every invocation.
- It walks **real paths**. A symlinked edit path would otherwise climb the logical tree and pass the `.git` boundary, picking up a config from outside the repo. A symlinked `$HOME`, the ordinary case in containers, defeats a string comparison against the home directory for the same reason. A verdict specifies the canonical path for both reasons.

The resolved config is **cached per directory**, and one walk fills the cache for every directory it climbed through, so a repo is walked once rather than on every keystroke. The cache lives for the pi session: adding a `.vale.ini` to a repo the session has already touched takes effect on the next session.

The block reason includes a `Rules:` line that says which rule set produced it:

```
Rules: /path/to/repo/.vale.ini (project)
Rules: /path/to/pi-noslop/vale/.vale.ini (vendored default)
```

### Unsynced repo rules

A repo may pin its rules upstream with a `Packages =` line and gitignore the fetched copy, so a fresh clone has the config and none of the styles. **pi-noslop blocks and its reason says to run `vale sync` yourself.** It does not fetch, and it does not fall back to the vendored pack.

Both halves of that are deliberate:

- **It never fetches.** This hook runs before every edit, and a pre-edit hook that touches the network stalls the agent on a slow DNS lookup. Syncing is a setup step, and it is the developer's to run.
- **It never falls back.** A repo that declares rules is judged by those rules or not at all. A silent fallback to the vendored pack would let a deleted styles directory swap in a weaker rule set while the edit still looked approved.

The block reason quotes vale's own diagnostic and states the exact command:

```
pi-noslop: blocked — the slop gate could not run (fail-closed). vale could not run:
E201 in .vale.ini: The path '/path/to/repo/styles' does not exist.
Rules: /path/to/repo/.vale.ini (project) This repo declares its own rules, so
pi-noslop blocks here instead of falling back to its vendored pack. If the rules
are pinned with a `Packages =` line they have to be fetched once:
cd /path/to/repo && vale sync. pi-noslop never fetches them for you — a hook that
runs before every edit stays off the network.
```

### What gets linted

- `edit`: each `newText`, individually. If the old text contained slop and the edit merely copies it, the copy is still blocked. Pre-existing slop elsewhere in the file does not block unrelated edits.
- `write`: the full `content`.
- `bash`: never gated. The gate is on the file-writing tools, not the shell.
- Targets vale has no parser for: skipped (issue #6), whatever their content.

### The block reason

```
pi-noslop: blocked — the text you are about to write contains AI-slop prose.

File: README.md
Rules: /path/to/pi-noslop/vale/.vale.ini (vendored default)
Violations: 2

- ai-tells.OpeningCliches: AI opening: 'In today's rapidly evolving'. Start with your actual point instead of this generic lead-in.
- ai-tells.OverusedVocabulary: AI vocabulary: 'delve'. Replace with a more specific or common word.

To see every violation at once, run:
  vale --no-global --config=/path/to/vale/.vale.ini --output=JSON --no-wrap README.md

Fix the flagged prose and re-issue the edit. There is no bypass.
```

## Install

```bash
pi install git:github.com/elecnix/pi-noslop
```

Requires the `vale` binary on `PATH` (the extension shells out to it). The default styles are vendored in the package, so a repo without rules of its own doesn't need the network or `vale sync`. A repo that pins its own rules has to have been synced once (see above).

```bash
brew install vale
```

## Test

```bash
npm test          # gate and resolution tests: real vale runs, synthetic tool inputs, no model — CI-safe, < 1s
```

The suite drives `gate()` directly with synthetic `edit`/`write`/`bash` inputs, so it needs only the `vale` binary, not a model, an API key, or the network. Resolution is proved against throwaway repos built under the temp dir: the same sentence passes under one rule set and blocks under another. The real-harness behavior (a live `pi -p` session whose write is blocked with the full reason) was verified during development. Wire that check into CI only with a model available.

```bash
pi -p -e ./index.ts "Use the write tool to create x.md with content: In today's rapidly evolving landscape, we delve into the rich tapestry of things."
# → pi-noslop blocks the write; x.md is not created; the model reports the four rules.
```

## Design decisions

| Decision | Why |
|---|---|
| Lint new text only | The spec: "fails edits that write ANY slop, even if the old text contained slop and is merely copied". Whole-file linting would block unrelated edits in a file that already has slop. |
| The edited repo's rules win | A project that lints its own prose already encodes its vocabulary and project style. A gate that ignored them would flag the project's own names. |
| The walk stops at the repo root, and skips `$HOME` | A config outside the repo, or one in a developer's home directory, would make the verdict depend on the machine. |
| Block, don't fetch, when the repo's rules are missing | A hook that runs before every edit stays off the network. `vale sync` is a setup step. |
| Block, don't fall back, when the repo's rules can't load | A deleted styles directory would otherwise swap in a weaker rule set and the edit would look approved. |
| `--ext` derived from the target path | A `.go` file is parsed as Go, not as Markdown prose, and its comments are still linted. A target vale has no parser for is skipped (issue #6): failing closed on a whole format trains authors to route around the gate. |
| Fail closed | A missing vale or styles must block, never pass. |
| No break-glass | No flag, env var, or config disables the gate. The binary is fixed at `vale` on `PATH`; the rule set is resolved from the tree, never from an environment variable a shell could set. |
| Bash untouched | The gate is on file-writing tools. |

## Keeping fixtures clean

This repo is public and its fixtures are agent-written. `tools/scrub.sh` runs in CI on every push and pull request and fails the build if private vocabulary appears anywhere in the tree.

It scans with two patterns. The **baseline** is committed and names nothing private. It catches the patterns a leak takes, such as a ticket reference or an internal hostname. The second comes from the `SCRUB_PATTERN` repository secret, an extended-regex alternation of the words this repo must never carry. Writing those words into the script would publish the thing the check exists to keep out.

The secret is **required**. A scrub that passes on an empty pattern reports green without checking anything. Fork pull requests are the one exception, since GitHub withholds secrets from them by design and a fork contributor has no access to the vocabulary anyway. There, only the baseline runs.

A finding is reported as `file:line` with the matching text withheld. Printing it would copy the leaked sentence into a public build log, the outcome the scrub exists to prevent. GitHub masks a secret's literal value but not the individual words inside a regex alternation. Run `SCRUB_SHOW_MATCHES=1 ./tools/scrub.sh` locally to see the text.

## License

MIT. The vendored ruleset is [vale-ai-tells](https://github.com/tbhb/vale-ai-tells) (MIT, © Tony Burns), vendored at v1.34.0 (see `vale/LICENSE.vale-ai-tells`).
