// Queue management for agent session: steering, follow-up, and "next turn" messages.
//
// Extracted from `agent-session.ts` so the queue state and message-delivery
// logic can be unit-tested independently of the rest of the session. The
// `SessionQueue` class operates on state owned by the session, exposed via
// the `SessionQueueHost` interface to avoid a circular dependency.

import type { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { CustomMessage } from "./messages.ts";

type AnyEvent = { type: string; [key: string]: unknown };

export type QueueDeliveryMode = "steer" | "followUp" | "nextTurn";

export interface SessionQueueHost {
	readonly isStreaming: boolean;
	readonly agent: Agent;
	getExtensionRunner(): ExtensionRunner;
	emitQueueUpdate(steering: readonly string[], followUp: readonly string[]): void;
	runAgentPrompt(message: CustomMessage<unknown>): Promise<void>;
	appendCustomMessageEntry(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details: unknown,
	): void;
	emit(event: AnyEvent): void;
}

export interface SessionQueueDeps {
	readonly host: SessionQueueHost;
	readonly steeringMessages: string[];
	readonly followUpMessages: string[];
	readonly pendingNextTurnMessages: CustomMessage[];
}

export class SessionQueue {
	private readonly deps: SessionQueueDeps;

	constructor(deps: SessionQueueDeps) {
		this.deps = deps;
	}

	get steering(): readonly string[] {
		return this.deps.steeringMessages;
	}

	get followUp(): readonly string[] {
		return this.deps.followUpMessages;
	}

	get pendingCount(): number {
		return this.deps.steeringMessages.length + this.deps.followUpMessages.length;
	}

	clear(): { steering: string[]; followUp: string[] } {
		const steering = [...this.deps.steeringMessages];
		const followUp = [...this.deps.followUpMessages];
		this.deps.steeringMessages.length = 0;
		this.deps.followUpMessages.length = 0;
		this.deps.host.agent.clearAllQueues();
		this.emitUpdate();
		return { steering, followUp };
	}

	/**
	 * Throw if the text starts with `/` and the first token is a known extension command.
	 * Extension commands cannot be queued; they must be invoked via `prompt()` or directly.
	 */
	throwIfExtensionCommand(text: string): void {
		if (!text.startsWith("/")) return;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.deps.host.getExtensionRunner().getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Internal: queue a steering message (already expanded, no extension-command check).
	 */
	queueSteer(text: string, images?: ImageContent[]): void {
		this.deps.steeringMessages.push(text);
		this.emitUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.deps.host.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: queue a follow-up message (already expanded, no extension-command check).
	 */
	queueFollowUp(text: string, images?: ImageContent[]): void {
		this.deps.followUpMessages.push(text);
		this.emitUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.deps.host.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Send a custom message to the session.
	 *
	 * Three delivery modes:
	 * - `"nextTurn"` — append to `_pendingNextTurnMessages` (consumed on next user turn)
	 * - streaming   — queue via `agent.steer` / `agent.followUp`
	 * - not streaming + `triggerTurn` — call `runAgentPrompt` directly
	 * - not streaming + no trigger — append to state + session, no turn
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: QueueDeliveryMode },
	): Promise<void> {
		const host = this.deps.host;
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;

		if (options?.deliverAs === "nextTurn") {
			this.deps.pendingNextTurnMessages.push(appMessage as CustomMessage);
			return;
		}

		if (host.isStreaming) {
			if (options?.deliverAs === "followUp") {
				host.agent.followUp(appMessage);
			} else {
				host.agent.steer(appMessage);
			}
			return;
		}

		if (options?.triggerTurn) {
			await host.runAgentPrompt(appMessage as CustomMessage<unknown>);
			return;
		}

		host.agent.state.messages.push(appMessage);
		host.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		host.emit({ type: "message_start", message: appMessage as CustomMessage });
		host.emit({ type: "message_end", message: appMessage as CustomMessage });
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		deliver: (input: {
			text: string;
			images?: ImageContent[];
			expandPromptTemplates: false;
			streamingBehavior?: "steer" | "followUp";
			source: "extension";
		}) => Promise<void>,
	): Promise<void> {
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await deliver({
			text,
			images,
			expandPromptTemplates: false,
			streamingBehavior: undefined, // caller passes this through options.deliverAs
			source: "extension",
		});
	}

	/**
	 * Remove a delivered user message from the steering/follow-up queues.
	 * Called by the agent event handler when a user message starts.
	 */
	consumeDelivered(messageText: string): void {
		const steeringIndex = this.deps.steeringMessages.indexOf(messageText);
		if (steeringIndex !== -1) {
			this.deps.steeringMessages.splice(steeringIndex, 1);
			this.emitUpdate();
			return;
		}
		const followUpIndex = this.deps.followUpMessages.indexOf(messageText);
		if (followUpIndex !== -1) {
			this.deps.followUpMessages.splice(followUpIndex, 1);
			this.emitUpdate();
		}
	}

	private emitUpdate(): void {
		this.deps.host.emitQueueUpdate(this.deps.steeringMessages, this.deps.followUpMessages);
	}
}
