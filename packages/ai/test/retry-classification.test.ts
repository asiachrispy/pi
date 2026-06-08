import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import {
	isNonRetryableProviderLimitError,
	isRetryableAssistantError,
	NON_RETRYABLE_PROVIDER_LIMIT_PATTERN,
	RETRYABLE_TRANSIENT_PATTERN,
} from "../src/utils/retry-classification.ts";

function createErrorMessage(
	errorMessage: string | undefined,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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
		...overrides,
	};
}

const OVERFLOW_MESSAGE = "prompt is too long: 200000 tokens > 200000 maximum";

describe("isNonRetryableProviderLimitError", () => {
	const table: Array<[string, boolean]> = [
		["insufficient_quota", true],
		["Your account has insufficient_quota for this request", true],
		["billing error on file", true],
		["quota exceeded for today", true],
		["Monthly usage limit reached", true],
		["FreeUsageLimitError from provider", true],
		["GoUsageLimitError: too many requests", true],
		["out of budget, please top up", true],
		["available balance: 0", true],
		["overloaded_error", false],
		["rate limit exceeded", false],
		["network_error", false],
		["", false],
	];

	for (const [input, expected] of table) {
		it(`classifies ${JSON.stringify(input)} as ${expected}`, () => {
			expect(isNonRetryableProviderLimitError(input)).toBe(expected);
		});
	}
});

describe("RETRYABLE_TRANSIENT_PATTERN", () => {
	it("matches the existing agent-session test fixtures", () => {
		expect(RETRYABLE_TRANSIENT_PATTERN.test("overloaded_error")).toBe(true);
		expect(RETRYABLE_TRANSIENT_PATTERN.test("Provider finish_reason: network_error")).toBe(true);
	});
});

describe("NON_RETRYABLE_PROVIDER_LIMIT_PATTERN", () => {
	it("is exported and matches a known billing-class message", () => {
		expect(NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test("insufficient_quota")).toBe(true);
	});
});

describe("isRetryableAssistantError", () => {
	const retryableTable: Array<[string, string]> = [
		["overloaded", "overloaded_error"],
		["provider returned error", "provider returned error: 502"],
		["rate limit", "rate limit exceeded"],
		["too many requests", "too many requests, slow down"],
		["429", "HTTP 429 returned"],
		["500", "500 Internal Server Error"],
		["502", "502 Bad Gateway"],
		["503", "503 Service Unavailable"],
		["504", "504 Gateway Timeout"],
		["service unavailable", "service unavailable, retry later"],
		["server error", "server error from upstream"],
		["internal error", "internal error, please retry"],
		["network error", "Provider finish_reason: network_error"],
		["connection error", "connection error: ECONNRESET"],
		["connection refused", "connection refused by upstream"],
		["connection lost", "connection lost mid-stream"],
		["websocket closed", "websocket closed unexpectedly"],
		["websocket error", "websocket error: invalid frame"],
		["other side closed", "other side closed WebSocket"],
		["fetch failed", "fetch failed: getaddrinfo ENOTFOUND"],
		["upstream connect", "upstream connect error or disconnect/reset before headers"],
		["reset before headers", "connection reset before headers"],
		["socket hang up", "socket hang up"],
		["ended without", "stream ended without message_stop"],
		["stream ended before message_stop", "stream ended before message_stop"],
		["http2 request did not get a response", "http2 request did not get a response"],
		["timed out", "request timed out"],
		["timeout", "operation timeout"],
		["terminated", "stream terminated by server"],
		["retry delay exceeded", "retry delay exceeded maximum"],
	];

	for (const [label, errorMessage] of retryableTable) {
		it(`retries ${label}`, () => {
			const msg = createErrorMessage(errorMessage);
			expect(isRetryableAssistantError(msg, 0)).toBe(true);
		});
	}

	const nonRetryableLimitTable: Array<[string, string]> = [
		["insufficient_quota", "insufficient_quota: out of credits"],
		["billing", "billing error: card declined"],
		["quota exceeded", "quota exceeded for account"],
		["Monthly usage limit", "Monthly usage limit reached"],
		["FreeUsageLimitError", "FreeUsageLimitError from google"],
		["GoUsageLimitError", "GoUsageLimitError: too many requests"],
		["available balance", "available balance: 0"],
		["out of budget", "out of budget for this model"],
	];

	for (const [label, errorMessage] of nonRetryableLimitTable) {
		it(`does NOT retry billing-class error: ${label}`, () => {
			const msg = createErrorMessage(errorMessage);
			expect(isRetryableAssistantError(msg, 0)).toBe(false);
		});
	}

	it("does NOT retry context overflow (handled by compaction instead)", () => {
		const msg = createErrorMessage(OVERFLOW_MESSAGE);
		// Pass a context window that matches the overflow message.
		expect(isRetryableAssistantError(msg, 200_000)).toBe(false);
	});

	it("returns false for a non-error stopReason", () => {
		const msg = createErrorMessage("overloaded_error", { stopReason: "stop" });
		expect(isRetryableAssistantError(msg, 0)).toBe(false);
	});

	it("returns false when errorMessage is undefined", () => {
		const msg = createErrorMessage(undefined);
		expect(isRetryableAssistantError(msg, 0)).toBe(false);
	});
});
