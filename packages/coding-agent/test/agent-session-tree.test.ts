import { describe, expect, it } from "vitest";
import { extractCustomMessageText, extractUserMessageText } from "../src/core/agent-session-tree.ts";

describe("extractUserMessageText", () => {
	it("returns the string itself when content is a string", () => {
		expect(extractUserMessageText("hello")).toBe("hello");
	});

	it("joins text parts from an array", () => {
		const content = [
			{ type: "text", text: "hello " },
			{ type: "text", text: "world" },
		];
		expect(extractUserMessageText(content)).toBe("hello world");
	});

	it("filters out non-text parts", () => {
		const content = [
			{ type: "text", text: "before" },
			{ type: "image" } as unknown as { type: string; text: string },
			{ type: "text", text: " after" },
		];
		expect(extractUserMessageText(content)).toBe("before after");
	});

	it("returns empty string for empty array", () => {
		expect(extractUserMessageText([])).toBe("");
	});

	it("extractCustomMessageText is an alias", () => {
		expect(extractCustomMessageText("hello")).toBe("hello");
		expect(extractCustomMessageText([{ type: "text", text: "x" }])).toBe("x");
	});
});
