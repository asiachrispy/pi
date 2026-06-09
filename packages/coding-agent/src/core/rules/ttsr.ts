/**
 * Time-traveling stream rules (TTSR) — compile + scan.
 *
 * A TTSR rule is a regex that, when matched against accumulating assistant
 * text during an LLM stream, aborts the stream and triggers a re-prompt
 * with the rule body injected as a system reminder.
 *
 * This file is intentionally pure: `compileTtsrRules` turns user-facing
 * `Rule` objects into a flat compiled list (with `pattern` as a `RegExp`),
 * and `scanTtsrTrigger` runs them over a string. The stream wrapper and
 * the session-level integration live elsewhere.
 */

import type { Rule, RuleInterruptMode } from "./types.ts";

/** A TTSR rule with a compiled regex and the rule body to inject. */
export interface TtsrCompiledRule {
	/** Stable identifier; used in diagnostics. */
	name: string;
	/** Source path (for diagnostics). */
	source: string;
	/** Compiled regex. Tested against the accumulating assistant text. */
	pattern: RegExp;
	/** Body to inject as a system reminder when the rule triggers. */
	body: string;
	/** Interrupt mode (mirrors `Rule.interruptMode` but allows settings overrides). */
	interruptMode: RuleInterruptMode;
}

/** Settings shape for explicit TTSR rules declared in `config.yml`. */
export interface TtsrSettingsRule {
	name?: string;
	pattern: string;
	body: string;
	interruptMode?: RuleInterruptMode;
	/** Glob patterns limiting when this rule is eligible. Reserved for future use. */
	globs?: string[];
}

/** Settings shape for the whole TTSR subsystem. */
export interface TtsrSettings {
	enabled?: boolean;
	rules?: TtsrSettingsRule[];
}

const DEFAULT_INTERRUPT_MODE: RuleInterruptMode = "never";

const VALID_MODES: readonly RuleInterruptMode[] = ["never", "prose-only", "tool-only", "always"];

function normalizeInterruptMode(mode: unknown): RuleInterruptMode {
	if (typeof mode === "string" && (VALID_MODES as readonly string[]).includes(mode)) {
		return mode as RuleInterruptMode;
	}
	return DEFAULT_INTERRUPT_MODE;
}

/** A rule only triggers TTSR when its `interruptMode` is not `"never"`. */
function isTtsrEligible(rule: Pick<Rule, "interruptMode" | "alwaysApply">): boolean {
	if (!rule.alwaysApply) return false;
	const mode = rule.interruptMode ?? "never";
	return mode !== "never";
}

/**
 * Compile a list of `Rule`s + explicit settings rules into a flat list of
 * `TtsrCompiledRule`. Rules with malformed patterns are dropped with a
 * diagnostic so a single bad rule does not break the whole compile.
 */
export function compileTtsrRules(
	rules: Rule[],
	settings: TtsrSettings | undefined,
): { compiled: TtsrCompiledRule[]; diagnostics: Array<{ name: string; reason: string }> } {
	const compiled: TtsrCompiledRule[] = [];
	const diagnostics: Array<{ name: string; reason: string }> = [];
	const seen = new Set<string>();

	// 1. Rules from AGENTS.md / CLAUDE.md that opted into TTSR
	for (const rule of rules) {
		if (!isTtsrEligible(rule)) continue;
		if (!rule.content.trim()) continue;
		// Use the rule's name as the regex. The convention is that
		// `interruptMode: prose-only` rules write their trigger pattern
		// in the body. To keep things simple, the first line is treated
		// as a literal substring trigger, and the rest is the body.
		const { firstLine, rest } = splitFirstLine(rule.content);
		const trigger = firstLine.trim();
		if (!trigger) continue;
		const regex = new RegExp(escapeRegExp(trigger));
		if (seen.has(rule.name)) continue;
		seen.add(rule.name);
		compiled.push({
			name: rule.name,
			source: rule._source.label,
			pattern: regex,
			body: rest.trim(),
			interruptMode: rule.interruptMode ?? "always",
		});
	}

	// 2. Explicit settings rules
	if (settings?.rules) {
		for (const settingsRule of settings.rules) {
			if (!settingsRule.pattern || !settingsRule.body) {
				diagnostics.push({
					name: settingsRule.name ?? "(unnamed)",
					reason: "missing `pattern` or `body`",
				});
				continue;
			}
			let regex: RegExp;
			try {
				regex = new RegExp(settingsRule.pattern);
			} catch (error) {
				diagnostics.push({
					name: settingsRule.name ?? settingsRule.pattern,
					reason: `invalid regex: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
			const name = settingsRule.name ?? `ttsr:${settingsRule.pattern}`;
			if (seen.has(name)) continue;
			seen.add(name);
			compiled.push({
				name,
				source: "<config>",
				pattern: regex,
				body: settingsRule.body,
				interruptMode: normalizeInterruptMode(settingsRule.interruptMode),
			});
		}
	}

	return { compiled, diagnostics };
}

/** Result of scanning the accumulated text against compiled rules. */
export interface TtsrMatch {
	rule: TtsrCompiledRule;
	/** Character index in the accumulated text where the match started. */
	matchIndex: number;
	/** The matched substring. */
	hit: string;
}

/**
 * Scan the accumulated text against compiled rules. Returns the first
 * match, or undefined. Pure function, easy to test.
 */
export function scanTtsrTrigger(accumulated: string, compiled: TtsrCompiledRule[]): TtsrMatch | undefined {
	for (const rule of compiled) {
		// Find the first occurrence; pin to a unique hit per scan.
		const m = rule.pattern.exec(accumulated);
		if (m && m.index !== undefined) {
			return { rule, matchIndex: m.index, hit: m[0] };
		}
	}
	return undefined;
}

/** Escape a literal string for use in a `RegExp`. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitFirstLine(content: string): { firstLine: string; rest: string } {
	const idx = content.indexOf("\n");
	if (idx === -1) return { firstLine: content, rest: "" };
	return { firstLine: content.slice(0, idx), rest: content.slice(idx + 1) };
}

/** Build the synthetic user message that injects a rule's body as a system reminder. */
export function buildTtsrInjectionMessage(match: TtsrMatch): {
	customType: "ttsr_injection";
	content: string;
	display: boolean;
	details: { ruleName: string; source: string; hit: string };
} {
	return {
		customType: "ttsr_injection",
		content: `[TTSR rule "${match.rule.name}" triggered]\n\n${match.rule.body}`,
		display: true,
		details: {
			ruleName: match.rule.name,
			source: match.rule.source,
			hit: match.hit,
		},
	};
}
