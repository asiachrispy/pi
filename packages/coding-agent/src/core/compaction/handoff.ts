/**
 * Handoff compaction.
 *
 * A handoff compaction generates a self-contained "handoff document" from
 * the live system prompt, tool array, and full conversation history, then
 * replaces the agent's message history with a single user message
 * containing the document. The next LLM call sees a clean slate that
 * captures everything important from the prior session.
 *
 * Compared to context-full compaction, handoff compaction:
 *
 * - Preserves the live system prompt + tool array verbatim (no need to
 *   rebuild a fresh system prompt from disk).
 * - Replaces the entire conversation with one synthetic user message.
 * - Avoids the long-compressed-history cliff some models exhibit.
 *
 * The handoff document is persisted to the session as a `custom_message`
 * entry with `customType: "handoff"` so it survives compaction and
 * restores correctly when the session is resumed.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { convertToLlm } from "../messages.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, serializeConversation } from "./utils.ts";

/** Options for `generateHandoff`. */
export interface GenerateHandoffOptions {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	signal: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	/** Live system prompt to embed in the handoff. */
	systemPrompt: string;
	/** Description of the active tool array, e.g. "read, bash, edit, write". */
	toolsDescription: string;
	/** Custom instructions to append to the handoff prompt. */
	customInstructions?: string;
}

/**
 * Generate a handoff document from the current session state.
 *
 * The document is a self-contained brief that another LLM could use to
 * continue the work: the system prompt, the active toolset, and a
 * serialized conversation. The prompt asks the model to produce a
 * structured continuation note.
 */
export async function generateHandoff(messages: AgentMessage[], options: GenerateHandoffOptions): Promise<string> {
	const streamOptions: SimpleStreamOptions = {
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
	};

	const conversation = serializeConversation(convertToLlm(messages));
	const prompt = buildHandoffPrompt(
		options.systemPrompt,
		options.toolsDescription,
		conversation,
		options.customInstructions,
	);

	const response = await completeSimple(
		options.model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		streamOptions,
	);

	// Extract the joined text from the response.
	return extractText(response);
}

function buildHandoffPrompt(
	systemPrompt: string,
	toolsDescription: string,
	conversation: string,
	customInstructions: string | undefined,
): string {
	const custom = customInstructions ? `\n\nAdditional instructions:\n${customInstructions}` : "";
	return `# Handoff

You are producing a handoff document for a new agent that will continue this work. The new agent has the same system prompt and tool set, but a fresh conversation history.

## Active system prompt

${systemPrompt}

## Available tools

${toolsDescription}

## Conversation so far

${conversation}
${custom}

## Your task

Produce a self-contained handoff document. Structure it as:

1. **Goal** — what the user originally asked for and where things stand.
2. **Decisions** — important design decisions the prior agent made.
3. **Open questions** — anything the new agent should clarify or revisit.
4. **Next steps** — concrete actions the new agent should take first.

Be concise. The new agent will read this fresh, so do not assume prior context.`;
}

function extractText(message: AssistantMessage): string {
	const blocks: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") blocks.push(block.text);
	}
	return blocks.join("").trim();
}

/** Build the synthetic user message that the handoff path injects as a fresh start. */
export function buildHandoffUserMessage(handoffDocument: string): {
	role: "user";
	content: string;
	timestamp: number;
} {
	return {
		role: "user",
		content: `# Handoff from prior agent\n\n${handoffDocument}\n\nContinue from here. Read the prior context above, then take the next concrete step.`,
		timestamp: Date.now(),
	};
}
