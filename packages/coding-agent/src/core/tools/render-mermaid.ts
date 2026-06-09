/**
 * Minimal Mermaid-to-text renderer.
 *
 * Renders a small subset of Mermaid to terminal-friendly ASCII art.
 * Supports flowcharts (graph TD/LR) and sequence diagrams.
 * This is deliberately minimal — full Mermaid syntax is out of scope.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const mermaidSchema = Type.Object({
	mermaid: Type.String({ description: "Mermaid diagram source (graph TD/LR or sequenceDiagram)" }),
	config: Type.Optional(
		Type.Object({
			useAscii: Type.Optional(
				Type.Boolean({ description: "Use plain ASCII box-drawing (no Unicode). Default: false" }),
			),
		}),
	),
});

type MermaidInput = { mermaid: string; config?: { useAscii?: boolean } };

// ─── Graph types ─────────────────────────────────────────────────────────

interface MermaidEdge {
	from: string;
	to: string;
	label?: string;
}

interface MermaidGraph {
	nodes: Map<string, string>; // id -> label
	edges: MermaidEdge[];
}

// ─── Graph parser ────────────────────────────────────────────────────────

function parseGraph(source: string): MermaidGraph {
	const nodes = new Map<string, string>();
	const edges: MermaidEdge[] = [];
	const lines = source.split("\n");

	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("%%")) continue;

		// Standalone node definition: id[Label] or id(Label) or id{Label}
		const soloNode = /^(\w+)\s*[\[({]\s*([^\])}]*)\s*[\])}]\s*$/.exec(line);
		if (soloNode) {
			nodes.set(soloNode[1] ?? "", (soloNode[2] ?? "").trim());
			continue;
		}

		// Edge with optional inline node labels and optional edge label.
		// Matches: A --> B, A[label] --> B, A --> B[label], A -->|label| B
		const edgeMatch = /^(\w+)(?:\s*\[[^\]]*\])?\s*-->(?:\|([^|]*)\|)?\s*(\w+)(?:\s*\[[^\]]*\])?\s*$/.exec(line);
		if (edgeMatch) {
			const fromId = edgeMatch[1] ?? "";
			const edgeLabel = edgeMatch[2]?.trim();
			const toId = edgeMatch[3] ?? "";

			// Extract inline labels from brackets in the original line.
			const fromLabelMatch = /(\w+)\s*\[([^\]]*)\]/.exec(line);
			if (fromLabelMatch && fromLabelMatch[1] === fromId) {
				nodes.set(fromId, (fromLabelMatch[2] ?? "").trim());
			}
			// Find the second bracket pair (after -->).
			const afterArrow = line.slice(line.indexOf("-->") + 3);
			const toLabelMatch = /(\w+)\s*\[([^\]]*)\]/.exec(afterArrow);
			if (toLabelMatch && toLabelMatch[1] === toId) {
				nodes.set(toId, (toLabelMatch[2] ?? "").trim());
			}

			edges.push({ from: fromId, to: toId, label: edgeLabel || undefined });
		}
	}

	return { nodes, edges };
}

function renderGraphAscii(graph: MermaidGraph, useAscii: boolean): string {
	const lines: string[] = [];
	const arrow = useAscii ? "-->" : "→";
	const boxH = useAscii ? "-" : "─";
	const boxV = useAscii ? "|" : "│";
	const boxTl = useAscii ? "+" : "┌";
	const boxBl = useAscii ? "+" : "└";

	if (graph.nodes.size === 0 && graph.edges.length === 0) {
		return "(empty diagram)";
	}

	const order: string[] = [];
	const seen = new Set<string>();
	for (const { from, to } of graph.edges) {
		if (!seen.has(from)) {
			seen.add(from);
			order.push(from);
		}
		if (!seen.has(to)) {
			seen.add(to);
			order.push(to);
		}
	}

	if (order.length > 0) {
		const maxLen = Math.max(...order.map((id) => (graph.nodes.get(id) ?? id).length)) + 4;
		const boxLine = `${boxTl}${boxH.repeat(maxLen + 2)}`;
		lines.push(boxLine);
		for (const id of order) {
			const label = graph.nodes.get(id) ?? id;
			lines.push(`${boxV} ${label.padEnd(maxLen)} ${boxV}`);
		}
		lines.push(`${boxBl}${boxH.repeat(maxLen + 2)}`);

		if (graph.edges.length > 0) {
			lines.push("");
			for (const { from, to, label } of graph.edges) {
				const text = label ? `${from} ${arrow}|${label}| ${to}` : `${from} ${arrow} ${to}`;
				lines.push(text);
			}
		}
	} else {
		for (const [id, label] of graph.nodes) {
			lines.push(`[${id}] ${label}`);
		}
	}

	return lines.join("\n");
}

// ─── Sequence diagram ────────────────────────────────────────────────────

interface SequenceParticipant {
	alias: string;
	label: string;
}

interface SequenceLine {
	from: string;
	to: string;
	label?: string;
	arrow: "->" | "-->" | "->>" | "-->>";
}

function parseSequence(source: string): { participants: SequenceParticipant[]; lines: SequenceLine[] } {
	const participants: SequenceParticipant[] = [];
	const lines: SequenceLine[] = [];
	const rawLines = source.split("\n");

	for (const raw of rawLines) {
		const line = raw.trim();
		if (!line || line.startsWith("%%")) continue;

		const partMatch = /^\s*participant\s+(\w+)(?:\s+as\s+(.+))?\s*$/.exec(line);
		if (partMatch) {
			participants.push({ alias: partMatch[1] ?? "", label: (partMatch[2] ?? partMatch[1])?.trim() ?? "" });
			continue;
		}

		const seqMatch = /^\s*(\w+)\s*(->>|-->>|-->|->)\s*(\w+)\s*:\s*(.+)$/.exec(line);
		if (seqMatch) {
			lines.push({
				from: seqMatch[1] ?? "",
				to: seqMatch[3] ?? "",
				arrow: (seqMatch[2] ?? "->") as SequenceLine["arrow"],
				label: seqMatch[4]?.trim(),
			});
		}
	}

	return { participants, lines };
}

function renderSequenceAscii(
	seq: { participants: SequenceParticipant[]; lines: SequenceLine[] },
	_useAscii: boolean,
): string {
	if (seq.lines.length === 0 && seq.participants.length > 0) {
		return seq.participants.map((p) => `participant ${p.alias}: ${p.label}`).join("\n");
	}

	const out: string[] = [];
	for (const { from, to, arrow, label } of seq.lines) {
		const arrowGlyph = arrow.includes(">>") ? "⇒" : "→";
		const text = label ? `${from} ${arrowGlyph} ${to}: ${label}` : `${from} ${arrowGlyph} ${to}`;
		out.push(text);
	}

	return out.join("\n");
}

// ─── Tool definition ─────────────────────────────────────────────────────

export function createRenderMermaidToolDefinition(): ToolDefinition<typeof mermaidSchema, undefined> {
	return {
		name: "render_mermaid",
		label: "Render Mermaid",
		description:
			"Render a Mermaid diagram to terminal-friendly text. Supports simple flowcharts (graph TD/LR) and sequence diagrams. Returns ASCII art suitable for reading in a terminal. Use this when you want to visualize a flow or sequence mentioned in text.",
		promptSnippet: "Render Mermaid diagrams to terminal text",
		parameters: mermaidSchema,
		async execute(_toolCallId, input: MermaidInput, _signal?, _onUpdate?, _ctx?) {
			const useAscii = input.config?.useAscii ?? false;
			let output: string;

			if (input.mermaid.trim().startsWith("sequenceDiagram")) {
				const seq = parseSequence(input.mermaid);
				output = renderSequenceAscii(seq, useAscii);
			} else {
				const graph = parseGraph(input.mermaid);
				output = renderGraphAscii(graph, useAscii);
			}

			return { content: [{ type: "text", text: output }], details: undefined };
		},
	};
}
