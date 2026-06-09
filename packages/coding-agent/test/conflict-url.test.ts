import { describe, expect, it } from "vitest";
import { findConflictRegions, isConflictUrl, parseConflictUrl } from "../src/core/tools/conflict-url.ts";

describe("conflict:// URL scheme", () => {
	describe("isConflictUrl", () => {
		it("matches simple path", () => {
			expect(isConflictUrl("conflict://src/file.ts")).toBe(true);
		});

		it("is case-insensitive", () => {
			expect(isConflictUrl("CONFLICT://file.ts")).toBe(true);
		});

		it("rejects file paths", () => {
			expect(isConflictUrl("/etc/passwd")).toBe(false);
		});
	});

	describe("parseConflictUrl", () => {
		it("parses a file path", () => {
			expect(parseConflictUrl("conflict://src/file.ts")).toEqual({ path: "src/file.ts" });
		});

		it("parses an index number", () => {
			expect(parseConflictUrl("conflict://3")).toEqual({ path: "3", index: 3 });
		});

		it("parses the bulk wildcard", () => {
			expect(parseConflictUrl("conflict://*")).toEqual({ path: "*" });
		});

		it("returns undefined for empty input", () => {
			expect(parseConflictUrl("conflict://")).toBeUndefined();
			expect(parseConflictUrl("conflict:")).toBeUndefined();
		});
	});
});

describe("findConflictRegions", () => {
	it("returns empty for clean files", () => {
		expect(findConflictRegions("hello\nworld\n")).toEqual([]);
	});

	it("finds a single merge conflict", () => {
		const text = ["before", "<<<<<<< HEAD", "ours line", "=======", "theirs line", ">>>>>>> branch"].join("\n");

		const regions = findConflictRegions(text);
		expect(regions).toHaveLength(1);
		expect(regions[0]?.oursLines).toEqual(["ours line"]);
		expect(regions[0]?.theirsLines).toEqual(["theirs line"]);
	});

	it("finds multiple conflicts", () => {
		const text = [
			"a",
			"<<<<<<< HEAD",
			"ours1",
			"=======",
			"theirs1",
			">>>>>>> branch",
			"b",
			"<<<<<<< HEAD",
			"ours2",
			"=======",
			"theirs2",
			">>>>>>> branch",
			"c",
		].join("\n");

		const regions = findConflictRegions(text);
		expect(regions).toHaveLength(2);
	});

	it("handles multi-line ours/theirs blocks", () => {
		const text = [
			"<<<<<<< HEAD",
			"ours a",
			"ours b",
			"=======",
			"theirs a",
			"theirs b",
			"theirs c",
			">>>>>>> branch",
		].join("\n");

		const regions = findConflictRegions(text);
		expect(regions).toHaveLength(1);
		expect(regions[0]?.oursLines).toEqual(["ours a", "ours b"]);
		expect(regions[0]?.theirsLines).toEqual(["theirs a", "theirs b", "theirs c"]);
	});

	it("ignores unclosed conflict markers", () => {
		const text = [
			"a",
			"<<<<<<< HEAD",
			"ours",
			"=======",
			"theirs",
			// No >>>>>>> closer
		].join("\n");

		const regions = findConflictRegions(text);
		expect(regions).toHaveLength(0);
	});
});
