/**
 * Which rule set judges a piece of text.
 *
 * A project's own rules win. The gate walks up from the edited file to the
 * nearest `.vale.ini` — how Vale itself resolves config — and uses the
 * vendored default pack only when the repo declares nothing.
 *
 * Two limits on that walk, both deliberate:
 *
 * - It stops at the repository root, so a stray config in a parent
 *   directory cannot reach into an unrelated checkout.
 * - It skips `$HOME`. A developer's personal `~/.vale.ini` must never
 *   decide a gate verdict; that is the hole `--no-global` closes, and
 *   passing the same file through `--config=` would reopen it.
 *
 * The walk runs on real paths, so a symlinked edit path or a symlinked
 * `$HOME` cannot smuggle in a config from outside the repo.
 *
 * The result is cached per directory, and one walk fills the cache for
 * every directory it climbed through, so a repo is walked once. The cache
 * lives as long as the pi session: adding a `.vale.ini` to a repo the
 * session has already touched takes effect on the next session.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to this repo's vendored vale config. */
export const VALE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vale");
export const VALE_INI = join(VALE_DIR, ".vale.ini");

/** The filenames Vale accepts for a project config, in its own order. */
export const CONFIG_NAMES = [".vale.ini", "_vale.ini"] as const;

export interface ResolvedConfig {
	/** The `--config=` argument every vale invocation gets. */
	configPath: string;
	source: "project" | "vendored";
	/** The directory the config governs — the repo root for a project config. */
	root: string;
}

export const VENDORED_CONFIG: ResolvedConfig = {
	configPath: VALE_INI,
	source: "vendored",
	root: VALE_DIR,
};

/** How a verdict names the rule set that produced it. */
export function configLabel(config: ResolvedConfig): string {
	return config.source === "project"
		? `${config.configPath} (project)`
		: `${config.configPath} (vendored default)`;
}

const cache = new Map<string, ResolvedConfig>();

/** Drop the cache. Tests use it; nothing in the extension does. */
export function clearConfigCache(): void {
	cache.clear();
}

function configIn(dir: string): string | undefined {
	for (const name of CONFIG_NAMES) {
		const candidate = join(dir, name);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** `.git` is a directory in a clone and a file in a worktree. Both count. */
function isRepoRoot(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

/**
 * The real path, as far down as the path exists.
 *
 * `resolve` normalizes `.`, `..` and a trailing slash but leaves symlinks
 * alone, and a walk up a logical path can climb straight out of the repo the
 * file really lives in — past the `.git` that is meant to stop it, into
 * whatever config sits above. Comparing real paths is also what keeps the
 * `$HOME` guard honest: a symlinked home is the ordinary case on Linux and in
 * containers, and a string compare misses it.
 *
 * Agents write into directories they are about to create, so the tail that
 * does not exist yet is kept as written rather than treated as a failure.
 */
function realPath(path: string): string {
	let dir = resolve(path);
	const tail: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(dir), ...tail.reverse());
		} catch {
			const parent = dirname(dir);
			if (parent === dir) {
				return resolve(path);
			}
			tail.push(basename(dir));
			dir = parent;
		}
	}
}

/**
 * Find the rule set that governs `filePath`. Relative paths resolve
 * against `cwd`, which is where pi is running.
 */
export function resolveValeConfig(filePath: string, cwd: string = process.cwd()): ResolvedConfig {
	return resolveValeConfigForDir(dirname(resolve(cwd, filePath)));
}

/**
 * Find the rule set that governs a directory. The gate uses this when a
 * tool call carries no path, where the directory to judge is pi's cwd
 * itself rather than its parent.
 */
export function resolveValeConfigForDir(where: string): ResolvedConfig {
	const start = realPath(where);
	const cached = cache.get(start);
	if (cached) {
		return cached;
	}

	const home = realPath(homedir());
	const filesystemRoot = parse(start).root;
	const climbed: string[] = [];
	let found: ResolvedConfig | undefined;
	let dir = start;

	for (;;) {
		climbed.push(dir);
		if (dir !== home) {
			const candidate = configIn(dir);
			if (candidate) {
				found = { configPath: candidate, source: "project", root: dir };
				break;
			}
		}
		if (isRepoRoot(dir) || dir === home || dir === filesystemRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	const result = found ?? VENDORED_CONFIG;
	for (const seen of climbed) {
		cache.set(seen, result);
	}
	return result;
}
