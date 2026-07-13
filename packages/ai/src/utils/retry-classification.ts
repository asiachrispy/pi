// Pure helpers for classifying provider errors as retryable / non-retryable /
// context-overflow. Extracted from packages/coding-agent/src/core/agent-session.ts
// so the rules can be unit-tested independently of the agent session and reused
// by other layers (e.g. the SDK).
//
// Context overflow is NOT retryable here; it is handled by compaction instead.

import type { AssistantMessage } from "../types.ts";
import { isContextOverflow } from "./overflow.ts";

/**
 * Error messages that signal a hard provider limit (quota / billing) where
 * retrying with the same credentials will not help. The user has to act.
 */
export const NON_RETRYABLE_PROVIDER_LIMIT_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/**
 * Error messages that signal a transient provider / transport failure that
 * is worth retrying with backoff: overload, rate limit, server errors, network
 * / connection problems, WebSocket transport close / errors, premature stream
 * endings, HTTP/2 closed before response, termination, retry-delay exceeded,
 * and explicit provider retry guidance (OpenAI Responses / Bedrock, #6019).
 */
export const RETRYABLE_TRANSIENT_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|you can retry your request|try your request again|please retry your request/i;

export function isNonRetryableProviderLimitError(errorMessage: string): boolean {
	return NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(errorMessage);
}

/**
 * Check whether an assistant-message error is worth auto-retrying.
 *
 * Returns true only when the message is an error, has an `errorMessage`, is
 * not a context-overflow (handled by compaction), and matches a transient
 * failure pattern. Provider-limit errors short-circuit to false.
 *
 * Pass `contextWindow = 0` when the model is unknown; that disables the
 * context-overflow short-circuit but does not change transient classification.
 */
export function isRetryableAssistantError(message: AssistantMessage, contextWindow: number): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (isContextOverflow(message, contextWindow)) return false;
	const err = message.errorMessage;
	if (isNonRetryableProviderLimitError(err)) return false;
	return RETRYABLE_TRANSIENT_PATTERN.test(err);
}
