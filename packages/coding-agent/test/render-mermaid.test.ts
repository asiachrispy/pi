import { describe, expect, it } from "vitest";
import { createRenderMermaidToolDefinition } from "../src/core/tools/render-mermaid.ts";

const tool = createRenderMermaidToolDefinition();

async function render(mermaid: string): Promise<string> {
	const result = await tool.execute("id", { mermaid }, undefined, undefined, undefined as never);
	return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

describe("render_mermaid", () => {
	describe("graph", () => {
		it("renders a simple graph", async () => {
			const out = await render("graph TD\nA[Start] --> B[End]\n");
			expect(out).toContain("Start");
			expect(out).toContain("End");
			expect(out).toContain("→");
		});

		it("renders multiple nodes", async () => {
			const out = await render("graph LR\nA --> B\nB --> C\n");
			expect(out).toContain("A");
			expect(out).toContain("B");
			expect(out).toContain("C");
		});

		it("renders labeled edges", async () => {
			const out = await render("graph TD\nA -->|label| B\n");
			expect(out).toContain("→|label|");
		});

		it("renders empty diagram gracefully", async () => {
			const out = await render("graph TD\n");
			expect(out).toContain("(empty diagram)");
		});

		it("renders with ASCII mode", async () => {
			const result = await tool.execute(
				"id",
				{ mermaid: "graph TD\nA --> B", config: { useAscii: true } },
				undefined,
				undefined,
				undefined as never,
			);
			const out = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			const hasUnicodeArrow = out.includes("→");
			expect(hasUnicodeArrow).toBe(false);
		});
	});

	describe("sequenceDiagram", () => {
		it("renders simple sequence", async () => {
			const out = await render(["sequenceDiagram", "Alice->>Bob: Hello", "Bob-->>Alice: Hi"].join("\n"));
			expect(out).toContain("Alice ⇒ Bob: Hello");
			expect(out).toContain("Bob ⇒ Alice: Hi");
		});

		it("renders participants", async () => {
			const out = await render(["sequenceDiagram", "participant A as Alice", "participant B"].join("\n"));
			expect(out).toContain("A: Alice");
			expect(out).toContain("B: B");
		});
	});
});
