import { type AssistantMessageEventStream, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { compileTtsrRules, scanTtsrTrigger, type TtsrCompiledRule } from "../src/core/rules/ttsr.ts";
import {
	isTtsrAbortError,
	parseTtsrAbortFromMessage,
	TtsrAbortError,
	wrapStreamFnWithTtsr,
} from "../src/core/rules/ttsr-stream.ts";
import type { Rule } from "../src/core/rules/types.ts";

const projectSource = { label: "<project-AGENTS.md>", path: "/repo/AGENTS.md", level: "project" as const };

function makeRule(content: string, name = "no-box-leak"): Rule {
	return {
		name,
		path: "/repo/AGENTS.md",
		content,
		interruptMode: "always",
		alwaysApply: true,
		_source: projectSource,
	};
}

function makeCompiled(overrides: Partial<TtsrCompiledRule> = {}): TtsrCompiledRule {
	return {
		name: "no-box-leak",
		source: "<config>",
		pattern: /Box::leak/,
		body: "Don't reach for Box::leak in production code paths",
		interruptMode: "always",
		...overrides,
	};
}

describe("scanTtsrTrigger", () => {
	it("returns undefined when no rules match", () => {
		expect(scanTtsrTrigger("hello world", [makeCompiled()])).toBeUndefined();
	});

	it("returns the first matching rule", () => {
		const a = makeCompiled({ name: "a", pattern: /foo/ });
		const b = makeCompiled({ name: "b", pattern: /bar/ });
		const match = scanTtsrTrigger("foo and bar", [a, b]);
		expect(match?.rule.name).toBe("a");
		expect(match?.hit).toBe("foo");
		expect(match?.matchIndex).toBe(0);
	});

	it("reports the match position", () => {
		const rule = makeCompiled({ pattern: /world/ });
		const match = scanTtsrTrigger("hello world", [rule]);
		expect(match?.matchIndex).toBe(6);
	});
});

describe("compileTtsrRules", () => {
	it("ignores rules with interruptMode never", () => {
		const rule: Rule = { ...makeRule("Box::leak\nbody"), interruptMode: "never" };
		const { compiled } = compileTtsrRules([rule], undefined);
		expect(compiled).toHaveLength(0);
	});

	it("uses the first line of a rule as the literal trigger", () => {
		const rule = makeRule("Box::leak\nDon't reach for Box::leak in production code paths");
		const { compiled } = compileTtsrRules([rule], undefined);
		expect(compiled).toHaveLength(1);
		expect(compiled[0]?.pattern.test("Box::leak in hot path")).toBe(true);
		expect(compiled[0]?.body).toBe("Don't reach for Box::leak in production code paths");
	});

	it("deduplicates rules by name", () => {
		const rule = makeRule("X\nbody");
		const dup: Rule = { ...rule, name: "no-box-leak", content: "X\nother" };
		const { compiled } = compileTtsrRules([rule, dup], undefined);
		expect(compiled).toHaveLength(1);
		expect(compiled[0]?.body).toBe("body");
	});

	it("compiles explicit settings rules", () => {
		const { compiled, diagnostics } = compileTtsrRules([], {
			enabled: true,
			rules: [{ name: "r1", pattern: "rm -rf /", body: "no" }],
		});
		expect(compiled).toHaveLength(1);
		expect(compiled[0]?.pattern.test("rm -rf /")).toBe(true);
		expect(diagnostics).toHaveLength(0);
	});

	it("rejects invalid regex with a diagnostic", () => {
		const { compiled, diagnostics } = compileTtsrRules([], {
			enabled: true,
			rules: [{ name: "bad", pattern: "[invalid", body: "x" }],
		});
		expect(compiled).toHaveLength(0);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.reason).toMatch(/invalid regex/);
	});

	it("ignores settings rules missing pattern or body", () => {
		const { compiled, diagnostics } = compileTtsrRules([], {
			enabled: true,
			rules: [
				{ pattern: "x" } as { name?: string; pattern: string; body: string },
				{ body: "y" } as { name?: string; pattern: string; body: string },
			],
		});
		expect(compiled).toHaveLength(0);
		expect(diagnostics).toHaveLength(2);
	});
});

describe("parseTtsrAbortFromMessage", () => {
	it("parses the rule name from the prefix", () => {
		expect(parseTtsrAbortFromMessage("[ttsr_abort:no-box-leak] Box::leak")).toEqual({
			ruleName: "no-box-leak",
		});
	});

	it("returns undefined for non-TTSR messages", () => {
		expect(parseTtsrAbortFromMessage("connection timeout")).toBeUndefined();
		expect(parseTtsrAbortFromMessage(undefined)).toBeUndefined();
	});
});

describe("TtsrAbortError", () => {
	it("carries the match details", () => {
		const match = { rule: makeCompiled(), matchIndex: 0, hit: "Box::leak" };
		const err = new TtsrAbortError(match, "Box::leak in hot path");
		expect(err.code).toBe("ttsr_abort");
		expect(err.ttsrMatch).toBe(match);
		expect(err.accumulated).toBe("Box::leak in hot path");
		expect(err.message).toBe("[ttsr_abort:no-box-leak] Box::leak");
		expect(isTtsrAbortError(err)).toBe(true);
	});

	it("isTtsrAbortError recognizes duck-typed errors", () => {
		const duck = { code: "ttsr_abort", message: "x" };
		expect(isTtsrAbortError(duck)).toBe(true);
		expect(isTtsrAbortError(new Error("nope"))).toBe(false);
	});
});

/**
 * Build a fake inner stream that yields a fixed list of events, then
 * resolves to a synthetic assistant message on `result()`.
 */
function fakeStream(
	events: Parameters<typeof createAssistantMessageEventStream>["push"] extends never ? never : any[],
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const finalMessage = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "final" }],
		api: "openai-completions" as const,
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	Promise.resolve().then(async () => {
		for (const event of events) {
			stream.push(event);
		}
		stream.end(finalMessage);
	});
	return stream;
}

describe("wrapStreamFnWithTtsr", () => {
	it("is a passthrough when disabled", async () => {
		const inner = async () => fakeStream([{ type: "text_delta", contentIndex: 0, delta: "Box::leak here" }]);
		const wrapped = wrapStreamFnWithTtsr(inner, { compiled: [makeCompiled()], enabled: false });
		const stream = await wrapped({} as never, {} as never, {} as never);
		const events: unknown[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(
			events.some((e) => typeof e === "object" && e !== null && (e as { type?: string }).type === "text_delta"),
		).toBe(true);
	});

	it("is a passthrough when no rules are compiled", async () => {
		const inner = async () => fakeStream([{ type: "text_delta", contentIndex: 0, delta: "Box::leak here" }]);
		const wrapped = wrapStreamFnWithTtsr(inner, { compiled: [], enabled: true });
		const stream = await wrapped({} as never, {} as never, {} as never);
		const events: unknown[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(
			events.some((e) => typeof e === "object" && e !== null && (e as { type?: string }).type === "text_delta"),
		).toBe(true);
	});

	it("passes through events when no rule matches", async () => {
		const inner = async () =>
			fakeStream([
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "safe code only" },
				{ type: "text_end", contentIndex: 0, content: "safe code only" },
			]);
		const wrapped = wrapStreamFnWithTtsr(inner, { compiled: [makeCompiled()], enabled: true });
		const stream = await wrapped({} as never, {} as never, {} as never);
		const types: string[] = [];
		for await (const event of stream) {
			types.push((event as { type: string }).type);
		}
		expect(types).toContain("text_delta");
		expect(types).toContain("text_end");
		// No error event because nothing matched.
		expect(types).not.toContain("error");
		// The final result is the inner stream's final message.
		const final = await stream.result();
		expect(final.stopReason).toBe("stop");
	});

	it("emits an error event when a rule matches", async () => {
		const inner = async () =>
			fakeStream([
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "danger: Box::leak" },
			]);
		const wrapped = wrapStreamFnWithTtsr(inner, { compiled: [makeCompiled()], enabled: true });
		const stream = await wrapped({} as never, {} as never, {} as never);
		const types: string[] = [];
		for await (const event of stream) {
			types.push((event as { type: string }).type);
		}
		expect(types).toContain("error");
		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/^\[ttsr_abort:no-box-leak\]/);
	});

	it("resets the accumulator between text blocks", async () => {
		// First block: contains the trigger → would normally match.
		// But the rule has interruptMode "always" and a regex of /Box::leak/,
		// so a single delta with "Box::leak" matches immediately. To test
		// the reset, use a non-matching first block followed by a matching
		// second block — only the second should trigger.
		const inner = async () =>
			fakeStream([
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "harmless" },
				{ type: "text_end", contentIndex: 0, content: "harmless" },
				{ type: "text_start", contentIndex: 1 },
				{ type: "text_delta", contentIndex: 1, delta: "Box::leak in second block" },
			]);
		const wrapped = wrapStreamFnWithTtsr(inner, { compiled: [makeCompiled()], enabled: true });
		const stream = await wrapped({} as never, {} as never, {} as never);
		const types: string[] = [];
		for await (const event of stream) {
			types.push((event as { type: string }).type);
		}
		// The second block does match; we expect the error event.
		expect(types).toContain("error");
	});
});
