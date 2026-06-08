import { describe, expect, it, vi } from "vitest";
import { SessionQueue, type SessionQueueHost } from "../src/core/agent-session-queue.ts";
import type { CustomMessage } from "../src/core/messages.ts";

interface FakeHost {
	isStreaming: boolean;
	agent: {
		steer: ReturnType<typeof vi.fn>;
		followUp: ReturnType<typeof vi.fn>;
		clearAllQueues: ReturnType<typeof vi.fn>;
		state: { messages: CustomMessage[] };
	};
	getExtensionRunner: ReturnType<typeof vi.fn>;
	emitQueueUpdate: ReturnType<typeof vi.fn>;
	runAgentPrompt: ReturnType<typeof vi.fn>;
	appendCustomMessageEntry: ReturnType<typeof vi.fn>;
	emit: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<FakeHost> = {}): FakeHost {
	return {
		isStreaming: false,
		agent: {
			steer: vi.fn(),
			followUp: vi.fn(),
			clearAllQueues: vi.fn(),
			state: { messages: [] },
		},
		getExtensionRunner: vi.fn(),
		emitQueueUpdate: vi.fn(),
		runAgentPrompt: vi.fn().mockResolvedValue(undefined),
		appendCustomMessageEntry: vi.fn(),
		emit: vi.fn(),
		...overrides,
	};
}

function makeQueue(host: FakeHost): {
	queue: SessionQueue;
	steering: string[];
	followUp: string[];
	pending: CustomMessage[];
} {
	const steering: string[] = [];
	const followUp: string[] = [];
	const pending: CustomMessage[] = [];
	const queue = new SessionQueue({
		host: host as unknown as SessionQueueHost,
		steeringMessages: steering,
		followUpMessages: followUp,
		pendingNextTurnMessages: pending,
	});
	return { queue, steering, followUp, pending };
}

describe("SessionQueue", () => {
	describe("steering / followUp / pendingCount", () => {
		it("initial state is empty", () => {
			const { queue } = makeQueue(makeHost());
			expect(queue.steering).toEqual([]);
			expect(queue.followUp).toEqual([]);
			expect(queue.pendingCount).toBe(0);
		});

		it("queueSteer pushes and emits", () => {
			const host = makeHost();
			const { queue, steering } = makeQueue(host);
			queue.queueSteer("hello");
			expect(steering).toEqual(["hello"]);
			expect(queue.pendingCount).toBe(1);
			expect(host.agent.steer).toHaveBeenCalled();
			expect(host.emitQueueUpdate).toHaveBeenCalled();
		});

		it("queueFollowUp pushes and emits", () => {
			const host = makeHost();
			const { queue, followUp } = makeQueue(host);
			queue.queueFollowUp("hi");
			expect(followUp).toEqual(["hi"]);
			expect(queue.pendingCount).toBe(1);
			expect(host.agent.followUp).toHaveBeenCalled();
		});

		it("pendingCount sums both queues", () => {
			const { queue } = makeQueue(makeHost());
			queue.queueSteer("a");
			queue.queueSteer("b");
			queue.queueFollowUp("c");
			expect(queue.pendingCount).toBe(3);
		});
	});

	describe("clear", () => {
		it("returns and clears both queues", () => {
			const host = makeHost();
			const { queue, steering, followUp } = makeQueue(host);
			queue.queueSteer("a");
			queue.queueFollowUp("b");
			const cleared = queue.clear();
			expect(cleared).toEqual({ steering: ["a"], followUp: ["b"] });
			expect(steering).toEqual([]);
			expect(followUp).toEqual([]);
			expect(host.agent.clearAllQueues).toHaveBeenCalled();
		});
	});

	describe("throwIfExtensionCommand", () => {
		it("does nothing for plain text", () => {
			const host = makeHost();
			const { queue } = makeQueue(host);
			queue.throwIfExtensionCommand("hello world");
			expect(host.getExtensionRunner).not.toHaveBeenCalled();
		});

		it("does nothing for unknown /commands", () => {
			const runner = { getCommand: vi.fn().mockReturnValue(undefined) };
			const host = makeHost({ getExtensionRunner: vi.fn().mockReturnValue(runner) });
			const { queue } = makeQueue(host);
			queue.throwIfExtensionCommand("/unknown");
			// no throw
		});

		it("throws for registered extension commands", () => {
			const runner = { getCommand: vi.fn().mockReturnValue({ name: "foo" }) };
			const host = makeHost({ getExtensionRunner: vi.fn().mockReturnValue(runner) });
			const { queue } = makeQueue(host);
			expect(() => queue.throwIfExtensionCommand("/foo bar")).toThrow(/cannot be queued/);
		});
	});

	describe("sendCustomMessage", () => {
		it("appends to pendingNextTurnMessages when deliverAs is nextTurn", async () => {
			const host = makeHost();
			const { queue, pending } = makeQueue(host);
			await queue.sendCustomMessage(
				{ customType: "x", content: "c", display: true, details: undefined },
				{ deliverAs: "nextTurn" },
			);
			expect(pending.length).toBe(1);
			expect(pending[0]?.customType).toBe("x");
		});

		it("routes to agent.steer when streaming and deliverAs is not followUp", async () => {
			const host = makeHost({ isStreaming: true });
			const { queue } = makeQueue(host);
			await queue.sendCustomMessage({ customType: "x", content: "c", display: true, details: undefined });
			expect(host.agent.steer).toHaveBeenCalled();
			expect(host.agent.followUp).not.toHaveBeenCalled();
		});

		it("routes to agent.followUp when streaming and deliverAs is followUp", async () => {
			const host = makeHost({ isStreaming: true });
			const { queue } = makeQueue(host);
			await queue.sendCustomMessage(
				{ customType: "x", content: "c", display: true, details: undefined },
				{ deliverAs: "followUp" },
			);
			expect(host.agent.followUp).toHaveBeenCalled();
		});

		it("triggers agent prompt when not streaming and triggerTurn is true", async () => {
			const host = makeHost({ isStreaming: false });
			const { queue } = makeQueue(host);
			await queue.sendCustomMessage(
				{ customType: "x", content: "c", display: true, details: undefined },
				{ triggerTurn: true },
			);
			expect(host.runAgentPrompt).toHaveBeenCalled();
		});

		it("appends to state.messages and emits when not streaming and no triggerTurn", async () => {
			const host = makeHost({ isStreaming: false });
			const { queue } = makeQueue(host);
			await queue.sendCustomMessage({ customType: "x", content: "c", display: true, details: undefined });
			expect(host.agent.state.messages.length).toBe(1);
			expect(host.appendCustomMessageEntry).toHaveBeenCalled();
			expect(host.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "message_start" }));
			expect(host.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "message_end" }));
		});
	});

	describe("consumeDelivered", () => {
		it("removes from steering queue and emits", () => {
			const host = makeHost();
			const { queue, steering } = makeQueue(host);
			queue.queueSteer("a");
			queue.queueSteer("b");
			queue.consumeDelivered("a");
			expect(steering).toEqual(["b"]);
		});

		it("removes from followUp queue and emits", () => {
			const host = makeHost();
			const { queue, followUp, steering } = makeQueue(host);
			queue.queueSteer("a");
			queue.queueFollowUp("b");
			queue.consumeDelivered("b");
			expect(followUp).toEqual([]);
			expect(steering).toEqual(["a"]);
		});

		it("does nothing if message not in either queue", () => {
			const host = makeHost();
			const { queue, steering, followUp } = makeQueue(host);
			queue.queueSteer("a");
			queue.consumeDelivered("zzz");
			expect(steering).toEqual(["a"]);
			expect(followUp).toEqual([]);
		});
	});
});
