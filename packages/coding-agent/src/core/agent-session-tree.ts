// Tree navigation helpers for the agent session.
//
// Extracted from `agent-session.ts` so the small set of pure functions used
// by tree navigation (`extractUserMessageText`, `extractCustomMessageText`)
// can be unit-tested independently of the heavy `navigateTree` orchestrator
// that lives on the session.

export type MessageContentPart = { type: string; text?: string };

/**
 * Extract plain text from a user message's content (string or content array).
 * Returns the empty string if the content cannot yield text.
 */
export function extractUserMessageText(content: string | MessageContentPart[]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

/**
 * Extract plain text from a custom message entry's content. Same shape as
 * `extractUserMessageText` but kept separate for call-site readability.
 */
export function extractCustomMessageText(content: string | MessageContentPart[]): string {
	return extractUserMessageText(content);
}
