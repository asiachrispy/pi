import { describe, expect, it } from "vitest";
import { buildToolIndex, searchToolIndex } from "../src/core/tools/tool-discovery.ts";

describe("tool-discovery", () => {
	const all: Array<{ name: string; description: string; label: string }> = [
		{ name: "read", description: "Read file contents", label: "read" },
		{ name: "bash", description: "Execute bash commands", label: "bash" },
		{ name: "github", description: "GitHub integration (issues, PRs, search)", label: "GitHub" },
		{ name: "browser", description: "Puppeteer browser automation", label: "Browser" },
	];

	describe("buildToolIndex", () => {
		it("returns hidden tools only", () => {
			const active = new Set(["read", "bash"]);
			const index = buildToolIndex(active, all);
			expect(index.map((e) => e.name)).toEqual(["github", "browser"]);
		});

		it("returns all tools when none are active", () => {
			const active = new Set<string>();
			const index = buildToolIndex(active, all);
			expect(index).toHaveLength(all.length);
		});

		it("returns empty when all tools are active", () => {
			const active = new Set(all.map((t) => t.name));
			const index = buildToolIndex(active, all);
			expect(index).toHaveLength(0);
		});
	});

	describe("searchToolIndex", () => {
		it("returns matching tools by keyword", () => {
			const results = searchToolIndex(all, "github");
			expect(results).toHaveLength(1);
			expect(results[0]?.name).toBe("github");
		});

		it("favors exact name match", () => {
			const results = searchToolIndex(all, "bash");
			expect(results[0]?.name).toBe("bash");
		});

		it("returns multiple matches", () => {
			const results = searchToolIndex(all, "tool");
			// none of the tools have "tool" in name/description
			expect(results).toHaveLength(0);
		});

		it("matches partial keywords across description", () => {
			const results = searchToolIndex(all, "browser");
			expect(results).toHaveLength(1);
			expect(results[0]?.name).toBe("browser");
		});

		it("returns empty for no match", () => {
			const results = searchToolIndex(all, "zzzzz");
			expect(results).toHaveLength(0);
		});

		it("respects maxResults", () => {
			const results = searchToolIndex(all, "e", 2);
			expect(results.length).toBeLessThanOrEqual(2);
		});

		it("handles empty query gracefully", () => {
			const results = searchToolIndex(all, "");
			expect(results).toHaveLength(0);
		});
	});
});
