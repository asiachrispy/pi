import { describe, expect, it } from "vitest";
import { parseRuleFromFile } from "../src/core/rules/parse.ts";
import { isRuleUrl, parseRuleUrl, resolveRuleUrl } from "../src/core/rules/rule-url.ts";
import type { Rule } from "../src/core/rules/types.ts";
import { formatRulebookForPrompt } from "../src/core/system-prompt.ts";

const projectSource = { label: "<project-AGENTS.md>", path: "/repo/AGENTS.md", level: "project" as const };

describe("parseRuleFromFile", () => {
	it("uses the file basename as the default name", () => {
		const result = parseRuleFromFile("/repo/AGENTS.md", "Always run tests before commit.", projectSource);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0]?.name).toBe("AGENTS");
		expect(result.rules[0]?.content).toContain("Always run tests before commit.");
		expect(result.rules[0]?.alwaysApply).toBe(true);
	});

	it("strips a leading numeric prefix from the default name", () => {
		const result = parseRuleFromFile("/repo/01-style.md", "Use 2-space indent.", projectSource);
		expect(result.rules[0]?.name).toBe("style");
	});

	it("honors frontmatter overrides", () => {
		const content = `---
name: style-guide
description: Project style rules
globs: ["*.ts", "src/**"]
alwaysApply: false
interruptMode: prose-only
---
Use 2-space indent.`;
		const result = parseRuleFromFile("/repo/style.md", content, projectSource);
		const rule = result.rules[0];
		expect(rule?.name).toBe("style-guide");
		expect(rule?.description).toBe("Project style rules");
		expect(rule?.globs).toEqual(["*.ts", "src/**"]);
		expect(rule?.alwaysApply).toBe(false);
		expect(rule?.interruptMode).toBe("prose-only");
	});

	it("rejects unknown interruptMode values", () => {
		const content = `---
name: x
interruptMode: bogus
---
body`;
		const result = parseRuleFromFile("/repo/x.md", content, projectSource);
		expect(result.rules[0]?.interruptMode).toBeUndefined();
	});

	it("does not throw on bad frontmatter; collects a diagnostic", () => {
		const result = parseRuleFromFile("/repo/x.md", "---\n: broken: :\n---\nbody", projectSource);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.type).toBe("warning");
		expect(result.rules[0]?.content).toContain("body");
	});
});

describe("rule:// URL scheme", () => {
	const rules: Rule[] = [
		{
			name: "style",
			path: "/repo/style.md",
			content: "Use 2-space indent.",
			alwaysApply: true,
			_source: projectSource,
		},
		{
			name: "tests",
			path: "/repo/tests.md",
			content: "Run npm test.",
			description: "Testing policy",
			_source: { label: "<project-CLAUDE.md>", path: "/repo/CLAUDE.md", level: "project" },
		},
	];

	it("isRuleUrl matches", () => {
		expect(isRuleUrl("rule://root")).toBe(true);
		expect(isRuleUrl("rule://style")).toBe(true);
		expect(isRuleUrl("RULE://root")).toBe(true);
		expect(isRuleUrl("/etc/passwd")).toBe(false);
	});

	it("parseRuleUrl handles root", () => {
		expect(parseRuleUrl("rule://root")).toEqual({ name: "" });
	});

	it("parseRuleUrl handles root/<name>", () => {
		expect(parseRuleUrl("rule://root/style")).toEqual({ name: "style" });
	});

	it("parseRuleUrl handles bare <name>", () => {
		expect(parseRuleUrl("rule://style")).toEqual({ name: "style" });
	});

	it("rejects empty names", () => {
		expect(() => parseRuleUrl("rule://")).toThrow(/Empty rule/);
	});

	it("resolves root to a listing", () => {
		const out = resolveRuleUrl("rule://root", rules);
		expect(out).toContain("Loaded Rules");
		expect(out).toContain("- style");
		expect(out).toContain("- tests");
		expect(out).toContain("Testing policy");
	});

	it("resolves a single rule to its body", () => {
		const out = resolveRuleUrl("rule://style", rules);
		expect(out).toContain("# style");
		expect(out).toContain("Use 2-space indent.");
		expect(out).toContain("Source: <project-AGENTS.md>");
	});

	it("resolves via root/<name> shorthand", () => {
		const out = resolveRuleUrl("rule://root/tests", rules);
		expect(out).toContain("# tests");
		expect(out).toContain("Run npm test.");
	});

	it("throws on missing rule with helpful message", () => {
		expect(() => resolveRuleUrl("rule://missing", rules)).toThrow(/Rule "missing" not found/);
	});

	it("renders an empty rulebook gracefully", () => {
		const out = resolveRuleUrl("rule://root", []);
		expect(out).toContain("No rules loaded");
	});
});

describe("formatRulebookForPrompt", () => {
	it("skips rules that are not alwaysApply", () => {
		const out = formatRulebookForPrompt([
			{ name: "a", path: "/x", content: "A", alwaysApply: true, _source: projectSource },
			{ name: "b", path: "/y", content: "B", alwaysApply: false, _source: projectSource },
		]);
		expect(out).toContain('<rule name="a"');
		expect(out).not.toContain('<rule name="b"');
	});

	it("returns empty string when no rules are applicable", () => {
		const out = formatRulebookForPrompt([]);
		expect(out).toBe("");
		const onlyConditional = formatRulebookForPrompt([
			{ name: "x", path: "/x", content: "X", alwaysApply: false, _source: projectSource },
		]);
		expect(onlyConditional).toBe("");
	});

	it("escapes XML attributes", () => {
		const out = formatRulebookForPrompt([
			{ name: 'weird"name', path: "/p/x", content: "body", _source: { ...projectSource, label: "<tag>" } },
		]);
		// Both `"` and `<>` are escaped to their XML entities
		expect(out).toContain("&quot;");
		expect(out).toContain("&lt;tag&gt;");
	});

	it("includes description when provided", () => {
		const out = formatRulebookForPrompt([
			{ name: "d", path: "/d", content: "body", description: "short", _source: projectSource },
		]);
		expect(out).toContain('description="short"');
	});

	it("opens and closes the rulebook wrapper", () => {
		const out = formatRulebookForPrompt([{ name: "a", path: "/x", content: "A", _source: projectSource }]);
		expect(out).toContain("<rulebook>");
		expect(out).toContain("</rulebook>");
	});
});
