// Pure source-string parsing and matching for the package manager.
//
// Extracted from `package-manager.ts` so the rules can be unit-tested
// independently of the I/O-heavy install / remove / update paths. The
// `createPackageSourceParser` factory binds the cwd used for local-path
// normalization; the class-level `DefaultPackageManager` consumes the
// returned `PackageSourceParser` for every source comparison.

import { relative } from "node:path";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import type { PackageSource } from "./settings-manager.ts";

export type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	pinned: boolean;
};

export type LocalSource = {
	type: "local";
	path: string;
};

export type ParsedSource = NpmSource | GitSource | LocalSource;

/**
 * Parse an npm spec like `pkg@1.2.3`, `@scope/pkg@1.2.3`, or just `pkg`.
 * Returns just the name when the version separator is absent or malformed.
 */
export function parseNpmSpec(spec: string): { name: string; version?: string } {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	if (!match) {
		return { name: spec };
	}
	const name = match[1] ?? spec;
	const version = match[2];
	return { name, version };
}

/**
 * Parse a configured / user-supplied source string into one of:
 * - `npm:<spec>`            -> `{ type: "npm", ... }`
 * - a local filesystem path -> `{ type: "local", path }`
 * - a git URL (https, ssh, git, shorthand) -> `{ type: "git", ... }` (delegated to `parseGitUrl`)
 * - anything else            -> `{ type: "local", path: source }` (best-effort fallback)
 */
export function parseSource(source: string): ParsedSource {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length).trim();
		const { name, version } = parseNpmSpec(spec);
		return {
			type: "npm",
			spec,
			name,
			pinned: Boolean(version),
		};
	}

	if (isLocalPath(source)) {
		return { type: "local", path: source };
	}

	// Try parsing as git URL
	const gitParsed = parseGitUrl(source);
	if (gitParsed) {
		return gitParsed;
	}

	return { type: "local", path: source };
}

/**
 * Extract the original source string from a configured package, which
 * may be either a string or an object with a `source` field.
 */
export function getPackageSourceString(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

/**
 * Suggest a configured package whose source string is a match for the
 * user's input. Used to enrich "no matching package" error messages.
 */
export function findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
	const trimmedSource = source.trim();
	const suggestions = new Set<string>();

	for (const pkg of configuredPackages) {
		const sourceStr = getPackageSourceString(pkg);
		const parsed = parseSource(sourceStr);
		if (parsed.type === "npm") {
			if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
				suggestions.add(sourceStr);
			}
			continue;
		}
		if (parsed.type === "git") {
			const shorthand = `${parsed.host}/${parsed.path}`;
			const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
			if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
				suggestions.add(sourceStr);
			}
		}
	}

	return suggestions.values().next().value;
}

export function buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
	const suggestion = findSuggestedConfiguredSource(source, configuredPackages);
	if (!suggestion) {
		return `No matching package found for ${source}`;
	}
	return `No matching package found for ${source}. Did you mean ${suggestion}?`;
}

export interface PackageSourceParser {
	/** Resolve a path against the package manager's working directory. */
	resolvePath(input: string): string;
	/** Resolve a path against an arbitrary base (typically a scope directory). */
	resolvePathFromBase(input: string, baseDir: string): string;
	parseSource(source: string): ParsedSource;
	parseNpmSpec(spec: string): { name: string; version?: string };
	getPackageSourceString(pkg: PackageSource): string;
	/**
	 * Canonical key for a user-supplied source string. Local paths are
	 * resolved against the package manager's cwd, so two equivalent paths
	 * (e.g. `./foo` and `/abs/foo`) compare equal.
	 */
	getSourceMatchKeyForInput(source: string): string;
	/**
	 * Canonical key for a configured (settings-stored) source string.
	 * Local paths are resolved against the scope's base dir so that
	 * relative paths stored in `user` vs `project` settings compare equal
	 * only when they point at the same file.
	 */
	getSourceMatchKeyForSettings(source: string, scopeBaseDir: string): string;
	packageSourcesMatch(existing: PackageSource, inputSource: string, scopeBaseDir: string): boolean;
	normalizePackageSourceForSettings(source: string, scopeBaseDir: string): string;
	buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string;
	findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined;
}

export function createPackageSourceParser(cwd: string): PackageSourceParser {
	const resolve = (input: string, baseDir: string): string => resolvePath(input, baseDir, { trim: true });
	return {
		resolvePath(input) {
			return resolve(input, cwd);
		},
		resolvePathFromBase(input, baseDir) {
			return resolve(input, baseDir);
		},
		parseSource,
		parseNpmSpec,
		getPackageSourceString,
		getSourceMatchKeyForInput(source) {
			const parsed = parseSource(source);
			if (parsed.type === "npm") {
				return `npm:${parsed.name}`;
			}
			if (parsed.type === "git") {
				return `git:${parsed.host}/${parsed.path}`;
			}
			return `local:${resolve(parsed.path, cwd)}`;
		},
		getSourceMatchKeyForSettings(source, scopeBaseDir) {
			const parsed = parseSource(source);
			if (parsed.type === "npm") {
				return `npm:${parsed.name}`;
			}
			if (parsed.type === "git") {
				return `git:${parsed.host}/${parsed.path}`;
			}
			return `local:${resolve(parsed.path, scopeBaseDir)}`;
		},
		packageSourcesMatch(existing, inputSource, scopeBaseDir) {
			const left = this.getSourceMatchKeyForSettings(getPackageSourceString(existing), scopeBaseDir);
			const right = this.getSourceMatchKeyForInput(inputSource);
			return left === right;
		},
		normalizePackageSourceForSettings(source, scopeBaseDir) {
			// Local paths are resolved against the package manager's cwd, then
			// re-expressed relative to the scope's base dir for storage. Resolving
			// against scopeBaseDir would yield empty rel paths for entries that
			// live inside the agent dir, which is not what callers expect.
			const parsed = parseSource(source);
			if (parsed.type !== "local") {
				return source;
			}
			const resolved = resolve(parsed.path, cwd);
			const rel = relative(scopeBaseDir, resolved);
			return rel || ".";
		},
		buildNoMatchingPackageMessage,
		findSuggestedConfiguredSource,
	};
}
