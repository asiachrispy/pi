/**
 * Frontmatter-based rule parser.
 *
 * Rules come from files that are usually written in the AGENTS.md / CLAUDE.md
 * style: free-form markdown with optional YAML frontmatter. This parser
 * turns one file into one `Rule`.
 *
 * Conventions:
 *
 * - The file's basename (without `.md`) is the default `name`.
 * - Frontmatter is optional. If absent, all fields get sensible defaults.
 * - Recognized frontmatter keys: `name`, `description`, `globs`, `alwaysApply`,
 *   `condition`, `astCondition`, `scope`, `interruptMode`.
 * - Unknown frontmatter keys are silently ignored to keep the parser
 *   tolerant of files written for other agents.
 *
 * Diagnostics are collected rather than thrown so a single malformed file
 * does not break the entire rulebook load.
 */

import { basename, extname } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { Rule, RuleInterruptMode, RuleLoadResult, RuleSource } from "./types.ts";

const VALID_INTERRUPT_MODES: readonly RuleInterruptMode[] = ["never", "prose-only", "tool-only", "always"];

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.length > 0) out.push(item);
	}
	return out.length > 0 ? out : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	return undefined;
}

function asInterruptMode(value: unknown): RuleInterruptMode | undefined {
	if (typeof value === "string" && (VALID_INTERRUPT_MODES as readonly string[]).includes(value)) {
		return value as RuleInterruptMode;
	}
	return undefined;
}

function defaultNameFromPath(path: string): string {
	const base = basename(path, extname(path));
	// Strip a leading numeric prefix that some teams use for ordering
	// (e.g. `01-style.md` -> `style`). This is purely cosmetic.
	return base.replace(/^\d+[-_]/, "");
}

/** Parse a single file into a `Rule`, collecting diagnostics on failure. */
export function parseRuleFromFile(path: string, rawContent: string, source: RuleSource): RuleLoadResult {
	const diagnostics: RuleLoadResult["diagnostics"] = [];
	let frontmatter: Record<string, unknown> = {};
	let body = rawContent;
	try {
		const parsed = parseFrontmatter(rawContent);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: `Failed to parse frontmatter: ${error instanceof Error ? error.message : String(error)}`,
			path,
		});
	}

	const name = asString(frontmatter.name) ?? defaultNameFromPath(path);
	const description = asString(frontmatter.description);
	const globs = asStringArray(frontmatter.globs);
	const condition = asStringArray(frontmatter.condition);
	const astCondition = asStringArray(frontmatter.astCondition);
	const scope = asStringArray(frontmatter.scope);
	const alwaysApply = asBoolean(frontmatter.alwaysApply) ?? true;
	const interruptMode = asInterruptMode(frontmatter.interruptMode);

	const rule: Rule = {
		name,
		path,
		content: body.trim(),
		...(globs ? { globs } : {}),
		alwaysApply,
		...(description ? { description } : {}),
		...(condition ? { condition } : {}),
		...(astCondition ? { astCondition } : {}),
		...(scope ? { scope } : {}),
		...(interruptMode ? { interruptMode } : {}),
		_source: source,
	};

	return { rules: [rule], diagnostics };
}
