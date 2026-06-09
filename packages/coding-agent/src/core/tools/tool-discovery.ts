/**
 * BM25 hidden tool discovery.
 *
 * When `tools.discoveryMode` is `"bm25"`, tools that are not in the
 * active set (the ones shown in the system prompt) are indexed by name
 * and description. The model can find them via the `search_tool_bm25`
 * built-in, which runs a simple keyword match against the index.
 *
 * Matched tools are auto-activated (added to the active set) so the
 * model can use them immediately on the next turn. This avoids bloating
 * the system prompt with rarely-used tool descriptions while keeping
 * the full toolbox discoverable.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/** A lightweight index entry for a hidden tool. */
export interface ToolIndexEntry {
	name: string;
	description: string;
	label: string;
}

/**
 * Build an inverted index of hidden tools for keyword search.
 * `activeNames` is the set of tools currently shown in the system prompt.
 * `allEntries` lists every tool in the registry.
 */
export function buildToolIndex(activeNames: Set<string>, allEntries: ToolIndexEntry[]): ToolIndexEntry[] {
	return allEntries.filter((e) => !activeNames.has(e.name));
}

/** Score an entry against a query. Simple token-overlap (not real BM25,
 * but enough for 10-50 tools). */
function scoreEntry(entry: ToolIndexEntry, query: string): number {
	const terms = query.toLowerCase().split(/\s+/);
	const target = `${entry.name} ${entry.description} ${entry.label}`.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (target.includes(term)) score += 1;
	}
	// Boost exact name match
	if (entry.name.toLowerCase() === query.toLowerCase()) score += 10;
	return score;
}

/** Search the index for tools matching a query. Returns matches sorted by relevance. */
export function searchToolIndex(index: ToolIndexEntry[], query: string, maxResults = 5): ToolIndexEntry[] {
	const scored = index
		.map((entry) => ({ entry, score: scoreEntry(entry, query) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults);
	return scored.map((s) => s.entry);
}

/** Schema for the search_tool_bm25 tool. */
export const bm25Schema = Type.Object({
	query: Type.String({ description: "Keywords to search for (e.g., 'git', 'github', 'browser')" }),
});

export function createBm25ToolDefinition(
	getIndex: () => ToolIndexEntry[],
	onActivate: (name: string) => void,
): ToolDefinition<typeof bm25Schema, { activated: string[] } | undefined> {
	return {
		name: "search_tool_bm25",
		label: "Search Hidden Tools",
		description: `Search for tools not currently in your active set. Returns matching tool names and descriptions. When you find a tool you need, it is automatically activated so you can call it on the next turn. Use this when you suspect a tool exists but it is not listed in the Available tools section.`,
		promptSnippet: "Search the hidden tool index by keyword",
		parameters: bm25Schema,
		async execute(_toolCallId, { query }: { query: string }, _signal, _onUpdate) {
			const index = getIndex();
			const results = searchToolIndex(index, query);
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No hidden tools matched "${query}".` }],
					details: { activated: [] },
				};
			}

			const activated: string[] = [];
			const lines: string[] = [`# Hidden tools matching "${query}"`, ""];
			for (const r of results) {
				lines.push(`- **${r.name}**: ${r.description}`);
				onActivate(r.name);
				activated.push(r.name);
			}
			lines.push("");
			lines.push(`${activated.length} tool(s) activated. You can call them immediately.`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { activated },
			};
		},
	};
}
