/**
 * TTSR stream wrapper.
 *
 * Wraps a stream function (the function pi passes to the agent loop) so
 * that accumulating assistant text is scanned against compiled TTSR
 * rules. On match, the wrapper:
 *
 * 1. Aborts the inner stream via the supplied `signal`.
 * 2. Throws a `TtsrAbortError` carrying the matched rule, hit, and the
 *    accumulated text up to the match. The agent loop's `for await`
 *    loop will see this error and surface it to `AgentSession`.
 *
 * The error message is serialized with a `[ttsr_abort:<ruleName>]` prefix
 * so the session-level integration can detect it from the final
 * `AssistantMessage.errorMessage` after the harness converts the
 * thrown error to a `stopReason: "error"` message.
 *
 * Notes:
 * - The wrapper is a no-op when `compiled.length === 0`.
 * - The accumulated text resets on every `text_start` (one text block per
 *   text content part of the assistant message).
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { TtsrCompiledRule } from "./ttsr.ts";
import { scanTtsrTrigger, type TtsrMatch } from "./ttsr.ts";

/** Error thrown when a TTSR rule matches during streaming. */
export class TtsrAbortError extends Error {
	readonly code = "ttsr_abort" as const;
	readonly ttsrMatch: TtsrMatch;
	/** Accumulated text up to and including the match. */
	readonly accumulated: string;
	constructor(match: TtsrMatch, accumulated: string) {
		super(`[ttsr_abort:${match.rule.name}] ${match.hit}`);
		this.name = "TtsrAbortError";
		this.ttsrMatch = match;
		this.accumulated = accumulated;
	}
}

/** Type guard for `TtsrAbortError`. */
export function isTtsrAbortError(error: unknown): error is TtsrAbortError {
	return (
		error instanceof TtsrAbortError ||
		(typeof error === "object" && error !== null && (error as { code?: string }).code === "ttsr_abort")
	);
}

/** Detect a TTSR abort from a serialized error message string. */
export function parseTtsrAbortFromMessage(errorMessage: string | undefined): { ruleName: string } | undefined {
	if (!errorMessage) return undefined;
	const match = /^\[ttsr_abort:([^\]]+)\]/.exec(errorMessage);
	if (!match) return undefined;
	return { ruleName: match[1] ?? "" };
}

interface WrapOptions {
	compiled: TtsrCompiledRule[];
	/** When false, the wrapper passes the stream through untouched. */
	enabled: boolean;
}

/** Wrap a stream function with TTSR scanning. */
export function wrapStreamFnWithTtsr(inner: StreamFn, options: WrapOptions): StreamFn {
	if (!options.enabled || options.compiled.length === 0) {
		return inner;
	}

	return async (model, context, opts) => {
		const innerStream = await inner(model, context, opts);
		return wrapAssistantStream(innerStream, options.compiled, opts?.signal);
	};
}

/** Wrap an `AssistantMessageEventStream` so TTSR can abort it. */
function wrapAssistantStream(
	stream: AssistantMessageEventStream,
	compiled: TtsrCompiledRule[],
	_signal: AbortSignal | undefined,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	const accumulated: string[] = [];
	let aborted = false;

	(async () => {
		try {
			for await (const event of stream) {
				if (aborted) break;

				// Reset accumulator on each text block start.
				if (event.type === "text_start") {
					accumulated.length = 0;
				}

				// Track text deltas. Other events (thinking, tool calls) pass through.
				if (event.type === "text_delta") {
					accumulated.push(event.delta);
					const text = accumulated.join("");
					const match = scanTtsrTrigger(text, compiled);
					if (match) {
						aborted = true;
						// We can't abort the underlying provider from here (the
						// signal is a read-only `AbortSignal`), so we just stop
						// consuming events. Any in-flight HTTP request will run to
						// completion; the agent loop will see the error event we
						// push in the catch block and end the run.
						throw new TtsrAbortError(match, text);
					}
				}

				out.push(event);
			}
			// Normal completion: end the outer stream with the inner result.
			const finalMessage = await stream.result();
			out.end(finalMessage);
		} catch (error) {
			// Build a synthetic "error" assistant message carrying the TTSR
			// info, then end the outer stream with it. The agent loop will
			// see this as a normal "error" stopReason and persist the
			// message; AgentSession will then detect the TTSR prefix.
			const errorMessage = error instanceof Error ? error.message : String(error);
			const partial = await safeResult(stream, errorMessage);
			out.push({
				type: "error",
				reason: "error",
				error: partial,
			});
			out.end(partial as AssistantMessage);
		}
	})();

	return out;
}

/** Get the inner stream's current partial, or build a minimal one on error. */
async function safeResult(stream: AssistantMessageEventStream, errorMessage: string): Promise<AssistantMessage> {
	try {
		const m = await stream.result();
		return { ...m, stopReason: "error" as const, errorMessage };
	} catch {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "unknown",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}
}
