/**
 * `rule://` URL protocol.
 *
 * Resolves a rule URL into a textual response the model can read. The
 * resolver takes a snapshot of the current rulebook so calls are pure and
 * easy to test; the read tool calls this before any file I/O.
 *
 * Supported URLs:
 *
 *   rule://root
 *     A short listing of every loaded rule (name, description, source).
 *
 *   rule://root/<name>
 *     Full body of the named rule, with the file path and metadata header.
 *
 *   rule://name
 *     Equivalent to `rule://root/<name>` for ergonomic shorthand.
 *
 * Returns `null` when the URL is not a `rule://` URL — the read tool falls
 * back to file I/O. Throws when the URL is malformed or the rule is
 * missing, so the read tool surfaces the error to the model.
 */

import type { Rule } from "./types.ts";

export const RULE_URL_SCHEME = "rule:";

export function isRuleUrl(url: string): boolean {
	return url.toLowerCase().startsWith(RULE_URL_SCHEME);
}

interface ParsedRuleUrl {
	/** Empty for `rule://root`, otherwise the rule name (URL-decoded). */
	name: string;
}

/** Parse a `rule://...` URL. Throws on malformed input. */
export function parseRuleUrl(url: string): ParsedRuleUrl {
	const stripped = url.slice(RULE_URL_SCHEME.length);
	// Accept `rule://`, `rule:///`, and `rule:` (rare but harmless).
	const noScheme = stripped.replace(/^\/+/, "");
	if (noScheme.length === 0) {
		throw new Error("Empty rule:// URL");
	}

	// `rule://root` -> { name: "" }
	if (noScheme === "root" || noScheme === "root/") {
		return { name: "" };
	}

	// `rule://root/<name>` -> { name: "<name>" }
	if (noScheme.startsWith("root/")) {
		const name = decodeURIComponent(noScheme.slice("root/".length));
		if (name.length === 0) throw new Error("Empty rule name in rule URL");
		return { name };
	}

	// `rule://<name>` shorthand.
	const name = decodeURIComponent(noScheme);
	if (name.length === 0) throw new Error("Empty rule name in rule URL");
	return { name };
}

/** Render a response for a `rule://` URL given the current rulebook. */
export function resolveRuleUrl(url: string, rules: Rule[]): string {
	const parsed = parseRuleUrl(url);
	if (parsed.name === "") {
		return formatRuleListing(rules);
	}
	const rule = rules.find((r) => r.name === parsed.name);
	if (!rule) {
		const known = rules.map((r) => r.name).join(", ");
		throw new Error(`Rule "${parsed.name}" not found. Known rules: ${known || "(none)"}`);
	}
	return formatRuleBody(rule);
}

function formatRuleListing(rules: Rule[]): string {
	if (rules.length === 0) {
		return "No rules loaded. Add AGENTS.md or CLAUDE.md to the project or agent directory.";
	}
	const lines: string[] = ["# Loaded Rules", ""];
	for (const rule of rules) {
		const desc = rule.description ? ` — ${rule.description}` : "";
		lines.push(`- ${rule.name}${desc}  (source: ${rule._source.label}, path: ${rule.path})`);
	}
	lines.push("");
	lines.push("Use `read rule://<name>` to view a single rule in full.");
	return lines.join("\n");
}

function formatRuleBody(rule: Rule): string {
	const lines: string[] = [`# ${rule.name}`, "", `Source: ${rule._source.label} (${rule.path})`];
	if (rule.description) lines.push(`Description: ${rule.description}`);
	if (rule.globs && rule.globs.length > 0) lines.push(`Globs: ${rule.globs.join(", ")}`);
	if (rule.scope && rule.scope.length > 0) lines.push(`Scope: ${rule.scope.join(", ")}`);
	if (rule.interruptMode) lines.push(`Interrupt mode: ${rule.interruptMode}`);
	lines.push("", rule.content);
	return lines.join("\n");
}
