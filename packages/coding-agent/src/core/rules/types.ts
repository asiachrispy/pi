/**
 * Rule types — the unified shape for project instructions loaded from
 * `AGENTS.md` / `CLAUDE.md` (and later Cursor MDC, Copilot applyTo, etc.).
 *
 * A rule is the basic unit of "context the model must read". It can serve
 * two consumers:
 *
 * - **Rulebook rules**: included in the system prompt as a static block
 *   alongside `<project_context>` and skills. Available to the model via
 *   `rule://` URLs.
 * - **TTSR rules**: the same content is also used as a regex trigger that
 *   can abort an in-flight LLM stream and inject a reminder. This is a
 *   future task; the `interruptMode` field is reserved for it.
 *
 * Deduplication is name-based: a rule with the same `name` from a higher
 * priority source shadows one from a lower priority source. Capability
 * identity is `rule.name`.
 */

/** Where a rule came from. Drives priority and diagnostics. */
export interface RuleSource {
	/** Display name for diagnostics (e.g. `<project-AGENTS.md>`, `<global-CLAUDE.md>`). */
	label: string;
	/** Absolute file path the rule was loaded from. */
	path: string;
	/** Scope of the file: project-level (cwd tree) or global (agent dir). */
	level: "project" | "global";
}

/** When a rule's TTSR trigger should fire. */
export type RuleInterruptMode = "never" | "prose-only" | "tool-only" | "always";

/** A parsed rule ready for inclusion in the system prompt and rulebook. */
export interface Rule {
	/** Stable identifier; used for deduplication and the `rule://<name>` URL. */
	name: string;
	/** Absolute path of the source file. */
	path: string;
	/** Rule body, with frontmatter stripped. */
	content: string;
	/** Glob patterns the rule applies to. Currently informational; not used to filter prompt inclusion. */
	globs?: string[];
	/** When true, the rule is always included in the system prompt. Defaults to true. */
	alwaysApply?: boolean;
	/** Optional one-line summary; surfaced in `rule://root` listings. */
	description?: string;
	/** Trigger condition tags; preserved for future TTSR use. */
	condition?: string[];
	/** AST trigger conditions; reserved for future TTSR use. */
	astCondition?: string[];
	/** Files this rule applies to (e.g. `["*.ts", "src/**"]`); preserved for future filtering. */
	scope?: string[];
	/** When TTSR should consider this rule as an interrupt trigger. Default: "never". */
	interruptMode?: RuleInterruptMode;
	/** Source metadata. */
	_source: RuleSource;
}

/** Result of loading rules from disk. */
export interface RuleLoadResult {
	rules: Rule[];
	diagnostics: Array<{ type: "warning" | "error"; message: string; path?: string }>;
}
